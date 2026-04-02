/**
 * Export Conversation Extension
 *
 * Registers /export command to export the current conversation to markdown or JSON.
 * Based on Claude Code's commands/export/ pattern.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { writeFileSync } from "fs";
import { resolve } from "path";

function extractText(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b.type === "text")
		.map((b: any) => b.text ?? "")
		.join("\n");
}

function formatEntryMarkdown(entry: any): string | null {
	if (entry.type !== "message") return null;
	const msg = entry.message;
	if (!msg) return null;

	if (msg.role === "user") {
		const text = extractText(msg.content);
		return text ? `## User\n\n${text}` : null;
	}

	if (msg.role === "assistant") {
		const parts: string[] = [];
		if (typeof msg.content === "string") {
			parts.push(msg.content);
		} else if (Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "text" && block.text) {
					parts.push(block.text);
				} else if (block.type === "toolCall") {
					const name = block.name ?? "unknown";
					const args = (block as any).arguments ?? {};
					const summary = Object.entries(args)
						.map(([k, v]) => {
							const s = typeof v === "string" ? v : JSON.stringify(v);
							return `${k}: ${s.length > 80 ? s.slice(0, 77) + "..." : s}`;
						})
						.join(", ");
					parts.push(`### Tool: ${name}\n\n${summary || "(no arguments)"}`);
				} else if (block.type === "toolResult") {
					const content = extractText(block.content ?? block.result);
					const preview = content.length > 200 ? content.slice(0, 197) + "..." : content;
					parts.push(`> Tool result: ${preview || "(empty)"}`);
				}
			}
		}
		return parts.length ? `## Assistant\n\n${parts.join("\n\n")}` : null;
	}

	// Tool results that arrive as top-level entries
	if (msg.role === "tool") {
		const content = extractText(msg.content);
		const preview = content.length > 200 ? content.slice(0, 197) + "..." : content;
		return preview ? `> Tool result: ${preview}` : null;
	}

	return null;
}

export default function exportConversation(pi: ExtensionAPI) {
	pi.registerCommand("export", {
		description: "Export conversation to markdown or JSON. Usage: /export [filename] [json]",
		handler: async (args, ctx) => {
			const entries = ctx.sessionManager.getEntries();
			const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);

			const isJson = tokens.includes("json");
			const nameTokens = tokens.filter((t) => t !== "json");
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
			const defaultName = `pi-session-${timestamp}${isJson ? ".json" : ".md"}`;
			const filename = nameTokens[0] || defaultName;
			const outPath = resolve(filename);

			let content: string;
			if (isJson) {
				content = JSON.stringify(entries, null, 2);
			} else {
				const sections = entries
					.map(formatEntryMarkdown)
					.filter((s): s is string => s !== null);
				content = `# Pi Session Export\n\n_Exported: ${new Date().toISOString()}_\n\n---\n\n${sections.join("\n\n---\n\n")}\n`;
			}

			writeFileSync(outPath, content, "utf-8");

			if (ctx.hasUI) {
				ctx.ui.notify(`Conversation exported to ${outPath}`);
			}
		},
	});
}
