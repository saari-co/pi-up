/**
 * Thinkback Extension — Session Replay Animation
 *
 * /thinkback command that analyzes session history, extracts milestones,
 * and generates an animated ASCII replay of the coding journey.
 *
 * Uses ctx.ui.custom() with a Component that renders animation frames.
 * All lines are truncated to terminal width via truncateToWidth() to
 * prevent TUI crashes.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

// ─── Types ───

interface Milestone {
	turn: number;
	type: "start" | "file_read" | "file_write" | "file_edit" | "bash" | "error" | "fix" | "decision" | "complete";
	label: string;
	detail?: string;
	timestamp: number;
}

interface SessionStats {
	turns: number;
	filesRead: Set<string>;
	filesWritten: Set<string>;
	filesEdited: Set<string>;
	bashCommands: number;
	errors: number;
	milestones: Milestone[];
	startTime: number;
	endTime: number;
}

interface AnimationFrame {
	lines: string[];
	label: string;
	delay: number;
}

// ─── ANSI helpers ───

const ESC = "\x1b[";
const bold = (s: string) => `${ESC}1m${s}${ESC}0m`;
const dim = (s: string) => `${ESC}2m${s}${ESC}0m`;
const red = (s: string) => `${ESC}31m${s}${ESC}0m`;
const green = (s: string) => `${ESC}32m${s}${ESC}0m`;
const yellow = (s: string) => `${ESC}33m${s}${ESC}0m`;
const blue = (s: string) => `${ESC}34m${s}${ESC}0m`;
const magenta = (s: string) => `${ESC}35m${s}${ESC}0m`;
const cyan = (s: string) => `${ESC}36m${s}${ESC}0m`;
const white = (s: string) => `${ESC}37m${s}${ESC}0m`;

// ─── Session Analysis ───

function analyzeSession(ctx: ExtensionContext): SessionStats {
	const entries = ctx.sessionManager.getEntries();
	const stats: SessionStats = {
		turns: 0,
		filesRead: new Set(),
		filesWritten: new Set(),
		filesEdited: new Set(),
		bashCommands: 0,
		errors: 0,
		milestones: [],
		startTime: Date.now(),
		endTime: Date.now(),
	};

	let turnCount = 0;
	let firstTimestampMs = 0;
	let lastTimestampMs = 0;

	/** Parse timestamp (ISO string or epoch ms) to epoch ms */
	function parseTs(ts: any): number {
		if (!ts) return 0;
		if (typeof ts === "number") return ts;
		if (typeof ts === "string") {
			const d = new Date(ts);
			return isNaN(d.getTime()) ? 0 : d.getTime();
		}
		return 0;
	}

	// First pass: build a map of toolCallId -> args from assistant tool_use blocks
	const toolArgsMap = new Map<string, Record<string, any>>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "toolCall" && block.id) {
					toolArgsMap.set(block.id, (block as any).arguments || {});
				}
			}
		}
	}

	// Second pass: walk entries and extract milestones
	for (const entry of entries) {
		const tsMs = parseTs(entry.timestamp);
		if (tsMs > 0) {
			if (!firstTimestampMs) firstTimestampMs = tsMs;
			lastTimestampMs = tsMs;
		}

		if (entry.type !== "message") continue;
		const msg = entry.message;

		if (msg.role === "user" && !("customType" in msg)) {
			turnCount++;
			if (turnCount === 1) {
				let text = "";
				if (typeof msg.content === "string") text = msg.content;
				else if (Array.isArray(msg.content)) {
					for (const block of msg.content) {
						if (block.type === "text") { text = (block as any).text; break; }
					}
				}
				if (text) {
					stats.milestones.push({
						turn: turnCount, type: "start",
						label: text.slice(0, 70) + (text.length > 70 ? "..." : ""),
						timestamp: tsMs || Date.now(),
					});
				}
			}
		}

		if (msg.role === "toolResult") {
			const toolName = msg.toolName;
			// Get args from the assistant's toolCall block (not from toolResult)
			const args = toolArgsMap.get(msg.toolCallId || "") || {};
			const filePath = (args.path || args.file_path || "") as string;

			if (toolName === "read" && filePath) {
				if (!stats.filesRead.has(filePath)) {
					stats.filesRead.add(filePath);
					if (stats.filesRead.size <= 8) {
						stats.milestones.push({
							turn: turnCount, type: "file_read",
							label: "Read " + shortenPath(filePath),
							timestamp: tsMs || Date.now(),
						});
					}
				}
			} else if (toolName === "write" && filePath) {
				stats.filesWritten.add(filePath);
				stats.milestones.push({
					turn: turnCount, type: "file_write",
					label: "Created " + shortenPath(filePath),
					timestamp: tsMs || Date.now(),
				});
			} else if (toolName === "edit" && filePath) {
				stats.filesEdited.add(filePath);
				stats.milestones.push({
					turn: turnCount, type: "file_edit",
					label: "Edited " + shortenPath(filePath),
					timestamp: tsMs || Date.now(),
				});
			} else if (toolName === "bash") {
				stats.bashCommands++;
				const command = (args.command || "") as string;
				if (command) {
					const shortCmd = command.split("\n")[0].slice(0, 50);
					if (stats.bashCommands <= 5 ||
						command.includes("test") ||
						command.includes("build") ||
						command.includes("install")) {
						stats.milestones.push({
							turn: turnCount, type: "bash",
							label: "$ " + shortCmd,
							timestamp: tsMs || Date.now(),
						});
					}
				}
				if (msg.isError) {
					stats.errors++;
					stats.milestones.push({
						turn: turnCount, type: "error",
						label: "Hit an error",
						detail: getTextContent(msg).slice(0, 50),
						timestamp: tsMs || Date.now(),
					});
				}
			}
		}

		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type !== "text") continue;
				const text = (block as any).text as string;
				if (text && text.includes("##") && stats.milestones.length < 30) {
					const heading = text.match(/^##\s+(.{5,50})/m);
					if (heading && !heading[1].includes("```")) {
						stats.milestones.push({
							turn: turnCount, type: "decision",
							label: heading[1].trim(),
							timestamp: tsMs || Date.now(),
						});
					}
				}
			}
		}
	}

	stats.turns = turnCount;
	stats.startTime = firstTimestampMs || Date.now();
	stats.endTime = lastTimestampMs || Date.now();

	if (stats.milestones.length > 0) {
		stats.milestones.push({
			turn: turnCount, type: "complete",
			label: "Session snapshot",
			timestamp: stats.endTime,
		});
	}

	return stats;
}

function getTextContent(msg: any): string {
	if (!msg.content) return "";
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) {
		return msg.content
			.filter((b: any) => b.type === "text")
			.map((b: any) => b.text)
			.join("\n");
	}
	return "";
}

function shortenPath(p: string): string {
	const parts = p.split("/");
	if (parts.length <= 2) return p;
	return ".../" + parts.slice(-2).join("/");
}

// ─── Frame Generation ───

function getIcon(type: Milestone["type"]): string {
	switch (type) {
		case "start": return ">";
		case "file_read": return "R";
		case "file_write": return "+";
		case "file_edit": return "~";
		case "bash": return "$";
		case "error": return "!";
		case "fix": return "*";
		case "decision": return "?";
		case "complete": return "#";
		default: return ".";
	}
}

function getColor(type: Milestone["type"]): (s: string) => string {
	switch (type) {
		case "start": return cyan;
		case "file_read": return blue;
		case "file_write": return green;
		case "file_edit": return yellow;
		case "bash": return white;
		case "error": return red;
		case "fix": return green;
		case "decision": return magenta;
		case "complete": return cyan;
		default: return (s: string) => s;
	}
}

function generateFrames(stats: SessionStats, width: number): AnimationFrame[] {
	const frames: AnimationFrame[] = [];
	const safeWidth = Math.max(40, width - 2);
	const barWidth = Math.min(safeWidth - 6, 60);

	// Intro
	frames.push({
		lines: [
			"",
			"  " + bold(cyan("pi")) + " " + bold("THINKBACK"),
			"  " + dim("-".repeat(Math.min(34, safeWidth - 4))),
			"",
			dim("  Loading session data..."),
		],
		label: "intro",
		delay: 800,
	});

	const totalFiles = stats.filesRead.size + stats.filesWritten.size + stats.filesEdited.size;
	frames.push({
		lines: [
			"",
			"  " + bold(cyan("pi")) + " " + bold("THINKBACK"),
			"  " + dim("-".repeat(Math.min(34, safeWidth - 4))),
			"",
			"  Turns: " + stats.turns + "  Files: " + totalFiles + "  Commands: " + stats.bashCommands,
			"",
			dim("  Replaying your journey..."),
		],
		label: "stats",
		delay: 1500,
	});

	// Milestone frames
	const milestones = stats.milestones.slice(0, 25);
	const total = milestones.length;

	for (let i = 0; i < total; i++) {
		const m = milestones[i];
		const progress = (i + 1) / total;
		const filled = Math.floor(barWidth * progress);
		const progressBar = green("#".repeat(filled)) + dim(".".repeat(barWidth - filled));

		const icon = getIcon(m.type);
		const colorFn = getColor(m.type);

		// Timeline: show last 4 milestones faded, then current highlighted
		const timeline: string[] = [];
		const histStart = Math.max(0, i - 4);
		for (let j = histStart; j < i; j++) {
			const prev = milestones[j];
			const pIcon = getIcon(prev.type);
			const age = i - j;
			const label = prev.label.slice(0, safeWidth - 12);
			if (age > 3) {
				timeline.push("  " + dim("| " + pIcon + " " + label));
			} else {
				timeline.push("  " + dim("|") + " " + pIcon + " " + label);
			}
		}

		timeline.push("  " + dim("|"));
		const currentLabel = m.label.slice(0, safeWidth - 12);
		timeline.push("  " + yellow(">") + " " + colorFn(bold(icon + " " + currentLabel)));
		if (m.detail) {
			timeline.push("  " + dim("|   " + m.detail.slice(0, safeWidth - 14)));
		}
		timeline.push("  " + dim("|"));

		const turnInfo = "Turn " + m.turn + "/" + stats.turns;
		const stepInfo = (i + 1) + "/" + total;

		const lines = [
			"",
			"  " + dim(turnInfo) + "  " + dim(stepInfo),
			"  " + progressBar,
			"",
			...timeline,
			"",
			dim("  [space=pause  arrows=nav  +/-=speed  q=quit]"),
		];

		frames.push({
			lines,
			label: m.label,
			delay: m.type === "error" ? 1200 : m.type === "start" ? 1500 : 600,
		});
	}

	// Summary frame
	const duration = Math.round((stats.endTime - stats.startTime) / 1000);
	const durationStr = duration > 3600
		? Math.floor(duration / 3600) + "h " + Math.floor((duration % 3600) / 60) + "m"
		: duration > 60
			? Math.floor(duration / 60) + "m " + (duration % 60) + "s"
			: duration + "s";

	const fileLines: string[] = [];
	for (const f of [...stats.filesWritten].slice(0, 5)) {
		fileLines.push("    " + green("+") + " " + shortenPath(f));
	}
	for (const f of [...stats.filesEdited].slice(0, 5)) {
		fileLines.push("    " + yellow("~") + " " + shortenPath(f));
	}

	const sep = "  " + "-".repeat(Math.min(40, safeWidth - 4));
	frames.push({
		lines: [
			"",
			sep,
			"  " + bold("SESSION COMPLETE"),
			sep,
			"  Duration:    " + durationStr,
			"  Turns:       " + stats.turns,
			"  Files R/W/E: " + stats.filesRead.size + " / " + stats.filesWritten.size + " / " + stats.filesEdited.size,
			"  Commands:    " + stats.bashCommands,
			"  Errors:      " + stats.errors,
			sep,
			"  " + bold("Files touched:"),
			...fileLines,
			sep,
			"",
			"  Press " + bold("q") + " or " + bold("esc") + " to exit",
			"",
			dim("  pi thinkback - your coding story, replayed"),
		],
		label: "summary",
		delay: 0,
	});

	return frames;
}

// ─── Animation Component ───

class ThinkbackComponent {
	private frames: AnimationFrame[];
	private currentFrame: number = 0;
	private paused: boolean = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private tui: { requestRender: () => void };
	private onClose: () => void;
	private speedMultiplier: number = 1;
	private cachedLines: string[] = [];
	private cachedWidth: number = 0;
	private version: number = 0;
	private cachedVersion: number = -1;

	constructor(
		tui: { requestRender: () => void },
		frames: AnimationFrame[],
		onClose: () => void,
	) {
		this.tui = tui;
		this.frames = frames;
		this.onClose = onClose;
		this.scheduleNext();
	}

	private scheduleNext(): void {
		if (this.timer) clearTimeout(this.timer);
		const frame = this.frames[this.currentFrame];
		if (!frame || frame.delay === 0) return;

		this.timer = setTimeout(() => {
			if (this.paused) return;
			if (this.currentFrame < this.frames.length - 1) {
				this.currentFrame++;
				this.version++;
				this.tui.requestRender();
				this.scheduleNext();
			}
		}, frame.delay / this.speedMultiplier);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "q") || matchesKey(data, "escape")) {
			this.dispose();
			this.onClose();
			return;
		}

		if (matchesKey(data, " ")) {
			this.paused = !this.paused;
			if (!this.paused) this.scheduleNext();
			this.version++;
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "right") || matchesKey(data, "l")) {
			if (this.currentFrame < this.frames.length - 1) {
				this.currentFrame++;
				this.version++;
				this.tui.requestRender();
				if (!this.paused) this.scheduleNext();
			}
			return;
		}

		if (matchesKey(data, "left") || matchesKey(data, "h")) {
			if (this.currentFrame > 0) {
				this.currentFrame--;
				this.version++;
				this.tui.requestRender();
				if (!this.paused) this.scheduleNext();
			}
			return;
		}

		if (data === "+" || data === "=") {
			this.speedMultiplier = Math.min(4, this.speedMultiplier * 1.5);
			if (!this.paused) this.scheduleNext();
			return;
		}

		if (data === "-" || data === "_") {
			this.speedMultiplier = Math.max(0.25, this.speedMultiplier / 1.5);
			if (!this.paused) this.scheduleNext();
			return;
		}
	}

	render(width: number): string[] {
		if (this.cachedVersion === this.version && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const frame = this.frames[this.currentFrame];
		if (!frame) return ["(no frames)"];

		const lines = [...frame.lines];

		if (this.paused) {
			lines.push("");
			lines.push("  " + yellow(bold("PAUSED")) + "  " + dim("speed: " + this.speedMultiplier.toFixed(1) + "x"));
		}

		// CRITICAL: truncate every line to terminal width to prevent TUI crash
		this.cachedLines = lines.map((line) => truncateToWidth(line, width));
		this.cachedWidth = width;
		this.cachedVersion = this.version;

		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedVersion = -1;
	}

	dispose(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}
}

// ─── Extension ───

export default function thinkback(pi: ExtensionAPI) {
	pi.registerCommand("thinkback", {
		description: "Replay your session as an animated ASCII timeline",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Thinkback requires interactive mode", "error");
				return;
			}

			const stats = analyzeSession(ctx);

			if (stats.milestones.length === 0) {
				ctx.ui.notify("No milestones found in this session yet. Do some work first!", "info");
				return;
			}

			ctx.ui.notify(
				"Found " + stats.milestones.length + " milestones across " + stats.turns + " turns. Starting replay...",
				"info",
			);

			await new Promise((resolve) => setTimeout(resolve, 500));

			await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
				const frames = generateFrames(stats, 80);
				return new ThinkbackComponent(tui, frames, () => done());
			});
		},
	});
}
