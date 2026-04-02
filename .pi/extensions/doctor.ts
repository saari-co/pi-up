/** /doctor — Installation diagnostics. Based on Claude Code's commands/doctor/. */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type S = "pass" | "warn" | "fail";
interface C { name: string; status: S; detail: string }
const icon = (s: S) => s === "pass" ? "[OK]" : s === "warn" ? "[!!]" : "[XX]";

export default function doctor(pi: ExtensionAPI) {
	pi.registerCommand("doctor", {
		description: "Diagnose pi installation health",
		handler: async (_args, ctx) => {
			const checks: C[] = [];

			checks.push({ name: "Node.js", status: "pass", detail: `${process.version} (${process.platform}/${process.arch})` });

			try {
				const piPkg = require("@mariozechner/pi-coding-agent/package.json");
				checks.push({ name: "Pi version", status: "pass", detail: piPkg.version });
			} catch {
				checks.push({ name: "Pi version", status: "warn", detail: "Could not read package version" });
			}

			try {
				const settingsResult = await pi.exec("cat", [".pi/settings.json"]);
				if (settingsResult.code !== 0) {
					checks.push({ name: "Settings", status: "warn", detail: ".pi/settings.json not found" });
				} else {
					JSON.parse(settingsResult.stdout);
					checks.push({ name: "Settings", status: "pass", detail: ".pi/settings.json valid JSON" });
				}
			} catch {
				checks.push({ name: "Settings", status: "fail", detail: ".pi/settings.json is malformed JSON" });
			}

			try {
				const agentsResult = await pi.exec("test", ["-f", "AGENTS.md"]);
				checks.push({
					name: "AGENTS.md",
					status: agentsResult.code === 0 ? "pass" : "warn",
					detail: agentsResult.code === 0 ? "Present" : "Not found",
				});
			} catch {
				checks.push({ name: "AGENTS.md", status: "warn", detail: "Could not check" });
			}

			try {
				const extResult = await pi.exec("ls", [".pi/extensions/"]);
				if (extResult.code === 0) {
					const files = extResult.stdout.trim().split("\n").filter((f: string) => f.endsWith(".ts"));
					checks.push({ name: "Extensions", status: "pass", detail: `${files.length} found: ${files.join(", ")}` });
				} else {
					checks.push({ name: "Extensions", status: "warn", detail: "No extensions directory" });
				}
			} catch {
				checks.push({ name: "Extensions", status: "warn", detail: "Could not list extensions" });
			}

			try {
				const skillResult = await pi.exec("find", [".pi/skills", "-name", "SKILL.md", "-maxdepth", "2"]);
				if (skillResult.code === 0 && skillResult.stdout.trim()) {
					const skills = skillResult.stdout.trim().split("\n");
					const names = skills.map((s: string) => s.replace(/.*\/skills\//, "").replace(/\/SKILL\.md$/, ""));
					checks.push({ name: "Skills", status: "pass", detail: `${skills.length} found: ${names.join(", ")}` });
				} else {
					checks.push({ name: "Skills", status: "warn", detail: "No skills discovered" });
				}
			} catch {
				checks.push({ name: "Skills", status: "warn", detail: "Could not scan skills" });
			}

			try {
				const gitVer = await pi.exec("git", ["--version"]);
				if (gitVer.code === 0) {
					const ver = gitVer.stdout.trim();
					const status = await pi.exec("git", ["status", "--porcelain"]);
					const dirty = status.stdout.trim();
					const repoDetail = dirty ? `${dirty.split("\n").length} uncommitted change(s)` : "Clean working tree";
					checks.push({ name: "Git", status: "pass", detail: `${ver} — ${repoDetail}` });
				} else {
					checks.push({ name: "Git", status: "fail", detail: "git not found" });
				}
			} catch {
				checks.push({ name: "Git", status: "fail", detail: "git execution failed" });
			}

			try {
				const model = (ctx as any).model;
				if (model) {
					checks.push({ name: "Model", status: "pass", detail: typeof model === "string" ? model : JSON.stringify(model) });
				} else {
					checks.push({ name: "Model", status: "warn", detail: "No model info available" });
				}
			} catch {
				checks.push({ name: "Model", status: "warn", detail: "Could not read model info" });
			}

			const fails = checks.filter((c) => c.status === "fail").length;
			const warns = checks.filter((c) => c.status === "warn").length;
			const overall = fails > 0 ? "ISSUES FOUND" : warns > 0 ? "MOSTLY HEALTHY" : "ALL HEALTHY";

			const lines = [
				`Pi Doctor — ${overall}`,
				"═".repeat(40),
				...checks.map((c) => `${icon(c.status)} ${c.name}: ${c.detail}`),
				"",
				`${checks.length} checks: ${checks.length - fails - warns} pass, ${warns} warn, ${fails} fail`,
			];

			ctx.ui.notify(lines.join("\n"), fails > 0 ? "error" : warns > 0 ? "warn" : "info");
		},
	});
}
