import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ─── Constants (from Claude Code speculation.ts) ───
const SPECULATION_TIMEOUT_MS = 90_000;		// Kill runaway speculations after 90s
const MAX_SPECULATION_TURNS = 20;			// Claude Code: MAX_SPECULATION_TURNS = 20
const MAX_SPECULATION_MESSAGES = 100;		// Claude Code: MAX_SPECULATION_MESSAGES = 100
const OVERLAY_ROOT = "/tmp/pi-speculation";

// Read-only bash commands allowed during speculation (Claude Code canUseTool pattern)
const READONLY_BASH_PREFIXES = [
	"cat ", "head ", "tail ", "grep ", "rg ", "find ", "ls ", "wc ",
	"file ", "stat ", "which ", "echo ", "pwd", "tree ", "du ", "df ",
	"env ", "printenv", "uname", "date", "whoami",
];

// Bash commands that modify state even if they look harmless
const STATE_MODIFYING_PATTERNS = [
	/\bcd\b/, /\bexport\b/, /\bsource\b/, /\bunset\b/, /\balias\b/,
	/\bmkdir\b/, /\btouch\b/, /\brm\b/, /\bmv\b/, /\bcp\b/,
	/\bchmod\b/, /\bchown\b/, /\bln\b/, /\bsed\s+-i/, /\bawk\b.*>/, 
	/>>/, />[^&]/, /\bkill\b/, /\bpkill\b/, /\bnpm\b/, /\byarn\b/,
	/\bgit\s+(add|commit|push|checkout|reset|rebase|merge|stash|branch\s+-[dD])/,
];

// ─── State ───
let pendingSpeculationPrompt: string | null = null;
let activeSpecProc: ChildProcess | null = null;
let activeKillTimer: ReturnType<typeof setTimeout> | null = null;
let speculationSessionId: string | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// Auto-speculation config
const DEBOUNCE_MS = 3000;       // Wait 3s after user stops typing
const MIN_PROMPT_LENGTH = 15;   // Don't speculate on short prompts

// ─── OverlayFS ───
// Copy-on-write filesystem that redirects writes to /tmp/pi-speculation/<id>/
// Reads check overlay first, fall back to real filesystem.
class OverlayFS {
	readonly id: string;
	readonly root: string;

	constructor() {
		this.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
		this.root = path.join(OVERLAY_ROOT, this.id);
		fs.mkdirSync(this.root, { recursive: true });
	}

	// Convert a real absolute path to its overlay equivalent
	toOverlay(realPath: string): string {
		const abs = path.resolve(realPath);
		// Strip leading slash/drive letter to make it relative
		const rel = abs.replace(/^[a-zA-Z]:\\|^\//, "");
		return path.join(this.root, rel);
	}

	// Check if a file exists in the overlay
	hasFile(realPath: string): boolean {
		return fs.existsSync(this.toOverlay(realPath));
	}

	// Copy a real file into the overlay (copy-on-write: first write triggers copy)
	copyToOverlay(realPath: string): string {
		const overlayPath = this.toOverlay(realPath);
		const abs = path.resolve(realPath);
		fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
		if (fs.existsSync(abs) && !fs.existsSync(overlayPath)) {
			fs.copyFileSync(abs, overlayPath);
		}
		return overlayPath;
	}

	// Accept: copy all overlay files back to the real filesystem
	accept(): string[] {
		const copied: string[] = [];
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
				} else {
					// Convert overlay path back to real path
					const rel = path.relative(this.root, full);
					const realPath = "/" + rel;
					fs.mkdirSync(path.dirname(realPath), { recursive: true });
					fs.copyFileSync(full, realPath);
					copied.push(realPath);
				}
			}
		};
		if (fs.existsSync(this.root)) walk(this.root);
		return copied;
	}

	// Cleanup: remove the overlay directory
	cleanup(): void {
		try {
			fs.rmSync(this.root, { recursive: true, force: true });
		} catch { /* ignore */ }
	}
}

// ─── Helper: kill active speculation safely ───
function killActiveSpeculation(): void {
	if (activeKillTimer) {
		clearTimeout(activeKillTimer);
		activeKillTimer = null;
	}
	if (activeSpecProc && !activeSpecProc.killed) {
		activeSpecProc.kill("SIGTERM");
	}
	activeSpecProc = null;
	pendingSpeculationPrompt = null;
	speculationSessionId = null;
}

// ─── Helper: check if bash command is read-only ───
// Claude Code uses checkReadOnlyConstraints() which checks both a prefix
// whitelist AND a state-modification blacklist
function isReadOnlyBash(command: string): boolean {
	const trimmed = command.trim();
	
	// First: reject any state-modifying patterns regardless of prefix
	for (const pattern of STATE_MODIFYING_PATTERNS) {
		if (pattern.test(trimmed)) return false;
	}
	
	// Then: check every segment against the prefix whitelist
	const segments = trimmed.split(/\s*[|&;]\s*/);
	return segments.every(seg => {
		const s = seg.trim();
		if (!s) return true;
		return READONLY_BASH_PREFIXES.some(prefix => s.startsWith(prefix));
	});
}

export default function speculationEngine(pi: ExtensionAPI) {
	// Store reference to the speculate handler so auto-trigger can call it
	let speculateHandler: ((args: string, ctx: any) => Promise<void>) | null = null;

	// ─── /speculate command ───
	const handler = async (args: string, ctx: any) => {
			if (!args) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /speculate <prompt>", "error");
				return;
			}

			// 🛡️ Guardrail: Never speculate inside a subagent
			if (process.env.PI_IS_SUBAGENT === "true" || process.env.PI_SUBAGENT_DEPTH) {
				if (ctx.hasUI) ctx.ui.notify("Cannot speculate from within a subagent.", "error");
				return;
			}

			// 🛡️ Guardrail: Kill any existing speculation before starting a new one
			if (activeSpecProc) {
				killActiveSpeculation();
				if (ctx.hasUI) ctx.ui.notify("Previous speculation killed.", "info");
			}

			// Create overlay filesystem for this speculation
			const overlay = new OverlayFS();
			speculationSessionId = overlay.id;

			const sessionFile = ctx.sessionManager?.getSessionFile?.();
			const spawnArgs = ["--mode", "json", "--no-session"];
			if (sessionFile) {
				// Use --fork for prompt cache inheritance, remove --no-session (they conflict)
				const forkArgs = ["--mode", "json", "--fork", sessionFile];
				forkArgs.push("-p", args);
				spawnArgs.length = 0;
				spawnArgs.push(...forkArgs);
			} else {
				spawnArgs.push("-p", args);
			}

			pendingSpeculationPrompt = args.trim();
			if (ctx.hasUI) {
				ctx.ui.setStatus("speculation", `🔮 Speculating: ${args.slice(0, 50)}...`);
			}

			const currentDepth = parseInt(process.env.PI_SUBAGENT_DEPTH || "0", 10);

			// 🛡️ Spawn with full guardrails
			// Use cheaper model for speculation (Claude Code uses CLAUDE_CODE_SUBAGENT_MODEL)
			// Defaults to gemini-flash, override with PI_SPECULATION_MODEL env var
			const speculationModel = process.env.PI_SPECULATION_MODEL || "gemini-2.5-flash";
			spawnArgs.unshift("--model", speculationModel);

			const proc = spawn(process.argv[0], [process.argv[1]!, ...spawnArgs], {
				env: {
					...process.env,
					PI_SPECULATE: "true",
					PI_IS_SUBAGENT: "true",
					PI_SUBAGENT_DEPTH: (currentDepth + 1).toString(),
					PI_SPECULATION_OVERLAY_ID: overlay.id,
					PI_SPECULATION_OVERLAY_ROOT: overlay.root,
				},
				stdio: ["ignore", "pipe", "pipe"],
			});

			activeSpecProc = proc;
			let output = "";
			let turnCount = 0;

			proc.stdout.on("data", (d: Buffer) => {
				const chunk = d.toString();
				output += chunk;

				// Count turns from JSON stream for guardrail
				const lines = chunk.split("\n");
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line);
						if (event.type === "message_end" && event.message?.role === "assistant") {
							turnCount++;
							// 🛡️ Guardrail: Hard turn limit (Claude Code: MAX_SPECULATION_TURNS = 20)
							if (turnCount >= MAX_SPECULATION_TURNS) {
								if (!proc.killed) proc.kill("SIGTERM");
							}
						}
					} catch { /* not JSON, ignore */ }
				}
			});

			proc.stderr.on("data", (d: Buffer) => {
				// Capture but don't surface stderr unless debugging
				output += d.toString();
			});

			// 🛡️ Guardrail: 90-second absolute kill timer (Claude Code abort controller pattern)
			activeKillTimer = setTimeout(() => {
				if (activeSpecProc && !activeSpecProc.killed) {
					activeSpecProc.kill("SIGTERM");
					if (ctx.hasUI) {
						ctx.ui.notify("Speculation timed out after 90s.", "error");
						ctx.ui.setStatus("speculation", undefined);
					}
				}
				activeKillTimer = null;
			}, SPECULATION_TIMEOUT_MS);

			proc.on("close", (code) => {
				if (activeKillTimer) {
					clearTimeout(activeKillTimer);
					activeKillTimer = null;
				}
				activeSpecProc = null;

				// Save result for later retrieval
				fs.mkdirSync(OVERLAY_ROOT, { recursive: true });
				fs.writeFileSync(path.join(OVERLAY_ROOT, "result.txt"), output);
				fs.writeFileSync(path.join(OVERLAY_ROOT, "meta.json"), JSON.stringify({
					prompt: pendingSpeculationPrompt,
					overlayId: overlay.id,
					turns: turnCount,
					exitCode: code,
					timestamp: Date.now(),
				}));

				if (ctx.hasUI) {
					ctx.ui.setStatus("speculation", undefined);
					if (code === 0 || code === null) {
						ctx.ui.notify(`Speculation complete (${turnCount} turns). Type your prompt to accept, or type something else to discard.`, "success");
					} else {
						ctx.ui.notify(`Speculation exited with code ${code} after ${turnCount} turns.`, "error");
					}
				}
			});
	};

	speculateHandler = handler;

	pi.registerCommand("speculate", {
		description: "Fork session to speculate on a prompt in a safe overlay filesystem",
		handler,
	});

	// ─── /speculate-status command ───
	pi.registerCommand("speculate-status", {
		description: "Show status of active or last speculation",
		handler: async (_args: string, ctx: any) => {
			if (activeSpecProc) {
				if (ctx.hasUI) ctx.ui.notify(`Speculation running: "${pendingSpeculationPrompt}"`, "info");
			} else if (pendingSpeculationPrompt) {
				if (ctx.hasUI) ctx.ui.notify(`Speculation finished: "${pendingSpeculationPrompt}" — type it to accept.`, "info");
			} else {
				if (ctx.hasUI) ctx.ui.notify("No active or pending speculation.", "info");
			}
		},
	});

	// ─── /speculate-cancel command ───
	pi.registerCommand("speculate-cancel", {
		description: "Kill active speculation and discard results",
		handler: async (_args: string, ctx: any) => {
			if (activeSpecProc || pendingSpeculationPrompt) {
				const overlayId = speculationSessionId;
				killActiveSpeculation();
				// Cleanup overlay
				if (overlayId) {
					const overlay = new OverlayFS();
					(overlay as any).id = overlayId;
					(overlay as any).root = path.join(OVERLAY_ROOT, overlayId);
					overlay.cleanup();
				}
				if (ctx.hasUI) ctx.ui.notify("Speculation cancelled and overlay cleaned up.", "info");
			} else {
				if (ctx.hasUI) ctx.ui.notify("Nothing to cancel.", "info");
			}
		},
	});

	// ─── Auto-speculate: poll editor text every second (Claude Code pattern) ───
	// Pi's SDK doesn't expose a keystroke event, so we poll the editor text
	// via the getEditorText() function exposed on the extension context.
	let lastSeenText = "";
	let stableCount = 0; // how many consecutive polls saw the same text
	let lastCtx: any = null;

	// Capture ctx from every event to ensure we have UI access
	const captureCtx = async (_event: any, ctx: any) => { if (ctx) lastCtx = ctx; };
	pi.on("agent_start", captureCtx);
	pi.on("agent_end", captureCtx);
	pi.on("turn_end", captureCtx);
	pi.on("tool_call", captureCtx);
	pi.on("tool_result", captureCtx);
	pi.on("input", captureCtx);

	// Write debug on first poll to confirm polling is alive
	const pollInterval = setInterval(() => {
		// Guards
		if (process.env.PI_IS_SUBAGENT === "true" || process.env.PI_SPECULATE === "true") return;

		const fsd = require("node:fs");
		if (!lastCtx) {
			fsd.appendFileSync("/tmp/pi-spec-debug.log", `${Date.now()} NO CTX\n`);
			return;
		}

		const getEditorText = lastCtx.ui?.getEditorText;
		if (!getEditorText) {
			fsd.appendFileSync("/tmp/pi-spec-debug.log", `${Date.now()} NO getEditorText ui=${!!lastCtx.ui}\n`);
			return;
		}

		const text = (getEditorText() || "").trim();
		fsd.appendFileSync("/tmp/pi-spec-debug.log", `${Date.now()} text="${text.slice(0,30)}" len=${text.length} stable=${stableCount} pending=${pendingSpeculationPrompt?.slice(0,20)} active=${!!activeSpecProc}\n`);

		if (!text || text.startsWith("/") || text.startsWith("!") || text.length < MIN_PROMPT_LENGTH) {
			lastSeenText = text;
			stableCount = 0;
			return;
		}

		if (text === lastSeenText) {
			stableCount++;
		} else {
			// Text changed — kill existing speculation if different
			if (activeSpecProc && pendingSpeculationPrompt && text !== pendingSpeculationPrompt) {
				killActiveSpeculation();
			}
			lastSeenText = text;
			stableCount = 0;
			return;
		}

		// After 3 stable polls (3 seconds), trigger speculation
		if (stableCount === 3 && text !== pendingSpeculationPrompt && !activeSpecProc) {
			if (speculateHandler && lastCtx) {
				speculateHandler(text, lastCtx);
			}
		}
	}, 1000);

	// Cleanup on agent end
	pi.on("agent_end", async () => {
		clearInterval(pollInterval);
	});

	// ─── tool_call hook: canUseTool() gating + OverlayFS redirect ───
	// Only active when running inside a speculation subprocess (PI_SPECULATE=true)
	pi.on("tool_call", async (event: any) => {
		if (process.env.PI_SPECULATE !== "true") return undefined;

		const overlayRoot = process.env.PI_SPECULATION_OVERLAY_ROOT;
		if (!overlayRoot) return undefined;

		// Helper: redirect a path to overlay
		const toOverlay = (realPath: string): string => {
			const abs = path.resolve(realPath);
			const rel = abs.replace(/^[a-zA-Z]:\\|^\//, "");
			const overlayPath = path.join(overlayRoot, rel);
			fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
			return overlayPath;
		};

		// Helper: copy-on-write — copy real file to overlay before first edit
		const ensureInOverlay = (realPath: string): string => {
			const overlayPath = toOverlay(realPath);
			const abs = path.resolve(realPath);
			if (!fs.existsSync(overlayPath) && fs.existsSync(abs)) {
				fs.copyFileSync(abs, overlayPath);
			}
			return overlayPath;
		};

		// ─── read: check overlay first, fall back to real FS ───
		if (event.toolName === "read") {
			const p = event.input.path as string;
			if (p) {
				const overlayPath = toOverlay(p);
				if (fs.existsSync(overlayPath)) {
					event.input.path = overlayPath;
				}
				// If not in overlay, let it read from real FS (read-only, safe)
			}
			return undefined;
		}

		// ─── edit: copy-on-write then redirect ───
		if (event.toolName === "edit") {
			const p = event.input.path as string;
			if (p) {
				event.input.path = ensureInOverlay(p);
			}
			return undefined;
		}

		// ─── write: redirect to overlay ───
		if (event.toolName === "write") {
			const p = event.input.path as string;
			if (p) {
				event.input.path = toOverlay(p);
			}
			return undefined;
		}

		// ─── bash: only allow read-only commands ───
		if (event.toolName === "bash") {
			const command = (event.input.command as string) || "";
			if (!isReadOnlyBash(command)) {
				return {
					block: true,
					reason: "Speculation mode: only read-only bash commands are allowed (ls, grep, cat, find, etc). Write operations must use edit/write tools.",
				};
			}
			// Read-only bash is allowed to run against the real FS
			return undefined;
		}

		// ─── All other tools: deny in speculation mode ───
		return {
			block: true,
			reason: `Tool "${event.toolName}" is not allowed during speculation. Only read, edit, write, and read-only bash are permitted.`,
		};
	});

	// ─── input hook: instant accept / abort-on-new-input ───
	pi.on("input", async (event: any, ctx: any) => {
		const text = (event.text || "").trim();

		// Check if speculation finished while we were idle
		// (Node event loop may not have fired the close callback yet)
		if (pendingSpeculationPrompt && activeSpecProc) {
			const resultFile = path.join(OVERLAY_ROOT, "result.txt");
			if (fs.existsSync(resultFile)) {
				// Subprocess wrote results but close event hasn't fired yet
				activeSpecProc = null;
				if (activeKillTimer) { clearTimeout(activeKillTimer); activeKillTimer = null; }
				if (ctx.hasUI) {
					ctx.ui.setStatus("speculation", undefined);
					ctx.ui.notify("Speculation complete! Type your prompt to accept, or type something else to discard.", "success");
				}
			}
		}

		// 🛡️ Abort-on-new-input: if speculation is still running and user types something
		// different, kill it immediately (Claude Code pattern: abort controller on keystroke)
		if (activeSpecProc && text !== pendingSpeculationPrompt) {
			killActiveSpeculation();
			if (ctx.hasUI) {
				ctx.ui.setStatus("speculation", undefined);
				ctx.ui.notify("Active speculation cancelled (new input detected).", "info");
			}
			return { action: "continue" };
		}

		// ─── Instant accept: prompt matches pending speculation ───
		if (pendingSpeculationPrompt && text === pendingSpeculationPrompt && !activeSpecProc) {
			const resultFile = path.join(OVERLAY_ROOT, "result.txt");
			const metaFile = path.join(OVERLAY_ROOT, "meta.json");

			if (!fs.existsSync(resultFile)) {
				// Speculation hasn't finished writing yet
				return { action: "continue" };
			}

			try {
				const result = fs.readFileSync(resultFile, "utf-8");
				let meta: any = {};
				if (fs.existsSync(metaFile)) {
					meta = JSON.parse(fs.readFileSync(metaFile, "utf-8"));
				}

				// Parse JSON stream output for assistant text content
				// Claude Code: prepareMessagesForInjection() strips thinking blocks,
				// failed tool_results, interrupt messages, and empty content
				let assistantText = "";
				for (const line of result.split("\n")) {
					if (!line.trim()) continue;
					try {
						const evt = JSON.parse(line);
						if (evt.type === "message_end" && evt.message?.role === "assistant") {
							const content = evt.message.content || [];
							for (const block of content) {
								// Skip thinking blocks (waste tokens post-injection)
								if (block.type === "thinking") continue;
								// Skip tool_use blocks (they reference overlay paths)
								if (block.type === "tool_use") continue;
								// Skip empty text
								if (block.type === "text" && (!block.text || !block.text.trim())) continue;
								// Keep valid text content
								if (block.type === "text" && block.text) {
									assistantText += block.text + "\n";
								}
							}
						}
						// Also skip tool_result messages entirely (they contain overlay paths)
						// Only inject clean assistant text
					} catch { /* not JSON */ }
				}

				if (assistantText) {
					// Inject the speculated response as an assistant message (Claude Code: message injection)
					pi.sendMessage({
						customType: "speculation-accepted",
						content: `**⚡ Speculation Result (${meta.turns || "?"} turns):**\n\n${assistantText.trim()}`,
						display: true,
					}, { triggerTurn: false });
				}

				// Apply overlay files if any exist
				if (meta.overlayId) {
					const overlayDir = path.join(OVERLAY_ROOT, meta.overlayId);
					if (fs.existsSync(overlayDir)) {
						if (ctx.hasUI) {
							const apply = await ctx.ui.confirm(
								"Apply Speculated Changes",
								"Copy overlay filesystem changes to your real repo?",
							);
							if (apply) {
								const overlay = new OverlayFS();
								(overlay as any).id = meta.overlayId;
								(overlay as any).root = overlayDir;
								const copied = overlay.accept();
								if (copied.length > 0) {
									ctx.ui.notify(`Applied ${copied.length} file(s) from speculation.`, "success");
								} else {
									ctx.ui.notify("No file changes to apply.", "info");
								}
							}
						}
					}
				}

				// Cleanup
				pendingSpeculationPrompt = null;
				speculationSessionId = null;
				try {
					fs.rmSync(OVERLAY_ROOT, { recursive: true, force: true });
				} catch { /* ignore */ }

				return { action: "handled" };
			} catch (err: any) {
				if (ctx.hasUI) ctx.ui.notify(`Error reading speculation: ${err.message}`, "error");
			}
		}

		return { action: "continue" };
	});
}
