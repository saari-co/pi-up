import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ─── Constants (from Claude Code speculation.ts) ───
const SPECULATION_TIMEOUT_MS = 30_000;		// Kill runaway speculations after 30s
const MAX_SPECULATION_TURNS = 20;			// Claude Code: MAX_SPECULATION_TURNS = 20
const OVERLAY_ROOT = "/tmp/pi-speculation";
const MIN_PROMPT_LENGTH = 15;

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
	/\$/, /`/, // Reject variable expansion and backticks (unpredictable)
];

// ─── Module-level state (to handle reloads safely) ───
let globalActiveSpecProc: ChildProcess | null = null;
let globalActiveKillTimer: ReturnType<typeof setTimeout> | null = null;
let globalPollInterval: ReturnType<typeof setInterval> | null = null;

// ─── OverlayFS ───
class OverlayFS {
	readonly id: string;
	readonly root: string;
	constructor(id?: string) {
		this.id = id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
		this.root = path.join(OVERLAY_ROOT, this.id);
		if (!fs.existsSync(this.root)) fs.mkdirSync(this.root, { recursive: true });
	}
	toOverlay(realPath: string): string {
		const abs = path.resolve(realPath);
		const rel = abs.replace(/^[a-zA-Z]:\\|^\//, "");
		return path.join(this.root, rel);
	}
	ensureInOverlay(realPath: string): string {
		const overlayPath = this.toOverlay(realPath);
		const abs = path.resolve(realPath);
		if (!fs.existsSync(overlayPath) && fs.existsSync(abs)) {
			fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
			fs.copyFileSync(abs, overlayPath);
		}
		return overlayPath;
	}
	accept(): string[] {
		const copied: string[] = [];
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
				} else {
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
	cleanup(): void {
		try { fs.rmSync(this.root, { recursive: true, force: true }); } catch { }
	}
}

function isReadOnlyBash(command: string): boolean {
	const trimmed = command.trim();
	if (trimmed.includes("$") || trimmed.includes("`")) return false;
	for (const pattern of STATE_MODIFYING_PATTERNS) {
		if (pattern.test(trimmed)) return false;
	}
	const segments = trimmed.split(/\s*[|&;]\s*/);
	return segments.every(seg => {
		const s = seg.trim();
		if (!s) return true;
		return READONLY_BASH_PREFIXES.some(prefix => s.startsWith(prefix));
	});
}

export default function speculationEngine(pi: ExtensionAPI) {
	// Instance state
	let pendingSpeculationPrompt: string | null = null;
	let speculationSessionId: string | null = null;
	let lastSeenText = "";
	let stableCount = 0;
	let lastCtx: any = null;
	let agentBusy = false;

	// Cleanup any leaked global interval from previous reload
	if (globalPollInterval) {
		clearInterval(globalPollInterval);
		globalPollInterval = null;
	}

	const killActiveSpeculation = () => {
		if (globalActiveKillTimer) {
			clearTimeout(globalActiveKillTimer);
			globalActiveKillTimer = null;
		}
		if (globalActiveSpecProc && !globalActiveSpecProc.killed) {
			globalActiveSpecProc.kill("SIGTERM");
		}
		globalActiveSpecProc = null;
		pendingSpeculationPrompt = null;
		speculationSessionId = null;
	};

	const speculate = async (args: string, ctx: any) => {
		if (!args) return;
		if (process.env.PI_IS_SUBAGENT === "true" || process.env.PI_SUBAGENT_DEPTH) return;

		if (globalActiveSpecProc) killActiveSpeculation();

		const overlay = new OverlayFS();
		speculationSessionId = overlay.id;
		pendingSpeculationPrompt = args.trim();

		const sessionFile = ctx.sessionManager?.getSessionFile?.();
		const spawnArgs = ["--mode", "json"];
		const speculationModel = process.env.PI_SPEC_MODEL || "gemini-2.5-flash";
		spawnArgs.push("--model", speculationModel);

		if (sessionFile) {
			spawnArgs.push("--fork", sessionFile);
		} else {
			spawnArgs.push("--no-session");
		}
		spawnArgs.push("-p", args);

		if (ctx.hasUI) ctx.ui.setStatus("speculation", `🔮 Speculating...`);

		const currentDepth = parseInt(process.env.PI_SUBAGENT_DEPTH || "0", 10);
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

		globalActiveSpecProc = proc;
		let output = "";
		let turnCount = 0;

		proc.stdout.on("data", (d: Buffer) => {
			const chunk = d.toString();
			output += chunk;
			const lines = chunk.split("\n");
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line);
					if (event.type === "message_end" && event.message?.role === "assistant") {
						turnCount++;
						if (turnCount >= MAX_SPECULATION_TURNS) proc.kill("SIGTERM");
					}
				} catch { }
			}
		});

		const thisProc = proc;
		globalActiveKillTimer = setTimeout(() => {
			if (thisProc && !thisProc.killed) {
				thisProc.kill("SIGTERM");
				if (ctx.hasUI) ctx.ui.notify("Speculation timed out.", "error");
			}
			if (globalActiveSpecProc === thisProc) globalActiveSpecProc = null;
			globalActiveKillTimer = null;
		}, SPECULATION_TIMEOUT_MS);

		proc.on("close", (code) => {
			if (globalActiveKillTimer) { clearTimeout(globalActiveKillTimer); globalActiveKillTimer = null; }
			if (globalActiveSpecProc === thisProc) globalActiveSpecProc = null;

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
					ctx.ui.notify(`Speculation complete (${turnCount} turns).`, "success");
				}
			}
		});
	};

	pi.registerCommand("speculate", {
		description: "Speculate on a prompt in a safe overlay filesystem",
		handler: speculate,
	});

	pi.registerCommand("speculate-cancel", {
		description: "Kill active speculation and discard results",
		handler: async (_args, ctx) => {
			const oid = speculationSessionId;
			killActiveSpeculation();
			if (oid) new OverlayFS(oid).cleanup();
			if (ctx.hasUI) {
				ctx.ui.setStatus("speculation", undefined);
				ctx.ui.notify("Speculation cancelled.", "info");
			}
		},
	});

	const captureCtx = async (_e: any, ctx: any) => { if (ctx) lastCtx = ctx; };
	pi.on("agent_start", async (e, ctx) => { agentBusy = true; await captureCtx(e, ctx); });
	pi.on("agent_end", async (e, ctx) => { agentBusy = false; await captureCtx(e, ctx); });
	pi.on("turn_end", async (e, ctx) => { agentBusy = false; await captureCtx(e, ctx); });
	pi.on("input", async (e, ctx) => { agentBusy = true; await captureCtx(e, ctx); });
	pi.on("tool_call", captureCtx);
	pi.on("tool_result", captureCtx);

	globalPollInterval = setInterval(() => {
		if (process.env.PI_IS_SUBAGENT === "true" || process.env.PI_SPECULATE === "true") return;
		if (!lastCtx || agentBusy) return;

		// 🛡️ Cleanup dead procs
		if (globalActiveSpecProc && !globalActiveSpecProc.killed && globalActiveSpecProc.pid) {
			try { process.kill(globalActiveSpecProc.pid, 0); } catch {
				globalActiveSpecProc = null;
				if (globalActiveKillTimer) { clearTimeout(globalActiveKillTimer); globalActiveKillTimer = null; }
			}
		}

		const getEditorText = lastCtx.ui?.getEditorText;
		if (!getEditorText) return;

		const text = (getEditorText() || "").trim();
		if (!text || text.startsWith("/") || text.startsWith("!") || text.length < MIN_PROMPT_LENGTH) {
			lastSeenText = text;
			stableCount = 0;
			return;
		}

		if (text === lastSeenText) {
			stableCount++;
		} else {
			if (globalActiveSpecProc && pendingSpeculationPrompt && text !== pendingSpeculationPrompt) {
				killActiveSpeculation();
			}
			lastSeenText = text;
			stableCount = 0;
			return;
		}

		if (stableCount === 3 && text !== pendingSpeculationPrompt && !globalActiveSpecProc) {
			speculate(text, lastCtx);
			stableCount = 999;
		}
	}, 1000);

	pi.on("tool_call", async (event: any) => {
		if (process.env.PI_SPECULATE !== "true") return undefined;
		const overlayRoot = process.env.PI_SPECULATION_OVERLAY_ROOT;
		if (!overlayRoot) return undefined;

		const ofs = new OverlayFS(process.env.PI_SPECULATION_OVERLAY_ID);

		if (event.toolName === "read") {
			const p = event.input.path;
			if (p && ofs.hasFile(p)) event.input.path = ofs.toOverlay(p);
			return undefined;
		}
		if (event.toolName === "edit") {
			const p = event.input.path;
			if (p) event.input.path = ofs.ensureInOverlay(p);
			return undefined;
		}
		if (event.toolName === "write") {
			const p = event.input.path;
			if (p) event.input.path = ofs.toOverlay(p);
			return undefined;
		}
		if (event.toolName === "bash") {
			const command = event.input.command || "";
			if (!isReadOnlyBash(command)) {
				return { block: true, reason: "Speculation mode: only read-only bash commands are allowed." };
			}
			return undefined;
		}
		return { block: true, reason: `Tool "${event.toolName}" is not allowed during speculation.` };
	});

	pi.on("input", async (event: any, ctx: any) => {
		const text = (event.text || "").trim();

		// check for completion while blocked
		if (pendingSpeculationPrompt && globalActiveSpecProc) {
			if (fs.existsSync(path.join(OVERLAY_ROOT, "result.txt"))) {
				globalActiveSpecProc = null;
				if (globalActiveKillTimer) { clearTimeout(globalActiveKillTimer); globalActiveKillTimer = null; }
				if (ctx.hasUI) {
					ctx.ui.setStatus("speculation", undefined);
					ctx.ui.notify("Speculation complete! Type prompt to accept.", "success");
				}
			}
		}

		if (globalActiveSpecProc && text !== pendingSpeculationPrompt) {
			killActiveSpeculation();
			if (ctx.hasUI) {
				ctx.ui.setStatus("speculation", undefined);
				ctx.ui.notify("Speculation cancelled (new input).", "info");
			}
			return { action: "continue" };
		}

		if (pendingSpeculationPrompt && text === pendingSpeculationPrompt && !globalActiveSpecProc) {
			const resFile = path.join(OVERLAY_ROOT, "result.txt");
			const metaFile = path.join(OVERLAY_ROOT, "meta.json");
			if (!fs.existsSync(resFile)) return { action: "continue" };

			try {
				const result = fs.readFileSync(resFile, "utf-8");
				let meta: any = {};
				if (fs.existsSync(metaFile)) meta = JSON.parse(fs.readFileSync(metaFile, "utf-8"));

				let assistantText = "";
				for (const line of result.split("\n")) {
					if (!line.trim()) continue;
					try {
						const evt = JSON.parse(line);
						if (evt.type === "message_end" && evt.message?.role === "assistant") {
							const content = evt.message.content || [];
							for (const block of content) {
								if (block.type === "text" && block.text?.trim()) assistantText += block.text + "\n";
							}
						}
					} catch { }
				}

				if (assistantText) {
					pi.sendMessage({
						customType: "speculation-accepted",
						content: `**⚡ Speculation Result:**\n\n${assistantText.trim()}`,
						display: true,
					}, { triggerTurn: false });
				}

				if (meta.overlayId) {
					const ofs = new OverlayFS(meta.overlayId);
					if (fs.existsSync(ofs.root)) {
						if (ctx.hasUI) {
							if (await ctx.ui.confirm("Apply Changes", "Copy overlay files to real repo?")) {
								const copied = ofs.accept();
								if (copied.length > 0) ctx.ui.notify(`Applied ${copied.length} files.`, "success");
							}
						}
					}
				}

				pendingSpeculationPrompt = null;
				speculationSessionId = null;
				try { fs.rmSync(OVERLAY_ROOT, { recursive: true, force: true }); } catch { }
				return { action: "handled" };
			} catch (err: any) {
				if (ctx.hasUI) ctx.ui.notify(`Error reading speculation: ${err.message}`, "error");
			}
		}
		return { action: "continue" };
	});
}
