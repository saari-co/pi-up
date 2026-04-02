/**
 * Dirty Repo Guard Extension
 *
 * Warns on session start when there are uncommitted git changes.
 * Prompts before session switch/fork with dirty state.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

async function getDirtyFiles(pi: ExtensionAPI): Promise<string[]> {
	const result = await pi.exec("git", ["status", "--porcelain"]);
	if (result.exitCode !== 0) return [];
	return result.stdout.split("\n").filter((line) => line.trim().length > 0);
}

function formatWarning(files: string[]): string {
	const count = files.length;
	const preview = files.slice(0, 5).map((f) => `  ${f}`).join("\n");
	let msg = `Warning: ${count} uncommitted change${count === 1 ? "" : "s"} in repo\n${preview}`;
	if (count > 5) msg += `\n  ... and ${count - 5} more`;
	return msg;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const files = await getDirtyFiles(pi);
		if (files.length > 0) {
			ctx.ui.notify(formatWarning(files), "warning");
		}
	});

	pi.on("session_before_switch", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const files = await getDirtyFiles(pi);
		if (files.length === 0) return;
		const ok = await ctx.ui.confirm(
			"Dirty repo",
			`${files.length} uncommitted change${files.length === 1 ? "" : "s"}. Switch anyway?`,
		);
		if (!ok) return { cancel: true };
	});

	pi.on("session_before_fork", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const files = await getDirtyFiles(pi);
		if (files.length === 0) return;
		const ok = await ctx.ui.confirm(
			"Dirty repo",
			`${files.length} uncommitted change${files.length === 1 ? "" : "s"}. Fork anyway?`,
		);
		if (!ok) return { cancel: true };
	});
}
