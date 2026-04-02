---
name: code-review
description: Multi-pass code review workflow covering correctness, security, performance, and style. Modeled after Claude Code's verification agent pattern. Use when reviewing code changes, PRs, or after implementing features.
---

# Code Review

Multi-pass review workflow derived from Claude Code's verification agent pattern (§12.2 Ultrareview / Bughunter) and the `VERIFICATION_AGENT` feature flag behavior.

## When to Use

- After implementing a feature (3+ file edits trigger this automatically in Claude Code)
- When asked to review code or a PR
- Before marking a task as complete
- When `git diff` shows significant changes

## Review Workflow

### Pass 1: Correctness

Focus: Does the code do what it's supposed to?

1. Read the diff: `git diff --stat` then `git diff` for full changes
2. For each changed file:
   - Does the logic match the stated intent?
   - Are edge cases handled?
   - Are error paths correct?
   - Do function signatures match their callers?
   - Are return types correct?
3. Check for:
   - Off-by-one errors
   - Null/undefined access without guards
   - Incorrect boolean logic
   - Missing `await` on async calls
   - Incorrect variable scope

### Pass 2: Security (OWASP Top 10)

Focus: Are there security vulnerabilities?

1. **Injection**: SQL injection, command injection, XSS
   - Is user input sanitized before use in SQL/HTML/shell?
   - Are parameterized queries used?
2. **Auth**: Authentication and authorization
   - Are auth checks present on all protected routes?
   - Are tokens validated properly?
3. **Data exposure**: Sensitive data leaks
   - Are secrets hardcoded? (API keys, passwords)
   - Is sensitive data logged?
   - Are error messages leaking internals?
4. **Configuration**: Security misconfigurations
   - CORS settings
   - CSP headers
   - Debug mode in production
5. **Dependencies**: Known vulnerabilities
   - Are new dependencies pinned to specific versions?
   - Are they well-maintained?

### Pass 3: Performance

Focus: Will this scale?

1. **Complexity**: O(n²) loops, unnecessary iterations
2. **Database**: N+1 queries, missing indexes, unbounded queries
3. **Memory**: Unbounded collections, large string concatenations
4. **Network**: Unnecessary API calls, missing caching, waterfall requests
5. **Bundle**: Importing entire libraries for one function

### Pass 4: Style & Maintainability

Focus: Will future developers understand this?

1. **Naming**: Clear, descriptive variable/function names
2. **Structure**: Functions doing one thing, appropriate abstraction level
3. **Consistency**: Matches existing codebase patterns
4. **Dead code**: Commented-out code, unused imports, unreachable branches
5. **Types**: Proper TypeScript types (no `any` without justification)

## Output Format

```markdown
## Code Review: <description>

### Summary
<1-2 sentence overview>

### Issues Found

#### 🔴 Critical
- **[file:line]** <description>
  ```
  <code snippet>
  ```
  **Fix**: <suggested fix>

#### 🟡 Warning
- **[file:line]** <description>

#### 🔵 Suggestion
- **[file:line]** <description>

### Security Checklist
- [ ] No injection vulnerabilities
- [ ] Auth checks present
- [ ] No hardcoded secrets
- [ ] Input validation at boundaries
- [ ] Error messages don't leak internals

### Verdict: PASS / PARTIAL / FAIL
<reasoning>
```

## Verification Protocol

From Claude Code's verification agent (§9.1 `VERIFICATION_AGENT`):

> "Non-trivial means: 3+ file edits, backend/API changes, or infrastructure changes."

After review, **verify by running**:
1. Type checker: `npx tsc --noEmit` or equivalent
2. Linter: `npx eslint .` or equivalent
3. Tests: `npm test` or equivalent
4. Build: `npm run build` or equivalent

Report actual output — never claim "all tests pass" when output shows failures.
