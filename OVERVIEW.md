# Pi-Up: Comprehensive System Overview

> A detailed breakdown of every extension and skill in the pi-up workspace, how they work individually and together, and what Claude Code source they were derived from.

---

## Extensions (4) — Always-on Runtime Behavior

### 1. `claude-core.ts` — The Security Brain

This is the big one. It intercepts every tool call before execution and runs a **4-tier security pipeline** lifted from Claude Code's actual permission system:

**Tier 1: Command Substitution Blocking** — Catches `$(...)`, backticks, and `${...}` patterns. These are CVE-class injection vectors documented in Claude Code's `bash/commands.ts`. It will block bash commands that use command substitution — that's working as intended.

**Tier 2: Destructive Pattern Confirmation** — 18 regex patterns catch things like `rm -rf`, `sudo`, `chmod 777`, `git push --force`, `git reset --hard`, `kill -9`, `DROP TABLE`, etc. If matched, it pops a confirmation prompt. If blocked, it increments a denial counter (from their `denialTracking.ts` — max 3 consecutive, 20 total before fallback).

**Tier 3: Tool Preference Enforcement** — Watches if you're using `cat`, `head`, `sed`, `awk` in bash when you should use pi's dedicated `read`/`edit` tools. Doesn't block — just tracks (matching Claude Code's behavior where the system prompt handles the steering).

**Tier 4: Git Safety** — Blocks `--no-verify` by default (Claude Code source says "NEVER skip hooks"). Confirms mutating git operations (push, merge, rebase, cherry-pick, reset). Lets read-only git commands (status, log, diff, blame, etc.) through without confirmation.

**Also does:**
- Blocks writes to protected paths (`.env`, `.git/`, `node_modules/`, `.ssh/`, `.pi/skills/`)
- Scans tool results for prompt injection patterns (`ignore previous instructions`, `[SYSTEM]`, `<|im_start|>`, etc.)
- Injects rejected command history into the next agent turn via `<system-reminder>` tags so the model doesn't repeat mistakes
- Provides `/safety` command to view denial stats

**Source files:**
- `src/utils/permissions/dangerousPatterns.ts`
- `src/utils/permissions/denialTracking.ts`
- `src/utils/bash/commands.ts`
- `src/utils/shell/readOnlyCommandValidation.ts`
- `src/utils/permissions/permissions.ts`
- `src/utils/toolErrors.ts`

---

### 2. `context-tracker.ts` — Session Instrumentation

Tracks everything happening in your session:

- **Turn counter** — how many LLM turns have happened
- **Tool call counter** — total tool invocations
- **File operation tracker** — every read, write, and edit with path, timestamp, and which turn it happened in. Separate sets for R/W/E so you can see which files were read-only vs. modified
- **Compaction awareness** — counts how many times context was compacted and notifies you
- **Status bar display** — shows `T5 · 23 calls · 3w/2e/8r` in the footer, updates live

**Commands:**
- `/stats` — full session statistics table
- `/files` — every file touched, with `[R]`, `[W]`, `[E]` action tags, sorted alphabetically

**Source files:**
- `src/utils/context.ts`
- `src/utils/contextAnalysis.ts`
- `src/utils/analyzeContext.ts`

---

### 3. `session-state.ts` — The Nervous System

Replicates Claude Code's centralized `State` singleton from `bootstrap/state.ts`. This is the foundation other extensions build on:

- **Skill tracking** — records which skills were invoked with composite keys (`agentId:skillName`), so skills survive across compaction (Claude Code's `POST_COMPACT_MAX_TOKENS_PER_SKILL = 5000` pattern)
- **File state cache** — tracks the last 20 files touched, matching Claude Code's `POST_COMPACT_MAX_FILES_TO_RESTORE = 5` for re-reading files after compaction
- **Tool discovery state** — remembers which tools were discovered during the session
- **Compaction hooks** — persists state to session entries BEFORE compaction and restores AFTER, so nothing is lost
- **Branch-correct** — restores from the current branch on fork/tree/switch, so branching works properly

**Command:** `/state` — shows uptime, turn count, CWD, skills, files tracked, discovered tools

**Source files:**
- `src/bootstrap/state.ts`
- `src/services/compact/compact.ts`

---

### 4. `memory-system.ts` — Persistent Learning

Implements Claude Code's **4-type memory taxonomy** from `memdir/memoryTypes.ts`:

| Type | What It Stores | Example |
|------|---------------|---------|
| **user** | Who you are, your role, preferences | "Senior backend dev, new to React" |
| **feedback** | Corrections and confirmed approaches | "Don't mock the database in tests" |
| **project** | Ongoing work, goals, deadlines | "Merge freeze starts Thursday for release" |
| **reference** | Pointers to external resources | "Pipeline bugs tracked in Linear project INGEST" |

**Auto-correction detection:** When a tool call gets blocked (by claude-core or by you), and your next message contains correction keywords ("no", "don't", "stop", "instead", "actually"), it automatically saves a `feedback` memory. This is from Claude Code's `extractMemories/prompts.ts` — "If the user corrected you, save it to memory."

**Memory injection:** Before each agent turn, all memories are injected as a `<system-reminder>` grouped by type, with feedback (corrections) given highest priority. Uses the same `isMeta: true` pattern from Claude Code — visible to the model, hidden from you.

**Persistence:** Stored as session entries via `pi.appendEntry()`, so memories are branch-correct. Fork a session, and each branch has its own memory state.

**Commands:**
- `/remember [type] title: content` — manually save a memory
- `/memories` — view all memories grouped by type with age
- `/memories clear` — wipe all memories

**Source files:**
- `src/memdir/memoryTypes.ts`
- `src/services/extractMemories/prompts.ts`
- `src/utils/memory/types.ts`
- `src/constants/prompts.ts`

---

## Skills (10) — On-Demand Workflow Guides

Skills are NOT always loaded. Pi shows the model their names and descriptions, and the model reads the full SKILL.md only when a task matches. This is Claude Code's "progressive disclosure" pattern.

---

### 1. `bash-security` — Command Validation Reference

The detailed security playbook. Documents all 4 CVE-class parser differential exploits found in Claude Code's source:

- **`git diff -S`** — arbitrary file write via parser mismatch between validator and git
- **`git ls-remote --server-option`** — data exfiltration by transmitting arbitrary strings to remote servers
- **`git cat-file --batch`** — object exfiltration by dumping arbitrary git object content
- **`git branch --abbrev`** — branch creation via PARSE_OPT_OPTARG detached argument

Also covers: command substitution blocking, data exfiltration vectors (`curl -d`, `wget --post-data`, piping to `nc`), safe heredoc detection, and the complete git read-only command whitelist with safe flags per subcommand.

**Source:** `src/utils/bash/commands.ts`, `src/utils/shell/readOnlyCommandValidation.ts`

---

### 2. `git-safety` — Complete Git Workflow

Pulled directly from Claude Code's `BashTool/prompt.ts` — the exact same commit and PR creation instructions they give their model:

- **Safe commit workflow** — 4-step: gather state (parallel) → analyze & draft → commit with heredoc → handle hook failures (NEVER amend after hook failure)
- **PR creation workflow** — with `gh pr create` using heredocs for body formatting
- **Read-only command list** — everything that's auto-approved without confirmation
- **Dangerous command list** — everything that requires confirmation
- **Explicit "NEVER use -i flag"** — for `git rebase -i`, `git add -i`, `git stash -p`
- **Git Safety Protocol** — 7 rules including never update git config, never skip hooks, never force push to main

**Source:** `src/tools/BashTool/prompt.ts`

---

### 3. `project-analysis` — Codebase Exploration

5-phase exploration workflow following the "read before proposing" principle from Claude Code's system prompt:

1. **Project overview** — structure, package info, git history (all parallel)
2. **Architecture detection** — read entry points, config, CI/CD, docs, tests
3. **Dependency map** — extract dependency lists by language
4. **Code patterns** — identify framework, state management, testing, database, API style
5. **Report** — structured markdown with overview, architecture, dependencies, testing, build/deploy, key files, observations

**Source:** `src/constants/prompts.ts` ("do not propose changes to code you haven't read")

---

### 4. `code-review` — Multi-Pass Review

4-pass review modeled after Claude Code's verification agent (`VERIFICATION_AGENT` feature flag):

| Pass | Focus | Checks |
|------|-------|--------|
| **1. Correctness** | Does it work? | Logic, edge cases, error paths, return types, missing await |
| **2. Security** | OWASP Top 10 | Injection, auth, data exposure, config, dependencies |
| **3. Performance** | Will it scale? | O(n²) loops, N+1 queries, memory leaks, bundle size |
| **4. Style** | Maintainability | Naming, structure, consistency, dead code, types |

Ends with actual verification: run type checker, linter, tests, build. Report real output — never claim "all tests pass" without running them.

**Source:** `VERIFICATION_AGENT` feature flag behavior, `src/constants/prompts.ts`

---

### 5. `refactoring` — Safe Refactoring

5-phase workflow with pre/post verification:

1. **Baseline** — run tests, type check, lint, save output, create git stash
2. **Understand** — read ALL affected files, map dependency graph, identify public API surface
3. **Plan** — state what will and won't change, identify risks
4. **Execute** — smallest possible changes, tests after each change
5. **Verify** — diff test output against baseline

Includes Claude Code's anti-patterns verbatim from source:
- Don't create helpers for one-time operations
- Three similar lines is better than a premature abstraction
- Don't add error handling for scenarios that can't happen
- Don't add docstrings to code you didn't change

**Source:** `src/constants/prompts.ts` (getSimpleDoingTasksSection)

---

### 6. `test-driven` — TDD Workflow

Full red-green-refactor cycle:

1. **RED** — write the simplest failing test, confirm it fails
2. **GREEN** — write MINIMUM code to pass, confirm it passes
3. **REFACTOR** — clean up without changing behavior, run ALL tests

Covers: Arrange-Act-Assert pattern, test priority order (happy path → edge cases → error cases → integration), and guidelines (one assertion per test, test behavior not implementation, no mocking what you don't own).

---

### 7. `debug-workflow` — Systematic Debugging

4-phase cycle derived from Claude Code's prompt: "diagnose why before switching tactics":

1. **Reproduce** — reliably trigger the bug, save error output
2. **Isolate** — read stack trace bottom-up, binary search codebase, check recent changes, add targeted logging
3. **Fix** — understand WHY before writing code, minimum change, root cause not symptom
4. **Verify** — run specific test, run full suite, report actual output

Includes common bug pattern table (off-by-one, null access, async race, type coercion, scope leak, stale state, import cycle) and anti-patterns (no shotgun debugging, no blind retry, no nuclear option).

**Source:** `src/constants/prompts.ts` (getSimpleDoingTasksSection)

---

### 8. `architecture-doc` — Documentation Generation

3-phase workflow:

1. **Discover** — entry points, route definitions, database models, environment dependencies (all via grep/find)
2. **Map components** — for each module: read main file, trace imports/exports, identify responsibility
3. **Generate document** — structured markdown with ASCII diagrams, component breakdowns, data flow, database schema, configuration table, deployment instructions, key decisions

Guidelines: use ASCII diagrams (they live in the repo), document DECISIONS and WHY not just WHAT, write for a new developer joining the team.

---

### 9. `dependency-audit` — Security Audit

5-phase audit:

1. **Vulnerability scan** — `npm audit`, `pip audit`, `cargo audit`, `govulncheck`
2. **Staleness check** — `npm outdated` with major version bump identification
3. **Unused dependency detection** — `depcheck` or manual import search
4. **License compliance** — check for GPL/AGPL/SSPL/BUSL licenses
5. **Supply chain review** — maintenance status, typosquatting risk, transitive dependencies

Output: structured report with severity ratings (Critical → fix today, High → this sprint, Major behind → next sprint).

---

### 10. `release-prep` — Release Checklist

5-phase pre-release workflow:

1. **State check** — current version, git status, branch (parallel)
2. **Verification** — tests, types, lint, build, dependency audit (all parallel)
3. **Changelog review** — all commits since last tag, categorized as Features/Fixes/Breaking
4. **Version bump analysis** — determine major/minor/patch based on breaking changes
5. **Clean install validation** — `rm -rf node_modules && npm ci && npm test && npm run build`

Output: release readiness report with pass/fail table and recommended version bump.

---

## How They Work Together

```
User types a prompt
    │
    ├─► memory-system checks for correction keywords after rejections
    ├─► memory-system injects memories via <system-reminder>
    ├─► claude-core injects rejected command history via <system-reminder>
    │
    ▼
Agent starts thinking
    │
    ├─► context-tracker counts the turn
    ├─► Agent reads a skill SKILL.md if task matches
    │
    ▼
Agent calls a tool
    │
    ├─► claude-core: 4-tier security check
    │     (substitution → destructive → preference → git)
    ├─► context-tracker: increment tool call count, track file if R/W/E
    ├─► session-state: track file in recentlyTouchedFiles
    │
    ▼
Tool executes, returns result
    │
    ├─► claude-core: scan for prompt injection patterns
    ├─► memory-system: check if result was blocked (pending correction)
    │
    ▼
Context gets full → auto-compaction
    │
    ├─► session-state: persist skills + discovery state BEFORE compaction
    ├─► context-tracker: increment compaction count, notify user
    ├─► session-state: restore state AFTER compaction
    │
    ▼
Session branches (/fork, /tree)
    │
    ├─► session-state: restore from branch entries
    ├─► memory-system: restore from branch entries
    └─► context-tracker: reset stats for new branch
```

---

## Command Reference

| Command | Extension | Description |
|---------|-----------|-------------|
| `/safety` | claude-core | Denial stats, rejected command history |
| `/stats` | context-tracker | Turns, tool calls, file counts, compactions |
| `/files` | context-tracker | All files touched with R/W/E action tags |
| `/state` | session-state | Uptime, CWD, skills invoked, files tracked |
| `/remember` | memory-system | Save a typed memory (user/feedback/project/reference) |
| `/memories` | memory-system | View all memories grouped by type |
| `/memories clear` | memory-system | Wipe all session memories |

---

## Source Mapping

Every behavior traces back to actual Claude Code source:

| Behavior | Claude Code Source File |
|----------|----------------------|
| System prompt structure | `src/constants/prompts.ts` — `getSystemPrompt()` |
| Cyber risk instruction | `src/constants/cyberRiskInstruction.ts` |
| Tool preference hierarchy | `src/constants/prompts.ts` — `getUsingYourToolsSection()` |
| Output efficiency rules | `src/constants/prompts.ts` — `getOutputEfficiencySection()` |
| Action safety guidelines | `src/constants/prompts.ts` — `getActionsSection()` |
| Code style rules | `src/constants/prompts.ts` — `getSimpleDoingTasksSection()` |
| Dangerous bash patterns | `src/utils/permissions/dangerousPatterns.ts` |
| Denial tracking (3 consecutive / 20 total) | `src/utils/permissions/denialTracking.ts` |
| Permission pipeline | `src/utils/permissions/permissions.ts` |
| Bash command parsing | `src/utils/bash/commands.ts` |
| Git read-only whitelist | `src/utils/shell/readOnlyCommandValidation.ts` |
| Commit/PR workflow | `src/tools/BashTool/prompt.ts` — `getCommitAndPRInstructions()` |
| 4-type memory taxonomy | `src/memdir/memoryTypes.ts` |
| Memory extraction prompts | `src/services/extractMemories/prompts.ts` |
| Compaction algorithm | `src/services/compact/compact.ts` |
| Compaction prompts | `src/services/compact/prompt.ts` |
| Session state singleton | `src/bootstrap/state.ts` |
| Context window constants | `src/utils/context.ts` |
| Structured error formatting | `src/utils/toolErrors.ts` |
| SSRF protection patterns | `src/utils/hooks/ssrfGuard.ts` |
| API preconnect optimization | `src/utils/apiPreconnect.ts` |
| Prompt injection detection | `src/constants/prompts.ts` (system prompt instruction) |
| Prompt cache boundary | `src/constants/prompts.ts` — `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` |
| Skills directory protection | `src/utils/sandbox/sandbox-adapter.ts` |
| Verification agent pattern | `VERIFICATION_AGENT` feature flag |
