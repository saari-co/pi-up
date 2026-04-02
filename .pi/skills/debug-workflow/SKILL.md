---
name: debug-workflow
description: Systematic debugging methodology following reproduce-isolate-fix-verify cycle. Prevents shotgun debugging and ensures root cause analysis. Use when investigating bugs, errors, or unexpected behavior.
---

# Systematic Debugging

From Claude Code's prompt: "If an approach fails, diagnose why before switching tactics — read the error, check your assumptions, try a focused fix. Don't retry the identical action blindly, but don't abandon a viable approach after a single failure either."

## Workflow: Reproduce → Isolate → Fix → Verify

### Phase 1: REPRODUCE

**Goal**: Reliably trigger the bug.

1. Read the error message COMPLETELY — don't skim
2. Get the exact steps to reproduce:
   ```bash
   # Run the failing command/test
   npm test -- --testPathPattern="<relevant-test>"
   # OR reproduce the reported scenario
   ```
3. Save the error output:
   ```bash
   <command> 2>&1 | tee /tmp/debug-error.txt
   ```
4. If you can't reproduce, investigate:
   - Environment differences (OS, Node version, env vars)
   - State dependencies (database, file system, cache)
   - Race conditions (timing, async ordering)

### Phase 2: ISOLATE

**Goal**: Find the exact line/function causing the issue.

1. **Read the stack trace** — start from the bottom (your code), not the top (framework)
2. **Binary search** the codebase:
   - If the error is in function A which calls B which calls C
   - Check B first (the middle)
   - Narrow from there
3. **Check recent changes**:
   ```bash
   git log --oneline -10
   git diff HEAD~5 -- <relevant-files>
   ```
4. **Add targeted logging** (not shotgun `console.log`):
   - Log inputs to the failing function
   - Log the state just before the error
   - Log the condition that should prevent the error

### Phase 3: FIX

**Goal**: Fix the root cause, not the symptom.

1. **Understand WHY** before writing code
2. Make the **minimum change** that fixes the issue
3. Consider:
   - Does this fix the root cause or just mask it?
   - Could this fix break anything else?
   - Is there a simpler fix?
4. **Don't refactor** adjacent code — fix the bug only

### Phase 4: VERIFY

**Goal**: Prove the fix works and nothing else broke.

```bash
# Run the specific failing test
npm test -- --testPathPattern="<test>"

# Run the full test suite
npm test

# Type check
npx tsc --noEmit
```

Report ACTUAL output. If tests still fail, go back to Phase 2.

## Common Bug Patterns

| Pattern | Symptom | Investigation |
|---------|---------|---------------|
| Off-by-one | Array index out of bounds | Check loop bounds, `<` vs `<=` |
| Null access | "Cannot read property of undefined" | Trace data flow backwards |
| Async race | Intermittent failures | Check `await`, Promise ordering |
| Type coercion | Unexpected `true`/`false` | Use `===`, check types |
| Scope leak | Wrong variable value | Check closures, `let` vs `var` |
| Stale state | Old data displayed | Check cache invalidation |
| Import cycle | Undefined at runtime | Check circular dependencies |

## Anti-Patterns

- ❌ **Shotgun debugging**: Changing multiple things at once
- ❌ **Blind retry**: Running the same command hoping for different results
- ❌ **Fix the symptom**: Wrapping in try/catch without understanding the error
- ❌ **Nuclear option**: Deleting files, clearing caches, reinstalling deps as first resort
- ✅ **Read the error**: Actually read the full error message and stack trace
- ✅ **One change at a time**: Change one thing, test, then change the next
- ✅ **Bisect**: Use `git bisect` for regressions
