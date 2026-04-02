/**
 * ToolSearch -- Deferred Tool Loading
 *
 * Modeled after Claude Code's tools/ToolSearchTool/. Tools are deferred
 * at startup (only names visible in context). When the LLM needs a tool,
 * it calls `tool_search` to fetch the full schema, then pi activates it.
 *
 * Source: tools/ToolSearchTool/ToolSearchTool.ts, tools/ToolSearchTool/prompt.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";

// Tools that must always be loaded (never deferred)
const ALWAYS_LOADED = new Set([
	"read",
	"edit",
	"write",
	"bash",
	"tool_search",
	"todo",
]);

export default function toolSearch(pi: ExtensionAPI) {
	let allToolNames: string[] = [];
	let deferredToolNames: string[] = [];
	let activeToolNames: Set<string> = new Set();
	let initialized = false;

	pi.on("session_start", async (_event, _ctx) => {
		setTimeout(() => initDeferred(), 500);
	});

	function initDeferred() {
		const all = pi.getAllTools();
		allToolNames = all.map((t) => t.name);

		const toActivate: string[] = [];
		const toDefer: string[] = [];

		for (const tool of all) {
			if (ALWAYS_LOADED.has(tool.name)) {
				toActivate.push(tool.name);
			} else {
				toDefer.push(tool.name);
			}
		}

		if (!toActivate.includes("tool_search")) {
			toActivate.push("tool_search");
		}

		deferredToolNames = toDefer;
		activeToolNames = new Set(toActivate);

		if (deferredToolNames.length > 0) {
			pi.setActiveTools([...activeToolNames]);
			initialized = true;
		}
	}

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!initialized) initDeferred();
		if (!initialized || deferredToolNames.length === 0) return;

		const deferredList = deferredToolNames
			.filter((n) => !activeToolNames.has(n))
			.join(", ");

		if (!deferredList) return;

		const notice = "\n\n<available-deferred-tools>\nThe following tools are available but deferred (schema not loaded yet). Use the tool_search tool to load any you need before calling them:\n" + deferredList + "\n</available-deferred-tools>";

		return {
			systemPrompt: event.systemPrompt + notice,
		};
	});

	pi.registerTool({
		name: "tool_search",
		label: "Tool Search",
		description: "Fetch full schema definitions for deferred tools so they can be called. Until fetched, only the tool name is known -- there is no parameter schema, so the tool cannot be invoked. Query forms: \"select:read,edit\" -- fetch exact tools by name; \"notebook jupyter\" -- keyword search.",
		promptSnippet: "Look up and activate deferred tools by name or keyword",
		promptGuidelines: [
			"When you need a tool that isn't currently active, use tool_search to load it first.",
			"Use 'select:tool_name' for direct activation, or keywords to search.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Query to find deferred tools. Use \"select:tool_name\" for direct selection, or keywords to search.",
			}),
			max_results: Type.Optional(
				Type.Number({
					description: "Maximum number of results to return (default: 5)",
					default: 5,
				}),
			),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { query, max_results = 5 } = params;

			if (!initialized) {
				return {
					content: [{ type: "text", text: "ToolSearch not initialized -- all tools are already active." }],
				};
			}

			const currentlyDeferred = deferredToolNames.filter(
				(n) => !activeToolNames.has(n),
			);

			if (currentlyDeferred.length === 0) {
				return {
					content: [{ type: "text", text: "All tools are already active. No deferred tools remaining." }],
				};
			}

			const selectMatch = query.match(/^select:(.+)$/i);
			if (selectMatch) {
				const requested = selectMatch[1]!
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);

				const found: string[] = [];
				const missing: string[] = [];

				for (const name of requested) {
					if (allToolNames.includes(name)) {
						found.push(name);
						activeToolNames.add(name);
					} else {
						missing.push(name);
					}
				}

				if (found.length > 0) {
					pi.setActiveTools([...activeToolNames]);
				}

				const lines: string[] = [];
				if (found.length > 0) {
					lines.push("Activated: " + found.join(", "));
					lines.push("These tools are now callable with full schemas.");
				}
				if (missing.length > 0) {
					lines.push("Not found: " + missing.join(", "));
				}
				lines.push("Remaining deferred: " + (currentlyDeferred.length - found.length));

				return {
					content: [{ type: "text", text: lines.join("\n") }],
				};
			}

			// Keyword search
			const queryLower = query.toLowerCase().trim();
			const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 0);

			const scored: { name: string; score: number }[] = [];

			for (const toolName of currentlyDeferred) {
				const parts = toolName
					.replace(/([a-z])([A-Z])/g, "$1 $2")
					.replace(/_/g, " ")
					.replace(/-/g, " ")
					.toLowerCase()
					.split(/\s+/);

				let score = 0;
				for (const term of queryTerms) {
					if (parts.includes(term)) {
						score += 10;
					} else if (parts.some((p) => p.includes(term))) {
						score += 5;
					}
					if (toolName.toLowerCase().includes(term)) {
						score += 3;
					}
				}

				if (score > 0) {
					scored.push({ name: toolName, score });
				}
			}

			const matches = scored
				.sort((a, b) => b.score - a.score)
				.slice(0, max_results)
				.map((s) => s.name);

			if (matches.length === 0) {
				return {
					content: [{ type: "text", text: "No deferred tools match \"" + query + "\".\nAvailable deferred tools: " + currentlyDeferred.join(", ") }],
				};
			}

			for (const name of matches) {
				activeToolNames.add(name);
			}
			pi.setActiveTools([...activeToolNames]);

			return {
				content: [{ type: "text", text: "Found and activated: " + matches.join(", ") + "\nThese tools are now callable. Remaining deferred: " + (currentlyDeferred.length - matches.length) }],
			};
		},

		renderCall(args) {
			return new Text("Searching tools: " + args.query, 0, 0);
		},

		renderResult(result) {
			const text = result.content[0]?.text ?? "";
			return new Text(text, 0, 0);
		},
	});

	// Debug command to inspect tool object shape
	pi.registerCommand("tools-deferred", {
		description: "Show deferred vs active tools",
		handler: async (_args, ctx) => {
			try {
				if (!initialized) initDeferred();

				// getActiveTools() returns string[], not objects
				const active = pi.getActiveTools() as unknown as string[];
				const activeSet = new Set(active);
				const all = pi.getAllTools();
				const allNames = all.map((t) => t.name);
				const deferred = allNames.filter((n) => !activeSet.has(n));

				const msg = [
					"[ToolSearch Status]",
					"Active (" + active.length + "): " + active.join(", "),
					"Deferred (" + deferred.length + "): " + (deferred.join(", ") || "(none)"),
					"Total: " + allNames.length,
				].join("\n");

				pi.sendUserMessage(msg, { deliverAs: "followUp" });
			} catch (err: any) {
				ctx.ui.notify("tools-deferred error: " + (err?.message || err), "error");
			}
		},
	});

	pi.registerCommand("tools-load-all", {
		description: "Activate all deferred tools at once",
		handler: async (_args, ctx) => {
			if (!initialized) initDeferred();

			for (const name of allToolNames) {
				activeToolNames.add(name);
			}
			pi.setActiveTools([...activeToolNames]);
			ctx.ui.notify("All " + allToolNames.length + " tools activated.", "success");
		},
	});
}
