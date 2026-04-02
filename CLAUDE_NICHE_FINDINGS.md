# Claude Code Niche Insights & Pi Implementations
## Deep Dive #2: Token Savings, Guardrails, and Subagent Management

This document outlines highly specific, token-saving, and safety-critical features reverse-engineered from the Claude Code VM source code that are vital for long-term session survival and API cost reduction.

---

## 1. Token Economics: The "Capped-then-Escalate" Output Strategy
**Source:** `services/api/claude.ts` -> `tengu_otk_slot_v1`
**What it does:** Claude Code does *not* request the maximum possible output tokens right away. Instead, it requests a highly capped default (`CAPPED_DEFAULT_MAX_TOKENS = 8,000`). If the model hits this limit and the response is truncated (stop reason `max_tokens`), the client catches it, hides the failure from the user, and silently *retries the exact same prompt* but with `ESCALATED_MAX_TOKENS = 64,000`.
**Why:** Anthropic API charges for context window reservations or allocates hardware slots based on `max_tokens`. Reserving 64k tokens for every turn when the p99 response is <5k tokens burns massive invisible capacity/money.
**Pi Implementation:** Update `api-registry` or our provider wrapper. Default `maxTokens` to 8k. If a stream ends with `stopReason: "max_tokens"`, immediately retry the request with 64k tokens.

## 2. Guardrail: Strict Subagent Turn Limits (`maxTurns`)
**Source:** `QueryEngine.ts`, `tools/AgentTool/runAgent.ts`
**What it does:** Subagents are notoriously prone to infinite loops (e.g., trying to grep a file, failing, trying again, failing forever). Claude Code enforces absolute, hardcoded turn limits on all background agents.
- Memory Extraction (AutoDream): `maxTurns = 5`
- Speculation Engine: `maxTurns = 1`
- Side Questions: `maxTurns = 1`
- Full Parallel Subagents: `maxTurns = 200`
If the loop iteration exceeds `maxTurns`, the system forcefully throws an error: `"Reached maximum number of turns (X)"` and aborts the agent.
**Pi Implementation:** Add a turn counter to the `parallel-batch.ts` loop. If `result.usage.turns > maxTurns`, kill the `spawn` process immediately and return a `FAILED: Reached max turns` result. 

## 3. Guardrail: Consecutive Denial Circuit Breaker
**Source:** `utils/permissions/denialTracking.ts`
**What it does:** In "auto" mode, if the model attempts to call a tool and the permission gate denies it, the model might stubborningly try the exact same tool call again, getting stuck in a loop of denials. Claude tracks `consecutiveDenials` and `totalDenials`. 
If `consecutiveDenials >= 3` or `totalDenials >= 20`, the agent forcibly drops out of "auto" mode and falls back to interactive prompting, requiring the human to intervene.
**Pi Implementation:** In `claude-core.ts`, track consecutive tool call denials in the `ctx.sessionManager`. If it hits 3 in a row, intercept the tool result and inject an `agent_abort` or a system message forcing it to ask the user what to do next.

## 4. Guardrail: Dangerous Bash Rule Prefix Filtering
**Source:** `permissions/dangerousPatterns.ts`
**What it does:** Users often write custom instructions like "You are allowed to run bash commands without asking." Claude Code strictly filters these generic allow-rules if they match `CROSS_PLATFORM_CODE_EXEC`.
If an allow-rule matches `python*`, `node*`, `bash`, `sh`, `npx`, `npm run`, `eval`, `exec`, or `xargs`, it strips the rule entirely because it allows the model to run *arbitrary code wrappers* that bypass the classifier.
**Pi Implementation:** In `bash-security` skill or `claude-core.ts`, check if the command starts with `python -c` or `node -e`. If the command executes an arbitrary script runner, escalate the permission requirement regardless of the user's trust mode.

## 5. Token Economics: The `budget_tokens` vs `max_tokens` Constraint
**Source:** `services/api/claude.ts` -> `adjustParamsForNonStreaming`
**What it does:** For models with "Extended Thinking" (Claude 3.7+), the API requires that `thinking.budget_tokens` must always be strictly less than `max_tokens`. When dynamically escalating or truncating tokens (see item 1), Claude Code has a strict interceptor that does `budget_tokens = Math.min(budget_tokens, max_tokens - 1)`. If this isn't enforced, the API returns a 400 error and crashes the agent.
**Pi Implementation:** Whenever setting a thinking budget in Pi, ensure `Math.min(budget, maxTokens - 1)` is applied before sending the payload.

## 6. Microcompaction Pre-Pass
**Source:** `services/compact/microCompact.ts` (Referenced in `utils/analyzeContext.ts`)
**What it does:** Before the expensive `session_before_compact` LLM summarization runs, Claude Code runs a deterministic `microcompactResult = await microcompactMessages(messages)` step. This finds massive `bash` or `read` tool outputs older than a few turns and simply string-replaces their `content` with `[Old tool result cleared]` without involving the LLM.
**Pi Implementation:** Our restored `micro-compact.ts` extension handles this. We need to ensure it hooks `before_agent_turn` so it truncates old I/O text *before* the token counting happens, delaying the need for a full LLM compaction.