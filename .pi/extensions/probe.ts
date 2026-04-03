import * as fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function probe(pi: ExtensionAPI) {
  fs.writeFileSync("/tmp/pi-probe-loaded", "OK");

  pi.registerTool({
    name: "probe_tool",
    description: "A simple tool to probe if tool registration works",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "Probe tool executed!" }] };
    }
  });
}
