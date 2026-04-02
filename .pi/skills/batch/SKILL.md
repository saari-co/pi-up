---
name: batch
description: Research and plan a large-scale change, then execute it as a series of independent units. Each unit gets its own implementation, review via /simplify, test run, and commit. Use when making sweeping mechanical changes across many files (migrations, refactors, bulk additions).
---

# Batch: Parallel Work Orchestration

You are orchestrating a large, parallelizable change across this codebase.

## User Instruction

The user's message following this skill invocation describes the change to make.

## Phase 1: Research and Plan

First, deeply research what the instruction touches:

1. **Understand the scope.** Search the codebase to find all files, patterns, and call sites that need to change. Understand existing conventions so the migration is consistent.

```bash
# Find all relevant files
grep -rn "<pattern>" --include="*.ts" --include="*.js" src/ | head -50
# Understand the project structure
find . -maxdepth 3 -type f | grep -v node_modules | grep -v .git | head -80
```

2. **Decompose into independent units.** Break the work into 5-30 self-contained units. Each unit must:
   - Be independently implementable without depending on other units
   - Be testable on its own
   - Be roughly uniform in size (split large units, merge trivial ones)
   - Map to a logical boundary (per-directory, per-module, per-feature)

3. **Write the plan.** Present a numbered list:

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
- <how to verify each unit works>

### Risks
- <anything that could go wrong>
```

4. **Ask for approval.** Present the plan and wait for the user to confirm before proceeding. If the user wants changes, adjust the plan.

## Phase 2: Execute Units Sequentially

After plan approval, execute each unit one at a time:

### For each unit:

1. **Announce** — "Starting unit N/total: <title>"

2. **Implement** — Make the changes described in the plan. Follow the conventions identified during research.

3. **Review** — Run the simplify review process on your changes:
   - Check for code reuse opportunities
   - Check for code quality issues
   - Check for efficiency problems
   - Fix any issues found

4. **Test** — Run the project's test suite:
   ```bash
   npm test 2>&1 | tail -30
   # OR the appropriate test command for the project
   ```
   If tests fail, fix them before proceeding.

5. **Commit** — Create a focused commit for this unit:
   ```bash
   git add <specific-files-for-this-unit>
   git commit -m "<descriptive message for this unit>"
   ```

6. **Report** — Update the progress table:

```markdown
| # | Unit | Status | Commit |
|---|------|--------|--------|
| 1 | <title> | done | abc1234 |
| 2 | <title> | done | def5678 |
| 3 | <title> | **in progress** | — |
| 4 | <title> | pending | — |
```

### Handling Failures

- If a unit fails tests: fix the issue within that unit, don't move on
- If a unit conflicts with a previous unit: resolve the conflict, re-test both
- If a unit turns out to be unnecessary: skip it and note why
- If a unit is much larger than expected: split it and adjust the plan

## Phase 3: Final Report

After all units are complete:

```markdown
## Batch Complete: <description>

### Results
| # | Unit | Status | Commit |
|---|------|--------|--------|
| 1 | <title> | done | abc1234 |
| 2 | <title> | done | def5678 |
| ... | | | |

### Summary
- Units completed: N/N
- Files changed: N
- Tests: passing/failing

### Follow-up
- <anything that needs manual attention>
- <any units that were skipped and why>
```

## Rules

- **Always plan before executing.** Never start implementing without an approved plan.
- **One unit at a time.** Complete each unit (implement, review, test, commit) before starting the next.
- **Atomic commits.** Each unit gets its own commit. Don't mix units in a single commit.
- **Test after each unit.** Don't accumulate untested changes.
- **Follow conventions.** Match the existing codebase patterns discovered during research.
- **Report progress.** Update the status table after each unit so the user can track progress.
- **Stop on blockers.** If something fundamental is wrong, stop and ask the user rather than plowing ahead.

## Example Invocation

```
/batch migrate all useState hooks to useReducer in the dashboard module
/batch add comprehensive error handling to all API route handlers
/batch convert all class components in src/components/ to functional components
/batch add TypeScript strict null checks to all files in src/utils/
```
