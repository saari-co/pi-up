/** Away Summary — "while you were away" recap on session resume. */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const AWAY_MS = 30 * 60 * 1000;

function toMs(ts: any): number {
	if (typeof ts === "number") return ts;
	if (typeof ts === "string") { const d = new Date(ts).getTime(); return isNaN(d) ? 0 : d; }
	return 0;
}

export default function awaySummary(pi: ExtensionAPI) {
	let pending: string | null = null;

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		if (entries.length < 2) return;
		let lastTs = 0;
		for (let i = entries.length - 1; i >= 0; i--) {
			const t = toMs(entries[i].timestamp);
			if (t > 0) { lastTs = t; break; }
		}
		if (!lastTs) return;
		const gap = Date.now() - lastTs;
		if (gap < AWAY_MS) return;

		const tail = entries.slice(-30);
		const lines: string[] = [];
		for (const e of tail) {
			if (e.type !== "message") continue;
			const m = e.message;
			let text = typeof m.content === "string" ? m.content : "";
			if (!text && Array.isArray(m.content)) {
				for (const b of m.content) { if (b.type === "text") { text = (b as any).text; break; } }
			}
			if (text) lines.push(`[${m.role}] ${text.slice(0, 200)}`);
		}
		pending = lines.join("\n");

		const mins = Math.round(gap / 60_000);
		const label = mins >= 60 ? `${Math.round(mins / 60)}h ${mins % 60}m` : `${mins}m`;
		if (ctx.hasUI) ctx.ui.setWidget("away-summary", [`Welcome back — away for ${label}.`]);
	});

	pi.on("before_agent_start", async () => {
		if (!pending) return;
		const ctx = pending;
		pending = null;
		return { message: { customType: "away-summary", content:
			"The user stepped away and is coming back. Write exactly 1-3 short sentences. " +
			"Start by stating the high-level task, then the concrete next step. " +
			"Skip status reports and commit recaps.\n\nRecent session context:\n" + ctx,
			display: false } };
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setWidget("away-summary", undefined);
	});
}
