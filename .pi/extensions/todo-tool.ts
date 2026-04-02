/**
 * Todo Tool Extension — Claude Code TodoWriteTool pattern
 *
 * Registers a `todo` custom tool the LLM uses proactively to manage task lists.
 *
 * Three states: pending, in_progress, completed.
 * Each task has `content` (imperative: 'Run tests') and `status`.
 *
 * Rules (from Claude Code's TodoWriteTool):
 * - Use for 3+ step tasks, don't use for trivial single-step tasks
 * - Exactly ONE task in_progress at a time
 * - Mark tasks complete IMMEDIATELY when done
 *
 * Tool actions:
 * - create: creates a full task list (replaces any existing)
 * - update: change status of one task by id
 * - list:   show current tasks
 *
 * State is stored in tool result details for branch-correct behavior.
 * Includes renderCall/renderResult for TUI display with checkmarks and progress.
 * Registers /todos command for users to view the list.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ─── Types ───

type TaskStatus = "pending" | "in_progress" | "completed";

interface Task {
	id: number;
	content: string;
	status: TaskStatus;
}

interface TodoDetails {
	action: "create" | "update" | "list";
	tasks: Task[];
	nextId: number;
	error?: string;
}

// ─── Tool Parameters ───

const TodoParams = Type.Object({
	action: StringEnum(["create", "update", "list"] as const),
	tasks: Type.Optional(
		Type.Array(
			Type.Object({
				content: Type.String({ description: "Imperative task description, e.g. 'Run tests'" }),
				status: StringEnum(["pending", "in_progress", "completed"] as const),
			}),
			{ description: "Full task list (for create)" },
		),
	),
	id: Type.Optional(Type.Number({ description: "Task ID to update (for update)" })),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed"] as const, {
			description: "New status (for update)",
		}),
	),
});

// ─── Status rendering helpers ───

function statusIcon(status: TaskStatus, theme: Theme): string {
	switch (status) {
		case "completed":
			return theme.fg("success", "✓");
		case "in_progress":
			return theme.fg("accent", "▶");
		case "pending":
			return theme.fg("dim", "○");
	}
}

function statusLabel(status: TaskStatus): string {
	switch (status) {
		case "completed":
			return "completed";
		case "in_progress":
			return "in_progress";
		case "pending":
			return "pending";
	}
}

function progressSummary(tasks: Task[]): string {
	const completed = tasks.filter((t) => t.status === "completed").length;
	const inProgress = tasks.filter((t) => t.status === "in_progress").length;
	const pending = tasks.filter((t) => t.status === "pending").length;
	return `${completed}/${tasks.length} done` +
		(inProgress > 0 ? `, ${inProgress} active` : "") +
		(pending > 0 ? `, ${pending} pending` : "");
}

function taskToPlainText(task: Task): string {
	const icon = task.status === "completed" ? "[x]" : task.status === "in_progress" ? "[>]" : "[ ]";
	return `${icon} #${task.id}: ${task.content}`;
}

// ─── TUI Component for /todos ───

class TodoListComponent {
	private tasks: Task[];
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(tasks: Task[], theme: Theme, onClose: () => void) {
		this.tasks = tasks;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " Tasks ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.tasks.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No tasks. The agent creates tasks for multi-step work.")}`, width));
		} else {
			lines.push(truncateToWidth(`  ${th.fg("muted", progressSummary(this.tasks))}`, width));
			lines.push("");

			// Show in_progress first, then pending, then completed
			const ordered = [
				...this.tasks.filter((t) => t.status === "in_progress"),
				...this.tasks.filter((t) => t.status === "pending"),
				...this.tasks.filter((t) => t.status === "completed"),
			];

			for (const task of ordered) {
				const icon = statusIcon(task.status, th);
				const id = th.fg("accent", `#${task.id}`);
				const text =
					task.status === "completed"
						? th.fg("dim", task.content)
						: task.status === "in_progress"
							? th.fg("text", th.bold(task.content))
							: th.fg("muted", task.content);
				lines.push(truncateToWidth(`  ${icon} ${id} ${text}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ─── Extension ───

export default function (pi: ExtensionAPI) {
	let tasks: Task[] = [];
	let nextId = 1;

	// ─── State Reconstruction ───

	const reconstructState = (ctx: ExtensionContext) => {
		tasks = [];
		nextId = 1;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

			const details = msg.details as TodoDetails | undefined;
			if (details && !details.error) {
				tasks = details.tasks;
				nextId = details.nextId;
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_switch", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_fork", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	// ─── Validation helpers ───

	function validateOneInProgress(taskList: Task[], excludeId?: number): string | null {
		const inProgress = taskList.filter((t) => t.status === "in_progress" && t.id !== excludeId);
		if (inProgress.length > 1) {
			return `Only one task can be in_progress at a time. Currently active: ${inProgress.map((t) => `#${t.id}`).join(", ")}`;
		}
		return null;
	}

	function makeResult(action: TodoDetails["action"], error?: string): {
		content: Array<{ type: "text"; text: string }>;
		details: TodoDetails;
	} {
		return {
			content: [
				{
					type: "text",
					text: error
						? `Error: ${error}`
						: tasks.length === 0
							? "No tasks"
							: tasks.map(taskToPlainText).join("\n"),
				},
			],
			details: { action, tasks: [...tasks.map((t) => ({ ...t }))], nextId, ...(error ? { error } : {}) },
		};
	}

	// ─── Register Tool ───

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: [
			"Manage a task list to track multi-step work. Use for tasks with 3+ steps.",
			"Do NOT use for trivial single-step tasks.",
			"Actions:",
			"  create — replace the entire task list. Provide `tasks` array with content (imperative verb phrase) and status.",
			"  update — change one task's status by `id` and `status`. Mark tasks complete IMMEDIATELY when done.",
			"  list   — show all current tasks.",
			"Rules: exactly ONE task may be in_progress at a time.",
		].join("\n"),
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			switch (params.action) {
				case "create": {
					if (!params.tasks || params.tasks.length === 0) {
						return makeResult("create", "tasks array required for create");
					}

					// Assign IDs and validate
					const newTasks: Task[] = params.tasks.map((t, i) => ({
						id: i + 1,
						content: t.content,
						status: t.status,
					}));

					const inProgressCount = newTasks.filter((t) => t.status === "in_progress").length;
					if (inProgressCount > 1) {
						return makeResult("create", "Only one task can be in_progress at a time");
					}

					tasks = newTasks;
					nextId = tasks.length + 1;

					return {
						content: [
							{
								type: "text",
								text: `Created ${tasks.length} tasks:\n${tasks.map(taskToPlainText).join("\n")}`,
							},
						],
						details: { action: "create", tasks: [...tasks.map((t) => ({ ...t }))], nextId } as TodoDetails,
					};
				}

				case "update": {
					if (params.id === undefined) {
						return makeResult("update", "id required for update");
					}
					if (!params.status) {
						return makeResult("update", "status required for update");
					}

					const task = tasks.find((t) => t.id === params.id);
					if (!task) {
						return makeResult("update", `Task #${params.id} not found`);
					}

					// If setting to in_progress, check no other task is already in_progress
					if (params.status === "in_progress") {
						const conflict = validateOneInProgress(tasks, task.id);
						if (conflict) {
							return makeResult("update", conflict);
						}
					}

					const oldStatus = task.status;
					task.status = params.status;

					return {
						content: [
							{
								type: "text",
								text: `Task #${task.id} "${task.content}": ${oldStatus} → ${task.status}`,
							},
						],
						details: { action: "update", tasks: [...tasks.map((t) => ({ ...t }))], nextId } as TodoDetails,
					};
				}

				case "list": {
					return makeResult("list");
				}

				default:
					return makeResult("list", `Unknown action: ${params.action}`);
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.action === "create" && args.tasks) {
				text += theme.fg("dim", ` (${args.tasks.length} tasks)`);
			}
			if (args.action === "update") {
				if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
				if (args.status) text += ` → ${theme.fg("muted", args.status)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			const taskList = details.tasks;

			switch (details.action) {
				case "create": {
					let output = theme.fg("success", "✓ ") + theme.fg("muted", `Created ${taskList.length} tasks`);
					if (expanded) {
						for (const t of taskList) {
							output += `\n${statusIcon(t.status, theme)} ${theme.fg("accent", `#${t.id}`)} ${theme.fg("muted", t.content)}`;
						}
					}
					return new Text(output, 0, 0);
				}

				case "update": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}

				case "list": {
					if (taskList.length === 0) {
						return new Text(theme.fg("dim", "No tasks"), 0, 0);
					}
					let output = theme.fg("muted", progressSummary(taskList));
					const display = expanded ? taskList : taskList.slice(0, 8);
					for (const t of display) {
						const icon = statusIcon(t.status, theme);
						const content =
							t.status === "completed"
								? theme.fg("dim", t.content)
								: t.status === "in_progress"
									? theme.fg("text", t.content)
									: theme.fg("muted", t.content);
						output += `\n${icon} ${theme.fg("accent", `#${t.id}`)} ${content}`;
					}
					if (!expanded && taskList.length > 8) {
						output += `\n${theme.fg("dim", `... ${taskList.length - 8} more`)}`;
					}
					return new Text(output, 0, 0);
				}
			}
		},
	});

	// ─── /todos Command ───

	pi.registerCommand("todos", {
		description: "Show all tasks on the current branch",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TodoListComponent(tasks, theme, () => done());
			});
		},
	});
}
