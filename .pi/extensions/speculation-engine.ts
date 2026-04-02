import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Track the pending speculation prompt globally in this session.
let pendingSpeculationPrompt: string | null = null;
let activeSpecProc: ChildProcess | null = null;

// 🛡️ Timeout: kill speculation after 90 seconds (Claude Code uses abort controllers)
const SPECULATION_TIMEOUT_MS = 90_000;

export default function speculationEngine(pi: ExtensionAPI) {
	// Register the /speculate command
	pi.registerCommand("speculate", {
		description: "Fork current session to test an idea safely in memory",
		handler: async (args: string, ctx: any) => {
			if (!args) {
				if (ctx.hasUI) ctx.ui.notify("Please provide a prompt to speculate on.", "error");
				return;
			}

			const sessionFile = ctx.sessionManager.getSessionFile();
			const spawnArgs = ["--mode", "json"];
			if (sessionFile) {
				spawnArgs.push("--fork", sessionFile);
			} else {
				spawnArgs.push("--no-session");
			}
			spawnArgs.push("-p", args);

			pendingSpeculationPrompt = args.trim();

			if (ctx.hasUI) ctx.ui.notify(`Speculating: ${args}...`, "info");

			// Spawn the speculation agent in non-interactive mode
			const proc = spawn(process.argv[0], [process.argv[1]!, ...spawnArgs], {
				env: { 
					...process.env, 
					PI_SPECULATE: "true",
					PI_IS_SUBAGENT: "true",
					PI_SUBAGENT_DEPTH: ((parseInt(process.env.PI_SUBAGENT_DEPTH || "0", 10)) + 1).toString()
				},
				stdio: ["ignore", "pipe", "pipe"],
			});

			activeSpecProc = proc;
			let output = "";
			proc.stdout.on("data", (d: Buffer) => (output += d.toString()));
			proc.stderr.on("data", (d: Buffer) => (output += d.toString()));

			// 🛡️ Kill timer — abort if speculation takes too long (mirrors Claude Code's abort controller)
			const killTimer = setTimeout(() => {
				if (!proc.killed) {
					proc.kill("SIGTERM");
					if (ctx.hasUI) ctx.ui.notify("Speculation timed out after 90s and was killed.", "error");
				}
			}, SPECULATION_TIMEOUT_MS);

			proc.on("close", () => {
				clearTimeout(killTimer);
				activeSpecProc = null;
				fs.mkdirSync("/tmp/pi-speculation", { recursive: true });
				fs.writeFileSync("/tmp/pi-speculation-result.txt", output);
				if (ctx.hasUI) {
					ctx.ui.notify("Speculation complete! Type the exact prompt to see the result.", "success");
				}
			});
		},
	});

	const resolveSpeculationPath = (p: string) => {
		const absPath = path.resolve(p);
		const relativeToRoot = absPath.replace(/^[a-zA-Z]:\\|^\//, "");
		return path.join("/tmp/pi-speculation", relativeToRoot);
	};

	// Hook tool_call to rewrite paths for the speculated process
	pi.on("tool_call", async (event: any) => {
		if (process.env.PI_SPECULATE !== "true") return;

		if (event.toolName === "edit" || event.toolName === "write" || event.toolName === "read") {
			const originalPath = event.input.path as string;
			if (!originalPath) return;

			const absPath = path.resolve(originalPath);
			const specPath = resolveSpeculationPath(originalPath);

			fs.mkdirSync(path.dirname(specPath), { recursive: true });

			// For edit/read, copy the original file into the overlay if it exists
			if ((event.toolName === "edit" || event.toolName === "read") && !fs.existsSync(specPath) && fs.existsSync(absPath)) {
				fs.copyFileSync(absPath, specPath);
			}

			event.input.path = specPath;
		} else if (event.toolName === "bash") {
			const command = event.input.command as string;
			if (!command) return;

			const specCwd = resolveSpeculationPath(process.cwd());

			fs.mkdirSync(specCwd, { recursive: true });

			// Sync project files to the speculation directory so tests and builds work
			const syncMarker = path.join(specCwd, ".pi-synced");
			if (!fs.existsSync(syncMarker)) {
				try {
					if (fs.promises.cp) {
						await fs.promises.cp(process.cwd(), specCwd, {
							recursive: true,
							force: false, // Do not overwrite edited files
							filter: (src: string) => {
								const name = path.basename(src);
								return name !== ".git" && name !== "node_modules";
							}
						});
					}
					const nmPath = path.join(process.cwd(), "node_modules");
					const specNmPath = path.join(specCwd, "node_modules");
					if (fs.existsSync(nmPath) && !fs.existsSync(specNmPath)) {
						await fs.promises.symlink(nmPath, specNmPath);
					}
					fs.writeFileSync(syncMarker, "1");
				} catch (err) {
					console.error("Failed to sync project to speculation dir:", err);
				}
			}

			event.input.command = `cd "${specCwd}" || exit 1\n${command}`;
		}
	});

	// On input event, check if it matches the pending speculation
	pi.on("input", async (event: any, ctx: any) => {
		const text = event.text.trim();
		if (pendingSpeculationPrompt && text === pendingSpeculationPrompt) {
			try {
				if (fs.existsSync("/tmp/pi-speculation-result.txt")) {
					const result = fs.readFileSync("/tmp/pi-speculation-result.txt", "utf-8");

					pi.sendMessage(
						{
							customType: "speculation-result",
							content: `**Speculation Result:**\n\n${result}`,
							display: true,
						},
						{ triggerTurn: false },
					);

					if (ctx.hasUI) {
						const apply = await ctx.ui.confirm(
							"Apply Changes",
							"Do you want to copy the speculated changes to your current directory?",
						);

						if (apply) {
							const srcDir = resolveSpeculationPath(process.cwd());
							if (fs.existsSync(srcDir)) {
								fs.cpSync(srcDir, process.cwd(), { recursive: true, force: true });
								ctx.ui.notify("Changes applied successfully.", "success");
							} else {
								ctx.ui.notify("No files were changed during speculation.", "info");
							}
						}
					}

					pendingSpeculationPrompt = null;
					return { action: "handled" };
				}
			} catch (err: any) {
				if (ctx.hasUI) ctx.ui.notify(`Error reading speculation result: ${err.message}`, "error");
			}
		}

		// 🛡️ Speculation Max Turns Guardrail (Feature 2)
		if (process.env.PI_SPECULATE === "true") {
			const turnCount = ctx.sessionManager.getEntries().length; // Rough turn count
			const MAX_SPECULATION_TURNS = 1; // Strict 1-turn limit
			
			if (turnCount > MAX_SPECULATION_TURNS) {
				pi.sendMessage({
					customType: "speculation-timeout",
					content: `Error: Reached maximum number of turns (${MAX_SPECULATION_TURNS}) for Speculation Engine. Aborting.`,
					display: true
				});
				return { action: "handled" }; // Stop processing further inputs
			}
		}

		return { action: "continue" };
	});
}
