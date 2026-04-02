/**
 * AutoDream Memory Consolidation Extension
 *
 * Background memory consolidation inspired by Claude Code's services/autoDream/.
 * On session start, checks time and session gates to decide if consolidation is needed.
 * If gates pass, injects a consolidation prompt as a followUp message.
 *
 * Registers /dream command for manual consolidation runs.
 * Writes timestamp to .pi/dream-last-run on completion.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

const MEMORY_ROOT = ".pi/memories";
const TIMESTAMP_FILE = ".pi/dream-last-run";
const HOURS_THRESHOLD = 24;
const MIN_SESSIONS = 3;

function buildConsolidationPrompt(memoryRoot: string, sessionDir: string): string {
	return `You are performing a background memory consolidation pass. Follow these 4 phases exactly:

## Phase 1: Orient
- List all files in \`${memoryRoot}/\` to understand current memory state.
- Read \`${memoryRoot}/index.md\` if it exists to see the memory index.
- If the memory directory doesn't exist, create it with an empty \`index.md\`.

## Phase 2: Gather
- Search session transcripts in \`${sessionDir}/\` for new signals:
  - User corrections ("don't", "instead", "actually", "I prefer")
  - Explicit preferences and project conventions
  - Discovered facts about the codebase (languages, frameworks, patterns)
  - Recurring themes across multiple sessions
- Use grep with narrow terms, don't read whole files.

## Phase 3: Consolidate
- For each new signal found:
  - If a related memory file already exists, update it (merge, don't duplicate).
  - If it's genuinely new, create a new memory file in \`${memoryRoot}/\`.
  - Use descriptive filenames like \`user-pref-testing.md\`, \`project-stack.md\`.
- Update \`${memoryRoot}/index.md\` to reference all memory files with one-line summaries.
- Convert relative dates to absolute dates.

## Phase 4: Prune
- If \`${memoryRoot}/index.md\` exceeds 25KB, consolidate related entries.
- Merge memories that overlap significantly.
- Remove memories that are superseded or no longer relevant.

After completing all phases, output a brief summary of what changed.`;
}

function readTimestamp(cwd: string): Date | null {
	try {
		const content = fs.readFileSync(path.join(cwd, TIMESTAMP_FILE), "utf8").trim();
		const d = new Date(content);
		return isNaN(d.getTime()) ? null : d;
	} catch {
		return null;
	}
}

function writeTimestamp(cwd: string): void {
	const dir = path.dirname(path.join(cwd, TIMESTAMP_FILE));
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(cwd, TIMESTAMP_FILE), new Date().toISOString() + "\n");
}

function countSessionFiles(sessionBaseDir: string): number {
	try {
		if (!fs.existsSync(sessionBaseDir)) return 0;
		const files = fs.readdirSync(sessionBaseDir);
		return files.filter((f) => f.endsWith(".jsonl")).length;
	} catch {
		return 0;
	}
}

function findSessionDir(): string | null {
	// Pi stores sessions in ~/.pi/agent/sessions/<sanitized-cwd>/
	const homeDir = process.env.HOME || process.env.USERPROFILE || "";
	const baseDir = path.join(homeDir, ".pi", "agent", "sessions");
	if (!fs.existsSync(baseDir)) return null;

	// Find the directory matching current cwd
	const cwd = process.cwd().replace(/\//g, "-").replace(/^-/, "-");
	try {
		const dirs = fs.readdirSync(baseDir);
		for (const d of dirs) {
			if (cwd.includes(d.slice(1, 20)) || d.includes("pi-up")) {
				return path.join(baseDir, d);
			}
		}
		// Fallback: return the most recently modified session dir
		if (dirs.length > 0) {
			return path.join(baseDir, dirs[dirs.length - 1]);
		}
	} catch {
		// ignore
	}
	return baseDir;
}

function shouldConsolidate(cwd: string): boolean {
	const lastRun = readTimestamp(cwd);

	// Time gate
	if (lastRun) {
		const hoursSince = (Date.now() - lastRun.getTime()) / 3_600_000;
		if (hoursSince < HOURS_THRESHOLD) return false;
	}

	// Session gate
	const sessionDir = findSessionDir();
	if (!sessionDir) return false;
	const count = countSessionFiles(sessionDir);
	return count >= MIN_SESSIONS;
}

let dreamTriggeredThisSession = false;

export default function autoDream(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		dreamTriggeredThisSession = false;

		if (shouldConsolidate(ctx.cwd)) {
			dreamTriggeredThisSession = true;
			if (ctx.hasUI) {
				ctx.ui.notify("AutoDream: Memory consolidation needed. Use /dream to run.", "info");
			}
		}
	});

	// Write timestamp after consolidation completes
	pi.on("agent_end", async (_event, ctx) => {
		if (dreamTriggeredThisSession) {
			writeTimestamp(ctx.cwd);
			dreamTriggeredThisSession = false;
		}
	});

	pi.registerCommand("dream", {
		description: "Run memory consolidation — review sessions and update persistent memories",
		handler: async (_args, ctx) => {
			const sessionDir = findSessionDir();
			if (!sessionDir) {
				ctx.ui.notify("No session directory found.", "warning");
				return;
			}

			dreamTriggeredThisSession = true;
			const prompt = buildConsolidationPrompt(
				path.join(ctx.cwd, MEMORY_ROOT),
				sessionDir,
			);
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			ctx.ui.notify("AutoDream: Consolidation prompt queued.", "info");
		},
	});
}
