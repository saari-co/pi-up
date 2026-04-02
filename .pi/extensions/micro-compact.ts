import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function microCompact(pi: ExtensionAPI) {
	// Content Stubbing (#43)
	pi.on("tool_result", (event) => {
		if (event.toolName === "read") {
			let totalLength = 0;
			for (const block of event.content) {
				if (block.type === "text") {
					totalLength += block.text.length;
					if (totalLength > 50000) {
						// Slice string down to ~50k chars and append the truncated marker
						block.text = block.text.slice(0, 50000) + "\n\n[... content truncated; use Read with offset if you need the full text]";
					}
				}
			}
		}
	});
}
