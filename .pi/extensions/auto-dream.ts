/**
 * AutoDream Memory Consolidation Extension
 *
 * Background memory consolidation inspired by Claude Code's services/autoDream/.
 * On session start, checks time and session gates to decide if consolidation is needed.
 * If gates pass, injects a consolidation prompt that walks through 4 phases:
 *   Phase 1: Orient — ls memory dir, read index
 *   Phase 2: Gather — grep session transcripts for new signal
 *   Phase 3: Consolidate — write/update memory files, merge duplicates, fix dates
 *   Phase 4: Prune — keep index under 25KB
 *
 * Registers /dream command for manual consolidation runs.
 * Writes timestamp to .pi/dream-last-run on completion via agent_end hook.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const MEMORY_ROOT = ".pi/memories/";
const TIMESTAMP_FILE = ".pi/dream-last-run";
const HOURS_THRESHOLD = 24;
const MIN_SESSIONS_SINCE = 3;

function buildConsolidationPrompt(memoryRoot: string, transcriptDir: string): string {
	return `You are performing a background memory consolidation pass. Follow these 4 phases exactly:

## Phase 1: Orient
- List all files in \`${memoryRoot}\` to understand current memory state.
- Read \`${memoryRoot}index.md\` if it exists to see the memory index.
- If the memory directory doesn't exist, create it with an empty \`index.md\`.

## Phase 2: Gather
- Search session transcripts in \`${transcriptDir}\` for new signals:
  - User corrections ("don't", "instead", "actually", "I prefer")
  - Explicit preferences and project conventions
  - Discovered facts about the codebase (languages, frameworks, patterns)
  - Recurring themes across multiple sessions
- Focus on transcripts newer than the last consolidation run.

## Phase 3: Consolidate
- For each new signal found:
  - If a related memory file already exists, update it (merge, don't duplicate).
  - If it's genuinely new, create a new memory file in \`${memoryRoot}\`.
  - Use descriptive filenames like \`user-pref-testing.md\`, \`project-stack.md\`.
  - Each memory file should have a clear title, date, and content.
- Update \`${memoryRoot}index.md\` to reference all memory files with one-line summaries.
- Fix any stale dates or duplicated entries found during the scan.

## Phase 4: Prune
- Check the total size of \`${memoryRoot}index.md\`.
- If it exceeds 25KB, consolidate related entries and remove low-value ones.
- Merge memories that overlap significantly.
- Remove memories that are no longer relevant (superseded corrections, old preferences).

After completing all phases, output a brief summary of what changed.`;
}

async function readTimestamp(pi: ExtensionAPI): Promise<Date | null> {
	try {
		const result = await pi.exec("cat", [TIMESTAMP_FILE]);
		if (result.code === 0 && result.stdout.trim()) {
			const ts = new Date(result.stdout.trim());
			return isNaN(ts.getTime()) ? null : ts;
		}
	} catch {
		// File doesn't exist yet
	}
	return null;
}

async function writeTimestamp(pi: ExtensionAPI): Promise<void> {
	await pi.exec("mkdir", ["-p", ".pi"]);
	await pi.exec("bash", ["-c", `echo "${new Date().toISOString()}" > ${TIMESTAMP_FILE}`]);
}

async function countRecentSessions(pi: ExtensionAPI, since: Date): Promise<number> {
	// Look for session files newer than the last run
	const sinceISO = since.toISOString();
	const result = await pi.exec("bash", [
		"-c",
		`find .pi/sessions -type f -newer ${TIMESTAMP_FILE} 2>/dev/null | wc -l`,
	]);
	if (result.code === 0) {
		return parseInt(result.stdout.trim(), 10) || 0;
	}
	return 0;
}

async function getTranscriptDir(pi: ExtensionAPI): Promise<string> {
	// Use pi's session storage directory for transcripts
	const result = await pi.exec("bash", ["-c", `ls -d .pi/sessions 2>/dev/null || echo ".pi/sessions"`]);
	return result.stdout.trim() || ".pi/sessions";
}

async function shouldConsolidate(pi: ExtensionAPI): Promise<boolean> {
	// Time gate: check hours since last run
	const lastRun = await readTimestamp(pi);
	if (lastRun) {
		const hoursSince = (Date.now() - lastRun.getTime()) / (1000 * 60 * 60);
		if (hoursSince < HOURS_THRESHOLD) {
			return false;
		}
	}
	// If no timestamp file exists, first run — check session gate only

	// Session gate: need at least MIN_SESSIONS_SINCE new sessions
	if (lastRun) {
		const recentCount = await countRecentSessions(pi, lastRun);
		if (recentCount < MIN_SESSIONS_SINCE) {
			return false;
		}
	} else {
		// No prior run — check if there are any sessions at all
		const result = await pi.exec("bash", ["-c", `find .pi/sessions -type f 2>/dev/null | wc -l`]);
		const total = parseInt(result.stdout.trim(), 10) || 0;
		if (total < MIN_SESSIONS_SINCE) {
			return false;
		}
	}

	return true;
}

async function triggerConsolidation(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const transcriptDir = await getTranscriptDir(pi);
	const prompt = buildConsolidationPrompt(MEMORY_ROOT, transcriptDir);
	pi.sendUserMessage(prompt);
	if (ctx.hasUI) {
		ctx.ui.notify("AutoDream: Memory consolidation triggered");
	}
}

let dreamTriggered = false;

export default function autoDream(pi: ExtensionAPI) {
	// Check consolidation on session start
	pi.on("session_start", async (ctx: ExtensionContext) => {
		dreamTriggered = false;
		const needed = await shouldConsolidate(pi);
		if (needed) {
			dreamTriggered = true;
			await triggerConsolidation(pi, ctx);
		}
	});

	// Write timestamp when agent finishes (if dream was triggered)
	pi.on("agent_end", async (_ctx: ExtensionContext) => {
		if (dreamTriggered) {
			await writeTimestamp(pi);
			dreamTriggered = false;
		}
	});

	// /dream command — force manual consolidation
	pi.registerCommand("dream", {
		description: "Force a memory consolidation run (AutoDream)",
		args: [],
		run: async (ctx: ExtensionContext, _args: string[]) => {
			dreamTriggered = true;
			await triggerConsolidation(pi, ctx);
			return "Memory consolidation prompt sent. The agent will now consolidate memories.";
		},
	});
}
