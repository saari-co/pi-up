/**
 * Custom Compaction Extension
 *
 * Hooks session_before_compact to generate a 9-section structured summary
 * modeled after Claude Code's compaction prompt (services/compact/prompt.ts).
 *
 * Sections:
 *   1) Primary Request and Intent
 *   2) Key Technical Concepts
 *   3) Files and Code Sections (with code snippets)
 *   4) Errors and Fixes (with user feedback)
 *   5) Problem Solving
 *   6) All User Messages (verbatim, non-tool-result)
 *   7) Pending Tasks
 *   8) Current Work (precise description)
 *   9) Optional Next Step (with direct quotes)
 *
 * Uses an <analysis> scratchpad block that gets stripped from the final summary.
 * Uses the current conversation model for summarization.
 */

import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";

const COMPACTION_SYSTEM_PROMPT = `You are a conversation compactor. Your job is to produce a structured summary of a coding conversation that preserves ALL information needed to continue working effectively.

First, use an <analysis> block as a scratchpad to think through each section. This block will be stripped from the final output — use it freely.

Then produce the summary with exactly these 9 sections in markdown:

## 1. Primary Request and Intent
What the user originally asked for and what they are trying to accomplish. Include the high-level goal and any constraints or preferences they stated.

## 2. Key Technical Concepts
Technologies, frameworks, patterns, algorithms, or domain concepts that are central to this conversation. Include version numbers, configuration details, and architectural decisions.

## 3. Files and Code Sections
List every file that was read, created, or modified. For each file include:
- Full path
- What was done (read/created/edited)
- Key code snippets that are relevant to ongoing work (use fenced code blocks)
- Current state of the file if it was modified

## 4. Errors and Fixes
Every error encountered and how it was resolved. Include:
- The exact error message or symptoms
- Root cause analysis
- The fix applied
- Any user feedback about the fix (quote verbatim)

## 5. Problem Solving
Document the reasoning chain: approaches considered, why some were rejected, what was tried, and what worked. Include dead ends to avoid repeating them.

## 6. All User Messages
Reproduce ALL user messages verbatim (excluding tool results). These contain intent, corrections, and preferences that must not be lost. Quote each message exactly.

## 7. Pending Tasks
List any tasks that were discussed but not yet completed. Include tasks the user mentioned wanting to do later and any known follow-ups.

## 8. Current Work
Precisely describe what is being worked on RIGHT NOW. Include:
- The specific task in progress
- What has been done so far
- What remains to be done
- Any files currently being modified

## 9. Optional Next Step
If the conversation suggests a clear next action, state it with direct quotes from the user or assistant that indicate what should happen next.

Rules:
- Be thorough — this summary REPLACES the entire conversation history
- Preserve exact file paths, code snippets, error messages, and commands
- Quote user messages verbatim in section 6
- Include code snippets in fenced blocks with language tags
- If a section has no content, write "None." and move on
- Do NOT invent or hallucinate information not present in the conversation`;

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		const branch = ctx.sessionManager.getBranch();
		const compactions = branch.filter(e => e.type === "compaction_summary").length;
		
		if (compactions > 0) {
			// Skill Dehydration (#41)
			// Truncate <available_skills> listing to save ~4k tokens per turn post-compaction
			const sys = event.systemPrompt;
			const skillsStart = sys.indexOf("<available_skills>");
			const skillsEnd = sys.indexOf("</available_skills>");
			
			if (skillsStart !== -1 && skillsEnd !== -1) {
				const before = sys.substring(0, skillsStart);
				const after = sys.substring(skillsEnd + "</available_skills>".length);
				
				const dehydratedSkills = "<available_skills>\n[Skills listing dehydrated post-compaction to save tokens. Use tool_search or reference your previously used skills.]\n</available_skills>";
				
				return {
					systemPrompt: before + dehydratedSkills + after
				};
			}
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		ctx.ui.notify("Custom compaction: generating structured 9-section summary...", "info");

		const { preparation, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;

		// Use the current conversation model
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

		// PTL Lossy Escape Hatch (#42)
		// If tokens exceed a reasonable fallback limit, explicitly slice the oldest user/assistant blocks.
		const PTL_THRESHOLD = 180000;
		if (tokensBefore > PTL_THRESHOLD) {
			const trimCount = Math.floor(messagesToSummarize.length / 3);
			messagesToSummarize.splice(0, trimCount);
			ctx.ui.notify(`[PTL Escape Hatch] Truncated ${trimCount} messages for compaction retry`, "warning");
			
			// Inject the truncation marker into the new oldest message if it's text
			const oldestMessage = messagesToSummarize[0];
			if (oldestMessage && typeof oldestMessage.content === "string") {
				oldestMessage.content = "[earlier conversation truncated for compaction retry]\n\n" + oldestMessage.content;
			}
		}

		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
		
		// Image Stripper (#8)
		const textOnlyMessages = allMessages.map((msg) => {
			if (msg.role === "user" && Array.isArray(msg.content)) {
				return {
					...msg,
					content: msg.content.map((block: any) =>
						block.type === "image" ? { type: "text", text: "[Image attached by user removed for compaction]" } : block
					),
				};
			}
			return msg;
		});

		// @ts-ignore
		const conversationText = serializeConversation(convertToLlm(textOnlyMessages));

		const previousContext = previousSummary
			? `\n\nA previous compaction summary exists. Incorporate its information where relevant:\n<previous_summary>\n${previousSummary}\n</previous_summary>`
			: "";

		const summaryMessages = [
			{
				role: "user" as const,
				content: [
					{
						type: "text" as const,
						text: `${COMPACTION_SYSTEM_PROMPT}${previousContext}

Produce the 9-section structured summary for this conversation. Start with <analysis> for your scratchpad, then output the final sections.

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
				`Custom compaction: summarizing ${allMessages.length} messages (${tokensBefore.toLocaleString()} tokens) with ${model.id}...`,
				"info",
			);

			const response = await complete(
				model,
				{ messages: summaryMessages },
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					maxTokens: 12_288,
					signal,
				},
			);

			let summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			// Strip <analysis>...</analysis> scratchpad blocks
			summary = summary.replace(/<analysis>[\s\S]*?<\/analysis>/g, "").trim();

			if (!summary) {
				if (!signal.aborted) ctx.ui.notify("Compaction summary was empty, falling back to default", "warning");
				return;
			}

			ctx.ui.notify("Custom compaction complete", "info");

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!signal.aborted) ctx.ui.notify(`Custom compaction failed: ${message}`, "error");
			return;
		}
	});
}
