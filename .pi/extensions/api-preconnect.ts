import * as https from "node:https";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Based on Claude Code: utils/apiPreconnect.ts
// Opens TCP+TLS connections to API endpoints on startup so the first
// real API call skips the handshake, saving 200-500ms.

const ENDPOINTS = [
	{ host: "api.anthropic.com", port: 443 },
	{ host: "generativelanguage.googleapis.com", port: 443 },
];

let warmedUp = false;

function warmEndpoint(host: string, port: number): Promise<void> {
	return new Promise((resolve) => {
		const req = https.request(
			{ host, port, method: "HEAD", path: "/", timeout: 5000 },
			(res) => {
				res.resume(); // drain
				res.on("end", resolve);
			},
		);
		req.on("error", () => resolve()); // swallow errors silently
		req.on("timeout", () => { req.destroy(); resolve(); });
		req.end();
	});
}

async function warmAll(): Promise<number> {
	const start = Date.now();
	await Promise.all(ENDPOINTS.map((e) => warmEndpoint(e.host, e.port)));
	warmedUp = true;
	return Date.now() - start;
}

export default function apiPreconnect(pi: ExtensionAPI) {
	// Warm connections on session start
	pi.on("agent_start", async () => {
		if (warmedUp) return;
		// Don't preconnect in subagents — they inherit the parent's connection pool
		if (process.env.PI_IS_SUBAGENT === "true") return;
		await warmAll();
	});

	pi.registerCommand("preconnect", {
		description: "Manually warm API connections (TCP+TLS handshake)",
		handler: async (_args: string, ctx: any) => {
			const ms = await warmAll();
			if (ctx.hasUI) {
				ctx.ui.notify(`Preconnect complete: ${ENDPOINTS.map(e => e.host).join(", ")} (${ms}ms)`, "success");
			}
		},
	});
}
