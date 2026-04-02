/**
 * Cron Scheduler Extension
 *
 * Provides scheduled task execution via /cron commands.
 * Based on Claude Code's utils/cronScheduler.ts pattern.
 *
 * Commands:
 *   /cron add <interval> <task>  — Schedule a recurring task (e.g. '5m run tests')
 *   /cron list                   — Show all active scheduled tasks
 *   /cron remove <id>            — Remove a specific task by ID
 *   /cron clear                  — Remove all scheduled tasks
 *
 * Features:
 *   - Interval parsing: '30s', '5m', '1h'
 *   - Jitter: random 0-10% of interval to avoid synchronized firing
 *   - Max 10 concurrent tasks
 *   - Status bar display of active cron count
 *   - Persistence via pi.appendEntry, restored on session start
 *   - Cleanup on session_shutdown
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

interface CronTask {
	id: string;
	intervalMs: number;
	intervalStr: string;
	task: string;
	lastRun: number | null;
	nextRun: number;
	createdAt: number;
}

interface CronPersistData {
	tasks: Array<Omit<CronTask, "nextRun"> & { nextRun: number }>;
}

const MAX_TASKS = 10;

export default function cronScheduler(pi: ExtensionAPI) {
	const tasks = new Map<string, CronTask>();
	const timers = new Map<string, ReturnType<typeof setInterval>>();
	let idCounter = 0;

	// ─── Interval Parsing ───

	function parseInterval(str: string): number | null {
		const match = str.match(/^(\d+(?:\.\d+)?)(s|m|h)$/i);
		if (!match) return null;
		const value = parseFloat(match[1]);
		const unit = match[2].toLowerCase();
		switch (unit) {
			case "s":
				return value * 1000;
			case "m":
				return value * 60 * 1000;
			case "h":
				return value * 60 * 60 * 1000;
			default:
				return null;
		}
	}

	function formatMs(ms: number): string {
		if (ms >= 3600000) return `${(ms / 3600000).toFixed(1)}h`;
		if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
		return `${(ms / 1000).toFixed(0)}s`;
	}

	function addJitter(intervalMs: number): number {
		const jitter = Math.random() * 0.1 * intervalMs;
		return intervalMs + jitter;
	}

	function generateId(): string {
		idCounter++;
		return `cron-${idCounter}`;
	}

	// ─── Task Management ───

	function startTimer(task: CronTask) {
		// Clear existing timer if any
		stopTimer(task.id);

		const jitteredInterval = addJitter(task.intervalMs);
		const timer = setInterval(() => {
			fireCronTask(task);
		}, jitteredInterval);

		timers.set(task.id, timer);
	}

	function stopTimer(id: string) {
		const timer = timers.get(id);
		if (timer) {
			clearInterval(timer);
			timers.delete(id);
		}
	}

	function stopAllTimers() {
		for (const [id] of timers) {
			stopTimer(id);
		}
	}

	function fireCronTask(task: CronTask) {
		const now = Date.now();
		task.lastRun = now;
		task.nextRun = now + task.intervalMs;
		persist();

		// Deliver task as a follow-up user message
		pi.sendUserMessage(task.task, { deliverAs: "followUp" });
	}

	function addTask(intervalStr: string, taskDescription: string): CronTask | string {
		if (tasks.size >= MAX_TASKS) {
			return `Maximum of ${MAX_TASKS} concurrent tasks reached. Remove a task first.`;
		}

		const intervalMs = parseInterval(intervalStr);
		if (!intervalMs || intervalMs <= 0) {
			return `Invalid interval '${intervalStr}'. Use format like '30s', '5m', '1h'.`;
		}

		if (intervalMs < 10000) {
			return "Minimum interval is 10s to avoid excessive firing.";
		}

		const id = generateId();
		const now = Date.now();
		const task: CronTask = {
			id,
			intervalMs,
			intervalStr,
			task: taskDescription,
			lastRun: null,
			nextRun: now + intervalMs,
			createdAt: now,
		};

		tasks.set(id, task);
		startTimer(task);
		persist();
		updateStatus();
		return task;
	}

	function removeTask(id: string): boolean {
		const task = tasks.get(id);
		if (!task) return false;
		stopTimer(id);
		tasks.delete(id);
		persist();
		updateStatus();
		return true;
	}

	function clearAllTasks(): number {
		const count = tasks.size;
		stopAllTimers();
		tasks.clear();
		persist();
		updateStatus();
		return count;
	}

	// ─── Persistence ───

	function persist() {
		const data: CronPersistData = {
			tasks: Array.from(tasks.values()),
		};
		pi.appendEntry<CronPersistData>("cron-scheduler", data);
	}

	function restoreFromBranch(ctx: ExtensionContext) {
		stopAllTimers();
		tasks.clear();

		let latestData: CronPersistData | null = null;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "cron-scheduler") {
				const data = entry.data as CronPersistData | undefined;
				if (data) latestData = data;
			}
		}

		if (latestData?.tasks) {
			const now = Date.now();
			for (const saved of latestData.tasks) {
				// Update nextRun relative to now
				const task: CronTask = {
					...saved,
					nextRun: now + saved.intervalMs,
				};
				// Ensure idCounter stays ahead
				const numPart = parseInt(task.id.replace("cron-", ""), 10);
				if (!isNaN(numPart) && numPart >= idCounter) {
					idCounter = numPart + 1;
				}
				tasks.set(task.id, task);
				startTimer(task);
			}
		}

		updateStatus();
	}

	// ─── Status Bar ───

	function updateStatus() {
		const count = tasks.size;
		if (count > 0) {
			pi.setStatus("cron-scheduler", `cron: ${count} task${count !== 1 ? "s" : ""}`);
		} else {
			pi.setStatus("cron-scheduler", "");
		}
	}

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
		restoreFromBranch(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopAllTimers();
	});

	// ─── Command ───

	pi.registerCommand("cron", {
		description: "Manage scheduled tasks: add <interval> <task>, list, remove <id>, clear",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();

			if (!trimmed || trimmed === "help") {
				ctx.ui.notify(
					[
						"Cron Scheduler",
						"──────────────",
						"/cron add <interval> <task>  — Schedule a task (e.g. '5m run tests')",
						"/cron list                   — Show active tasks",
						"/cron remove <id>            — Remove a task",
						"/cron clear                  — Remove all tasks",
						"",
						"Intervals: 30s, 5m, 1h (minimum 10s)",
						`Tasks: ${tasks.size}/${MAX_TASKS}`,
					].join("\n"),
					"info",
				);
				return;
			}

			const parts = trimmed.split(/\s+/);
			const subcommand = parts[0].toLowerCase();

			if (subcommand === "add") {
				if (parts.length < 3) {
					ctx.ui.notify("Usage: /cron add <interval> <task>\nExample: /cron add 5m run tests", "warning");
					return;
				}
				const intervalStr = parts[1];
				const taskDescription = parts.slice(2).join(" ");
				const result = addTask(intervalStr, taskDescription);
				if (typeof result === "string") {
					ctx.ui.notify(result, "warning");
				} else {
					ctx.ui.notify(
						`Scheduled task ${result.id}: "${result.task}" every ${result.intervalStr}`,
						"info",
					);
				}
			} else if (subcommand === "list") {
				if (tasks.size === 0) {
					ctx.ui.notify("No scheduled tasks.", "info");
					return;
				}
				const now = Date.now();
				const lines = [`Active tasks (${tasks.size}/${MAX_TASKS})`, "─".repeat(40)];
				for (const task of tasks.values()) {
					const untilNext = Math.max(0, task.nextRun - now);
					const lastRunStr = task.lastRun ? `${formatMs(now - task.lastRun)} ago` : "never";
					lines.push(
						`${task.id}: "${task.task}"`,
						`  every ${task.intervalStr} | last: ${lastRunStr} | next: ~${formatMs(untilNext)}`,
					);
				}
				ctx.ui.notify(lines.join("\n"), "info");
			} else if (subcommand === "remove") {
				if (parts.length < 2) {
					ctx.ui.notify("Usage: /cron remove <id>", "warning");
					return;
				}
				const id = parts[1];
				if (removeTask(id)) {
					ctx.ui.notify(`Removed task ${id}.`, "info");
				} else {
					ctx.ui.notify(`Task '${id}' not found. Use /cron list to see active tasks.`, "warning");
				}
			} else if (subcommand === "clear") {
				const count = clearAllTasks();
				ctx.ui.notify(`Cleared ${count} task${count !== 1 ? "s" : ""}.`, "info");
			} else {
				ctx.ui.notify(`Unknown subcommand '${subcommand}'. Use /cron for help.`, "warning");
			}
		},
	});
}
