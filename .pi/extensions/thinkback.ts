/**
 * Thinkback Extension — Session Replay Animation
 *
 * A /thinkback command that analyzes session history, extracts milestones,
 * and generates an animated ASCII replay of the coding journey.
 *
 * Inspired by Claude Code's commands/thinkback/ — adapted for pi's TUI
 * using ctx.ui.custom() with a Component that renders animation frames.
 *
 * Features:
 * - Reads session history to extract milestones (files, tools, errors, decisions)
 * - Generates personalized ASCII animation frames
 * - Keyboard controls: space=pause, q/esc=quit, left/right=navigate, +/-=speed
 * - Stats summary at the end
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@mariozechner/pi-tui";

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
	delay: number; // ms to show this frame
}

// ─── ANSI helpers (no external deps) ───

const ESC = "\x1b[";
const bold = (s: string) => `${ESC}1m${s}${ESC}0m`;
const dim = (s: string) => `${ESC}2m${s}${ESC}0m`;
const italic = (s: string) => `${ESC}3m${s}${ESC}0m`;
const red = (s: string) => `${ESC}31m${s}${ESC}0m`;
const green = (s: string) => `${ESC}32m${s}${ESC}0m`;
const yellow = (s: string) => `${ESC}33m${s}${ESC}0m`;
const blue = (s: string) => `${ESC}34m${s}${ESC}0m`;
const magenta = (s: string) => `${ESC}35m${s}${ESC}0m`;
const cyan = (s: string) => `${ESC}36m${s}${ESC}0m`;
const white = (s: string) => `${ESC}37m${s}${ESC}0m`;
const bgBlue = (s: string) => `${ESC}44m${s}${ESC}0m`;

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
	let firstTimestamp = Infinity;
	let lastTimestamp = 0;

	for (const entry of entries) {
		if (entry.timestamp) {
			firstTimestamp = Math.min(firstTimestamp, entry.timestamp);
			lastTimestamp = Math.max(lastTimestamp, entry.timestamp);
		}

		if (entry.type !== "message") continue;
		const msg = entry.message;

		// Count turns
		if (msg.role === "user" && !("customType" in msg)) {
			turnCount++;
			if (turnCount === 1) {
				// Extract first user message as the session goal
				let text = "";
				if (typeof msg.content === "string") text = msg.content;
				else if (Array.isArray(msg.content)) {
					for (const block of msg.content) {
						if (block.type === "text") { text = block.text; break; }
					}
				}
				if (text) {
					stats.milestones.push({
						turn: turnCount,
						type: "start",
						label: text.slice(0, 80) + (text.length > 80 ? "..." : ""),
						timestamp: entry.timestamp || Date.now(),
					});
				}
			}
		}

		// Track tool results
		if (msg.role === "toolResult") {
			const toolName = msg.toolName;
			const path = msg.toolCallArgs?.path as string | undefined;

			if (toolName === "read" && path) {
				if (!stats.filesRead.has(path)) {
					stats.filesRead.add(path);
					if (stats.filesRead.size <= 8) {
						stats.milestones.push({
							turn: turnCount,
							type: "file_read",
							label: `Read ${shortenPath(path)}`,
							timestamp: entry.timestamp || Date.now(),
						});
					}
				}
			} else if (toolName === "write" && path) {
				stats.filesWritten.add(path);
				stats.milestones.push({
					turn: turnCount,
					type: "file_write",
					label: `Created ${shortenPath(path)}`,
					timestamp: entry.timestamp || Date.now(),
				});
			} else if (toolName === "edit" && path) {
				stats.filesEdited.add(path);
				stats.milestones.push({
					turn: turnCount,
					type: "file_edit",
					label: `Edited ${shortenPath(path)}`,
					timestamp: entry.timestamp || Date.now(),
				});
			} else if (toolName === "bash") {
				stats.bashCommands++;
				const command = msg.toolCallArgs?.command as string | undefined;
				if (command) {
					const shortCmd = command.split("\n")[0].slice(0, 60);
					// Only milestone notable commands
					if (stats.bashCommands <= 5 ||
						command.includes("test") ||
						command.includes("build") ||
						command.includes("install")) {
						stats.milestones.push({
							turn: turnCount,
							type: "bash",
							label: `$ ${shortCmd}`,
							timestamp: entry.timestamp || Date.now(),
						});
					}
				}

				// Detect errors
				if (msg.isError) {
					stats.errors++;
					stats.milestones.push({
						turn: turnCount,
						type: "error",
						label: "Hit an error",
						detail: getTextContent(msg).slice(0, 60),
						timestamp: entry.timestamp || Date.now(),
					});
				}
			}
		}

		// Track assistant decisions from text
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type !== "text") continue;
				const text = block.text;
				// Detect key decision moments
				if (text.includes("##") && stats.milestones.length < 30) {
					const heading = text.match(/^##\s+(.{5,60})/m);
					if (heading && !heading[1].includes("```")) {
						stats.milestones.push({
							turn: turnCount,
							type: "decision",
							label: heading[1].trim(),
							timestamp: entry.timestamp || Date.now(),
						});
					}
				}
			}
		}
	}

	stats.turns = turnCount;
	stats.startTime = firstTimestamp === Infinity ? Date.now() : firstTimestamp;
	stats.endTime = lastTimestamp || Date.now();

	// Add completion milestone
	if (stats.milestones.length > 0) {
		stats.milestones.push({
			turn: turnCount,
			type: "complete",
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

const PI_LOGO = [
	`  ╔═══════════════════════════════╗`,
	`  ║        ${bold(cyan("π"))}  ${bold("THINKBACK")}          ║`,
	`  ║     ${dim("Session Replay")}             ║`,
	`  ╚═══════════════════════════════╝`,
];

const PROGRESS_CHARS = ["░", "▒", "▓", "█"];

function generateFrames(stats: SessionStats, width: number): AnimationFrame[] {
	const frames: AnimationFrame[] = [];
	const boxWidth = Math.min(width - 4, 70);
	const inner = boxWidth - 4;

	// ── Intro frames ──
	// Fade-in logo
	frames.push({
		lines: ["", "", "", ...PI_LOGO, "", "", dim("  Loading session data...")],
		label: "intro",
		delay: 800,
	});

	frames.push({
		lines: [
			"", "",
			...PI_LOGO,
			"",
			`  ${cyan("Turns:")} ${bold(String(stats.turns))}  ${cyan("Files:")} ${bold(String(stats.filesRead.size + stats.filesWritten.size + stats.filesEdited.size))}  ${cyan("Commands:")} ${bold(String(stats.bashCommands))}`,
			"",
			dim("  Replaying your journey..."),
			"",
		],
		label: "stats",
		delay: 1500,
	});

	// ── Milestone frames ──
	const milestones = stats.milestones.slice(0, 25); // Cap at 25 milestones
	const totalMilestones = milestones.length;

	for (let i = 0; i < totalMilestones; i++) {
		const m = milestones[i];
		const progress = (i + 1) / totalMilestones;
		const barLen = Math.floor(inner * progress);
		const progressBar =
			green("█".repeat(barLen)) + dim("░".repeat(inner - barLen));

		const icon = getIcon(m.type);
		const colorFn = getColor(m.type);

		// Build the timeline
		const timelineLines: string[] = [];

		// Show last 5 milestones as history
		const historyStart = Math.max(0, i - 4);
		for (let j = historyStart; j < i; j++) {
			const prev = milestones[j];
			const prevIcon = getIcon(prev.type);
			const age = i - j;
			const fader = age > 3 ? dim : age > 1 ? (s: string) => s : bold;
			timelineLines.push(`  ${dim("│")} ${fader(`${prevIcon} ${prev.label}`)}`);
		}

		// Current milestone (highlighted)
		timelineLines.push(`  ${dim("│")}`);
		timelineLines.push(`  ${yellow("▸")} ${colorFn(bold(`${icon} ${m.label}`))}`);
		if (m.detail) {
			timelineLines.push(`  ${dim("│")}   ${dim(m.detail)}`);
		}
		timelineLines.push(`  ${dim("│")}`);

		const lines = [
			"",
			`  ${dim(`Turn ${m.turn}/${stats.turns}`)}${" ".repeat(Math.max(0, boxWidth - 24))}${dim(`${i + 1}/${totalMilestones}`)}`,
			`  ${progressBar}`,
			"",
			...timelineLines,
			"",
			dim(`  [${"space"}=pause  ${"←→"}=navigate  ${"+/-"}=speed  ${"q"}=quit]`),
		];

		frames.push({
			lines,
			label: m.label,
			delay: m.type === "error" ? 1200 : m.type === "start" ? 1500 : 600,
		});
	}

	// ── Summary frame ──
	const duration = Math.round((stats.endTime - stats.startTime) / 1000);
	const durationStr = duration > 3600
		? `${Math.floor(duration / 3600)}h ${Math.floor((duration % 3600) / 60)}m`
		: duration > 60
			? `${Math.floor(duration / 60)}m ${duration % 60}s`
			: `${duration}s`;

	const filesList: string[] = [];
	for (const f of [...stats.filesWritten].slice(0, 6)) {
		filesList.push(`    ${green("+")} ${shortenPath(f)}`);
	}
	for (const f of [...stats.filesEdited].slice(0, 6)) {
		filesList.push(`    ${yellow("~")} ${shortenPath(f)}`);
	}

	frames.push({
		lines: [
			"",
			`  ╔${"═".repeat(boxWidth - 2)}╗`,
			`  ║${centerText(bold("SESSION COMPLETE"), boxWidth - 2)}║`,
			`  ╠${"═".repeat(boxWidth - 2)}╣`,
			`  ║${padRight(`  ${cyan("Duration:")}  ${bold(durationStr)}`, boxWidth - 2)}║`,
			`  ║${padRight(`  ${cyan("Turns:")}     ${bold(String(stats.turns))}`, boxWidth - 2)}║`,
			`  ║${padRight(`  ${cyan("Files R/W/E:")} ${green(String(stats.filesRead.size))} / ${yellow(String(stats.filesWritten.size))} / ${magenta(String(stats.filesEdited.size))}`, boxWidth - 2)}║`,
			`  ║${padRight(`  ${cyan("Commands:")}  ${bold(String(stats.bashCommands))}`, boxWidth - 2)}║`,
			`  ║${padRight(`  ${cyan("Errors:")}    ${stats.errors > 0 ? red(String(stats.errors)) : green("0")}`, boxWidth - 2)}║`,
			`  ╠${"═".repeat(boxWidth - 2)}╣`,
			`  ║${padRight(`  ${bold("Files touched:")}`, boxWidth - 2)}║`,
			...filesList.map((l) => `  ║${padRight(l, boxWidth - 2)}║`),
			`  ╚${"═".repeat(boxWidth - 2)}╝`,
			"",
			`  ${dim("Press")} ${bold("q")} ${dim("or")} ${bold("esc")} ${dim("to exit")}`,
			"",
			dim(`  ${bold("π")} thinkback — your coding story, replayed`),
		],
		label: "summary",
		delay: 0, // Stays until user exits
	});

	return frames;
}

function getIcon(type: Milestone["type"]): string {
	switch (type) {
		case "start": return "🎯";
		case "file_read": return "📖";
		case "file_write": return "📝";
		case "file_edit": return "✏️";
		case "bash": return "💻";
		case "error": return "❌";
		case "fix": return "✅";
		case "decision": return "💡";
		case "complete": return "🏁";
		default: return "•";
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

function centerText(text: string, width: number): string {
	const visLen = text.replace(/\x1b\[[0-9;]*m/g, "").length;
	const pad = Math.max(0, Math.floor((width - visLen) / 2));
	const rightPad = Math.max(0, width - visLen - pad);
	return " ".repeat(pad) + text + " ".repeat(rightPad);
}

function padRight(text: string, width: number): string {
	const visLen = text.replace(/\x1b\[[0-9;]*m/g, "").length;
	const pad = Math.max(0, width - visLen);
	return text + " ".repeat(pad);
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
		if (!frame || frame.delay === 0) return; // Last frame stays

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

		// Add pause indicator
		if (this.paused) {
			lines.push("");
			lines.push(`  ${yellow(bold("⏸ PAUSED"))}  ${dim(`speed: ${this.speedMultiplier.toFixed(1)}x`)}`);
		}

		// Pad lines to fill screen width
		this.cachedLines = lines.map((line) => {
			const visLen = line.replace(/\x1b\[[0-9;]*m/g, "").length;
			return line + " ".repeat(Math.max(0, width - visLen));
		});
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
				`Found ${stats.milestones.length} milestones across ${stats.turns} turns. Starting replay...`,
				"info",
			);

			// Small delay so notify is visible
			await new Promise((resolve) => setTimeout(resolve, 500));

			await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
				const frames = generateFrames(stats, 80);
				return new ThinkbackComponent(tui, frames, () => done());
			});
		},
	});
}
