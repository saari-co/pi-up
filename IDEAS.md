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

### 6. MicroCompact — Silent Context Trimming
**Source:** `services/compact/microCompact.ts`
**What it does:** Silently trims the output of specific tools *while* you're working, rather than waiting for a full session compaction. It watches tools that generate large text blocks (like `grep`, `cat`, or shell commands). If their output is old (defined by `timeBasedMCConfig`), it quietly replaces the output in the context window with `[Old tool result content cleared]` to save tokens without interrupting the flow.
**Pi implementation:** An extension that hooks `context` or `before_provider_request`. It would scan the message history for large tool results from previous turns and replace their content strings with a cleared marker.

### 7. SessionMemoryCompact — Invariant-Preserving Summarization
**Source:** `services/compact/sessionMemoryCompact.ts`
**What it does:** A new compaction algorithm (gated in Claude Code behind `tengu_session_memory`). Instead of replacing old messages with a static summary block, it generates a continuous "Session Memory" document appended over time. Crucially, it calculates exactly which messages to keep based on `adjustIndexToPreserveAPIInvariants`, ensuring it never accidentally deletes a `tool_use` block while stranding its corresponding `tool_result`.
**Pi implementation:** A more advanced version of our `custom-compaction.ts` extension. Instead of just returning a summary string, it would precisely select which recent messages to preserve intact based on unresolved tool chains, while summarizing the rest.

### 8. Image Stripper for Compaction
**Source:** `services/compact/compact.ts`
**What it does:** Actively strips all image blocks from the transcript and replaces them with a text marker *before* sending the history to the LLM for summarization.
**Why:** Compaction uses an LLM call. Sending 5 screenshots to the summarizer model burns massive tokens and risks `prompt_too_long` errors.
**Pi implementation:** Update our `custom-compaction.ts` to filter out `type: "image"` blocks from the messages array before calling `serializeConversation()`.

### 9. `/verify` Skill — End-to-End Verification
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

## Tier 4: Discovered in Deep Dive (April 2026)

### 23. `/commit` Command — Smart Git Commit
**Source:** `commands/commit.ts`
**What it does:** Analyzes staged/unstaged changes, recent commit history, and branch context, then drafts a commit message matching the repo's style. Follows strict git safety: never amends, never skips hooks, never commits secrets. Uses heredoc syntax for multi-line messages. Includes commit attribution.

**Pi implementation:** A skill that runs `git status`, `git diff HEAD`, `git log --oneline -10`, `git branch --show-current` and then stages and commits with a well-crafted message. Very useful as a daily driver.

---

### 24. `/review` Command — PR Code Review
**Source:** `commands/review.ts`
**What it does:** Reviews pull requests using `gh pr view` and `gh pr diff`. Analyzes code quality, project conventions, performance, security, and test coverage. Can target a specific PR by number or list open PRs.

**Pi implementation:** A skill that takes an optional PR number, fetches the diff via `gh`, and runs a thorough review. Simpler than ultrareview but focused on PR workflow.

---

### 25. `/doctor` Command — Installation Diagnostics
**Source:** `commands/doctor/`
**What it does:** Diagnoses the Claude Code installation — checks settings files, API connectivity, model availability, permissions, hooks, and MCP servers. Reports issues with concrete fix suggestions.

**Pi implementation:** An extension that registers `/doctor` command. Checks: pi version, settings.json validity, extension load errors, model API key availability, git status, node version. Reports a health card.

---

### 26. `/context` Command — Context Usage Visualizer
**Source:** `commands/context/`
**What it does:** Visualizes current context window usage as a colored grid. Shows token breakdown by system prompt, tools, messages, and remaining space. Non-interactive mode returns text stats.

**Pi implementation:** An extension using `ctx.getContextUsage()` to get token counts, then renders a visual bar or grid via `ctx.ui.custom()`. Shows what's consuming context.

---

### 27. `/export` Command — Conversation Export
**Source:** `commands/export/`
**What it does:** Exports the current conversation to a file or clipboard. Supports multiple formats.

**Pi implementation:** An extension that reads `ctx.sessionManager.getEntries()`, serializes to markdown or JSON, writes to file or copies to clipboard via `pbcopy`/`xclip`.

---

### 28. `/diff` Command — Visual Diff Viewer
**Source:** `commands/diff/`
**What it does:** Shows uncommitted changes and per-turn diffs with syntax highlighting. Lets you see what changed in each turn of the conversation.

**Pi implementation:** An extension that runs `git diff` and renders with color-coded additions/deletions. Could also track per-turn diffs by comparing git state at turn boundaries (using git-checkpoint data).

---

### 29. `/cost` Command — Session Cost Tracker
**Source:** `commands/cost/`
**What it does:** Shows total cost and duration of the current session. Breaks down by input/output/cache tokens.

**Pi implementation:** An extension that tracks token usage from assistant message `usage` fields across the session. Display via command or status bar. Uses `ctx.sessionManager.getEntries()` to sum costs.

---

### 30. AutoDream — Background Memory Consolidation
**Source:** `services/autoDream/`, `services/autoDream/consolidationPrompt.ts`
**What it does:** Fires a "/dream" prompt as a forked subagent when enough sessions accumulate. Reads session transcripts, synthesizes learnings into durable memory files. Three phases: Orient (ls memory dir, read index), Gather (scan transcripts for new signal), Consolidate (update memory files). Merges, deduplicates, converts relative dates to absolute.

**Pi implementation:** A skill or extension that periodically reviews session history and updates memory files. Could run on session_start if enough time has passed since last consolidation. The consolidation prompt is gold.

---

### 31. Away Summary — "While You Were Away" Card
**Source:** `services/awaySummary.ts`
**What it does:** When user returns after stepping away, generates a 1-3 sentence recap. Uses a fast model on the last 30 messages plus session memory. States the high-level task and the concrete next step.

**Pi implementation:** An extension that hooks `session_start` or detects idle gaps. If the session has history but user has been away (time gap > threshold), generate a brief recap and show as a notification or widget.

---

### 32. `/stuck` Skill — Diagnose Frozen Sessions
**Source:** `skills/bundled/stuck.ts`
**What it does:** Investigates frozen/stuck/slow sessions. Runs `ps` to find Claude processes, checks CPU/RSS/state, looks for hung child processes, samples stack traces. Reports findings.

**Pi implementation:** A skill that runs `ps`, `pgrep`, and process analysis to find stuck pi processes, high CPU, zombie processes, or hung git/node subprocesses.

---

### 33. `/loop` Skill — Recurring Prompt Scheduler
**Source:** `skills/bundled/loop.ts`
**What it does:** Syntactic sugar for scheduling recurring prompts: `/loop 5m /babysit-prs` or `/loop check the deploy every 20m`. Parses interval from leading token or trailing "every" clause, delegates to the cron scheduler.

**Pi implementation:** A skill (or addition to cron-scheduler extension) that parses the natural-language interval syntax and creates a cron task. Much nicer UX than raw `/cron add`.

---

### 34. ToolSearch — Deferred Tool Loading
**Source:** `tools/ToolSearchTool/`
**What it does:** Tools are loaded on-demand rather than all at startup. Only tool names appear in context initially. When the model needs a tool, it calls ToolSearch to fetch the full schema. Reduces baseline token consumption dramatically.

**Pi implementation:** An extension that uses `pi.setActiveTools()` to start with a minimal set, then dynamically activates tools when the LLM requests them via a `tool_search` custom tool. Could save significant context tokens.

---

### 35. WebSearch Tool — Native Web Search
**Source:** `tools/WebSearchTool/`
**What it does:** Native web search via Anthropic's API (not scraping). Returns search results with links. Requires sources section in response. Domain filtering supported.

**Pi implementation:** Could wrap a search API (Brave, SerpAPI, or Tavily) in a custom tool. Different from web_fetch (which fetches a known URL) — this searches the open web.

---

### 36. NotebookEdit Tool — Jupyter Notebook Editing
**Source:** `tools/NotebookEditTool/`
**What it does:** Edit Jupyter notebook cells by cell ID. Handles the JSON structure of .ipynb files so the model can modify individual cells without corrupting the notebook.

**Pi implementation:** A custom tool that parses .ipynb JSON, lets the LLM edit cells by ID, and writes back valid notebook JSON. Useful for data science workflows.

---

## Priority Matrix (Updated)

| # | Feature | Status | Impact | Effort |
|---|---------|--------|--------|--------|
| 1-22 | Original features | BUILT | — | — |
| 23 | `/commit` command | NEW | Very High | Low |
| 24 | `/review` command | NEW | Very High | Low |
| 25 | `/doctor` diagnostics | NEW | High | Low |
| 26 | `/context` visualizer | NEW | High | Medium |
| 27 | `/export` conversation | NEW | Medium | Low |
| 28 | `/diff` visual viewer | NEW | Medium | Medium |
| 29 | `/cost` tracker | NEW | Medium | Low |
| 30 | AutoDream memory | NEW | Very High | High |
| 31 | Away Summary | NEW | High | Medium |
| 32 | `/stuck` diagnostics | NEW | Medium | Low |
| 33 | `/loop` scheduler | NEW | Medium | Very Low |
| 34 | ToolSearch deferred | NEW | Very High | High |
| 35 | WebSearch native | NEW | High | Medium |
| 36 | NotebookEdit tool | NEW | Medium | Medium |

---

## Original Priority Matrix

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

## Tier 5: Advanced Subagent Architecture (April 2026 Deep Dive)

### 37. Prompt Cache Inheritance (Zero-Cost Spawns)
**Source:** `utils/forkedAgent.ts`
**What it does:** Subagents inherit the exact same `systemPrompt`, `toolUseContext`, and `forkContextMessages` as the leader. Because the mathematical prefix is identical, the API registers a 100% Prompt Cache Hit, dropping the input token cost of spawning an army of agents by ~90%.
**Pi implementation:** When spawning a subagent, export the current session history or use `pi --fork` so the subagent has the identical message prefix, then append the subagent's task instruction.

### 38. Subagent Sandboxing (TeamAllowedPath)
**Source:** `utils/swarm/teamHelpers.ts`
**What it does:** Prevents background agents from destroying the project. A team leader can lock a worker so it is only allowed to use the `Edit` tool inside `/src/frontend/`. If the worker tries to edit `backend.ts`, the permission system blocks it.
**Pi implementation:** Pass `PI_ALLOWED_PATHS` environment variable to subagents. Modify `claude-core.ts` to intercept `edit`, `write`, and `bash` calls, blocking paths that fall outside the sandbox.

### 39. In-Process Subagents
**Source:** `utils/swarm/inProcessRunner.ts`
**What it does:** Instead of spawning heavy `child_process` binaries, Claude Code defaults to running subagents directly inside the main Node thread using `AsyncLocalStorage` to isolate their state.
**Pi implementation:** Use `ctx.model.stream()` inside an extension to run secondary conversation loops headlessly. Saves memory and latency for simple background research tasks that don't need a separate Git worktree.

### 40. Speculation Engine (Zero-Latency Ghost Agent) [ANT-ONLY] [DECOMMISSIONED: BETA]
**Source:** `services/PromptSuggestion/speculation.ts` (Anthropic Internal)
**Status:** Decommissioned and removed due to critical multi-spawn bugs during extension reloads. The Pi extension environment (`agent-session.js`) cannot safely manage persistent background pollers across `/reload` without leaking processes. The Claude Code implementation works because it is a core feature running in-process (`runForkedAgent`), not an extension trying to spawn separate subprocesses via intervals.
**What it does:** While you are typing or idle, a background agent guesses what you'll ask next. It uses an "Overlay Filesystem" (`/tmp/claude/speculation/`) to do fake edits. If you hit Enter and the prompts match, it instantly applies the cached edits to your real repo.
**Pi implementation:** A TUI hook or `input` event interceptor that spawns a ghost agent. Intercept `edit`/`write`/`bash` to redirect paths to `/tmp/pi-speculation/`.

### 41. Skill "Dehydration" (Context Savings)
**Source:** `services/compact/compact.ts`, `tools/SkillTool/prompt.ts`
**What it does:** Claude Code has a "Skill Listing" that defines all available skills (~4k tokens). After the first compaction, they intentionally *stop* re-injecting the full text of skills that weren't invoked in the recent conversation, replacing them with just a name and description.
**Pi implementation:** Modify `session-memory-compact.ts`. If `ctx.sessionManager.getBranch()` shows previous compactions, intercept the system prompt and strip out the full text of `SKILL.md` files that haven't been invoked recently.

### 42. PTL (Prompt Too Long) "Lossy" Escape Hatch
**Source:** `services/compact/compact.ts` -> `truncateHeadForPTLRetry`
**What it does:** If a conversation gets so big that the compaction request itself fails (exceeds 200k limit), Claude Code identifies the token gap and iteratively deletes the oldest API rounds (User/Assistant/Tool triplets) until the request fits. It prepends `[earlier conversation truncated for compaction retry]` to prevent stuck loops.
**Pi implementation:** Update the compaction routine. Wrap the summarization LLM call in a try/catch or token-check. If it exceeds limits, explicitly slice the oldest messages and prepend the truncation marker.

### 43. Content "Stubbing" with Read Markers
**Source:** `tools/FileReadTool/prompt.ts` -> `FILE_UNCHANGED_STUB`
**What it does:** When reading massive files, it truncates the content to a fixed token limit and appends a marker: `[... content truncated; use Read if you need the full text]`. It keeps the "scent" of the file in context without paying for the full body.
**Pi implementation:** Update the `read` tool (or intercept `tool_result` via `micro-compact.ts`) to slice strings > 50KB and append the stub marker.

### 44. API-Native "Micro-Compaction" (Clear Tool Uses)
**Source:** `services/compact/apiMicrocompact.ts`
**What it does:** Uses a beta Anthropic API feature (`clear_tool_uses_20250919`) that allows the client to tell the API to delete specific tool results from its prompt cache memory directly. Targets High-I/O tools like grep, ls, and read.
**Pi implementation:** This requires Anthropic API support. As a fallback, our `micro-compact.ts` extension actively overwrites the string payloads of old `toolResult` blocks before sending the request.

---

## Tier 6: Claude Code Architecture Parity (April 2026 Deep Dive #3)

### 45. Split Compaction into Separate Modules
**Source:** `services/compact/` (7 separate files)
**What it does:** Claude Code separates compaction concerns into distinct modules:
- `compact.ts` — Main LLM-based summarization (image stripping, skill dehydration, PTL retry)
- `microCompact.ts` — Deterministic pre-pass clearing old tool results
- `apiMicrocompact.ts` — API-native `clear_tool_uses` beta feature
- `sessionMemoryCompact.ts` — Rolling invariant-preserving memory
- `postCompactCleanup.ts` — Post-compaction cleanup (strip thinking, re-inject tools, clean empties)
- `autoCompact.ts` — Orchestrator deciding WHEN to compact and which strategy
- `grouping.ts` — Groups messages into API rounds for truncation
**Pi implementation:** Split our monolithic `custom-compaction.ts` into separate files matching this architecture.

### 46. Post-Compact Cleanup
**Source:** `services/compact/postCompactCleanup.ts`
**What it does:** Runs AFTER compaction completes:
- Strips `<thinking>` blocks from compacted output (they waste tokens post-summary)
- Re-injects minimal tool schemas so the model doesn't forget its tools
- Removes empty text blocks left behind by content stubbing
- Cleans up orphaned tool_result blocks with no matching tool_use
**Pi implementation:** New extension `post-compact-cleanup.ts` hooking `session_after_compact`.

### 47. Coordinator Mode with Dispatch-Only Agent [ANT-ONLY]
**Source:** `coordinator/coordinatorMode.ts` (Anthropic Internal)
**What it does:** A session mode where the agent becomes a pure orchestrator:
- Can ONLY use `dispatch_agent`, `send_message`, and `task_stop` tools
- Cannot use read/edit/bash directly — must delegate to workers
- Each worker gets an isolated git worktree
- Manages concurrency: read-only tasks parallel, write tasks serialize per file set
- Tracks worker results via `<task-notification>` XML messages
- Synthesizes findings before directing follow-up work
- ~4000 token system prompt with detailed orchestration rules
**Pi implementation:** New extension `coordinator-mode.ts` with `/coordinate` command.

### 48. Mailbox System for Inter-Agent Communication
**Source:** `utils/mailbox.ts`
**What it does:** File-based JSON message queue at `/tmp/claude-code-mailbox/<sessionId>.json`. Workers write results, coordinator reads them. Simple filesystem-based IPC — no sockets, no databases.
**Pi implementation:** New extension or utility integrated into `coordinator-mode.ts` and `parallel-batch.ts`.

### 49. API Preconnect — TCP/TLS Warmup
**Source:** `utils/apiPreconnect.ts`
**What it does:** On startup, before any API call, opens a TCP+TLS connection to the provider endpoint using `https.request()` with `createConnection` override. Connection stays alive in the Node agent pool. Shaves 200-500ms off the first API response.
**Pi implementation:** New extension `api-preconnect.ts` hooking `agent_start`.

### 50. API-Native Micro-Compaction (clear_tool_uses)
**Source:** `services/compact/apiMicrocompact.ts`
**What it does:** Uses the `clear_tool_uses_20250919` beta API header. Tells the Anthropic API to forget specific `tool_use`/`tool_result` pairs by ID. Targets high-I/O tools (bash, read, grep, ls). Fires when context hits 180k tokens. Falls back to client-side stubbing if the API feature isn't available.
**Pi implementation:** New extension `api-microcompact.ts` hooking `before_provider_request`.

---

## Tier 7: Ant-Only Features Reverse-Engineered (April 2026 Deep Dive #4)

These features are gated behind `USER_TYPE === 'ant'` in Claude Code source and only available to Anthropic employees. We can implement all of them for Pi.

### 51. REPLTool — Persistent Interactive Runtime [ANT-ONLY]
**Source:** `tools/REPLTool/` (Gated behind `tengu_repl_mode`)
**What it does:** Instead of spawning a fresh `bash` process for every tool call, REPLTool keeps a persistent Python, Node, or shell process alive across turns. Commands are piped into stdin, output read from stdout. Eliminates cold-start overhead (~200ms per bash call) and allows stateful operations (variables, imports, connections persist between turns). Supports multiple concurrent REPL sessions.
**Pi implementation:** New extension `repl-tool.ts` with a `repl` tool that spawns persistent child processes keyed by language. Track active sessions, auto-kill on session end.

### 52. /commit-push-pr — One-Shot Git Workflow [ANT-ONLY]
**Source:** `commands.ts` (INTERNAL_ONLY_COMMANDS)
**What it does:** Single command that chains: `git add -A` → `git commit -m <msg>` → `git push origin HEAD` → `gh pr create`. No manual steps, no forgetting to push. Generates commit message from staged diff using the LLM.
**Pi implementation:** New skill `commit-push-pr/` or extension command. Chain existing `/commit` skill with programmatic push and `gh pr create`.

### 53. /bughunter — Automated Bug Scanning Mode [ANT-ONLY]
**Source:** `commands.ts` (INTERNAL_ONLY_COMMANDS)
**What it does:** Enters a mode where the agent systematically scans the codebase for bugs, security vulnerabilities, and code smells. Uses multi-pass analysis: first pass identifies files of interest, second pass deep-reads them, third pass reports findings with severity and fix suggestions.
**Pi implementation:** New skill `bughunter/SKILL.md` combining project-analysis + ultrareview patterns.

### 54. /autofix-pr — Auto-Fix PR Review Comments [ANT-ONLY]
**Source:** `commands.ts` (INTERNAL_ONLY_COMMANDS)
**What it does:** Reads PR review comments via `gh` CLI, parses each comment's file/line reference and suggestion, then automatically applies fixes. Commits with a message referencing the review comment. Handles both inline suggestions and general comments.
**Pi implementation:** New skill `autofix-pr/SKILL.md`. Use `gh pr view --json reviews` to fetch comments, parse file:line references, apply fixes via edit tool.

### 55. /teleport — Cross-Project Context Switch [ANT-ONLY]
**Source:** `commands.ts` (INTERNAL_ONLY_COMMANDS)
**What it does:** Switches the agent's working directory to a different project without losing conversation context. Re-reads the new project's AGENTS.md/README, injects project architecture as a system message, and continues the conversation with awareness of both projects.
**Pi implementation:** New extension command `/teleport <path>`. Change `process.cwd()`, read new AGENTS.md if present, inject context via `sendMessage()`.

### 56. /force-snip — Force Context Truncation [ANT-ONLY]
**Source:** `commands.ts` (INTERNAL_ONLY_COMMANDS)
**What it does:** Immediately triggers compaction regardless of context size. Useful when the conversation is getting unfocused or the agent is confused by old context. Runs the full compaction pipeline (microcompact → LLM summary → postCompactCleanup).
**Pi implementation:** New extension command `/snip`. Trigger `session_before_compact` event manually, run compaction pipeline.

### 57. /break-cache — Force Prompt Cache Invalidation [ANT-ONLY]
**Source:** `commands.ts` (INTERNAL_ONLY_COMMANDS)
**What it does:** Mutates the system prompt slightly (appends a random token or timestamp) to force the API to invalidate the prompt cache. Useful when cached responses are stale or the model is stuck in a loop.
**Pi implementation:** New extension command `/break-cache`. Append a `<!-- cache-bust: <timestamp> -->` comment to the system prompt, then remove it on next turn.

### 58. Computer Use — Screen Control [ANT-ONLY]
**Source:** `utils/computerUse/gates.ts`, `tools/ComputerTool/` (Gated behind `tengu_computer_use`)
**What it does:** Uses Anthropic's Computer Use API to control the screen: take screenshots, move mouse, click buttons, type text. Gated behind `tengu_computer_use` feature flag. Allows the agent to interact with GUIs, browsers, and desktop apps.
**Pi implementation:** New extension `computer-use.ts`. Requires Anthropic API with computer use beta. Register `computer` tool that takes screenshots via `screencapture`/`scrot`, sends to API, returns action coordinates.

### 59. Undercover Mode — Dogfooding Mode [ANT-ONLY]
**Source:** `utils/undercover.ts` (Anthropic Internal)
**What it does:** Strips all power-user features and runs the agent in "vanilla" mode as an external user would experience it. Used by Anthropic employees to test the default experience. Disables ant-only tools, commands, model overrides, and analytics.
**Pi implementation:** New extension command `/undercover`. Disables all pi-up extensions temporarily, runs with only built-in pi tools. `/undercover off` to restore.

### 60. /subscribe-pr — PR Watch Mode [ANT-ONLY]
**Source:** `commands.ts` (INTERNAL_ONLY_COMMANDS)
**What it does:** Watches a PR for new commits, review comments, or status changes. When activity is detected, injects a notification into the conversation so the agent can react (e.g., auto-fix new review comments).
**Pi implementation:** New extension `pr-watcher.ts`. Use `gh pr view --json` on a cron interval (via cron-scheduler), notify on changes.

### 61. /share — Session Sharing [ANT-ONLY]
**Source:** `commands.ts` (INTERNAL_ONLY_COMMANDS)
**What it does:** Exports the current conversation as a shareable link or file that another person can load into their own Claude Code session, preserving full context.
**Pi implementation:** Extend existing `/export` extension. Add a `/share` command that exports to a hosted URL (GitHub Gist) or generates a loadable `.jsonl` session file.
