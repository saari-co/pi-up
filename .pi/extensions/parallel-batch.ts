/**
 * Parallel Batch Extension
 *
 * Orchestrates large-scale codebase changes using parallel subagent workers,
 * each in an isolated git worktree. Inspired by Claude Code's batch skill
 * (src/skills/bundled/batch.ts) and worktree management (src/utils/worktree.ts),
 * adapted for pi's subagent extension pattern.
 *
 * Architecture:
 * - Coordinator (this extension) plans the work, creates worktrees, spawns workers
 * - Workers (batch-worker agent) each get their own git worktree with a unique branch
 * - Each worker: implements -> reviews -> tests -> commits -> pushes -> PRs
 * - Coordinator tracks progress and reports results
 *
 * Source references:
 * - Claude Code: src/skills/bundled/batch.ts (orchestration prompt)
 * - Claude Code: src/utils/worktree.ts (createAgentWorktree, removeAgentWorktree)
 * - Pi: examples/extensions/subagent/ (parallel pi process spawning)
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ─── Constants ───

const MAX_WORKERS = 30;
const MAX_CONCURRENCY = 4;
const WORKTREE_PREFIX = "batch";

// ─── Types ───

interface WorkerUnit {
	index: number;
	title: string;
	files: string[];
	description: string;
}

interface WorktreeInfo {
	path: string;
	branch: string;
	slug: string;
}

interface WorkerResult {
	unit: WorkerUnit;
	worktree: WorktreeInfo;
	exitCode: number;
	output: string;
	prUrl?: string;
	branch?: string;
	commitSha?: string;
	error?: string;
	messages: Message[];
	usage: { input: number; output: number; cost: number; turns: number };
}

interface BatchState {
	id: string;
	instruction: string;
	units: WorkerUnit[];
	results: WorkerResult[];
	worktrees: WorktreeInfo[];
	gitRoot: string;
	startTime: number;
	status: "planning" | "running" | "complete" | "failed";
}

interface BatchToolDetails {
	action: string;
	state?: BatchState;
	results?: WorkerResult[];
}

// ─── Git Worktree Management (adapted from Claude Code src/utils/worktree.ts) ───

async function findGitRoot(cwd: string): Promise<string | null> {
	return new Promise((resolve) => {
		const proc = spawn("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		proc.stdout.on("data", (d) => (stdout += d.toString()));
		proc.on("close", (code) => resolve(code === 0 ? stdout.trim() : null));
		proc.on("error", () => resolve(null));
	});
}

async function getDefaultBranch(gitRoot: string): Promise<string> {
	return new Promise((resolve) => {
		const proc = spawn("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], {
			cwd: gitRoot,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		proc.stdout.on("data", (d) => (stdout += d.toString()));
		proc.on("close", (code) => {
			if (code === 0 && stdout.trim()) {
				// e.g. "origin/main" -> "main"
				const branch = stdout.trim().replace(/^origin\//, "");
				resolve(branch);
			} else {
				resolve("main");
			}
		});
		proc.on("error", () => resolve("main"));
	});
}

async function execGit(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn("git", args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" },
		});
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d) => (stdout += d.toString()));
		proc.stderr.on("data", (d) => (stderr += d.toString()));
		proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
		proc.on("error", (err) => resolve({ code: 1, stdout: "", stderr: err.message }));
	});
}

/**
 * Create a git worktree for a batch worker.
 * Adapted from Claude Code's createAgentWorktree() in src/utils/worktree.ts.
 *
 * Creates: <gitRoot>/.pi/worktrees/<slug>/ on branch worktree-<slug>
 * based on the current HEAD (or origin/default if available).
 */
async function createWorktree(gitRoot: string, slug: string): Promise<WorktreeInfo> {
	const worktreesDir = path.join(gitRoot, ".pi", "worktrees");
	await fs.promises.mkdir(worktreesDir, { recursive: true });

	const worktreePath = path.join(worktreesDir, slug);
	const branch = `worktree-${slug}`;

	// Check if worktree already exists
	try {
		const stat = await fs.promises.stat(worktreePath);
		if (stat.isDirectory()) {
			// Worktree exists, reuse it — reset to HEAD
			await execGit(["checkout", "-B", branch, "HEAD"], worktreePath);
			return { path: worktreePath, branch, slug };
		}
	} catch {
		// Doesn't exist, create it
	}

	// Determine base: prefer origin/default, fall back to HEAD
	const defaultBranch = await getDefaultBranch(gitRoot);
	const { code: fetchCode } = await execGit(["fetch", "origin", defaultBranch, "--depth=1"], gitRoot);
	const base = fetchCode === 0 ? `origin/${defaultBranch}` : "HEAD";

	// Create the worktree with a new branch
	// -B: force-create branch (resets if orphaned from previous run)
	const { code, stderr } = await execGit(
		["worktree", "add", "-B", branch, worktreePath, base],
		gitRoot,
	);

	if (code !== 0) {
		throw new Error(`Failed to create worktree "${slug}": ${stderr.trim()}`);
	}

	// Symlink node_modules to avoid duplication (like Claude Code's symlinkDirectories)
	for (const dir of ["node_modules", ".venv", "vendor"]) {
		const source = path.join(gitRoot, dir);
		const dest = path.join(worktreePath, dir);
		try {
			const stat = await fs.promises.stat(source);
			if (stat.isDirectory()) {
				await fs.promises.symlink(source, dest, "dir");
			}
		} catch {
			// Source doesn't exist or symlink failed — skip
		}
	}

	return { path: worktreePath, branch, slug };
}

/**
 * Remove a git worktree. Adapted from Claude Code's removeAgentWorktree().
 */
async function removeWorktree(gitRoot: string, worktreePath: string, branch: string): Promise<boolean> {
	const { code } = await execGit(["worktree", "remove", "--force", worktreePath], gitRoot);
	if (code !== 0) return false;

	// Delete the branch
	await execGit(["branch", "-D", branch], gitRoot);
	return true;
}

// ─── Subagent Runner (adapted from pi's subagent extension) ───

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	return { command: "pi", args };
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

/**
 * Run a single batch worker in an isolated worktree.
 * Spawns a pi process in JSON mode pointed at the worktree directory.
 */
async function runWorker(
	unit: WorkerUnit,
	worktree: WorktreeInfo,
	prompt: string,
	sessionFile: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate?: (result: WorkerResult) => void,
): Promise<WorkerResult> {
	const result: WorkerResult = {
		unit,
		worktree,
		exitCode: -1,
		output: "",
		messages: [],
		usage: { input: 0, output: 0, cost: 0, turns: 0 },
	};

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (sessionFile) {
		args.push("--fork", sessionFile);
	}
	args.push(prompt);
	const invocation = getPiInvocation(args);

	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn(invocation.command, invocation.args, {
			cwd: worktree.path,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let buffer = "";
		let wasAborted = false;

		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line);
					if (event.type === "message_end" && event.message) {
						const msg = event.message as Message;
						result.messages.push(msg);
						if (msg.role === "assistant") {
							result.usage.turns++;
							const usage = msg.usage;
							if (usage) {
								result.usage.input += usage.input || 0;
								result.usage.output += usage.output || 0;
								result.usage.cost += usage.cost?.total || 0;
							}
						}
						onUpdate?.(result);
					}
					if (event.type === "tool_result_end" && event.message) {
						result.messages.push(event.message as Message);
					}
				} catch {
					// Not JSON, ignore
				}
			}
		});

		let stderr = "";
		proc.stderr.on("data", (d) => (stderr += d.toString()));

		proc.on("close", (code) => {
			if (buffer.trim()) {
				try {
					const event = JSON.parse(buffer);
					if (event.type === "message_end" && event.message) {
						result.messages.push(event.message as Message);
					}
				} catch { /* ignore */ }
			}
			if (stderr) result.error = stderr;
			resolve(code ?? 1);
		});
		proc.on("error", () => resolve(1));

		if (signal) {
			const killProc = () => {
				wasAborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
			};
			if (signal.aborted) killProc();
			else signal.addEventListener("abort", killProc, { once: true });
		}
	});

	result.exitCode = exitCode;
	result.output = getFinalOutput(result.messages);

	// Parse result markers from output
	const prMatch = result.output.match(/PR:\s*(https?:\/\/\S+)/);
	const pushedMatch = result.output.match(/PUSHED:\s*(\S+)/);
	const committedMatch = result.output.match(/COMMITTED:\s*(\S+)/);
	const failedMatch = result.output.match(/FAILED:\s*(.+)/);

	if (prMatch) result.prUrl = prMatch[1];
	else if (pushedMatch) result.branch = pushedMatch[1];
	else if (committedMatch) result.commitSha = committedMatch[1];
	else if (failedMatch) result.error = failedMatch[1];

	return result;
}

/**
 * Run workers with concurrency limit.
 */
async function runWorkersParallel(
	units: WorkerUnit[],
	worktrees: WorktreeInfo[],
	buildPrompt: (unit: WorkerUnit) => string,
	sessionFile: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: (results: WorkerResult[]) => void,
): Promise<WorkerResult[]> {
	const results: WorkerResult[] = new Array(units.length);
	let nextIndex = 0;

	// Initialize placeholder results
	for (let i = 0; i < units.length; i++) {
		results[i] = {
			unit: units[i],
			worktree: worktrees[i],
			exitCode: -1,
			output: "",
			messages: [],
			usage: { input: 0, output: 0, cost: 0, turns: 0 },
		};
	}

	const concurrency = Math.min(MAX_CONCURRENCY, units.length);
	const workers = Array.from({ length: concurrency }, async () => {
		while (true) {
			const idx = nextIndex++;
			if (idx >= units.length) return;

			const prompt = buildPrompt(units[idx]);
			results[idx] = await runWorker(
				units[idx],
				worktrees[idx],
				prompt,
				sessionFile,
				signal,
				(partial) => {
					results[idx] = partial;
					onUpdate(results);
				},
			);
			onUpdate(results);
		}
	});

	await Promise.all(workers);
	return results;
}

// ─── Extension ───

export default function parallelBatch(pi: ExtensionAPI) {
	let currentBatch: BatchState | null = null;

	// Register the batch_orchestrate tool for the LLM to use
	pi.registerTool({
		name: "batch_orchestrate",
		label: "Batch Orchestrate",
		description: [
			"Execute a batch of independent work units in parallel, each in its own git worktree.",
			"The LLM should first plan the units, then call this tool with the full unit list.",
			"Each worker gets an isolated branch, implements the change, tests, commits, and optionally creates a PR.",
			"Max " + MAX_WORKERS + " units, " + MAX_CONCURRENCY + " concurrent workers.",
		].join(" "),
		promptSnippet: "Run parallel batch workers in isolated git worktrees",
		promptGuidelines: [
			"Use batch_orchestrate only after planning and decomposing a large change into independent units.",
			"Each unit must be independently implementable — no shared state between workers.",
			"Provide codebase conventions discovered during research so workers follow them.",
		],
		parameters: Type.Object({
			instruction: Type.String({ description: "The overall change being made (user's original request)" }),
			conventions: Type.String({ description: "Codebase conventions workers should follow" }),
			test_command: Type.Optional(Type.String({ description: "Command to run tests (e.g. 'npm test')" })),
			units: Type.Array(
				Type.Object({
					title: Type.String({ description: "Short title for this unit" }),
					files: Type.Array(Type.String(), { description: "Files/directories this unit touches" }),
					description: Type.String({ description: "What changes to make in this unit" }),
				}),
				{ description: "Work units to execute in parallel", minItems: 1, maxItems: MAX_WORKERS },
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Validate git repo
			const gitRoot = await findGitRoot(ctx.cwd);
			if (!gitRoot) {
				throw new Error("Not in a git repository. Parallel batch requires git for worktree isolation.");
			}

			const batchId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
			const units: WorkerUnit[] = params.units.map((u, i) => ({
				index: i + 1,
				title: u.title,
				files: u.files,
				description: u.description,
			}));

			// Create worktrees for all units
			const worktrees: WorktreeInfo[] = [];
			for (let i = 0; i < units.length; i++) {
				const slug = `${WORKTREE_PREFIX}-${batchId}-${i + 1}`;
				try {
					const wt = await createWorktree(gitRoot, slug);
					worktrees.push(wt);
				} catch (err) {
					// Clean up already-created worktrees
					for (const wt of worktrees) {
						await removeWorktree(gitRoot, wt.path, wt.branch);
					}
					throw new Error(`Failed to create worktree for unit ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}

			currentBatch = {
				id: batchId,
				instruction: params.instruction,
				units,
				results: [],
				worktrees,
				gitRoot,
				startTime: Date.now(),
				status: "running",
			};

			// Build worker prompts
			const buildPrompt = (unit: WorkerUnit): string => {
				const testCmd = params.test_command || "npm test";
				return `You are batch worker ${unit.index}/${units.length} for: ${params.instruction}

## Your Unit: ${unit.title}

${unit.description}

### Files to modify
${unit.files.map((f) => `- ${f}`).join("\n")}

### Codebase Conventions
${params.conventions}

### Workflow
1. Implement the change described above
2. Review your changes for code reuse, quality, and efficiency issues. Fix any you find.
3. Run tests: \`${testCmd}\` — fix failures if related to your changes
4. Commit: \`git add -A && git commit -m "batch(${unit.title.toLowerCase().replace(/\s+/g, "-")}): ${unit.title}"\`
5. Push: \`git push origin HEAD\`
6. Create PR if \`gh\` is available: \`gh pr create --title "${unit.title}" --body "Part of batch: ${params.instruction}" --head ${worktrees[unit.index - 1].branch}\`

### Report
End your response with exactly one of:
- \`PR: <url>\` if PR was created
- \`PUSHED: <branch>\` if pushed without PR
- \`COMMITTED: <sha>\` if committed but couldn't push
- \`FAILED: <reason>\` if you couldn't complete the work`;
			};

			// Emit initial status
			onUpdate?.({
				content: [{ type: "text", text: `Batch ${batchId}: launching ${units.length} workers (${MAX_CONCURRENCY} concurrent)...` }],
				details: { action: "running", state: currentBatch } as BatchToolDetails,
			});

			const currentSessionFile = ctx.sessionManager.getSessionFile();
			let tempSessionFile: string | undefined;

			if (currentSessionFile) {
				tempSessionFile = path.join(os.tmpdir(), `pi-batch-cache-${batchId}.jsonl`);
				try {
					const sessionContent = await fs.promises.readFile(currentSessionFile, "utf-8");
					const lines = sessionContent.split("\n");
					if (lines.length > 0 && lines[lines.length - 1].trim() === "") {
						lines.pop();
					}
					if (lines.length > 0 && lines[lines.length - 1].includes("batch_orchestrate")) {
						lines.pop();
					}
					await fs.promises.writeFile(tempSessionFile, lines.join("\n") + "\n", "utf-8");
				} catch (err) {
					throw new Error(`Failed to create temp session file: ${err instanceof Error ? err.message : String(err)}`);
				}
			}

			// Run workers
			const results = await runWorkersParallel(
				units,
				worktrees,
				buildPrompt,
				tempSessionFile,
				signal,
				(partialResults) => {
					const running = partialResults.filter((r) => r.exitCode === -1).length;
					const done = partialResults.filter((r) => r.exitCode !== -1).length;
					onUpdate?.({
						content: [{ type: "text", text: `Batch ${batchId}: ${done}/${units.length} done, ${running} running...` }],
						details: { action: "running", results: partialResults } as BatchToolDetails,
					});
				},
			);

			currentBatch.results = results;
			currentBatch.status = "complete";

			// Build summary
			const succeeded = results.filter((r) => r.exitCode === 0 && !r.error);
			const failed = results.filter((r) => r.exitCode !== 0 || r.error);
			const prs = results.filter((r) => r.prUrl);
			const pushed = results.filter((r) => r.branch);
			const committed = results.filter((r) => r.commitSha);

			const lines: string[] = [
				`## Batch Complete: ${params.instruction}`,
				"",
				`**${succeeded.length}/${units.length}** units succeeded`,
				"",
				"| # | Unit | Status | Result |",
				"|---|------|--------|--------|",
			];

			for (const r of results) {
				const status = r.exitCode === 0 && !r.error ? "done" : "FAILED";
				let resultCol = "";
				if (r.prUrl) resultCol = `[PR](${r.prUrl})`;
				else if (r.branch) resultCol = `branch: ${r.branch}`;
				else if (r.commitSha) resultCol = `sha: ${r.commitSha.slice(0, 7)}`;
				else if (r.error) resultCol = r.error.slice(0, 50);
				else resultCol = "—";
				lines.push(`| ${r.unit.index} | ${r.unit.title} | ${status} | ${resultCol} |`);
			}

			if (prs.length > 0) {
				lines.push("", "### PRs Created");
				for (const r of prs) {
					lines.push(`- ${r.unit.title}: ${r.prUrl}`);
				}
			}

			if (failed.length > 0) {
				lines.push("", "### Failures");
				for (const r of failed) {
					const reason = r.error || r.output.slice(-200) || "unknown error";
					lines.push(`- **${r.unit.title}**: ${reason.slice(0, 100)}`);
				}
			}

			// Aggregate costs
			const totalCost = results.reduce((sum, r) => sum + r.usage.cost, 0);
			const totalTurns = results.reduce((sum, r) => sum + r.usage.turns, 0);
			const elapsed = ((Date.now() - currentBatch.startTime) / 1000).toFixed(0);
			lines.push("", `### Stats`, `- Time: ${elapsed}s`, `- Total turns: ${totalTurns}`, `- Cost: $${totalCost.toFixed(4)}`);

			const summary = lines.join("\n");

			return {
				content: [{ type: "text", text: summary }],
				details: { action: "complete", state: currentBatch, results } as BatchToolDetails,
			};
		},

		renderCall(args, theme, _context) {
			const unitCount = args.units?.length ?? 0;
			let text = theme.fg("toolTitle", theme.bold("batch_orchestrate "));
			text += theme.fg("accent", `${unitCount} units`);
			if (args.instruction) {
				const preview = args.instruction.length > 60 ? args.instruction.slice(0, 60) + "..." : args.instruction;
				text += "\n  " + theme.fg("dim", preview);
			}
			if (args.units) {
				for (const u of args.units.slice(0, 5)) {
					text += "\n  " + theme.fg("muted", "•") + " " + theme.fg("accent", u.title);
				}
				if (args.units.length > 5) {
					text += "\n  " + theme.fg("muted", `... +${args.units.length - 5} more`);
				}
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as BatchToolDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.action === "running" && details.results) {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const done = details.results.filter((r) => r.exitCode !== -1).length;
				const total = details.results.length;
				const icon = theme.fg("warning", "⏳");
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("batch "))}${theme.fg("accent", `${done}/${total} done, ${running} running`)}`;

				for (const r of details.results) {
					const rIcon = r.exitCode === -1
						? theme.fg("warning", "⏳")
						: r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					text += `\n  ${rIcon} ${theme.fg("accent", r.unit.title)}`;
					if (r.prUrl) text += ` ${theme.fg("dim", r.prUrl)}`;
					else if (r.exitCode === -1) text += ` ${theme.fg("dim", "(running...)")}`;
				}
				return new Text(text, 0, 0);
			}

			if (details.action === "complete" && details.results) {
				const succeeded = details.results.filter((r) => r.exitCode === 0 && !r.error).length;
				const total = details.results.length;
				const allGood = succeeded === total;
				const icon = allGood ? theme.fg("success", "✓") : theme.fg("warning", "◐");

				let text = `${icon} ${theme.fg("toolTitle", theme.bold("batch "))}${theme.fg("accent", `${succeeded}/${total} succeeded`)}`;

				if (expanded) {
					for (const r of details.results) {
						const rIcon = r.exitCode === 0 && !r.error ? theme.fg("success", "✓") : theme.fg("error", "✗");
						text += `\n\n  ${rIcon} ${theme.fg("accent", r.unit.title)}`;
						if (r.prUrl) text += `\n    PR: ${theme.fg("dim", r.prUrl)}`;
						else if (r.branch) text += `\n    Branch: ${theme.fg("dim", r.branch)}`;
						else if (r.error) text += `\n    ${theme.fg("error", r.error.slice(0, 80))}`;

						const usage = `${r.usage.turns} turns, $${r.usage.cost.toFixed(4)}`;
						text += `\n    ${theme.fg("dim", usage)}`;
					}
				} else {
					for (const r of details.results) {
						const rIcon = r.exitCode === 0 && !r.error ? theme.fg("success", "✓") : theme.fg("error", "✗");
						let line = `${rIcon} ${theme.fg("accent", r.unit.title)}`;
						if (r.prUrl) line += ` ${theme.fg("dim", r.prUrl)}`;
						text += `\n  ${line}`;
					}
				}
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});

	// Register /batch-status command
	pi.registerCommand("batch-status", {
		description: "Show current/last batch execution status",
		handler: async (_args, ctx) => {
			if (!currentBatch) {
				ctx.ui.notify("No batch has been executed in this session.", "info");
				return;
			}

			const b = currentBatch;
			const lines = [
				`Batch: ${b.id} (${b.status})`,
				`Instruction: ${b.instruction.slice(0, 80)}`,
				`Units: ${b.units.length}`,
				`Worktrees: ${b.worktrees.length}`,
			];

			if (b.results.length > 0) {
				const succeeded = b.results.filter((r) => r.exitCode === 0).length;
				lines.push(`Results: ${succeeded}/${b.results.length} succeeded`);

				for (const r of b.results) {
					const icon = r.exitCode === 0 ? "✓" : "✗";
					let detail = "";
					if (r.prUrl) detail = r.prUrl;
					else if (r.branch) detail = `branch: ${r.branch}`;
					else if (r.error) detail = `error: ${r.error.slice(0, 50)}`;
					lines.push(`  ${icon} ${r.unit.title} ${detail}`);
				}
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// Register /batch-cleanup command
	pi.registerCommand("batch-cleanup", {
		description: "Remove all worktrees from the last batch",
		handler: async (_args, ctx) => {
			if (!currentBatch || currentBatch.worktrees.length === 0) {
				ctx.ui.notify("No worktrees to clean up.", "info");
				return;
			}

			const ok = await ctx.ui.confirm(
				"Cleanup worktrees?",
				`Remove ${currentBatch.worktrees.length} worktrees from batch ${currentBatch.id}?`,
			);
			if (!ok) return;

			let removed = 0;
			for (const wt of currentBatch.worktrees) {
				if (await removeWorktree(currentBatch.gitRoot, wt.path, wt.branch)) {
					removed++;
				}
			}

			// Prune git worktree list
			await execGit(["worktree", "prune"], currentBatch.gitRoot);

			ctx.ui.notify(`Removed ${removed}/${currentBatch.worktrees.length} worktrees.`, "info");
			currentBatch.worktrees = [];
		},
	});
}
