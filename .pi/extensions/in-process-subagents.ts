import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { streamSimple, type Context } from "@mariozechner/pi-ai";

export default function(pi: ExtensionAPI) {
    pi.registerTool({
        name: "subagent_research",
        label: "Subagent Research",
        description: "Ask the underlying model a simple query headlessly.",
        parameters: Type.Object({
            query: Type.String({ description: "Query to ask the subagent" }),
        }),
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            if (!ctx.model) {
                return {
                    content: [{ type: "text", text: "Error: No active model in context." }],
                    isError: true,
                };
            }

            if (process.env.PI_IS_SUBAGENT) {
                return {
                    content: [{ type: "text", text: "Error: Already running as a subagent to prevent infinite loops." }],
                    isError: true,
                };
            }

            onUpdate?.({ content: [{ type: "text", text: "Researching..." }] });

            const aiContext: Context = {
                messages: [{
                    role: "user",
                    content: params.query,
                    timestamp: Date.now()
                }]
            };

            let responseText = "";

            try {
                const stream = streamSimple(ctx.model, aiContext);

                for await (const event of stream) {
                    if (signal?.aborted) {
                        return { content: [{ type: "text", text: "Cancelled" }] };
                    }
                    
                    if (event.type === "text_delta") {
                        responseText += event.delta;
                        onUpdate?.({ content: [{ type: "text", text: responseText }] });
                    }
                    
                    if (event.type === "error") {
                        return {
                            content: [{ type: "text", text: "Error from model: " + (event.error.errorMessage || "Unknown error") }],
                            isError: true
                        };
                    }
                    
                    if (event.type === "done") {
                        const textContent = event.message.content.find(c => c.type === "text");
                        if (textContent && textContent.type === "text") {
                            responseText = textContent.text;
                        }
                        break;
                    }
                }

                return {
                    content: [{ type: "text", text: responseText }],
                };
            } catch (error: any) {
                return {
                    content: [{ type: "text", text: `Error: ${error.message}` }],
                    isError: true,
                };
            }
        }
    });
}
