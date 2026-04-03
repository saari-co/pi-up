import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ─── Constants ───
const SPECULATION_TIMEOUT_MS = 30_000;
const MAX_SPECULATION_TURNS = 20;
const OVERLAY_ROOT = "/tmp/pi-speculation";
const MIN_PROMPT_LENGTH = 15;
const LOCK_FILE = "/tmp/pi-speculation.pid";
const POLL_OWNER_FILE = "/tmp/pi-speculation-poller.id";

// ─── PID-file based singleton ───
function isProcessAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

function getRunningSpecPid(): number | null {
	try {
		const pid = parseInt(fs.readFileSync(LOCK_FILE, "utf-8").trim(), 10);
		if (!isNaN(pid) && isProcessAlive(pid)) return pid;
		fs.unlinkSync(LOCK_FILE);
	} catch { }
	return null;
}

function killByPidFile(): void {
	const pid = getRunningSpecPid();
	if (pid) {
		try { process.kill(pid, "SIGTERM"); } catch { }
		try { fs.unlinkSync(LOCK_FILE); } catch { }
	}
}

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
		const rel = path.resolve(realPath).replace(/^[a-zA-Z]:\\|^\//, "");
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
				if (entry.isDirectory()) walk(full);
				else {
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
	cleanup(): void { try { fs.rmSync(this.root, { recursive: true, force: true }); } catch { } }
}

// ─── Bash gating ───
const READONLY_BASH_PREFIXES = ["cat ", "head ", "tail ", "grep ", "rg ", "find ", "ls ", "wc ", "file ", "stat ", "which ", "echo ", "pwd", "tree ", "du ", "df ", "env ", "printenv", "uname", "date", "whoami"];
const STATE_MODIFYING_PATTERNS = [/\bcd\b/, /\bexport\b/, /\bsource\b/, /\bunset\b/, /\balias\b/, /\bmkdir\b/, /\btouch\b/, /\brm\b/, /\bmv\b/, /\bcp\b/, /\bchmod\b/, /\bchown\b/, /\bln\b/, /\bsed\s+-i/, /\bawk\b.*>/, />>/, />[^&]/, /\bkill\b/, /\bpkill\b/, /\bnpm\b/, /\byarn\b/, /\bgit\s+(add|commit|push|checkout|reset|rebase|merge|stash|branch\s+-[dD])/, /\$/, /`/];

function isReadOnlyBash(command: string): boolean {
	const t = command.trim();
	if (t.includes("$") || t.includes("`")) return false;
	for (const p of STATE_MODIFYING_PATTERNS) if (p.test(t)) return false;
	return t.split(/\s*[|&;]\s*/).every(seg => { const s = seg.trim(); return !s || READONLY_BASH_PREFIXES.some(pfx => s.startsWith(pfx)); });
}

export default function speculationEngine(pi: ExtensionAPI) {
	let pendingSpeculationPrompt: string | null = null;
	let speculationSessionId: string | null = null;
	let activeProc: ChildProcess | null = null;
	let activeTimer: ReturnType<typeof setTimeout> | null = null;
	let lastSeenText = "";
	let stableCount = 0;
	let lastCtx: any = null;
	let agentBusy = false;

	// Claim ownership of the poller — previous pollers will see this and stop
	const myPollerId = String(process.pid) + "-" + Date.now();
	fs.writeFileSync(POLL_OWNER_FILE, myPollerId);
	let pollStopped = false;

	// 🛡️ Pi emits session_shutdown before /reload. Clean up everything.
	pi.on("session_shutdown" as any, async () => {
		pollStopped = true;
		try { fs.unlinkSync(POLL_OWNER_FILE); } catch { }
		try { fs.unlinkSync(LOCK_FILE); } catch { }
		killByPidFile();
	});

	const killActive = () => {
		if (activeTimer) { clearTimeout(activeTimer); activeTimer = null; }
		if (activeProc && !activeProc.killed) activeProc.kill("SIGTERM");
		activeProc = null;
		killByPidFile();
	};

	const speculate = async (args: string, ctx: any) => {
		if (!args) return;
		if (process.env.PI_IS_SUBAGENT === "true" || process.env.PI_SUBAGENT_DEPTH) return;

		// 🛡️ Count pi processes. If more than 1 (our main session), don't spawn another.
		try {
			const { execSync } = require("node:child_process");
			const count = parseInt(execSync("pgrep -u $(whoami) -c pi 2>/dev/null || echo 0", { encoding: "utf-8" }).trim(), 10);
			if (count >= 2) return; // Main session + something else already running
		} catch { }

		killActive();

		const overlay = new OverlayFS();
		speculationSessionId = overlay.id;
		pendingSpeculationPrompt = args.trim();

		const sessionFile = ctx.sessionManager?.getSessionFile?.();
		const spawnArgs = ["--mode", "json", "--model", process.env.PI_SPEC_MODEL || "gemini-2.5-flash"];
		if (sessionFile) spawnArgs.push("--fork", sessionFile); else spawnArgs.push("--no-session");
		spawnArgs.push("-p", args);

		if (ctx.hasUI) ctx.ui.setStatus("speculation", "🔮 Speculating...");

		const proc = spawn(process.argv[0], [process.argv[1]!, ...spawnArgs], {
			env: { ...process.env, PI_SPECULATE: "true", PI_IS_SUBAGENT: "true", PI_SUBAGENT_DEPTH: String((parseInt(process.env.PI_SUBAGENT_DEPTH || "0", 10)) + 1), PI_SPECULATION_OVERLAY_ID: overlay.id, PI_SPECULATION_OVERLAY_ROOT: overlay.root },
			stdio: ["ignore", "pipe", "pipe"],
		});

		activeProc = proc;
		// Write PID file IMMEDIATELY so other pollers see it
		if (proc.pid) fs.writeFileSync(LOCK_FILE, String(proc.pid));

		let output = "";
		let turnCount = 0;
		proc.stdout.on("data", (d: Buffer) => {
			output += d.toString();
			for (const line of d.toString().split("\n")) {
				try { const e = JSON.parse(line); if (e.type === "message_end" && e.message?.role === "assistant") { turnCount++; if (turnCount >= MAX_SPECULATION_TURNS) proc.kill("SIGTERM"); } } catch { }
			}
		});

		activeTimer = setTimeout(() => {
			if (!proc.killed) { proc.kill("SIGTERM"); if (ctx.hasUI) ctx.ui.notify("Speculation timed out.", "error"); }
			activeProc = null; activeTimer = null;
			try { fs.unlinkSync(LOCK_FILE); } catch { }
		}, SPECULATION_TIMEOUT_MS);

		proc.on("close", (code) => {
			if (activeTimer) { clearTimeout(activeTimer); activeTimer = null; }
			activeProc = null;
			try { fs.unlinkSync(LOCK_FILE); } catch { }
			fs.mkdirSync(OVERLAY_ROOT, { recursive: true });
			fs.writeFileSync(path.join(OVERLAY_ROOT, "result.txt"), output);
			fs.writeFileSync(path.join(OVERLAY_ROOT, "meta.json"), JSON.stringify({ prompt: pendingSpeculationPrompt, overlayId: overlay.id, turns: turnCount, exitCode: code, timestamp: Date.now() }));
			if (ctx.hasUI) { ctx.ui.setStatus("speculation", undefined); if (code === 0 || code === null) ctx.ui.notify(`Speculation complete (${turnCount} turns).`, "success"); }
		});
	};

	pi.registerCommand("speculate", { description: "Speculate on a prompt safely", handler: speculate });
	pi.registerCommand("speculate-cancel", {
		description: "Kill active speculation",
		handler: async (_args, ctx) => {
			killActive();
			if (ctx.hasUI) { ctx.ui.setStatus("speculation", undefined); ctx.ui.notify("Speculation cancelled.", "info"); }
		},
	});

	// ─── Ctx capture ───
	const cap = async (_e: any, ctx: any) => { if (ctx) lastCtx = ctx; };
	pi.on("agent_start", async (e, c) => { agentBusy = true; cap(e, c); });
	pi.on("agent_end", async (e, c) => { agentBusy = false; cap(e, c); });
	pi.on("turn_end", async (e, c) => { agentBusy = false; cap(e, c); });
	pi.on("input", async (e, c) => { agentBusy = true; cap(e, c); });
	pi.on("tool_call", cap);
	pi.on("tool_result", cap);

	// ─── Poller (self-terminating setTimeout chain) ───
	function poll() {
		if (pollStopped) return; // Killed by session_shutdown
		try { if (fs.readFileSync(POLL_OWNER_FILE, "utf-8").trim() !== myPollerId) return; } catch { return; }

		setTimeout(poll, 1000);

		if (process.env.PI_IS_SUBAGENT === "true" || process.env.PI_SPECULATE === "true" || !lastCtx || agentBusy) return;

		const fn = lastCtx.ui?.getEditorText;
		if (!fn) return;
		const text = (fn() || "").trim();

		if (!text || text.startsWith("/") || text.startsWith("!") || text.length < MIN_PROMPT_LENGTH) {
			lastSeenText = text; stableCount = 0; return;
		}

		if (text === lastSeenText) {
			stableCount++;
		} else {
			if (getRunningSpecPid() && pendingSpeculationPrompt && text !== pendingSpeculationPrompt) killActive();
			lastSeenText = text; stableCount = 0; return;
		}

		// Trigger once after 3s stable, then never again for same text
		if (stableCount === 3 && text !== pendingSpeculationPrompt && !getRunningSpecPid()) {
			speculate(text, lastCtx);
			stableCount = 999;
		}
	}
	setTimeout(poll, 2000); // Initial delay to let ctx populate

	// ─── Tool gating for speculation subprocess ───
	pi.on("tool_call", async (event: any) => {
		if (process.env.PI_SPECULATE !== "true") return undefined;
		const ofs = new OverlayFS(process.env.PI_SPECULATION_OVERLAY_ID);
		if (event.toolName === "read") { const p = event.input.path; if (p && fs.existsSync(ofs.toOverlay(p))) event.input.path = ofs.toOverlay(p); return undefined; }
		if (event.toolName === "edit") { const p = event.input.path; if (p) event.input.path = ofs.ensureInOverlay(p); return undefined; }
		if (event.toolName === "write") { const p = event.input.path; if (p) event.input.path = ofs.toOverlay(p); return undefined; }
		if (event.toolName === "bash") { if (!isReadOnlyBash(event.input.command || "")) return { block: true, reason: "Speculation: read-only bash only." }; return undefined; }
		return { block: true, reason: `"${event.toolName}" blocked in speculation.` };
	});

	// ─── Input hook: accept/cancel speculation ───
	pi.on("input", async (event: any, ctx: any) => {
		const text = (event.text || "").trim();

		// Check for completion
		if (pendingSpeculationPrompt && fs.existsSync(path.join(OVERLAY_ROOT, "result.txt")) && !getRunningSpecPid()) {
			if (ctx.hasUI) { ctx.ui.setStatus("speculation", undefined); ctx.ui.notify("Speculation ready! Type prompt to accept.", "success"); }
		}

		// Cancel if different text
		if (getRunningSpecPid() && text !== pendingSpeculationPrompt) {
			killActive();
			if (ctx.hasUI) { ctx.ui.setStatus("speculation", undefined); ctx.ui.notify("Speculation cancelled.", "info"); }
			return { action: "continue" };
		}

		// Accept if matching
		if (pendingSpeculationPrompt && text === pendingSpeculationPrompt && !getRunningSpecPid()) {
			const resFile = path.join(OVERLAY_ROOT, "result.txt");
			if (!fs.existsSync(resFile)) return { action: "continue" };
			try {
				const result = fs.readFileSync(resFile, "utf-8");
				let meta: any = {};
				try { meta = JSON.parse(fs.readFileSync(path.join(OVERLAY_ROOT, "meta.json"), "utf-8")); } catch { }

				let assistantText = "";
				for (const line of result.split("\n")) {
					try { const e = JSON.parse(line); if (e.type === "message_end" && e.message?.role === "assistant") for (const b of (e.message.content || [])) if (b.type === "text" && b.text?.trim()) assistantText += b.text + "\n"; } catch { }
				}

				if (assistantText) pi.sendMessage({ customType: "speculation-accepted", content: `**⚡ Speculation Result:**\n\n${assistantText.trim()}`, display: true }, { triggerTurn: false });

				if (meta.overlayId) {
					const ofs = new OverlayFS(meta.overlayId);
					if (fs.existsSync(ofs.root) && ctx.hasUI && await ctx.ui.confirm("Apply Changes", "Copy overlay files?")) {
						const copied = ofs.accept();
						if (copied.length > 0) ctx.ui.notify(`Applied ${copied.length} files.`, "success");
					}
				}

				pendingSpeculationPrompt = null; speculationSessionId = null;
				try { fs.rmSync(OVERLAY_ROOT, { recursive: true, force: true }); } catch { }
				return { action: "handled" };
			} catch (err: any) { if (ctx.hasUI) ctx.ui.notify(`Error: ${err.message}`, "error"); }
		}
		return { action: "continue" };
	});
}
