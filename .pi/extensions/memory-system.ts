/**
 * Memory System Extension
 *
 * Implements Claude Code's persistent memory system from:
 * - src/memdir/memoryTypes.ts — 4-type taxonomy (user, feedback, project, reference)
 * - src/services/extractMemories/prompts.ts — auto-extraction patterns
 * - src/utils/memory/types.ts — memory storage types
 * - src/constants/prompts.ts — memory correction hints on cancellation
 *
 * Provides:
 * - Automatic correction detection when tool calls are blocked
 * - Memory injection into agent context via before_agent_start
 * - /remember command for manual memory creation
 * - /memories command to view all session memories
 * - Persistent storage via session entries (branch-correct)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ─── Memory Types (from src/memdir/memoryTypes.ts) ───

const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
type MemoryType = (typeof MEMORY_TYPES)[number];

interface Memory {
	id: string;
	type: MemoryType;
	title: string;
	content: string;
	timestamp: number;
	source: "auto-correction" | "auto-preference" | "manual" | "tool-rejection";
}

interface MemoryStore {
	memories: Memory[];
	nextId: number;
}

// ─── Correction Detection Patterns ───
// From Claude Code: when user cancels or rejects a tool call, detect WHY

const CORRECTION_KEYWORDS = [
	// Direct negation
	"no", "don't", "stop", "not that", "wrong", "incorrect", "nope",
	// Redirection
	"instead", "rather", "actually", "use this", "try this",
	// Preference
	"I prefer", "always use", "never use", "please don't",
];

export default function memorySystem(pi: ExtensionAPI) {
	let store: MemoryStore = { memories: [], nextId: 1 };
	let pendingCorrections: Array<{ toolName: string; input: unknown; timestamp: number }> = [];

	// ─── State Management ───

	function persist() {
		pi.appendEntry<MemoryStore>("memory-store", store);
	}

	function restoreFromBranch(ctx: ExtensionContext) {
		store = { memories: [], nextId: 1 };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "memory-store") {
				const data = entry.data as MemoryStore | undefined;
				if (data) {
					store = data;
				}
			}
		}
	}

	function addMemory(type: MemoryType, title: string, content: string, source: Memory["source"]) {
		// Deduplicate by title
		store.memories = store.memories.filter((m) => m.title !== title);

		store.memories.push({
			id: `mem-${store.nextId++}`,
			type,
			title,
			content,
			timestamp: Date.now(),
			source,
		});

		// Cap at 100 memories
		if (store.memories.length > 100) {
			store.memories = store.memories.slice(-100);
		}

		persist();
	}

	// ─── Auto-correction Detection ───
	// From Claude Code §1.5: "If the user corrected you or expressed a preference,
	// save it to memory for future reference."

	pi.on("tool_call", async (event, _ctx) => {
		// Track tool calls that get blocked — the next user message may explain why
		return undefined;
	});

	// When a tool call is blocked, record it as a pending correction
	pi.on("tool_call", async (event, _ctx) => {
		// This is a second handler — if the first handler (claude-core) blocks,
		// this won't run. We track via tool_result instead.
		return undefined;
	});

	// Track blocked tool results to detect corrections
	pi.on("tool_result", async (event, _ctx) => {
		const result = event.result;
		if (!result?.content) return;

		for (const block of result.content) {
			if (block.type !== "text") continue;
			// Check if this is a blocked/error result
			if (block.text.includes("block") || block.text.includes("denied") || block.text.includes("Blocked")) {
				pendingCorrections.push({
					toolName: event.toolName,
					input: event.args,
					timestamp: Date.now(),
				});
				// Keep only last 5 pending
				if (pendingCorrections.length > 5) {
					pendingCorrections = pendingCorrections.slice(-5);
				}
			}
		}
	});

	// When user sends a message after a rejection, check if it's a correction
	pi.on("input", async (event, _ctx) => {
		if (pendingCorrections.length === 0) return { action: "continue" as const };

		const text = event.text.toLowerCase();
		const isCorrection = CORRECTION_KEYWORDS.some((kw) => text.includes(kw));

		if (isCorrection && pendingCorrections.length > 0) {
			const lastRejection = pendingCorrections[pendingCorrections.length - 1];
			addMemory(
				"feedback",
				`correction-${lastRejection.toolName}-${Date.now()}`,
				`User corrected ${lastRejection.toolName} usage: "${event.text.slice(0, 200)}"`,
				"auto-correction",
			);
			pendingCorrections = [];
		}

		return { action: "continue" as const };
	});

	// ─── Memory Injection (§2.3 Context Injection Pattern) ───

	pi.on("before_agent_start", async (_event, _ctx) => {
		if (store.memories.length === 0) return;

		// Group memories by type (Claude Code's taxonomy)
		const byType = new Map<MemoryType, Memory[]>();
		for (const mem of store.memories) {
			const list = byType.get(mem.type) || [];
			list.push(mem);
			byType.set(mem.type, list);
		}

		const sections: string[] = [];

		// Feedback (corrections) are highest priority
		const feedback = byType.get("feedback") || [];
		if (feedback.length > 0) {
			sections.push("## Corrections & Preferences");
			for (const m of feedback.slice(-10)) {
				sections.push(`- ${m.content}`);
			}
		}

		// User context
		const user = byType.get("user") || [];
		if (user.length > 0) {
			sections.push("## User Context");
			for (const m of user.slice(-5)) {
				sections.push(`- ${m.title}: ${m.content}`);
			}
		}

		// Project context
		const project = byType.get("project") || [];
		if (project.length > 0) {
			sections.push("## Project Context");
			for (const m of project.slice(-5)) {
				sections.push(`- ${m.title}: ${m.content}`);
			}
		}

		// References
		const reference = byType.get("reference") || [];
		if (reference.length > 0) {
			sections.push("## References");
			for (const m of reference.slice(-5)) {
				sections.push(`- ${m.title}: ${m.content}`);
			}
		}

		if (sections.length === 0) return;

		return {
			message: {
				customType: "memory-context",
				content: `<system-reminder>Session memory (${store.memories.length} entries):\n${sections.join("\n")}\n\nIMPORTANT: This context may or may not be relevant to your tasks. Do not respond to it unless it is highly relevant.</system-reminder>`,
				display: false,
			},
		};
	});

	// ─── Session Lifecycle ───

	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	// ─── Commands ───

	pi.registerCommand("remember", {
		description: "Save a memory. Usage: /remember [type:user|feedback|project|reference] <title>: <content>",
		handler: async (args, ctx) => {
			if (!args) {
				ctx.ui.notify(
					"Usage: /remember [type] <title>: <content>\n" +
						"Types: user, feedback, project, reference\n" +
						"Example: /remember feedback prefer-tabs: Use tabs not spaces for indentation",
					"info",
				);
				return;
			}

			// Parse type prefix
			let type: MemoryType = "feedback";
			let rest = args;
			for (const t of MEMORY_TYPES) {
				if (args.startsWith(`${t} `) || args.startsWith(`${t}:`)) {
					type = t;
					rest = args.slice(t.length).trim();
					if (rest.startsWith(":")) rest = rest.slice(1).trim();
					break;
				}
			}

			// Parse title: content
			const colonIdx = rest.indexOf(":");
			if (colonIdx === -1) {
				addMemory(type, rest.trim(), rest.trim(), "manual");
				ctx.ui.notify(`💾 Memory saved (${type}): ${rest.trim().slice(0, 50)}`, "success");
			} else {
				const title = rest.slice(0, colonIdx).trim();
				const content = rest.slice(colonIdx + 1).trim();
				addMemory(type, title, content, "manual");
				ctx.ui.notify(`💾 Memory saved (${type}): ${title}`, "success");
			}
		},
	});

	pi.registerCommand("memories", {
		description: "Show all session memories",
		handler: async (args, ctx) => {
			if (args === "clear") {
				store = { memories: [], nextId: store.nextId };
				persist();
				ctx.ui.notify("All memories cleared.", "info");
				return;
			}

			if (store.memories.length === 0) {
				ctx.ui.notify("No memories stored.\nUse /remember to add one, or they're auto-detected from corrections.", "info");
				return;
			}

			const lines = [`Session Memories (${store.memories.length})`, ""];

			// Group by type
			const byType = new Map<string, Memory[]>();
			for (const m of store.memories) {
				const list = byType.get(m.type) || [];
				list.push(m);
				byType.set(m.type, list);
			}

			const typeEmoji: Record<string, string> = {
				user: "👤",
				feedback: "💬",
				project: "📋",
				reference: "🔗",
			};

			for (const [type, mems] of byType) {
				lines.push(`${typeEmoji[type] || "📝"} ${type.toUpperCase()} (${mems.length})`);
				for (const m of mems) {
					const age = Math.round((Date.now() - m.timestamp) / 60000);
					const ageStr = age < 60 ? `${age}m` : `${Math.round(age / 60)}h`;
					lines.push(`  • [${m.source}] ${m.title}: ${m.content.slice(0, 80)}${m.content.length > 80 ? "..." : ""} (${ageStr} ago)`);
				}
				lines.push("");
			}

			lines.push("Commands: /remember <text> | /memories clear");
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
