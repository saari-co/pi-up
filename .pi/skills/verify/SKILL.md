---
name: verify
description: End-to-end verification after implementing a feature or fix. Actually runs the app, exercises the changed behavior, and verifies it works — not just tests, but real verification with evidence. Use after implementing features, fixes, or refactors.
---

# Verify: End-to-End Verification

You just implemented something. Now prove it actually works.

## Phase 1: Identify What Changed

1. Run `git diff --stat` to see which files changed.
2. Identify the **user-visible behavior** that was added or modified. Not internal refactoring — the thing the user would actually test.
3. State clearly: "I need to verify that [specific behavior] works."

## Phase 2: Determine Verification Strategy

Based on the project type, choose the appropriate verification approach:

### For libraries/packages:
1. Run the existing test suite: `npm test`, `pytest`, `cargo test`, etc.
2. If tests pass, write a minimal script that exercises the new behavior directly.
3. Run the script and check the output.

### For CLI tools:
1. Run the tool with arguments that exercise the change.
2. Check stdout/stderr for expected output.
3. Check exit codes.

### For web apps/servers:
1. Start the dev server in the background.
2. Use `curl` or `fetch` to hit the relevant endpoints.
3. Check response status codes and body content.
4. Kill the server when done.

### For configuration/infrastructure changes:
1. Validate the configuration syntax (linters, validators).
2. Dry-run any deployment commands if available.
3. Check that dependent systems still build.

## Phase 3: Run Verification

Execute the verification plan. For each check:

1. **Run the command** — show the exact command and its output.
2. **Check the result** — does it match expectations?
3. **Record evidence** — capture the actual output (not just "it worked").

```bash
# Example: Run tests
npm test 2>&1 | tail -30

# Example: Exercise a CLI change
./my-tool --new-flag input.txt
echo "Exit code: $?"

# Example: Hit an endpoint
curl -s http://localhost:3000/api/new-endpoint | head -20
```

## Phase 4: Edge Cases

After the happy path works, check at least one edge case:

1. **Empty/missing input** — what happens with no arguments or empty data?
2. **Error path** — does the error handling work?
3. **Boundary condition** — large input, special characters, concurrent access?

Pick the most relevant edge case for the specific change. Don't exhaustively test everything.

## Phase 5: Report

```markdown
## Verification Report

### What was verified
[Specific behavior that was tested]

### Results
| Check | Command | Result | Status |
|-------|---------|--------|--------|
| Happy path | `command` | [actual output] | PASS/FAIL |
| Edge case | `command` | [actual output] | PASS/FAIL |
| Test suite | `npm test` | [summary] | PASS/FAIL |

### Evidence
[Key output snippets proving it works]

### Issues Found
[Any problems discovered, or "None"]
```

## Rules

- **Actually run things.** Don't just read the code and say "looks correct." Execute it.
- **Show evidence.** Include actual command output, not just assertions.
- **Clean up after yourself.** Kill background processes, remove temp files.
- **Report honestly.** If something fails, say so. Don't paper over issues.
- **Don't fix during verification.** If you find a bug, report it. Don't start fixing mid-verification unless it's trivial.
- **Time-bound server checks.** If starting a server, set a timeout and kill it. Don't leave processes running.
