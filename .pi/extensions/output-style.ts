/**
 * Output Style Extension
 *
 * Based on Claude Code's constants/outputStyles.ts pattern.
 * Provides response style presets that modify agent behavior:
 * - default: no modification
 * - concise: 1-3 sentences, skip explanations
 * - explanatory: explain choices, add Insight boxes
 * - teaching: pause to ask user to write small code pieces
 *
 * Features:
 * - /style command to cycle through or set presets
 * - Style prompt injection via before_agent_start
 * - Footer status showing current style
 * - Persistence via appendEntry, restore on session lifecycle
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ─── Style Definitions ───

interface StylePreset {
	name: string;
	label: string;
	description: string;
	prompt: string | null;
}

const STYLE_PRESETS: StylePreset[] = [
	{
		name: "default",
		label: "Default",
		description: "Standard response style, no modification",
		prompt: null,
	},
	{
		name: "concise",
		label: "Concise",
		description: "1-3 sentences, skip explanations",
		prompt: [
			"RESPONSE STYLE: Concise",
			"- Respond in 1-3 sentences maximum unless the user explicitly asks for detail.",
			"- Skip explanations of what you did or why unless asked.",
			"- No preamble, no summaries, no sign-offs.",
			"- Code output only when directly requested or necessary to show a fix.",
		].join("\n"),
	},
	{
		name: "explanatory",
		label: "Explanatory",
		description: "Explain implementation choices, add Insight boxes",
		prompt: [
			"RESPONSE STYLE: Explanatory",
			"- Explain your implementation choices and reasoning.",
			"- After non-trivial changes, include an **Insight** box:",
			"  > **Insight:** <brief explanation of why this approach was chosen over alternatives>",
			"- When multiple approaches exist, briefly mention why you picked this one.",
			"- Still be efficient — explain decisions, not basics.",
		].join("\n"),
	},
	{
		name: "teaching",
		label: "Teaching",
		description: "Pause to ask user to write small code pieces",
		prompt: [
			"RESPONSE STYLE: Teaching",
			"- Act as a mentor guiding the user through the task.",
			"- Before implementing non-trivial pieces, pause and ask the user:",
			'  "Before I write this, try writing the <specific piece> yourself. What would you do?"',
			"- After the user responds (or asks you to continue), provide the implementation with explanation.",
			"- Point out patterns, gotchas, and learning opportunities.",
			"- Use **Try it:** prompts for small exercises the user can attempt.",
			"- If the user seems impatient, switch to implementing directly but keep explanations.",
		].join("\n"),
	},
];

const STYLE_NAMES = STYLE_PRESETS.map((s) => s.name);

// ─── Persistence Types ───

interface StyleState {
	currentStyle: string;
}

export default function outputStyle(pi: ExtensionAPI) {
	let currentStyle = "default";

	// ─── Helpers ───

	function getPreset(name: string): StylePreset | undefined {
		return STYLE_PRESETS.find((s) => s.name === name);
	}

	function persist() {
		pi.appendEntry<StyleState>("output-style", { currentStyle });
	}

	function restoreFromBranch(ctx: ExtensionContext) {
		currentStyle = "default";
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "output-style") {
				const data = entry.data as StyleState | undefined;
				if (data?.currentStyle && STYLE_NAMES.includes(data.currentStyle)) {
					currentStyle = data.currentStyle;
				}
			}
		}
		updateStatus(ctx);
	}

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (currentStyle === "default") {
			ctx.ui.setStatus("output-style", "");
		} else {
			const preset = getPreset(currentStyle);
			ctx.ui.setStatus("output-style", `Style: ${preset?.label ?? currentStyle}`);
		}
	}

	// ─── Style Prompt Injection ───

	pi.on("before_agent_start", async (event, ctx) => {
		const preset = getPreset(currentStyle);
		if (preset?.prompt) {
			event.systemPrompt += `\n\n${preset.prompt}`;
		}
	});

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

	// ─── /style Command ───

	pi.registerCommand("style", {
		description: "Set response style preset (default, concise, explanatory, teaching)",
		handler: async (args, ctx) => {
			const requested = args?.trim().toLowerCase();

			if (requested && STYLE_NAMES.includes(requested)) {
				// Direct set
				currentStyle = requested;
				persist();
				updateStatus(ctx);
				const preset = getPreset(currentStyle)!;
				ctx.ui.notify(`Style set to: ${preset.label} — ${preset.description}`, "info");
				return;
			}

			if (requested && !STYLE_NAMES.includes(requested)) {
				ctx.ui.notify(
					`Unknown style "${requested}". Available: ${STYLE_NAMES.join(", ")}`,
					"warning",
				);
				return;
			}

			// No args — show interactive select
			if (!ctx.hasUI) {
				ctx.ui.notify(`Current style: ${currentStyle}. Use /style <name> to change.`, "info");
				return;
			}

			const options = STYLE_PRESETS.map((s) => ({
				label: `${s.label}${s.name === currentStyle ? " (current)" : ""}`,
				value: s.name,
				description: s.description,
			}));

			const selected = await ctx.ui.select("Select response style:", options);
			if (!selected) return;

			currentStyle = selected;
			persist();
			updateStatus(ctx);
			const preset = getPreset(currentStyle)!;
			ctx.ui.notify(`Style set to: ${preset.label} — ${preset.description}`, "info");
		},
	});
}
