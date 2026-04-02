---
name: refactoring
description: Safe refactoring workflow with pre/post verification. Ensures refactoring doesn't break existing behavior through systematic test-first validation. Use when restructuring code, extracting functions, or reorganizing modules.
---

# Safe Refactoring

Follows Claude Code's "measure twice, cut once" principle from `src/constants/prompts.ts` action safety guidelines.

## Core Principle

From Claude Code source: "Don't add features, refactor code, or make 'improvements' beyond what was asked. A bug fix doesn't need surrounding code cleaned up."

Only refactor what was explicitly requested. Don't gold-plate.

## Workflow

### Phase 1: Baseline (before touching anything)

```bash
# Run existing tests and save output
npm test 2>&1 | tee /tmp/refactor-baseline.txt
echo "Exit code: $?" >> /tmp/refactor-baseline.txt

# Type check
npx tsc --noEmit 2>&1 | tee /tmp/refactor-types-baseline.txt

# Lint
npx eslint . 2>&1 | tee /tmp/refactor-lint-baseline.txt

# Snapshot current state
git stash create
```

### Phase 2: Understand

1. Read ALL files that will be affected
2. Map the dependency graph: who calls what?
3. Identify the public API surface (what external code depends on)
4. Check for tests covering the code to be refactored

### Phase 3: Plan

Before making changes, state:
- What will change
- What will NOT change (public API contract)
- What tests cover this code
- What risks exist

### Phase 4: Execute

Apply changes incrementally:
1. Make the smallest possible change
2. Run tests after each change
3. If tests fail, understand why before proceeding
4. Keep commits atomic — one logical change per commit

### Phase 5: Verify

```bash
# Run tests again
npm test 2>&1 | tee /tmp/refactor-after.txt

# Compare with baseline
diff /tmp/refactor-baseline.txt /tmp/refactor-after.txt

# Type check
npx tsc --noEmit

# Lint
npx eslint .
```

### Phase 6: Report

```markdown
## Refactoring Complete

### What Changed
- <file>: <description of change>

### What Didn't Change
- Public API: <unchanged contracts>

### Verification
- Tests: <PASS/FAIL — actual output>
- Types: <PASS/FAIL>
- Lint: <PASS/FAIL>

### Before → After
<brief comparison>
```

## Anti-Patterns (from Claude Code source)

- ❌ Don't create helpers or utilities for one-time operations
- ❌ Don't design for hypothetical future requirements
- ❌ Three similar lines of code is better than a premature abstraction
- ❌ Don't add error handling for scenarios that can't happen
- ❌ Don't add docstrings or comments to code you didn't change
- ❌ Don't add backwards-compatibility hacks (renaming unused _vars, re-exporting)
- ✅ If something is unused, delete it completely
- ✅ Trust internal code and framework guarantees
- ✅ Only validate at system boundaries
