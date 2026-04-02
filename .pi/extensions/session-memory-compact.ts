/**
 * Session Memory Compact Extension (#7 from IDEAS.md)
 *
 * Instead of replacing old messages with a static summary block, it generates a
 * continuous "Session Memory" document appended over time.
 * Invariant-preserving logic (not splitting tool calls from results) is
 * natively handled by pi-coding-agent's cut point rules.
 */

import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";

const SESSION_MEMORY_PROMPT = `You are maintaining a continuous "Session Memory" document for an ongoing coding agent conversation. 
Your goal is to append new information from the recent conversation to the existing session memory, updating states and replacing outdated facts without losing important context.

The resulting Session Memory document MUST contain exactly these sections:
## 1. OVERVIEW
High-level goal of the session and what the user originally asked for.

## 2. SYSTEM STATE
Current architecture, important variables, dependencies, or environment details.

## 3. RECENT PROGRESS
What was just accomplished in the most recent conversation segment.

## 4. OPEN ISSUES
Errors, bugs, or blockers currently being faced. If a previous issue was fixed, MOVE it to Recent Progress.

## 5. NEXT STEPS
What needs to happen next based on the last few messages.

Instructions:
- If a <previous_memory> is provided, use it as your base document. Update it with the new <conversation>.
- Keep the document concise. It should be a living state document, not a chronological log.
- Do NOT output preamble, just the updated Markdown document.
`;

export default function sessionMemoryCompact(pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;

		const model = ctx.model;
		if (!model) {
			ctx.ui.notify("No current model available, falling back to default compaction", "warning");
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			ctx.ui.notify(`Compaction auth failed for ${model.id}, falling back to default`, "warning");
			return;
		}

		// Combine messages
		const allMessages = [...messagesToSummarize, ...(turnPrefixMessages || [])];

		// Strip images to save tokens
		const textOnlyMessages = allMessages.map((msg) => {
			if (msg.role === "user" && Array.isArray(msg.content)) {
				return {
					...msg,
					content: msg.content.map((block: any) =>
						block.type === "image" ? { type: "text", text: "[Image attached by user]" } : block
					),
				};
			}
			return msg;
		});

		// @ts-ignore - pi-coding-agent typings
		const conversationText = serializeConversation(convertToLlm(textOnlyMessages));

		const previousContext = previousSummary
			? `\n<previous_memory>\n${previousSummary}\n</previous_memory>\n`
			: "";

		const summaryMessages = [
			{
				role: "user" as const,
				content: [
					{
						type: "text" as const,
						text: `${SESSION_MEMORY_PROMPT}${previousContext}
Please provide the updated Session Memory based on this new conversation segment:
<conversation>
${conversationText}
</conversation>`,
					},
				],
				timestamp: Date.now(),
			},
		];

		try {
			ctx.ui.notify(
				`Generating Session Memory (${tokensBefore.toLocaleString()} tokens)...`,
				"info",
			);

			const response = await complete(
				model,
				{ messages: summaryMessages },
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					maxTokens: 8192,
					signal,
				},
			);

			let summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			if (!summary) {
				if (!signal.aborted) ctx.ui.notify("Session Memory was empty, falling back", "warning");
				return;
			}

			ctx.ui.notify("Session Memory updated", "success");

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!signal.aborted) ctx.ui.notify(`Session Memory failed: ${message}`, "error");
			return;
		}
	});
}
