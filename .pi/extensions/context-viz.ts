/**
 * Context Usage Visualizer Extension
 *
 * Registers /context command to visualize context window usage with a colored bar.
 * Also updates a status bar indicator showing context % on each turn_end.
 *
 * Based on Claude Code's commands/context/ pattern.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const BAR_WIDTH = 40;
const FILLED_CHAR = "█";
const EMPTY_CHAR = "░";

function getColorLabel(percent: number): string {
	if (percent >= 90) return "RED";
	if (percent >= 70) return "YEL";
	return "GRN";
}

function getStatusIcon(percent: number): string {
	if (percent >= 90) return "[!]";
	if (percent >= 70) return "[~]";
	return "[.]";
}

function buildBar(percent: number): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * BAR_WIDTH);
	const empty = BAR_WIDTH - filled;
	return FILLED_CHAR.repeat(filled) + EMPTY_CHAR.repeat(empty);
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

function renderContextDisplay(usage: { tokens: number | null; contextWindow: number; percent: number | null }): string {
	const lines: string[] = [];

	lines.push("Context Window Usage");
	lines.push("════════════════════");

	if (usage.tokens == null || usage.percent == null) {
		lines.push("");
		lines.push("Token count unavailable (pending after compaction).");
		lines.push(`Context window: ${formatTokens(usage.contextWindow)}`);
		return lines.join("\n");
	}

	const percent = usage.percent;
	const colorTag = getColorLabel(percent);
	const bar = buildBar(percent);

	lines.push("");
	lines.push(`[${bar}] ${percent.toFixed(1)}% [${colorTag}]`);
	lines.push("");
	lines.push(`Used:      ${formatTokens(usage.tokens)} tokens`);
	lines.push(`Total:     ${formatTokens(usage.contextWindow)} tokens`);
	lines.push(`Available: ${formatTokens(usage.contextWindow - usage.tokens)} tokens`);
	lines.push("");

	if (percent >= 90) {
		lines.push("⚠ Context nearly full — compaction imminent.");
	} else if (percent >= 70) {
		lines.push("Context usage is elevated. Consider compacting soon.");
	} else {
		lines.push("Context usage is healthy.");
	}

	return lines.join("\n");
}

export default function contextViz(pi: ExtensionAPI) {
	// /context command — full visualization
	pi.registerCommand("context", {
		description: "Visualize context window usage with a bar chart",
		handler: async (_args, ctx) => {
			const usage = ctx.getContextUsage();
			if (!usage) {
				ctx.ui.notify("Context usage data not available (no model or context window).", "warn");
				return;
			}
			ctx.ui.notify(renderContextDisplay(usage), "info");
		},
	});

	// Status bar updater — runs after each turn
	pi.on("turn_end", async (_event, ctx) => {
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens == null || usage.percent == null) {
			ctx.ui.setStatus("context-viz", undefined);
			return;
		}
		const icon = getStatusIcon(usage.percent);
		ctx.ui.setStatus("context-viz", `${icon} ctx ${usage.percent.toFixed(0)}%`);
	});

	// Clear status on session reset
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("context-viz", undefined);
	});

	pi.on("session_switch", async (_event, ctx) => {
		ctx.ui.setStatus("context-viz", undefined);
	});
}
