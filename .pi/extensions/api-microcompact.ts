import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Based on Claude Code: services/compact/apiMicrocompact.ts
// Two strategies:
// 1. API-native: Use clear_tool_uses beta to delete tool pairs server-side
// 2. Client-side fallback: Replace old tool results with stubs
// Also strips image/document blocks from old messages (image stripper audit)

const HIGH_IO_TOOLS = new Set(["bash", "read", "grep", "find", "ls"]);
const CONTEXT_THRESHOLD_TOKENS = 150_000;
const STALE_TURN_THRESHOLD = 5;
const IMAGE_STALE_TURNS = 3;

interface ToolUsePair {
	toolUseId: string;
	toolName: string;
	turnIndex: number;
}

export default function apiMicrocompact(pi: ExtensionAPI) {
	pi.on("before_provider_request", (event: any, ctx: any) => {
		const payload = event.payload;
		if (!payload || !payload.messages) return undefined;

		const messages = payload.messages as any[];
		const totalMessages = messages.length;

		// Rough token estimate: ~4 tokens per word, ~15 words per message content block
		// More accurate: check if usage metadata is available
		const estimatedTokens = totalMessages * 800; // rough heuristic
		if (estimatedTokens < CONTEXT_THRESHOLD_TOKENS && totalMessages < 60) {
			return undefined; // Not enough context to worry about
		}

		const currentTurn = totalMessages;
		let modified = false;

		// ─── Strategy 1: Collect stale high-I/O tool pairs ───
		const stalePairs: ToolUsePair[] = [];

		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			if (!msg.content || !Array.isArray(msg.content)) continue;

			const turnAge = currentTurn - i;

			for (const block of msg.content) {
				// Collect stale tool_use blocks from high-I/O tools
				if (block.type === "tool_use" && HIGH_IO_TOOLS.has(block.name) && turnAge > STALE_TURN_THRESHOLD) {
					stalePairs.push({
						toolUseId: block.id,
						toolName: block.name,
						turnIndex: i,
					});
				}

				// ─── Image/Document Stripper (audit fix) ───
				// Strip image and document blocks from messages older than IMAGE_STALE_TURNS
				if (turnAge > IMAGE_STALE_TURNS) {
					if (block.type === "image") {
						block.type = "text";
						block.text = "[image cleared by micro-compaction]";
						delete block.source;
						delete block.media_type;
						delete block.data;
						modified = true;
					}
					if (block.type === "document") {
						block.type = "text";
						block.text = "[document cleared by micro-compaction]";
						delete block.source;
						delete block.media_type;
						delete block.data;
						modified = true;
					}
				}

				// Strip nested images inside tool_result content arrays
				if (block.type === "tool_result" && Array.isArray(block.content) && turnAge > IMAGE_STALE_TURNS) {
					for (let j = 0; j < block.content.length; j++) {
						const inner = block.content[j];
						if (inner.type === "image" || inner.type === "document") {
							block.content[j] = { type: "text", text: `[${inner.type} cleared by micro-compaction]` };
							modified = true;
						}
					}
				}
			}
		}

		if (stalePairs.length === 0 && !modified) return undefined;

		if (modified && ctx.hasUI) {
			ctx.ui.setStatus("microcompact", "🧹 Micro-compacting context");
			setTimeout(() => ctx.ui.setStatus("microcompact", undefined), 3000);
		}

		// ─── Strategy 2: Check if Anthropic API supports clear_tool_uses ───
		const isAnthropic = payload.model?.includes("claude") || 
			(event.headers && event.headers["x-api-key"]) ||
			(event.headers && event.headers["anthropic-version"]);

		if (isAnthropic && stalePairs.length > 0) {
			// Try API-native approach: add beta header and clear IDs
			const betaHeader = payload.metadata?.["anthropic-beta"] || "";
			const hasClearFeature = betaHeader.includes("clear_tool_uses");

			if (hasClearFeature) {
				// API-native: tell the server to forget these tool pairs
				if (!payload.clear_tool_uses) {
					payload.clear_tool_uses = [];
				}
				for (const pair of stalePairs) {
					payload.clear_tool_uses.push({ id: pair.toolUseId });
				}
				return payload;
			}
		}

		// ─── Fallback: Client-side stubbing ───
		for (const pair of stalePairs) {
			for (const msg of messages) {
				if (!msg.content || !Array.isArray(msg.content)) continue;
				for (const block of msg.content) {
					if (block.type === "tool_result" && block.tool_use_id === pair.toolUseId) {
						// Replace content with stub
						if (typeof block.content === "string" && block.content.length > 200) {
							block.content = `[Old ${pair.toolName} result cleared by API micro-compaction. Original length: ${block.content.length}]`;
							modified = true;
						} else if (Array.isArray(block.content)) {
							const totalLen = block.content.reduce((sum: number, b: any) => sum + (b.text?.length || 0), 0);
							if (totalLen > 200) {
								block.content = [{ type: "text", text: `[Old ${pair.toolName} result cleared by API micro-compaction. Original length: ${totalLen}]` }];
								modified = true;
							}
						}
					}
				}
			}
		}

		return modified ? payload : undefined;
	});
}
