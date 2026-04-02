/**
 * Buddy Companion Extension
 *
 * Generates a deterministic ASCII art companion based on the username.
 * Based on Claude Code's buddy/prompt.ts concept.
 *
 * - Hashes os.userInfo().username to pick a species and generate stats
 * - Generates a name from adjective+noun lists seeded by hash
 * - Shows companion widget via ctx.ui.setWidget
 * - Injects personality note into systemPrompt via before_agent_start
 * - Registers /buddy command to show full companion card
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as os from "os";

const SPECIES = ["fox", "owl", "cat", "frog", "robot", "ghost", "octopus", "dragon"] as const;
type Species = (typeof SPECIES)[number];

const ADJECTIVES = [
	"Tiny", "Brave", "Sneaky", "Fuzzy", "Cosmic", "Grumpy", "Lucky", "Dizzy",
	"Rusty", "Sparkly", "Witty", "Zappy", "Nimble", "Peppy", "Quirky", "Jolly",
];

const NOUNS = [
	"Byte", "Pixel", "Glitch", "Widget", "Spark", "Blip", "Chip", "Patch",
	"Echo", "Dash", "Bolt", "Fern", "Mote", "Fizz", "Loop", "Rune",
];

const STAT_NAMES = ["DEBUGGING", "PATIENCE", "CHAOS", "WISDOM", "SNARK"] as const;

const ASCII_ART: Record<Species, string[]> = {
	fox: [
		" /\\   /\\",
		"( o . o )",
		" > ^ <",
	],
	owl: [
		" {o,o}",
		" |)__)",
		' -"-"-',
	],
	cat: [
		" /\\_/\\",
		"( o.o )",
		" > ^ <",
	],
	frog: [
		" @..@",
		"(----)",
		"( >__< )",
	],
	robot: [
		" [o_o]",
		"/|===|\\",
		"  d b",
	],
	ghost: [
		"  .-.",
		" (o o)",
		" | O |",
	],
	octopus: [
		"  ,~,",
		" (o o)",
		"//|\\\\|\\\\",
	],
	dragon: [
		"  /\\_/}",
		" ( o.o)",
		"  /|~|\\",
	],
};

/**
 * Simple deterministic hash from a string to a 32-bit integer.
 * Uses FNV-1a for good distribution.
 */
function fnv1a(str: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i);
		hash = (hash * 0x01000193) >>> 0;
	}
	return hash;
}

/** Derive a value 0..max-1 from hash with an offset for independence. */
function pick(hash: number, offset: number, max: number): number {
	const mixed = fnv1a(hash.toString() + ":" + offset.toString());
	return mixed % max;
}

/** Derive a stat value 1-10 from hash. */
function stat(hash: number, index: number): number {
	return (pick(hash, index + 100, 10)) + 1;
}

interface Companion {
	species: Species;
	name: string;
	stats: Record<string, number>;
	art: string[];
}

function generateCompanion(username: string): Companion {
	const hash = fnv1a(username);

	const species = SPECIES[pick(hash, 0, SPECIES.length)];
	const adjective = ADJECTIVES[pick(hash, 1, ADJECTIVES.length)];
	const noun = NOUNS[pick(hash, 2, NOUNS.length)];
	const name = `${adjective} ${noun}`;

	const stats: Record<string, number> = {};
	for (let i = 0; i < STAT_NAMES.length; i++) {
		stats[STAT_NAMES[i]] = stat(hash, i);
	}

	return { species, name, stats, art: ASCII_ART[species] };
}

function formatStatBar(value: number): string {
	return "\u2588".repeat(value) + "\u2591".repeat(10 - value);
}

function buildCompanionCard(c: Companion): string[] {
	const lines: string[] = [];
	lines.push(`--- ${c.name} the ${c.species} ---`);
	lines.push("");
	for (const line of c.art) {
		lines.push("  " + line);
	}
	lines.push("");
	for (const [name, value] of Object.entries(c.stats)) {
		lines.push(`  ${name.padEnd(10)} ${formatStatBar(value)} ${value}/10`);
	}
	return lines;
}

function buildWidgetLines(c: Companion): string[] {
	const statStr = Object.entries(c.stats)
		.map(([k, v]) => `${k.slice(0, 3)}:${v}`)
		.join(" ");
	return [
		`${c.art[0]}  ${c.name} the ${c.species}`,
		`${c.art[1]}  ${statStr}`,
		...(c.art.length > 2 ? [`${c.art[2]}`] : []),
	];
}

export default function buddy(pi: ExtensionAPI) {
	let companion: Companion | null = null;

	function ensureCompanion(): Companion {
		if (!companion) {
			const username = os.userInfo().username;
			companion = generateCompanion(username);
		}
		return companion;
	}

	// Show widget on session start
	pi.on("session_start", async (_event, ctx) => {
		const c = ensureCompanion();
		if (ctx.hasUI) {
			ctx.ui.setWidget("buddy", buildWidgetLines(c), { placement: "aboveEditor" });
		}
	});

	// Inject personality note into system prompt
	pi.on("before_agent_start", async (_event, _ctx) => {
		const c = ensureCompanion();
		return {
			message: {
				customType: "buddy-companion",
				content: `<system-reminder>A small ${c.species} named ${c.name} sits beside the input. When the user addresses ${c.name} directly, respond briefly in character.</system-reminder>`,
				display: false,
			},
		};
	});

	// /buddy command: show full companion card
	pi.registerCommand("buddy", {
		description: "Show your coding companion's full stats card",
		handler: async (_args, ctx) => {
			const c = ensureCompanion();
			const card = buildCompanionCard(c);
			ctx.ui.notify(card.join("\n"), "info");
		},
	});
}
