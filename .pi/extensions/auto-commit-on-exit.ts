/**
 * Auto-Commit on Exit Extension
 *
 * Hooks session_shutdown to offer the user a choice when uncommitted
 * changes exist: commit, stash, or leave as-is.
 *
 * Based on pi's examples/extensions/auto-commit-on-exit.ts.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function autoCommitOnExit(pi: ExtensionAPI) {
	pi.on("session_shutdown", async (_event, ctx) => {
		const { stdout: status, code } = await pi.exec("git", ["status", "--porcelain"]);

		if (code !== 0 || status.trim().length === 0) {
			return;
		}

		if (!ctx.hasUI) {
			return;
		}

		const choice = await ctx.ui.select("Uncommitted changes detected. What would you like to do?", [
			"Commit changes",
			"Stash changes",
			"Leave as-is",
		]);

		if (choice === "Commit changes") {
			const commitMessage = generateCommitMessage(ctx);
			await pi.exec("git", ["add", "-A"]);
			const { code: commitCode } = await pi.exec("git", ["commit", "-m", commitMessage]);
			if (commitCode === 0) {
				ctx.ui.notify(`Committed: ${commitMessage}`, "info");
			} else {
				ctx.ui.notify("Commit failed.", "error");
			}
		} else if (choice === "Stash changes") {
			const { code: stashCode } = await pi.exec("git", ["stash", "push", "-m", "pi session WIP"]);
			if (stashCode === 0) {
				ctx.ui.notify("Changes stashed as 'pi session WIP'.", "info");
			} else {
				ctx.ui.notify("Stash failed.", "error");
			}
		}
	});
}

function generateCommitMessage(ctx: { sessionManager: { getEntries: () => any[] } }): string {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message" && entry.message.role === "assistant") {
			const content = entry.message.content;
			let text = "";
			if (Array.isArray(content)) {
				text = content
					.filter((c: any): c is { type: "text"; text: string } => c.type === "text")
					.map((c: { text: string }) => c.text)
					.join("\n");
			} else if (typeof content === "string") {
				text = content;
			}
			if (text) {
				const firstLine = text.split("\n")[0].slice(0, 72);
				return `[pi] ${firstLine}`;
			}
		}
	}
	return "[pi] Work in progress";
}
