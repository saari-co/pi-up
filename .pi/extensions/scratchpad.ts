/**
 * Scratchpad Directory Extension
 *
 * Creates a per-session temporary directory for scratch files.
 * Injects the path into the system prompt so the agent knows about it.
 * Cleans up on session shutdown.
 *
 * Inspired by Claude Code's getScratchpadInstructions().
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

export default function scratchpad(pi: ExtensionAPI) {
	let scratchDir: string | null = null;

	pi.on("session_start", async (_event, ctx) => {
		scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scratch-"));
		if (ctx.hasUI) {
			ctx.ui.setStatus("scratchpad", `Scratchpad: ${scratchDir}`);
		}
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!scratchDir) return;

		const instructions = `\n\nA scratchpad directory is available at ${scratchDir} for temporary files. Use this instead of /tmp. It is cleaned up when the session ends.`;

		return {
			systemPrompt: event.systemPrompt + instructions,
		};
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (scratchDir) {
			try {
				fs.rmSync(scratchDir, { recursive: true, force: true });
			} catch {
				// Best effort cleanup
			}
			scratchDir = null;
			if (ctx.hasUI) {
				ctx.ui.setStatus("scratchpad", undefined);
			}
		}
	});
}
