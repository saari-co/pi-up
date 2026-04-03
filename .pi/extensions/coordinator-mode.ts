import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Based on Claude Code: coordinator/coordinatorMode.ts + utils/mailbox.ts
// Coordinator mode: the agent becomes a pure orchestrator that can ONLY
// dispatch workers, read mailbox results, and stop tasks. No direct
// read/edit/bash access.

const MAX_CONCURRENT_WORKERS = 4;
const MAX_WORKER_TURNS = 20;
const WORKER_TIMEOUT_MS = 90_000;
const MAILBOX_ROOT = "/tmp/pi-mailbox";

interface Worker {
	id: string;
	prompt: string;
	files: string[];
	proc: ChildProcess;
	killTimer: ReturnType<typeof setTimeout>;
	status: "running" | "done" | "failed" | "killed";
	result?: string;
	startedAt: number;
}

let coordinatorActive = false;
let sessionId = "";
const workers = new Map<string, Worker>();

// ─── Mailbox System (IDEAS #48) ───
function getMailboxDir(): string {
	const dir = path.join(MAILBOX_ROOT, sessionId);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function writeToMailbox(workerId: string, data: any): void {
	const file = path.join(getMailboxDir(), `${workerId}.json`);
	fs.writeFileSync(file, JSON.stringify({ ...data, timestamp: Date.now() }, null, 2));
}

function readMailbox(): Record<string, any> {
	const dir = getMailboxDir();
	const results: Record<string, any> = {};
	if (!fs.existsSync(dir)) return results;
	for (const file of fs.readdirSync(dir)) {
		if (!file.endsWith(".json")) continue;
		try {
			results[file.replace(".json", "")] = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
		} catch { /* skip corrupt */ }
	}
	return results;
}

function clearMailbox(): void {
	const dir = getMailboxDir();
	try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ─── Worker Management ───
function generateWorkerId(): string {
	return "w-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

function killWorker(w: Worker): void {
	clearTimeout(w.killTimer);
	if (w.proc && !w.proc.killed) w.proc.kill("SIGTERM");
	if (w.status === "running") w.status = "killed";
}

function killAllWorkers(): void {
	for (const w of workers.values()) killWorker(w);
}

function getRunningCount(): number {
	return [...workers.values()].filter(w => w.status === "running").length;
}

function spawnWorker(prompt: string, files: string[], ctx: any): Worker {
	const id = generateWorkerId();
	const currentDepth = parseInt(process.env.PI_SUBAGENT_DEPTH || "0", 10);
	const model = process.env.PI_BATCH_MODEL || "gemini-2.5-flash";

	const args = [
		process.argv[1]!,
		"--model", model,
		"--mode", "json",
		"--no-session",
		"-p", prompt,
	];

	const proc = spawn(process.argv[0], args, {
		cwd: process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			PI_IS_SUBAGENT: "true",
			PI_SUBAGENT_DEPTH: (currentDepth + 1).toString(),
			PI_ALLOWED_PATHS: files.join(","),
			PI_COORDINATOR_SESSION: sessionId,
			PI_WORKER_ID: id,
		},
	});

	let output = "";
	let turnCount = 0;

	proc.stdout.on("data", (d: Buffer) => {
		const chunk = d.toString();
		output += chunk;
		for (const line of chunk.split("\n")) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line);
				if (event.type === "message_end" && event.message?.role === "assistant") {
					turnCount++;
					if (turnCount >= MAX_WORKER_TURNS) {
						if (!proc.killed) proc.kill("SIGTERM");
					}
				}
			} catch { /* not JSON */ }
		}
	});

	proc.stderr.on("data", (d: Buffer) => { output += d.toString(); });

	const killTimer = setTimeout(() => {
		if (!proc.killed) {
			proc.kill("SIGTERM");
			const w = workers.get(id);
			if (w) w.status = "killed";
			writeToMailbox(id, { status: "killed", reason: "timeout", turns: turnCount });
			if (ctx.hasUI) ctx.ui.notify(`Worker ${id} killed (timeout after ${WORKER_TIMEOUT_MS / 1000}s)`, "error");
		}
	}, WORKER_TIMEOUT_MS);

	proc.on("close", (code) => {
		clearTimeout(killTimer);
		const w = workers.get(id);
		if (w && w.status === "running") {
			w.status = code === 0 ? "done" : "failed";
			w.result = output;
		}
		// Parse final assistant text for mailbox
		let assistantText = "";
		for (const line of output.split("\n")) {
			try {
				const event = JSON.parse(line);
				if (event.type === "message_end" && event.message?.role === "assistant") {
					const tb = event.message.content?.find((c: any) => c.type === "text");
					if (tb?.text) assistantText = tb.text;
				}
			} catch { /* not JSON */ }
		}
		writeToMailbox(id, {
			status: code === 0 ? "done" : "failed",
			exitCode: code,
			turns: turnCount,
			files,
			prompt,
			result: assistantText.slice(0, 5000), // Truncate for mailbox
		});
		if (ctx.hasUI) {
			const emoji = code === 0 ? "✅" : "❌";
			ctx.ui.notify(`${emoji} Worker ${id} finished (${turnCount} turns, exit ${code})`, code === 0 ? "success" : "error");
		}
	});

	const worker: Worker = { id, prompt, files, proc, killTimer, status: "running", startedAt: Date.now() };
	workers.set(id, worker);
	return worker;
}

export default function coordinatorMode(pi: ExtensionAPI) {
	// ─── /coordinate command ───
	pi.registerCommand("coordinate", {
		description: "Enter coordinator mode — dispatch workers, no direct tool access",
		handler: async (_args: string, ctx: any) => {
			coordinatorActive = true;
			sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
			clearMailbox();
			if (ctx.hasUI) {
				ctx.ui.notify("🎯 Coordinator Mode Activated\n- Direct tools (bash, read, etc) are BLOCKED.\n- Use dispatch_agent to assign tasks.\n- Use /uncoordinate to exit.", "success");
				ctx.ui.setStatus("coordinator", "🎯 Coordinator Mode");
			}
		},
	});

	// ─── /coordinate-status command ───
	pi.registerCommand("coordinate-status", {
		description: "Show active workers and mailbox status",
		handler: async (_args: string, ctx: any) => {
			if (!coordinatorActive) {
				if (ctx.hasUI) ctx.ui.notify("Not in coordinator mode. Use /coordinate to start.", "info");
				return;
			}
			const running = [...workers.values()].filter(w => w.status === "running");
			const done = [...workers.values()].filter(w => w.status === "done");
			const failed = [...workers.values()].filter(w => w.status !== "running" && w.status !== "done");
			const mailbox = readMailbox();
			const lines = [
				`Workers: ${running.length} running, ${done.length} done, ${failed.length} failed/killed`,
				`Mailbox: ${Object.keys(mailbox).length} entries`,
				...running.map(w => `  🔄 ${w.id}: "${w.prompt.slice(0, 60)}..." (${Math.round((Date.now() - w.startedAt) / 1000)}s)`),
			];
			if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ─── /uncoordinate command ───
	pi.registerCommand("uncoordinate", {
		description: "Kill all workers and exit coordinator mode",
		handler: async (_args: string, ctx: any) => {
			killAllWorkers();
			coordinatorActive = false;
			if (ctx.hasUI) {
				ctx.ui.setStatus("coordinator", undefined);
				ctx.ui.notify("Coordinator mode deactivated. All workers killed.", "info");
			}
		},
	});

	// ─── Register tools on session_start so refreshTools() is wired up ───
	pi.on("session_start", async () => {

	// ─── dispatch_agent tool ───
	pi.registerTool({
		name: "dispatch_agent",
		label: "Dispatch Agent",
		description: "Dispatch a worker agent with a specific task. Only available in coordinator mode.",
		parameters: {
			type: "object",
			properties: {
				prompt: { type: "string", description: "The task description for the worker" },
				files: {
					type: "array",
					items: { type: "string" },
					description: "Files/directories this worker is allowed to touch",
				},
			},
			required: ["prompt", "files"],
		},
		async execute(_toolCallId: string, params: any, _signal: any, onUpdate: any, ctx: any) {
			if (!coordinatorActive) {
				return {
					content: [{ type: "text", text: "Error: Not in coordinator mode. Use /coordinate first." }],
					isError: true,
				};
			}

			if (process.env.PI_IS_SUBAGENT === "true") {
				return {
					content: [{ type: "text", text: "Error: Cannot dispatch from within a subagent." }],
					isError: true,
				};
			}

			if (getRunningCount() >= MAX_CONCURRENT_WORKERS) {
				return {
					content: [{ type: "text", text: `Error: Max concurrent workers (${MAX_CONCURRENT_WORKERS}) reached. Wait for a worker to finish or use /uncoordinate.` }],
					isError: true,
				};
			}

			const worker = spawnWorker(params.prompt, params.files, ctx);
			onUpdate?.({ content: [{ type: "text", text: `Dispatched worker ${worker.id}` }] });

			return {
				content: [{ type: "text", text: `Worker ${worker.id} dispatched.\nPrompt: ${params.prompt}\nFiles: ${params.files.join(", ")}\nUse read_mailbox to check results.` }],
			};
		},
	});

	// ─── read_mailbox tool ───
	pi.registerTool({
		name: "read_mailbox",
		label: "Read Mailbox",
		description: "Read results from dispatched workers. Only available in coordinator mode.",
		parameters: {
			type: "object",
			properties: {
				worker_id: { type: "string", description: "Specific worker ID to read, or omit for all" },
			},
		},
		async execute(_toolCallId: string, params: any) {
			if (!coordinatorActive) {
				return {
					content: [{ type: "text", text: "Error: Not in coordinator mode." }],
					isError: true,
				};
			}

			const mailbox = readMailbox();
			if (params.worker_id) {
				const entry = mailbox[params.worker_id];
				if (!entry) {
					return { content: [{ type: "text", text: `No mailbox entry for worker ${params.worker_id}. It may still be running.` }] };
				}
				return { content: [{ type: "text", text: JSON.stringify(entry, null, 2) }] };
			}

			if (Object.keys(mailbox).length === 0) {
				return { content: [{ type: "text", text: "Mailbox is empty. Workers may still be running." }] };
			}

			return { content: [{ type: "text", text: JSON.stringify(mailbox, null, 2) }] };
		},
	});

	}); // end session_start

	// ─── tool_call gate: block direct tools in coordinator mode ───
	pi.on("tool_call", async (event: any) => {
		if (!coordinatorActive) return undefined;

		const allowed = new Set(["dispatch_agent", "read_mailbox", "todo", "tool_search"]);
		if (allowed.has(event.toolName)) return undefined;

		return {
			block: true,
			reason: `Coordinator mode: you can only use dispatch_agent and read_mailbox. Cannot use "${event.toolName}" directly — dispatch a worker instead.`,
		};
	});
}
