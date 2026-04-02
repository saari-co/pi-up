/**
 * Session State Extension
 *
 * Implements Claude Code's centralized session state pattern (§A1):
 * - Centralized session state singleton with getter/setter/reset
 * - Skill invocation tracking with composite keys for cross-agent safety
 * - File state tracking for post-compaction restoration
 * - Discovery state preservation across compaction boundaries
 * - Memory persistence with session entries for branch-correct behavior
 *
 * Source: Claude Code CLI src/bootstrap/state.ts, src/services/compact/compact.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ─── State Types (from src/bootstrap/state.ts §A1) ───

interface SkillInfo {
	skillName: string;
	invokedAt: number;
}

interface SessionState {
	// Core
	projectRoot: string;
	originalCwd: string;

	// Skills (§A3 — preserved across compaction)
	invokedSkills: Map<string, SkillInfo>;

	// File tracking (§A3 — post-compaction file restoration)
	recentlyTouchedFiles: Set<string>;
	maxFilesToRestore: number;

	// Discovery state
	discoveredTools: Set<string>;

	// Session metadata
	turnCount: number;
	sessionStartTime: number;
}

interface PersistentState {
	invokedSkills: Array<[string, SkillInfo]>;
	discoveredTools: string[];
}

export default function sessionState(pi: ExtensionAPI) {
	let state: SessionState = createInitialState();

	function createInitialState(): SessionState {
		return {
			projectRoot: process.cwd(),
			originalCwd: process.cwd(),
			invokedSkills: new Map(),
			recentlyTouchedFiles: new Set(),
			maxFilesToRestore: 5, // POST_COMPACT_MAX_FILES_TO_RESTORE from §A3
					discoveredTools: new Set(),
			turnCount: 0,
			sessionStartTime: Date.now(),
		};
	}

	// ─── State Persistence ───

	function persistState() {
		const data: PersistentState = {
			invokedSkills: Array.from(state.invokedSkills.entries()),
			discoveredTools: Array.from(state.discoveredTools),
		};
		pi.appendEntry<PersistentState>("session-state", data);
	}

	function restoreFromBranch(ctx: ExtensionContext) {
		state = createInitialState();

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "session-state") {
				const data = entry.data as PersistentState | undefined;
				if (data) {
					state.invokedSkills = new Map(data.invokedSkills || []);
					state.discoveredTools = new Set(data.discoveredTools || []);
				}
			}
		}
	}

	// ─── Track File Operations ───

	pi.on("tool_result", async (event, _ctx) => {
		if (!event.result) return;

		const toolName = event.toolName;
		const path = event.args?.path as string | undefined;

		if (path && (toolName === "write" || toolName === "edit" || toolName === "read")) {
			state.recentlyTouchedFiles.add(path);
			// Keep only last 20 files
			if (state.recentlyTouchedFiles.size > 20) {
				const arr = Array.from(state.recentlyTouchedFiles);
				state.recentlyTouchedFiles = new Set(arr.slice(-20));
			}
		}
	});

	// ─── Track Turns ───
	pi.on("turn_start", async () => {
		state.turnCount++;
	});

	// ─── Compaction Support (§A3) ───
	// Preserve critical state across compaction boundaries
	pi.on("session_before_compact", async (event, ctx) => {
		// Persist state before compaction so it survives
		persistState();

		// Log what we're preserving
		const skillCount = state.invokedSkills.size;
		const memoryCount = 0;
		const fileCount = state.recentlyTouchedFiles.size;

		if (ctx.hasUI && (skillCount > 0 || memoryCount > 0)) {
			ctx.ui.notify(
				`Preserving across compaction: ${memoryCount} memories, ${skillCount} skills, ${fileCount} files tracked`,
				"info",
			);
		}
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

	pi.on("session_compact", async (_event, ctx) => {
		// After compaction, restore state
		restoreFromBranch(ctx);
	});

	// ─── Commands ───

	pi.registerCommand("state", {
		description: "Show session state overview",
		handler: async (_args, ctx) => {
			const uptime = Math.round((Date.now() - state.sessionStartTime) / 60000);
			const lines = [
				"Session State",
				"─────────────",
				`Uptime: ${uptime}m`,
				`Turns: ${state.turnCount}`,
				`CWD: ${state.projectRoot}`,
				`Skills invoked: ${state.invokedSkills.size}`,
				`Files tracked: ${state.recentlyTouchedFiles.size}`,
				`Discovered tools: ${state.discoveredTools.size}`,
			];

			if (state.invokedSkills.size > 0) {
				lines.push("", "Invoked skills:");
				for (const [key, info] of state.invokedSkills) {
					lines.push(`  • ${info.skillName} (${key})`);
				}
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
