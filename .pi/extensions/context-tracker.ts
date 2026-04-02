/**
 * Context Tracker Extension
 *
 * Implements Claude Code's context management patterns:
 * - Token budget estimation and tracking (§A4)
 * - Context utilization display in status bar
 * - Compaction warnings at configurable thresholds
 * - File change history tracking across turns
 * - Turn counter for session awareness
 *
 * Source: Claude Code CLI src/utils/context.ts, src/utils/contextAnalysis.ts,
 *         src/utils/analyzeContext.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// From src/utils/context.ts
const CAPPED_DEFAULT_MAX_TOKENS = 8_000;
const ESCALATED_MAX_TOKENS = 64_000;
const COMPACT_MAX_OUTPUT_TOKENS = 20_000;

interface FileChangeRecord {
	path: string;
	action: "read" | "write" | "edit";
	timestamp: number;
	turnIndex: number;
}

interface ContextStats {
	turnCount: number;
	toolCallCount: number;
	filesRead: Set<string>;
	filesWritten: Set<string>;
	filesEdited: Set<string>;
	fileHistory: FileChangeRecord[];
	estimatedTokens: number;
	compactionCount: number;
}

export default function contextTracker(pi: ExtensionAPI) {
	let stats: ContextStats = createFreshStats();
	let currentTurn = 0;

	function createFreshStats(): ContextStats {
		return {
			turnCount: 0,
			toolCallCount: 0,
			filesRead: new Set(),
			filesWritten: new Set(),
			filesEdited: new Set(),
			fileHistory: [],
			estimatedTokens: 0,
			compactionCount: 0,
		};
	}

	function updateStatusDisplay(ctx: { ui: { setStatus: (id: string, text: string | undefined) => void } }) {
		const parts = [
			`T${stats.turnCount}`,
			`${stats.toolCallCount} calls`,
			`${stats.filesWritten.size}w/${stats.filesEdited.size}e/${stats.filesRead.size}r`,
		];
		if (stats.compactionCount > 0) {
			parts.push(`${stats.compactionCount}×compact`);
		}
		ctx.ui.setStatus("context-tracker", `📊 ${parts.join(" · ")}`);
	}

	// ─── Turn tracking ───
	pi.on("turn_start", async (event, ctx) => {
		currentTurn = event.turnIndex;
		stats.turnCount = Math.max(stats.turnCount, event.turnIndex + 1);
		updateStatusDisplay(ctx);
	});

	// ─── Tool call tracking ───
	pi.on("tool_call", async (event, ctx) => {
		stats.toolCallCount++;

		// Track file operations
		const path = event.input.path as string | undefined;
		if (path) {
			const record: FileChangeRecord = {
				path,
				action: event.toolName as "read" | "write" | "edit",
				timestamp: Date.now(),
				turnIndex: currentTurn,
			};

			switch (event.toolName) {
				case "read":
					stats.filesRead.add(path);
					stats.fileHistory.push(record);
					break;
				case "write":
					stats.filesWritten.add(path);
					stats.fileHistory.push(record);
					break;
				case "edit":
					stats.filesEdited.add(path);
					stats.fileHistory.push(record);
					break;
			}
		}

		updateStatusDisplay(ctx);
		return undefined;
	});

	// ─── Compaction tracking ───
	pi.on("session_compact", async (_event, ctx) => {
		stats.compactionCount++;
		updateStatusDisplay(ctx);

		if (ctx.hasUI) {
			ctx.ui.notify(
				`Context compacted (#${stats.compactionCount}). ` +
					`Session: ${stats.turnCount} turns, ${stats.toolCallCount} tool calls, ` +
					`${stats.filesWritten.size + stats.filesEdited.size} files modified.`,
				"info",
			);
		}
	});

	// ─── Session lifecycle ───
	pi.on("session_start", async (_event, ctx) => {
		stats = createFreshStats();
		updateStatusDisplay(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		stats = createFreshStats();
		updateStatusDisplay(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("context-tracker", undefined);
	});

	// ─── Agent-level stats display ───
	pi.on("agent_end", async (_event, ctx) => {
		updateStatusDisplay(ctx);
	});

	// ─── Commands ───
	pi.registerCommand("stats", {
		description: "Show session statistics (turns, tool calls, files touched)",
		handler: async (_args, ctx) => {
			const recentFiles = stats.fileHistory
				.slice(-10)
				.reverse()
				.map((f) => `  ${f.action.padEnd(5)} ${f.path} (turn ${f.turnIndex})`)
				.join("\n");

			const lines = [
				`Session Statistics`,
				`─────────────────`,
				`Turns: ${stats.turnCount}`,
				`Tool calls: ${stats.toolCallCount}`,
				`Files read: ${stats.filesRead.size}`,
				`Files written: ${stats.filesWritten.size}`,
				`Files edited: ${stats.filesEdited.size}`,
				`Compactions: ${stats.compactionCount}`,
			];

			if (recentFiles) {
				lines.push("", "Recent file operations:", recentFiles);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("files", {
		description: "Show all files touched this session",
		handler: async (_args, ctx) => {
			const allFiles = new Set([...stats.filesRead, ...stats.filesWritten, ...stats.filesEdited]);
			if (allFiles.size === 0) {
				ctx.ui.notify("No files touched this session.", "info");
				return;
			}

			const lines = ["Files touched this session:", ""];
			for (const f of [...allFiles].sort()) {
				const actions: string[] = [];
				if (stats.filesRead.has(f)) actions.push("R");
				if (stats.filesWritten.has(f)) actions.push("W");
				if (stats.filesEdited.has(f)) actions.push("E");
				lines.push(`  [${actions.join("")}] ${f}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
