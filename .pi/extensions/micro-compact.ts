import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const MIN_TURNS_OLD = 3;
const MAX_LENGTH = 1000;

export default function microCompact(pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload as any;
		if (!payload || !Array.isArray(payload.messages)) {
			return undefined;
		}

		// Clone the payload to avoid mutating the original reference if it's reused,
		// though usually it's freshly built.
		const newPayload = JSON.parse(JSON.stringify(payload));
		let replacedCount = 0;
		let userMessageCount = 0;

		// Iterate backwards to count turns (user messages represent turn boundaries)
		for (let i = newPayload.messages.length - 1; i >= 0; i--) {
			const msg = newPayload.messages[i];
			if (msg.role === "user") {
				// Not all user messages are new turns (tool results are also user messages in Anthropic)
				// But let's assume each user message object increments the "age" of previous messages.
				userMessageCount++;
			}
			
			if (userMessageCount > MIN_TURNS_OLD) {
				// Anthropic format: tool results are blocks inside user messages
				if (msg.role === "user" && Array.isArray(msg.content)) {
					for (const block of msg.content) {
						if (block.type === "tool_result") {
							if (typeof block.content === "string" && block.content.length > MAX_LENGTH) {
								block.content = `[Old tool result content cleared by MicroCompact. Original length: ${block.content.length}]`;
								replacedCount++;
							} else if (Array.isArray(block.content)) {
								for (const sub of block.content) {
									if (sub.type === "text" && typeof sub.text === "string" && sub.text.length > MAX_LENGTH) {
										sub.text = `[Old tool result content cleared by MicroCompact. Original length: ${sub.text.length}]`;
										replacedCount++;
									}
								}
							}
						}
					}
				}
				
				// OpenAI format: tool results are separate messages with role "tool"
				if (msg.role === "tool" && typeof msg.content === "string" && msg.content.length > MAX_LENGTH) {
					msg.content = `[Old tool result content cleared by MicroCompact. Original length: ${msg.content.length}]`;
					replacedCount++;
				}
			}
		}

		if (replacedCount > 0) {
			ctx.ui.setStatus("micro-compact", `✂️ MicroCompact trimmed ${replacedCount} old results`);
			setTimeout(() => ctx.ui.setStatus("micro-compact", undefined), 3000);
			return newPayload;
		}

		return undefined;
	});
}
