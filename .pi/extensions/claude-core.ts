/**
 * Claude Core Extension
 *
 * Replicates the core behavioral DNA of Claude Code CLI:
 * - Permission gating with dangerous pattern detection (§3.3, §A6)
 * - Structured error formatting with XML tags (§1.8)
 * - Prompt injection detection in tool results (§1.4)
 * - Tool preference enforcement (§1.3)
 * - Cancellation memory / correction tracking (§1.5)
 * - Bash security validation (§3.4, §A8)
 * - Git safety enforcement (§A8)
 *
 * Source: Claude Code CLI src/utils/permissions/, src/tools/BashTool/,
 *         src/constants/prompts.ts, src/utils/toolErrors.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ─── Dangerous patterns from src/utils/permissions/dangerousPatterns.ts ───

const CROSS_PLATFORM_CODE_EXEC = [
	"python", "python3", "python2", "node", "deno", "tsx", "ruby", "perl",
	"php", "lua", "npx", "bunx", "npm run", "yarn run", "pnpm run",
	"bun run", "bash", "sh", "ssh",
] as const;

const DANGEROUS_BASH_PATTERNS: readonly string[] = [
	...CROSS_PLATFORM_CODE_EXEC,
	"zsh", "fish", "eval", "exec", "env", "xargs", "sudo",
];

// Patterns that indicate destructive/risky bash commands
const DESTRUCTIVE_PATTERNS = [
	/\brm\s+(-[rRf]+|--recursive|--force)/i,
	/\bsudo\b/i,
	/\b(chmod|chown)\b.*777/i,
	/\bgit\s+push\s+.*--force/i,
	/\bgit\s+reset\s+--hard/i,
	/\bgit\s+checkout\s+\.\s*$/i,
	/\bgit\s+clean\s+-[fdx]/i,
	/\bgit\s+branch\s+-D/i,
	/\bdd\s+/i,
	/\bmkfs\b/i,
	/>\s*\/dev\/sd/i,
	/\bkill\s+-9/i,
	/\bpkill\b/i,
	/\bshutdown\b/i,
	/\breboot\b/i,
	/\bdropdb\b/i,
	/DROP\s+(TABLE|DATABASE)/i,
	/TRUNCATE\s+TABLE/i,
];

// Command substitution patterns — CVE-class from §3.4
const COMMAND_SUBSTITUTION_PATTERNS = [
	/\$\([^)]/,           // $(...)
	/`[^`]/,              // `...`
	/\$\{[^}]*[^a-zA-Z_0-9}]/, // ${...} with non-variable chars
];

// Bash commands that should use dedicated tools instead
const TOOL_PREFERENCE_VIOLATIONS: Record<string, { pattern: RegExp; suggestion: string }> = {
	cat: { pattern: /\bcat\s+\S/, suggestion: "read" },
	head: { pattern: /\bhead\s+/, suggestion: "read" },
	tail: { pattern: /\btail\s+/, suggestion: "read" },
	sed: { pattern: /\bsed\s+/, suggestion: "edit" },
	awk: { pattern: /\bawk\s+/, suggestion: "edit" },
};

// Git read-only commands whitelist from src/utils/shell/readOnlyCommandValidation.ts
const GIT_READONLY_SUBCOMMANDS = new Set([
	"status", "log", "diff", "show", "branch", "tag", "reflog",
	"remote", "ls-remote", "cat-file", "rev-parse", "config",
	"stash", "ls-files", "ls-tree", "blame", "shortlog",
	"describe", "for-each-ref", "rev-list", "merge-base",
	"name-rev", "check-ignore",
]);

// Git commands that mutate state
const GIT_MUTATING_COMMANDS = [
	/\bgit\s+push\b/,
	/\bgit\s+commit\b/,
	/\bgit\s+merge\b/,
	/\bgit\s+rebase\b/,
	/\bgit\s+cherry-pick\b/,
	/\bgit\s+reset\b/,
	/\bgit\s+revert\b/,
	/\bgit\s+stash\s+(drop|pop|clear)\b/,
	/\bgit\s+tag\s+(?!-l|--list)/,
	/\bgit\s+branch\s+-[dDmM]/,
];

// Prompt injection detection patterns
const INJECTION_PATTERNS = [
	/ignore\s+(all\s+)?previous\s+instructions/i,
	/you\s+are\s+now\s+/i,
	/disregard\s+(all\s+)?prior/i,
	/new\s+instructions?\s*:/i,
	/system\s*:\s*you\s+are/i,
	/\[SYSTEM\]/i,
	/\[INST\]/i,
	/<\|im_start\|>/i,
	/BEGIN\s+INJECTION/i,
	/OVERRIDE\s+SYSTEM/i,
];

// ─── Denial tracking from src/utils/permissions/denialTracking.ts ───

interface DenialTrackingState {
	consecutiveDenials: number;
	totalDenials: number;
}

const DENIAL_LIMITS = { maxConsecutive: 3, maxTotal: 20 } as const;

// ─── Main Extension ───

export default function claudeCore(pi: ExtensionAPI) {
	// Session state
	let denials: DenialTrackingState = { consecutiveDenials: 0, totalDenials: 0 };
	let rejectedCommands: Array<{ command: string; reason: string; timestamp: number }> = [];
	let sessionToolPreferenceWarnings = 0;

	// ─── Permission Gate (tool_call) ───
	// From src/utils/permissions/permissions.ts — two-tier safety check
	pi.on("tool_call", async (event, ctx) => {
		let isBlocked = false;
		let blockReason = "";
		let isDestructive = false;

		// === BASH TOOL SECURITY ===
		if (event.toolName === "bash") {
			const command = (event.input.command as string) || "";

			// Tier 1: Block command substitution patterns (CVE-class, §3.4)
			for (const pattern of COMMAND_SUBSTITUTION_PATTERNS) {
				if (pattern.test(command)) {
					const inQuotes = /(['"]).*\$\(.*\1/.test(command) || /\bcat\s+<</.test(command);
					if (!inQuotes) {
						isBlocked = true;
						blockReason = `<tool_use_error>Security: Command substitution pattern detected. Use explicit commands instead of \$(...) or backtick substitution.</tool_use_error>`;
						break;
					}
				}
			}

			// Tier 1.5: Dangerous Script Runners / Bash Patterns
			if (!isBlocked) {
				const firstWord = command.trim().split(/\s+/)[0];
				if (firstWord && DANGEROUS_BASH_PATTERNS.includes(firstWord)) {
					if (!ctx.hasUI) {
						isBlocked = true;
						blockReason = "Dangerous script runner blocked (no UI for confirmation)";
					} else {
						const choice = await ctx.ui.select(
							`⚠️ Dangerous script runner detected:\n\n  ${command}\n\nThis executes arbitrary code and bypasses shell security.`,
							["Allow this once", "Block"],
						);
						if (choice !== "Allow this once") {
							isBlocked = true;
							blockReason = "Blocked by user — dangerous script runner.";
							isDestructive = true;
						} else {
							denials = { ...denials, consecutiveDenials: 0 };
						}
					}
				}
			}

			// Tier 2: Destructive pattern confirmation
			if (!isBlocked) {
				const matchedDestructive = DESTRUCTIVE_PATTERNS.find((p) => p.test(command));
				if (matchedDestructive) {
					if (!ctx.hasUI) {
						isBlocked = true;
						blockReason = "Dangerous command blocked (no UI for confirmation)";
					} else {
						const choice = await ctx.ui.select(
							`⚠️  Destructive command detected:\n\n  ${command}\n\nThis action may be hard to reverse.`,
							["Allow this once", "Block"],
						);
						if (choice !== "Allow this once") {
							isBlocked = true;
							blockReason = "Blocked by user — consider a safer approach";
							isDestructive = true;
						} else {
							denials = { ...denials, consecutiveDenials: 0 };
						}
					}
				}
			}

			// Tier 3: Tool preference enforcement (§1.3)
			if (!isBlocked) {
				for (const [cmd, info] of Object.entries(TOOL_PREFERENCE_VIOLATIONS)) {
					if (info.pattern.test(command)) {
						sessionToolPreferenceWarnings++;
						break;
					}
				}
			}

			// Tier 4: Git safety (§A8)
			if (!isBlocked) {
				const gitMatch = command.match(/\bgit\s+(\w+)/);
				if (gitMatch) {
					const subcommand = gitMatch[1];

					if (/--no-verify/.test(command)) {
						if (!ctx.hasUI) {
							isBlocked = true;
							blockReason = "git --no-verify blocked (skips hooks)";
						} else {
							const ok = await ctx.ui.select(
								`⚠️  git --no-verify skips safety hooks:\n\n  ${command}\n\nThis bypasses pre-commit checks.`,
								["Allow", "Block"],
							);
							if (ok !== "Allow") {
								isBlocked = true;
								blockReason = "Blocked: --no-verify skips safety hooks. Fix the underlying issue instead.";
								isDestructive = true;
							} else {
								denials = { ...denials, consecutiveDenials: 0 };
							}
						}
					} else {
						const isMutating = GIT_MUTATING_COMMANDS.some((p) => p.test(command));
						if (isMutating && subcommand !== "commit") {
							if (ctx.hasUI) {
								const ok = await ctx.ui.select(
									`Git operation: ${command}\n\nThis modifies repository state.`,
									["Allow", "Block"],
								);
								if (ok !== "Allow") {
									isBlocked = true;
									blockReason = `Git ${subcommand} blocked by user`;
									isDestructive = true;
								} else {
									denials = { ...denials, consecutiveDenials: 0 };
								}
							}
						}
					}
				}
			}
		}

		// === WRITE/EDIT TOOL — Protected paths ===
		if (!isBlocked && (event.toolName === "write" || event.toolName === "edit")) {
			const path = (event.input.path as string) || "";
			const protectedPatterns = [
				/\.env($|\.)/,
				/\.git\//,
				/node_modules\//,
				/\.ssh\//,
				/credentials/i,
				/\.pi\/skills\//,  // Skills directory protection (§11.4)
			];
			const isProtected = protectedPatterns.some((p) => p.test(path));
			if (isProtected) {
				if (!ctx.hasUI) {
					isBlocked = true;
					blockReason = `Protected path: ${path}`;
				} else {
					const ok = await ctx.ui.select(
						`⚠️  Writing to protected path:\n\n  ${path}\n\nThis file may contain sensitive data.`,
						["Allow", "Block"],
					);
					if (ok !== "Allow") {
						isBlocked = true;
						blockReason = `Protected path blocked: ${path}`;
						isDestructive = true;
					} else {
						denials = { ...denials, consecutiveDenials: 0 };
					}
				}
			}
		}

		// Handle blocking and denial limits
		if (isBlocked) {
			if (isDestructive) {
				denials = { ...denials, consecutiveDenials: denials.consecutiveDenials + 1, totalDenials: denials.totalDenials + 1 };
				rejectedCommands.push({ 
					command: event.toolName === "bash" ? (event.input.command as string) : `[${event.toolName}] ${(event.input.path as string)}`, 
					reason: blockReason, 
					timestamp: Date.now() 
				});
			}

			// 3-Strike Denial Breaker (Feature 3)
			if (denials.consecutiveDenials >= DENIAL_LIMITS.maxConsecutive || denials.totalDenials >= DENIAL_LIMITS.maxTotal) {
				if (ctx.hasUI) ctx.ui.notify("Too many consecutive denied tool calls. Dropping out of auto mode.", "error");
				return { 
					block: true, 
					reason: "CRITICAL: Consecutive denials exceeded. You MUST stop using tools and ask the user for guidance." 
				};
			}

			return { block: true, reason: blockReason };
		} else {
			// If a tool successfully passes the gate, reset consecutive denials
			denials = { ...denials, consecutiveDenials: 0 };
		}

		return undefined;
	});

	// ─── Before Provider Request (Payload Mutation) ───
	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload as any;

		// 🛡️ Thinking Budget Constraint (Feature 5)
		// API Rule: thinking.budget_tokens must be < max_tokens
		if (payload && payload.max_tokens && payload.thinking && payload.thinking.budget_tokens) {
			if (payload.thinking.budget_tokens >= payload.max_tokens) {
				payload.thinking.budget_tokens = payload.max_tokens - 1;
				if (ctx.hasUI) {
					ctx.ui.setStatus("claude-core", "⚠️ Clamped thinking budget to maxTokens - 1");
					setTimeout(() => ctx.ui.setStatus("claude-core", undefined), 3000);
				}
				return payload;
			}
		}

		return undefined;
	});

	// ─── Prompt Injection Detection (tool_result) ───
	// From §1.4 — scan tool results for injection attempts
	pi.on("tool_result", async (event, ctx) => {
		if (!event.result?.content) return;

		for (const block of event.result.content) {
			if (block.type !== "text") continue;
			const text = block.text;

			const injectionDetected = INJECTION_PATTERNS.some((p) => p.test(text));
			if (injectionDetected) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						"⚠️  Possible prompt injection detected in tool result. Flagging for review.",
						"warning",
					);
				}
				// Don't block — flag to the model via the system (Claude Code behavior)
				// The system prompt tells the model to flag this to the user
				break;
			}
		}
	});

	// ─── Correction Memory on Rejection ───
	// From §1.5 — when tool calls are blocked, track for session memory
	pi.on("tool_call", async (event, _ctx) => {
		// This handler runs AFTER the permission gate above
		// We use it to track patterns of what's being attempted
		return undefined;
	});

	// ─── Status Display ───
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("claude-core", "🛡️ Claude Core active");
	});

	pi.on("agent_end", async (_event, ctx) => {
		// Reset per-agent-run state
		sessionToolPreferenceWarnings = 0;
	});

	// ─── Inject Correction Context ───
	// From §1.5 + §2.3 — inject rejected command history into agent context
	pi.on("before_agent_start", async (event, _ctx) => {
		if (rejectedCommands.length === 0) return;

		// Only include recent rejections (last 5)
		const recent = rejectedCommands.slice(-5);
		const correctionContext = recent
			.map((r) => `- Rejected: "${r.command}" — Reason: ${r.reason}`)
			.join("\n");

		return {
			message: {
				customType: "claude-core-corrections",
				content: `<system-reminder>Previously rejected actions this session:\n${correctionContext}\nAvoid repeating these patterns. If the user corrected you or expressed a preference, adjust your approach accordingly.</system-reminder>`,
				display: false,
			},
		};
	});

	// ─── Session Lifecycle ───
	pi.on("session_start", async (_event, _ctx) => {
		denials = { consecutiveDenials: 0, totalDenials: 0 };
		rejectedCommands = [];
		sessionToolPreferenceWarnings = 0;
	});

	// ─── Commands ───
	pi.registerCommand("safety", {
		description: "Show session safety stats (blocked commands, denials)",
		handler: async (_args, ctx) => {
			const lines = [
				`Denials: ${denials.totalDenials} total, ${denials.consecutiveDenials} consecutive`,
				`Rejected commands: ${rejectedCommands.length}`,
			];
			if (rejectedCommands.length > 0) {
				lines.push("", "Recent rejections:");
				for (const r of rejectedCommands.slice(-5)) {
					lines.push(`  • ${r.command.slice(0, 60)}${r.command.length > 60 ? "..." : ""}`);
					lines.push(`    Reason: ${r.reason}`);
				}
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
