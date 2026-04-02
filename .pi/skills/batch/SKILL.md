---
name: batch
description: Research and plan a large-scale change, then execute it in parallel across isolated git worktree agents that each commit and optionally open a PR. Use when making sweeping mechanical changes across many files (migrations, refactors, bulk additions).
---

# Batch: Parallel Worktree Orchestration

You are orchestrating a large, parallelizable change across this codebase.
Each work unit runs in its own git worktree with a dedicated pi subagent.

## User Instruction

The user's message following this skill invocation describes the change to make.

## Phase 1: Research and Plan

Before executing anything, deeply research the scope:

1. **Understand the scope.** Search the codebase to find all files, patterns, and call sites that need to change. Understand existing conventions so the migration is consistent.

```bash
# Find all relevant files
grep -rn "<pattern>" --include="*.ts" --include="*.js" src/ | head -50
# Understand the project structure
find . -maxdepth 3 -type f | grep -v node_modules | grep -v .git | head -80
```

2. **Decompose into independent units.** Break the work into 5-30 self-contained units. Each unit MUST:
   - Be independently implementable in an isolated git worktree (no shared state with sibling units)
   - Be mergeable on its own without depending on another unit's PR landing first
   - Be roughly uniform in size (split large units, merge trivial ones)
   - Map to a logical boundary (per-directory, per-module, per-feature)

   Scale the count to the actual work: few files -> closer to 5; hundreds of files -> closer to 30.

3. **Identify the test command.** Figure out how to run tests: `npm test`, `pytest`, `cargo test`, `go test`, etc. If no tests exist, note it.

4. **Document conventions.** Write down the coding conventions you discovered:
   - Import style, naming conventions, file organization
   - Test patterns, error handling style
   - Any project-specific patterns workers must follow

5. **Write the plan.** Present it for user approval:

```markdown
## Batch Plan: <description>

### Units (N total)

| # | Title | Files | Description |
|---|-------|-------|-------------|
| 1 | <title> | <file list> | <what changes> |
| 2 | <title> | <file list> | <what changes> |
| ... | | | |

### Conventions
- <coding conventions discovered during research>
- <patterns to follow for consistency>

### Test Strategy
- Test command: `<command>`
- E2E verification: <how to verify beyond unit tests>

### Architecture
- Workers: N (parallel, max 4 concurrent)
- Isolation: git worktree per worker
- Each worker: implement -> review -> test -> commit -> push -> PR
```

6. **Ask for approval.** Present the plan and wait for the user to confirm before proceeding. If the user wants changes, adjust the plan.

## Phase 2: Execute with batch_orchestrate

After plan approval, call the `batch_orchestrate` tool with:

- `instruction`: The user's original request
- `conventions`: The coding conventions you documented
- `test_command`: The test command you identified
- `units`: Array of work units from your plan, each with `title`, `files`, and `description`

The tool will:
1. Create an isolated git worktree for each unit
2. Spawn parallel pi subagent workers (max 4 concurrent)
3. Each worker: implements the change, reviews it, runs tests, commits, pushes, and creates a PR
4. Track and report progress in real-time
5. Return a summary table with results and PR links

## Phase 3: Review Results

After `batch_orchestrate` completes:

1. Review the results table — note any failures
2. For failed units, diagnose why they failed and decide whether to:
   - Retry manually (implement the change yourself)
   - Skip (explain why)
   - Adjust and re-run
3. Present the final status to the user

## Rules

- **Always plan before executing.** Never call batch_orchestrate without an approved plan.
- **Units must be independent.** If unit B depends on unit A, merge them into one unit.
- **Follow conventions.** Pass ALL discovered conventions to workers so they match the existing codebase.
- **Respect scope.** Each unit should only touch the files listed in its definition.
- **Report honestly.** If units fail, explain why. Don't paper over failures.
- **Clean up on request.** Use `/batch-cleanup` to remove worktrees when done.

## Available Commands

- `/batch-status` — Show current/last batch execution status
- `/batch-cleanup` — Remove all worktrees from the last batch

## Example Invocation

```
/batch migrate all useState hooks to useReducer in the dashboard module
/batch add comprehensive error handling to all API route handlers
/batch convert all class components in src/components/ to functional components
```
