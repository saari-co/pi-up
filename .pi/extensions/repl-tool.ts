import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ─── Pi REPLTool: Persistent Interactive Runtimes ───
// Inspired by Claude Code's REPLTool concept (ant-only, IDEAS #51).
// Unlike Claude's REPL which is a web bridge, ours is a true persistent
// runtime — keeps Python/Node/Bash processes alive across turns.

// ─── Constants ───
const MAX_SESSIONS = 3;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;  // 10 minutes
const COMMAND_TIMEOUT_MS = 30_000;         // 30 seconds per command
const MAX_OUTPUT_BYTES = 50 * 1024;        // 50KB output cap
const END_MARKER = "___PI_REPL_END_" + Date.now().toString(36) + "___";

const SUPPORTED_LANGUAGES: Record<string, { cmd: string; args: string[]; initCode?: string }> = {
	python3: {
		cmd: "python3",
		args: ["-u", "-i"],  // -u unbuffered, -i interactive
		initCode: "import sys; sys.ps1 = ''; sys.ps2 = ''\n",
	},
	node: {
		cmd: "node",
		args: ["--interactive"],
		initCode: "",
	},
	bash: {
		cmd: "bash",
		args: ["--norc", "--noprofile", "-i"],
		initCode: "PS1=''; PS2=''\n",
	},
};

// ─── REPLSession Class ───
class REPLSession {
	readonly id: string;
	readonly language: string;
	readonly proc: ChildProcess;
	readonly createdAt: number;
	lastUsedAt: number;
	private buffer: string = "";
	private pendingResolve: ((result: { stdout: string; stderr: string; timedOut: boolean }) => void) | null = null;
	private stderrBuffer: string = "";

	constructor(id: string, language: string) {
		const lang = SUPPORTED_LANGUAGES[language];
		if (!lang) throw new Error(`Unsupported language: ${language}`);

		this.id = id;
		this.language = language;
		this.createdAt = Date.now();
		this.lastUsedAt = Date.now();

		this.proc = spawn(lang.cmd, lang.args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, TERM: "dumb", PYTHONDONTWRITEBYTECODE: "1" },
		});

		this.proc.stdout?.on("data", (data: Buffer) => {
			this.buffer += data.toString();
			this.checkForMarker();
		});

		this.proc.stderr?.on("data", (data: Buffer) => {
			this.stderrBuffer += data.toString();
		});

		this.proc.on("exit", () => {
			if (this.pendingResolve) {
				this.pendingResolve({ stdout: this.buffer, stderr: this.stderrBuffer, timedOut: false });
				this.pendingResolve = null;
			}
		});

		// Send init code to suppress prompts
		if (lang.initCode) {
			this.proc.stdin?.write(lang.initCode);
		}
	}

	get isAlive(): boolean {
		return !this.proc.killed && this.proc.exitCode === null;
	}

	private checkForMarker(): void {
		const idx = this.buffer.indexOf(END_MARKER);
		if (idx !== -1 && this.pendingResolve) {
			const output = this.buffer.slice(0, idx);
			this.buffer = this.buffer.slice(idx + END_MARKER.length);
			// Truncate if too large
			const truncated = output.length > MAX_OUTPUT_BYTES
				? output.slice(0, MAX_OUTPUT_BYTES) + `\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]`
				: output;
			this.pendingResolve({ stdout: truncated.trim(), stderr: this.stderrBuffer.trim(), timedOut: false });
			this.pendingResolve = null;
			this.stderrBuffer = "";
		}
	}

	async execute(code: string): Promise<{ stdout: string; stderr: string; timedOut: boolean }> {
		if (!this.isAlive) {
			return { stdout: "", stderr: "Session has exited.", timedOut: false };
		}

		this.lastUsedAt = Date.now();
		this.buffer = "";
		this.stderrBuffer = "";

		return new Promise((resolve) => {
			this.pendingResolve = resolve;

			// Write code followed by the end marker echo
			let markerCmd: string;
			if (this.language === "python3") {
				markerCmd = `\nprint("${END_MARKER}")\n`;
			} else if (this.language === "node") {
				markerCmd = `\nconsole.log("${END_MARKER}")\n`;
			} else {
				markerCmd = `\necho "${END_MARKER}"\n`;
			}

			this.proc.stdin?.write(code + markerCmd);

			// Timeout
			const timer = setTimeout(() => {
				if (this.pendingResolve) {
					const partial = this.buffer.trim();
					this.pendingResolve = null;
					resolve({
						stdout: partial || "[no output before timeout]",
						stderr: this.stderrBuffer.trim(),
						timedOut: true,
					});
				}
			}, COMMAND_TIMEOUT_MS);

			// Clear timeout when resolved normally
			const origResolve = this.pendingResolve;
			this.pendingResolve = (result) => {
				clearTimeout(timer);
				origResolve?.(result);
			};
		});
	}

	kill(): void {
		if (this.isAlive) {
			this.proc.kill("SIGTERM");
			setTimeout(() => { if (this.isAlive) this.proc.kill("SIGKILL"); }, 2000);
		}
	}
}

// ─── REPLManager Singleton ───
class REPLManager {
	private sessions = new Map<string, REPLSession>();
	private cleanupInterval: ReturnType<typeof setInterval> | null = null;

	constructor() {
		// Auto-cleanup idle sessions every 60 seconds
		this.cleanupInterval = setInterval(() => this.cleanupIdle(), 60_000);
	}

	getOrCreate(sessionId: string, language: string): REPLSession {
		let session = this.sessions.get(sessionId);

		// If session exists but is dead, remove it
		if (session && !session.isAlive) {
			this.sessions.delete(sessionId);
			session = undefined;
		}

		// If session exists with different language, error
		if (session && session.language !== language) {
			throw new Error(`Session "${sessionId}" already exists with language "${session.language}". Kill it first or use a different session ID.`);
		}

		if (!session) {
			if (this.sessions.size >= MAX_SESSIONS) {
				// Kill oldest idle session to make room
				let oldest: REPLSession | null = null;
				for (const s of this.sessions.values()) {
					if (!oldest || s.lastUsedAt < oldest.lastUsedAt) oldest = s;
				}
				if (oldest) {
					oldest.kill();
					this.sessions.delete(oldest.id);
				}
			}
			session = new REPLSession(sessionId, language);
			this.sessions.set(sessionId, session);
		}

		return session;
	}

	async execute(sessionId: string, language: string, code: string): Promise<{ stdout: string; stderr: string; timedOut: boolean; sessionId: string }> {
		const session = this.getOrCreate(sessionId, language);
		const result = await session.execute(code);
		return { ...result, sessionId: session.id };
	}

	killSession(sessionId: string): boolean {
		const session = this.sessions.get(sessionId);
		if (session) {
			session.kill();
			this.sessions.delete(sessionId);
			return true;
		}
		return false;
	}

	killAll(): number {
		let count = 0;
		for (const session of this.sessions.values()) {
			session.kill();
			count++;
		}
		this.sessions.clear();
		return count;
	}

	listSessions(): Array<{ id: string; language: string; alive: boolean; idleMs: number; createdAt: number }> {
		return [...this.sessions.entries()].map(([id, s]) => ({
			id,
			language: s.language,
			alive: s.isAlive,
			idleMs: Date.now() - s.lastUsedAt,
			createdAt: s.createdAt,
		}));
	}

	private cleanupIdle(): void {
		const now = Date.now();
		for (const [id, session] of this.sessions) {
			if (now - session.lastUsedAt > IDLE_TIMEOUT_MS) {
				session.kill();
				this.sessions.delete(id);
			}
		}
	}

	destroy(): void {
		if (this.cleanupInterval) clearInterval(this.cleanupInterval);
		this.killAll();
	}
}

// ─── Extension ───
export default function replTool(pi: ExtensionAPI) {
	const manager = new REPLManager();

	// 🛡️ Guardrail: No REPL in subagents or speculation
	if (process.env.PI_IS_SUBAGENT === "true" || process.env.PI_SPECULATE === "true") {
		return; // Don't register the tool at all
	}

	// ─── Register the `repl` tool ───
	pi.registerTool({
		name: "repl",
		label: "REPL",
		description: `Execute code in a persistent REPL session. Unlike bash, the process stays alive between turns — variables, imports, and state persist. Use this for iterative work: data exploration, debugging, testing expressions, or any multi-step computation.

Supported languages: python3, node, bash.

When to use repl vs bash:
- Use \`repl\` for iterative/stateful work (keep variables alive, build up state)
- Use \`bash\` for one-off commands (ls, grep, git, file operations)

Sessions auto-close after 10 minutes of inactivity. Max 3 concurrent sessions.`,
		parameters: Type.Object({
			language: Type.Union([
				Type.Literal("python3"),
				Type.Literal("node"),
				Type.Literal("bash"),
			], { description: "The language runtime to use" }),
			code: Type.String({ description: "Code to execute in the REPL session" }),
			session_id: Type.Optional(Type.String({ description: "Session ID (defaults to language name). Use different IDs for parallel sessions." })),
		}),
		async execute(_toolCallId, params, _signal, onUpdate) {
			const sessionId = params.session_id || params.language;
			onUpdate?.({ content: [{ type: "text", text: `Running in ${params.language} session "${sessionId}"...` }] });

			try {
				const result = await manager.execute(sessionId, params.language, params.code);
				let text = "";
				if (result.stdout) text += result.stdout;
				if (result.stderr) text += (text ? "\n\n" : "") + "STDERR:\n" + result.stderr;
				if (result.timedOut) text += "\n\n⚠️ Command timed out after 30 seconds.";
				if (!text) text = "[no output]";

				return {
					content: [{ type: "text", text }],
					isError: result.timedOut,
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Error: ${err.message}` }],
					isError: true,
				};
			}
		},
	});

	// ─── Commands ───
	pi.registerCommand("repl-status", {
		description: "Show active REPL sessions",
		handler: async (_args: string, ctx: any) => {
			const sessions = manager.listSessions();
			if (sessions.length === 0) {
				if (ctx.hasUI) ctx.ui.notify("No active REPL sessions.", "info");
				return;
			}
			const lines = sessions.map(s => {
				const idle = Math.round(s.idleMs / 1000);
				const age = Math.round((Date.now() - s.createdAt) / 1000);
				return `${s.alive ? "🟢" : "🔴"} ${s.id} (${s.language}) — idle ${idle}s, age ${age}s`;
			});
			if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("repl-kill", {
		description: "Kill REPL session(s). Usage: /repl-kill [session_id|all]",
		handler: async (args: string, ctx: any) => {
			if (args.trim() === "all" || !args.trim()) {
				const count = manager.killAll();
				if (ctx.hasUI) ctx.ui.notify(`Killed ${count} REPL session(s).`, "info");
			} else {
				const killed = manager.killSession(args.trim());
				if (ctx.hasUI) ctx.ui.notify(killed ? `Killed session "${args.trim()}".` : `Session "${args.trim()}" not found.`, killed ? "info" : "error");
			}
		},
	});

	// 🛡️ Guardrail: Kill all sessions on agent end
	pi.on("agent_end", async () => {
		manager.destroy();
	});
}
