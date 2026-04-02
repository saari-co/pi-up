/**
 * Ultraplan Extension
 *
 * Detects "plan" keyword at the start of user input and transforms it
 * into a plan-mode prompt that restricts the agent to read-only tools.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PLAN_PREFIX =
	"You are in PLAN MODE. Analyze the following request and create a detailed, numbered execution plan. " +
	"Do NOT execute any tools that modify files. Only use read-only tools (read, grep, find, ls, bash for read-only commands). " +
	'Present your plan for approval. When I say "execute" or "go", switch to execution mode and implement the plan step by step.\n\nRequest: ';

function toPlanPrompt(text: string): string {
	return PLAN_PREFIX + text;
}

export default function ultraplan(pi: ExtensionAPI) {
	pi.on("input", (_ctx, ev) => {
		const text = ev.text.trim();
		let body: string | null = null;

		if (text.toLowerCase().startsWith("plan ")) {
			body = text.slice(5).trim();
		} else if (text.toLowerCase().startsWith("plan:")) {
			body = text.slice(5).trim();
		}

		if (body) {
			return { action: "transform" as const, text: toPlanPrompt(body) };
		}
	});

	pi.registerCommand("ultraplan", {
		description: "Enter plan mode — analyze a request and produce a numbered execution plan without modifying files",
		execute: (_ctx, args) => {
			const body = args.trim();
			if (!body) return "Usage: /ultraplan <request>";
			return { action: "transform" as const, text: toPlanPrompt(body) };
		},
	});
}
