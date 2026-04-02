# Pi-Up: Ideas & Roadmap

> Features from Claude Code source that we haven't built yet, ranked by impact and feasibility. Source paths reference the VM repo at `C0AMW683YFP/scratch/claude-code/src/`.

---

## Tier 1: High Impact — Build Next

### 1. `/simplify` Skill — 3-Agent Parallel Code Review
**Source:** `skills/bundled/simplify.ts`
**What it does:** After any code change, spawns 3 parallel review agents:
- **Agent 1: Code Reuse** — searches for existing utilities that could replace newly written code, flags duplicated functionality
- **Agent 2: Code Quality** — catches redundant state, parameter sprawl, copy-paste, leaky abstractions, stringly-typed code, unnecessary comments, unnecessary JSX nesting
- **Agent 3: Efficiency** — finds redundant computations, missed concurrency, hot-path bloat, recurring no-op updates, TOCTOU anti-patterns, memory leaks, overly broad operations

Then aggregates findings and fixes everything. Much more thorough than our single-pass `code-review` skill.

**Pi implementation:** A skill that instructs the model to read `git diff`, then reason through each of the 3 review categories sequentially (pi doesn't have native subagents, but the model can do the 3 passes itself). Alternatively, if the user has a multi-model setup, this could be an extension that spawns 3 parallel LLM calls.

---

### 2. Custom Compaction Extension — 9-Section Structured Summary
**Source:** `services/compact/prompt.ts`
**What it does:** When context gets compacted, Claude Code doesn't just "summarize." It generates a highly structured 9-section summary inside `<analysis>` + `<summary>` blocks:
1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections (with full code snippets)
4. Errors and Fixes (with user feedback)
5. Problem Solving
6. All User Messages (verbatim, non-tool-result)
7. Pending Tasks
8. Current Work (precise description of what was happening right before compaction)
9. Optional Next Step (with direct quotes from recent conversation)

The `<analysis>` block is a scratchpad that gets stripped before the summary enters context — it improves quality without consuming ongoing tokens.

**Pi implementation:** Hook `session_before_compact` in an extension. Use `serializeConversation()` + `complete()` with the exact prompt from Claude Code source to generate the structured summary. Strip the `<analysis>` block. Return via `compaction.summary`.

---

### 3. Todo/Task Management Tool
**Source:** `tools/TodoWriteTool/prompt.ts`, `tools/TodoWriteTool/TodoWriteTool.ts`
**What it does:** A tool the LLM uses proactively to create and manage task lists. Three states: `pending`, `in_progress`, `completed`. Rules:
- Use for 3+ step tasks
- Don't use for trivial single-step tasks
- Exactly ONE task `in_progress` at any time
- Mark tasks complete IMMEDIATELY (don't batch)
- Each task has `content` (imperative: "Run tests") and `activeForm` (progressive: "Running tests")
- Never mark a task complete if tests are failing or implementation is partial

**Pi implementation:** Register a custom tool via `pi.registerTool()` with the full prompt. Store state in tool result details for branch-correct behavior (same pattern as the `todo.ts` example extension). Add custom rendering with progress indicators.

---

### 4. `/skillify` Skill — Turn Any Session Into a Reusable Skill
**Source:** `skills/bundled/skillify.ts`
**What it does:** At the end of a session where you did something repeatable, `/skillify` will:
1. Analyze session memory + all user messages to identify the process
2. Interview you in 4 rounds (name/description, steps/arguments, per-step details, triggers)
3. Write a complete SKILL.md with frontmatter, steps, success criteria, tool permissions, and per-step annotations (execution mode, artifacts, human checkpoints, rules)
4. Save to repo (`.pi/skills/`) or personal (`~/.pi/agent/skills/`)

It's a skill that creates skills. Self-replicating workflows.

**Pi implementation:** A skill with the full interview prompt. Uses `AskUserQuestion`-style interaction (pi doesn't have this tool natively, but the model can ask questions in text and the user responds). The skill writes the SKILL.md file at the end.

---

### 5. `/batch` Skill — Parallel Worktree Army
**Source:** `skills/bundled/batch.ts`
**What it does:** Orchestrates 5-30 parallel agents for sweeping codebase changes:
1. **Plan mode** — research the scope, decompose into independent units, determine e2e test recipe
2. **Spawn workers** — each in its own git worktree with `isolation: "worktree"`, running in background
3. **Each worker:** implements change → runs `/simplify` → runs tests → tests e2e → commits → pushes → creates PR
4. **Track progress** — renders a status table updated as workers complete

**Pi implementation:** This is the heaviest lift. Pi doesn't have worktree isolation or native subagents. A simplified version could: plan the decomposition, then execute units sequentially with checkpoints, or instruct the user to run parallel pi instances. The planning phase alone is valuable.

---

## Tier 2: Medium Impact — Worth Building

### 6. `/verify` Skill — End-to-End Verification
**Source:** `skills/bundled/verify.ts`, `skills/bundled/verifyContent.ts`
**What it does:** After implementing something, actually runs the app and verifies it works. Not just tests — actual end-to-end verification: start the dev server, hit the endpoints, click through the UI, check screenshots. Ant-only currently but the concept is universal.

**Pi implementation:** A skill that instructs the model to: identify how to run the app, start it, exercise the changed behavior, verify output, and report with evidence. Generic enough to work for any project type.

---

### 7. Git Checkpoint Extension
**Source:** Pi example `git-checkpoint.ts`, Claude Code `services/compact/compact.ts` (file state restoration)
**What it does:** Creates git stash checkpoints at each turn. When you `/fork` a session, offers to restore code state to that point in history. This means session branching also branches your code state.

**Pi implementation:** Already an example extension in pi's repo. Integrate with session-state to persist checkpoint refs across compaction.

---

### 8. `/remember` Skill — Memory Layer Management
**Source:** `skills/bundled/remember.ts`
**What it does:** Reviews all memory layers and proposes cleanup:
1. Reads CLAUDE.md, CLAUDE.local.md, and auto-memory
2. Classifies each entry by best destination (project instructions, personal instructions, team memory, stay in auto-memory)
3. Detects duplicates, outdated entries, and conflicts across layers
4. Presents a structured report with proposed promotions, cleanup, and ambiguous items
5. Waits for user approval before making any changes

**Pi implementation:** A skill that reads `.pi/settings.json`, `AGENTS.md`, and session memories, then proposes reorganization. The classification heuristics (project convention vs personal preference) are directly transferable.

---

### 9. Dirty Repo Guard Extension
**Source:** Pi example `dirty-repo-guard.ts`
**What it does:** On session start, checks for uncommitted git changes and warns. Prevents accidental loss of work when the agent starts modifying files.

**Pi implementation:** Simple `session_start` hook. Run `git status --porcelain`, warn if non-empty.

---

### 10. WebFetch Tool — URL Content Extraction
**Source:** `tools/WebFetchTool/WebFetchTool.ts`, `tools/WebFetchTool/prompt.ts`
**What it does:** Fetches a URL, converts HTML to markdown, processes with a fast model, returns extracted information. Features:
- 15-minute self-cleaning cache
- HTTP → HTTPS auto-upgrade
- Redirect detection and re-fetch
- Pre-approved domains get full content extraction; others get 125-char quote limits
- For GitHub URLs, prefers `gh` CLI instead

**Pi implementation:** Register a custom tool that uses `fetch()` + a markdown converter (like `turndown` or similar). Process with a secondary model call for summarization. Add to pi as a proper tool with rendering.

---

### 11. `/debug` Skill — Session Self-Diagnosis
**Source:** `skills/bundled/debug.ts`
**What it does:** Reads pi's own debug log, greps for `[ERROR]` and `[WARN]`, and helps diagnose issues. Enables debug logging if not already active. Self-healing agent behavior.

**Pi implementation:** A skill that reads pi's log file location, tails the last N lines, and analyzes errors. Adapted to pi's log format instead of Claude Code's.

---

### 12. Auto-Commit on Exit Extension
**Source:** Pi example `auto-commit-on-exit.ts`
**What it does:** On `session_shutdown`, checks for uncommitted changes and offers to create a WIP commit so work isn't lost.

**Pi implementation:** Simple `session_shutdown` hook. Check `git status`, offer to `git stash create` or `git commit -m "WIP"`.

---

## Tier 3: Advanced — Bigger Builds

### 13. Kairos — Always-On Daemon Mode
**Source:** `bridge/`, `proactive/`, feature flags `KAIROS`, `KAIROS_BRIEF`, `PROACTIVE`
**What it does:** Claude Code's "assistant daemon" mode. The agent runs perpetually, surviving CLI restarts via a bridge session. Key behaviors:
- Receives periodic `<tick>` prompts that keep it alive between turns
- Terminal focus awareness — more autonomous when you're away, more collaborative when you're watching
- Cron scheduler for recurring tasks (with jitter to avoid :00/:30 spikes)
- Sleeps between actions to control pacing (`SleepTool`)
- Proactive behavior: explores codebase, runs tests, commits, pushes — all without being asked
- Brief mode: concise status updates instead of verbose explanations
- Auto-background: long-running agents get backgrounded automatically

The bridge architecture uses:
- WebSocket/polling for persistent sessions
- JWT auth with trusted device registration
- Session runner that outlives the CLI process
- Capacity-based wake scheduling

**Pi implementation:** This is a full architectural feature, not just an extension. Possible approaches:
1. **Minimal:** An extension that polls for file changes and sends synthetic prompts on trigger
2. **Medium:** A background process (pm2/systemd) running pi in headless mode with cron triggers
3. **Full:** A bridge daemon similar to Claude Code's, with WebSocket streaming back to the TUI

The system prompt section for proactive mode is in `constants/prompts.ts` — `getProactiveSection()`. Key instructions: "On your very first tick, greet the user and ask what to work on. Don't start exploring unprompted." "If you have nothing useful to do, call SleepTool. Never respond with just a status message."

---

### 14. Ultraplan — Multi-Agent Planning with Remote Execution
**Source:** `utils/ultraplan/`, feature flag `ULTRAPLAN`
**What it does:** When the user types "ultraplan" in their prompt, it triggers a special workflow:
1. The keyword is detected via `findUltraplanTriggerPositions()` (with smart filtering — ignores quotes, paths, questions)
2. The prompt is teleported to a remote CCR (Claude Code Remote) environment
3. The remote agent enters **plan mode** — it plans but doesn't execute
4. The plan is presented in a web UI where the user can edit, approve, or reject
5. On approval, the plan is teleported back and executed locally (or remotely)
6. Uses `ExitPlanModeScanner` to poll the remote session for plan approval/rejection

The remote execution uses git bundle transfer — packages local repo state, uploads to cloud container, unbundles there.

**Pi implementation:** The remote execution part needs infrastructure. But the **planning pattern** is fully implementable:
1. Detect "plan" keyword in user input
2. Enter plan mode (model plans, doesn't execute)
3. Present plan for approval
4. Execute on approval

This could be an extension that hooks `input` to detect the keyword, then modifies the system prompt to add "You are in plan mode. Present a detailed plan but do NOT execute any tools. Wait for approval." Then on the next turn, execute the plan.

---

### 15. Ultrareview — Fleet Code Review
**Source:** Feature flag `REVIEW_ARTIFACT`, `skills/bundled/hunter.ts` (registered as "hunter" skill)
**What it does:** Deploys a fleet of 5-20 agents (each running up to 25 minutes) for deep code review. Uses CCR remote execution. Has its own quota system. The "Bughunter" configuration is stored in `tengu_review_bughunter_config` feature flag.

**Pi implementation:** Simplified version: a skill that runs multiple sequential review passes with different focus areas (similar to `/simplify` but more exhaustive, running longer, and checking for security vulnerabilities specifically).

---

### 16. Coordinator Mode — Multi-Worker Orchestration
**Source:** `coordinator/coordinatorMode.ts`
**What it does:** An alternative operational mode where Claude Code becomes a pure orchestrator:
- Spawns workers via AgentTool, continues them via SendMessage, stops them via TaskStop
- Tracks worker results via `<task-notification>` XML messages
- Synthesizes findings before directing follow-up work ("Never write 'based on your findings'")
- Manages concurrency: read-only tasks run in parallel, write-heavy tasks serialize per file set
- Handles PR activity subscriptions for CI/review monitoring

The coordinator system prompt is ~4000 tokens of detailed orchestration instructions including:
- When to continue a worker vs spawn fresh (context overlap heuristic)
- How to write self-contained worker prompts
- Verification standards ("proving code works, not confirming it exists")
- Failure handling (continue with error context, try different approach, or report)

**Pi implementation:** An extension that provides a `/coordinate` command or a system prompt mode. When active, modifies the agent's behavior to plan-then-delegate rather than implement directly. Works best with pi's `subagent` directory-extension pattern.

---

### 17. Cron Scheduler — Recurring Tasks
**Source:** `utils/cronScheduler.ts`, `utils/cronTasks.ts`, `utils/cronJitterConfig.ts`
**What it does:** Full cron system with:
- Standard cron expressions for scheduling
- Jitter to avoid :00/:30 API load spikes
- Durable persistence to `scheduled_tasks.json`
- Session-only non-persistent tasks
- 7-day auto-expiry for recurring tasks (unless `permanent`)
- Lock-based single-owner scheduling (prevents duplicate fires across sessions)
- Missed-task detection on startup
- Kill switches (env var + feature flag)

**Pi implementation:** Use the `cron` npm package in an extension. Store tasks in session entries or a JSON file. Fire by injecting synthetic user messages into the conversation.

---

### 18. Plan Mode — Think Before Acting
**Source:** `tools/EnterPlanModeTool/`, `tools/ExitPlanModeTool/`, `utils/planModeV2.ts`
**What it does:** `/plan` enters a mode where the model can only read and think — no writes, no execution. It presents a plan, and the user approves/edits before execution begins. Claude Code's `opusplan` routing uses Opus for planning and Sonnet for execution.

**Pi implementation:** An extension that hooks `tool_call` and blocks write/execute tools when plan mode is active. Tracks mode via session state. `/plan` toggles it on, approval toggles it off.

---

### 19. Scratchpad Directory — Per-Session Temp Space
**Source:** `utils/systemPrompt.ts` — `getScratchpadInstructions()`
**What it does:** A per-session directory for temporary files, isolated from the project. The model is instructed to use `$TMPDIR` instead of `/tmp`. Auto-cleaned, sandboxed, permission-free.

**Pi implementation:** Create a temp dir on `session_start`, inject the path into the system prompt via `before_agent_start`, clean up on `session_shutdown`.

---

### 20. Output Style System — Configurable Response Modes
**Source:** `constants/outputStyles.ts`, `constants/prompts.ts` — `getOutputStyleSection()`
**What it does:** Users can configure response styles that modify the system prompt. The style has a `name` and `prompt` that gets injected, plus a `keepCodingInstructions` flag that determines whether the standard coding guidelines are retained or replaced.

**Pi implementation:** An extension that provides `/style` command to cycle through presets (concise, detailed, educational, pair-programming). Modifies the system prompt via `before_agent_start`.

---

### 21. Buddy — Companion Sprite System
**Source:** `buddy/prompt.ts`
**What it does:** A deterministic ASCII art companion assigned per user (based on hashed user ID). Has species, rarity, and stats (DEBUGGING, PATIENCE, CHAOS, WISDOM, SNARK). The companion is injected into the system prompt and the model responds in character when addressed. Pure fun.

**Pi implementation:** An extension that generates a deterministic companion from the username hash, renders ASCII art in the status bar or header widget, and adds a personality note to the system prompt.

---

### 22. Thinkback — Session Replay Animation
**Source:** `commands/thinkback/`, `commands/thinkback-play/`
**What it does:** Year-in-review animation. Analyzes session history, generates a personalized ASCII animation summarizing your coding journey. Fun visualization of what you've built.

**Pi implementation:** A command that reads session history, identifies key milestones, and generates an animated TUI display using pi's `ctx.ui.custom()`.

---

## Priority Matrix

| # | Feature | Impact | Effort | Dependencies |
|---|---------|--------|--------|-------------|
| 1 | `/simplify` skill | Very High | Low | None |
| 2 | Custom compaction | Very High | Medium | Extension API |
| 3 | Todo tool | High | Medium | Custom tool API |
| 4 | `/skillify` skill | High | Low | None |
| 5 | `/batch` skill | High | High | Worktree support |
| 6 | `/verify` skill | High | Low | None |
| 7 | Git checkpoint | Medium | Low | git-checkpoint example |
| 8 | `/remember` skill | Medium | Low | Memory system |
| 9 | Dirty repo guard | Medium | Very Low | None |
| 10 | WebFetch tool | Medium | Medium | HTTP + markdown lib |
| 11 | `/debug` skill | Medium | Low | None |
| 12 | Auto-commit on exit | Low | Very Low | None |
| 13 | Kairos daemon | Very High | Very High | Background process arch |
| 14 | Ultraplan | High | High | Plan mode + keyword detection |
| 15 | Ultrareview | Medium | High | Multi-agent fleet |
| 16 | Coordinator mode | High | High | Multi-agent comms |
| 17 | Cron scheduler | Medium | Medium | cron npm package |
| 18 | Plan mode | High | Medium | Tool blocking extension |
| 19 | Scratchpad directory | Low | Very Low | None |
| 20 | Output style system | Low | Low | None |
| 21 | Buddy companion | Fun | Low | None |
| 22 | Thinkback replay | Fun | Medium | TUI custom components |

---

## Implementation Order Recommendation

**Phase 1 — Quick Wins (1-2 hours each):**
1. `/simplify` skill
2. `/verify` skill
3. `/skillify` skill
4. Dirty repo guard extension
5. Auto-commit on exit extension
6. Scratchpad directory extension

**Phase 2 — Core Upgrades (half day each):**
7. Custom compaction extension
8. Todo tool
9. Plan mode extension
10. `/remember` skill
11. Git checkpoint extension

**Phase 3 — Power Features (1-2 days each):**
12. WebFetch tool
13. `/debug` skill
14. Output style system
15. Cron scheduler
16. `/batch` skill (simplified)

**Phase 4 — Architecture (multi-day):**
17. Coordinator mode
18. Ultraplan (local plan mode first)
19. Kairos daemon (minimal version first)
20. Ultrareview (simplified fleet)

**Phase 5 — Fun:**
21. Buddy companion
22. Thinkback replay
