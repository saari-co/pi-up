/**
 * AutoDream — Background Memory Extraction & Consolidation
 *
 * Modeled after Claude Code's extractMemories + autoDream:
 *
 * 1. **Extract (per-turn):** After each agent turn, spawns a background
 *    memory-extractor subagent (separate pi process) that analyzes the
 *    last N messages and writes durable memories to .pi/memories/.
 *
 * 2. **Consolidate (/dream):** On-demand deep consolidation that reads
 *    session transcripts and reorganizes the memory directory.
 *
 * The subagent pattern matches Claude Code's runForkedAgent — a separate
 * pi process in JSON mode with --no-session, so it has isolated context
 * and doesn't pollute the main conversation.
 *
 * Source: services/extractMemories/extractMemories.ts, services/autoDream/
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Config ───

const MEMORY_DIR = ".pi/memories";
const INDEX_FILE = "index.md";
const TIMESTAMP_FILE = ".pi/dream-last-run";
const EXTRACT_COOLDOWN_MS = 60_000; // Min 1 min between extractions
const CONSOLIDATION_HOURS = 24;
const MIN_SESSIONS_FOR_DREAM = 3;
const MAX_RECENT_MESSAGES = 30;

// ─── Subagent runner ───

function getPiCommand(): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript] };
	}
	return { command: "pi", args: [] };
}

/**
 * Spawn a background pi subagent process that runs a prompt and exits.
 * Fire-and-forget — we don't wait for completion or read output.
 * Matches Claude Code's pattern: forked agent with skipTranscript.
 */
function spawnSubagent(prompt: string, cwd: string): void {
	const pi = getPiCommand();
	const args = [...pi.args, "--mode", "json", "-p", "--no-session", prompt];

	const proc = spawn(pi.command, args, {
		cwd,
		shell: false,
		stdio: ["ignore", "ignore", "ignore"],
		detached: true,
	});

	// Unref so the child doesn't prevent the parent from exiting
	proc.unref();
}

// ─── Memory directory helpers ───

function ensureMemoryDir(cwd: string): string {
	const dir = path.join(cwd, MEMORY_DIR);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function readMemoryManifest(cwd: string): string {
	const dir = path.join(cwd, MEMORY_DIR);
	if (!fs.existsSync(dir)) return "(empty — no memories yet)";

	try {
		const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
		if (files.length === 0) return "(empty — no memories yet)";

		const manifest: string[] = [];
		for (const file of files) {
			const content = fs.readFileSync(path.join(dir, file), "utf8");
			const firstLine = content.split("\n").find((l) => l.startsWith("# ")) || file;
			manifest.push(`- ${file}: ${firstLine.replace(/^#\s*/, "").slice(0, 80)}`);
		}
		return manifest.join("\n");
	} catch {
		return "(could not read memory directory)";
	}
}

// ─── Extract: runs after each agent turn ───

function buildExtractionPrompt(
	recentMessages: string,
	memoryDir: string,
	existingMemories: string,
): string {
	return `You are the memory extraction subagent. Analyze the recent conversation below and save any durable memories.

## Memory directory
${memoryDir}/
${existingMemories}

## What to save
- **user** — Personal preferences, communication style, workflow habits
- **feedback** — Corrections ("don't do X"), rejected approaches, style steering
- **project** — Tech stack, conventions, build commands, architecture decisions
- **reference** — Server addresses, API endpoints, team roles

## What NOT to save
- Transient task state, code patterns derivable from codebase, info already in AGENTS.md

## How to save
1. Read existing memory files first to avoid duplicates.
2. Write/update files in ${memoryDir}/ with frontmatter: type, date.
3. Update ${memoryDir}/${INDEX_FILE} with one-line pointers.
4. If nothing worth saving, just output "No new memories." and stop.
5. Work in 2 turns max: read existing → write updates.

## Recent conversation to analyze
${recentMessages}`;
}

function serializeRecentEntries(entries: any[], maxEntries: number): string {
	const recent = entries.slice(-maxEntries);
	const lines: string[] = [];

	for (const entry of recent) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg) continue;

		if (msg.role === "user") {
			let text = "";
			if (typeof msg.content === "string") text = msg.content;
			else if (Array.isArray(msg.content)) {
				for (const b of msg.content) {
					if (b.type === "text") { text += (b as any).text + "\n"; }
				}
			}
			if (text.trim()) {
				lines.push(`[User]: ${text.trim().slice(0, 500)}`);
			}
		} else if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const b of msg.content) {
				if (b.type === "text") {
					lines.push(`[Assistant]: ${((b as any).text || "").slice(0, 500)}`);
				}
			}
		}
	}

	return lines.join("\n\n");
}

// ─── Consolidation: deep review of sessions + memory reorg ───

function buildConsolidationPrompt(memoryDir: string, sessionDir: string): string {
	return `# Dream: Memory Consolidation

You are performing a dream — a reflective pass over your memory files. Synthesize what you've learned recently into durable, well-organized memories.

Memory directory: ${memoryDir}/

## Phase 1 — Orient
- List all files in the memory directory.
- Read ${INDEX_FILE} to understand the current index.
- Skim existing topic files so you improve them rather than creating duplicates.

## Phase 2 — Gather recent signal
Search session transcripts in ${sessionDir}/ for new information:
- User corrections and preferences
- Project conventions and architecture facts
- Recurring patterns across sessions
Use grep with narrow terms. Don't read whole transcript files.

## Phase 3 — Consolidate
- Merge new signal into existing topic files (don't duplicate).
- Convert relative dates to absolute dates.
- Delete contradicted facts.
- Create new files only for genuinely new topics.

## Phase 4 — Prune and index
- Update ${INDEX_FILE}: one line per entry, under ~150 chars each.
- Keep under 200 lines and 25KB.
- Remove stale pointers, resolve contradictions.

Return a brief summary of what you consolidated, updated, or pruned.`;
}

function findSessionDir(): string | null {
	const home = process.env.HOME || "";
	const baseDir = path.join(home, ".pi", "agent", "sessions");
	if (!fs.existsSync(baseDir)) return null;

	try {
		const dirs = fs.readdirSync(baseDir);
		// Find dir matching current project
		const cwd = process.cwd();
		for (const d of dirs) {
			const decoded = d.replace(/--/g, "/");
			if (cwd.includes(decoded.slice(1, 30))) {
				return path.join(baseDir, d);
			}
		}
		return dirs.length > 0 ? path.join(baseDir, dirs[dirs.length - 1]) : null;
	} catch {
		return null;
	}
}

function shouldConsolidate(cwd: string): boolean {
	const tsFile = path.join(cwd, TIMESTAMP_FILE);
	try {
		const content = fs.readFileSync(tsFile, "utf8").trim();
		const lastRun = new Date(content);
		if (isNaN(lastRun.getTime())) return true;
		const hoursSince = (Date.now() - lastRun.getTime()) / 3_600_000;
		if (hoursSince < CONSOLIDATION_HOURS) return false;
	} catch {
		// No timestamp = never run
	}

	const sessionDir = findSessionDir();
	if (!sessionDir) return false;
	try {
		const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
		return files.length >= MIN_SESSIONS_FOR_DREAM;
	} catch {
		return false;
	}
}

function writeTimestamp(cwd: string): void {
	const dir = path.dirname(path.join(cwd, TIMESTAMP_FILE));
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(cwd, TIMESTAMP_FILE), new Date().toISOString() + "\n");
}

// ─── Extension ───

export default function autoDream(pi: ExtensionAPI) {
	let lastExtractionTime = 0;
	let extractionEnabled = true;

	// After each agent turn, spawn a background extraction subagent
	pi.on("agent_end", async (event, ctx) => {
		if (!extractionEnabled) return;

		// Cooldown: don't extract more than once per minute
		const now = Date.now();
		if (now - lastExtractionTime < EXTRACT_COOLDOWN_MS) return;
		lastExtractionTime = now;

		// Get recent messages for the extraction prompt
		const entries = ctx.sessionManager.getEntries();
		if (entries.length < 4) return; // Need meaningful conversation

		const recentText = serializeRecentEntries(entries, MAX_RECENT_MESSAGES);
		if (recentText.length < 100) return; // Too little content

		const memDir = ensureMemoryDir(ctx.cwd);
		const manifest = readMemoryManifest(ctx.cwd);
		const prompt = buildExtractionPrompt(recentText, memDir, manifest);

		// Fire-and-forget: spawn a background pi process
		spawnSubagent(prompt, ctx.cwd);
	});

	// On session start, check if full consolidation is needed
	pi.on("session_start", async (_event, ctx) => {
		if (shouldConsolidate(ctx.cwd)) {
			ctx.ui.notify("AutoDream: Memory consolidation available. Run /dream to consolidate.", "info");
		}
	});

	// /dream command — full consolidation via subagent
	pi.registerCommand("dream", {
		description: "Run deep memory consolidation — review sessions and reorganize memories",
		handler: async (_args, ctx) => {
			const sessionDir = findSessionDir();
			if (!sessionDir) {
				ctx.ui.notify("No session directory found.", "warning");
				return;
			}

			const memDir = ensureMemoryDir(ctx.cwd);
			const prompt = buildConsolidationPrompt(memDir, sessionDir);

			// For consolidation, we run it in the foreground so user sees progress
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			writeTimestamp(ctx.cwd);
			ctx.ui.notify("Dream: Consolidation started.", "info");
		},
	});

	// /dream-bg command — consolidation via background subagent
	pi.registerCommand("dream-bg", {
		description: "Run memory consolidation silently in the background",
		handler: async (_args, ctx) => {
			const sessionDir = findSessionDir();
			if (!sessionDir) {
				ctx.ui.notify("No session directory found.", "warning");
				return;
			}

			const memDir = ensureMemoryDir(ctx.cwd);
			const prompt = buildConsolidationPrompt(memDir, sessionDir);

			spawnSubagent(prompt, ctx.cwd);
			writeTimestamp(ctx.cwd);
			ctx.ui.notify("Dream: Background consolidation spawned.", "info");
		},
	});

	// /memories command — show current memory state
	pi.registerCommand("memories", {
		description: "Show current persistent memories",
		handler: async (_args, ctx) => {
			const manifest = readMemoryManifest(ctx.cwd);
			ctx.ui.notify("Persistent Memories\n" + "─".repeat(20) + "\n" + manifest, "info");
		},
	});

	// /dream-off and /dream-on — toggle extraction
	pi.registerCommand("dream-off", {
		description: "Disable automatic memory extraction",
		handler: async (_args, ctx) => {
			extractionEnabled = false;
			ctx.ui.notify("AutoDream: Extraction disabled for this session.", "info");
		},
	});

	pi.registerCommand("dream-on", {
		description: "Enable automatic memory extraction",
		handler: async (_args, ctx) => {
			extractionEnabled = true;
			ctx.ui.notify("AutoDream: Extraction enabled.", "info");
		},
	});
}
