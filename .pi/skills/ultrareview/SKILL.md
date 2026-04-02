---
name: ultrareview
description: Deep 5-pass security-focused code review. Goes beyond /simplify with sequential passes for security audit (OWASP Top 10), correctness, performance, reliability, and API contract review. Reports findings by severity with file:line references and fixes critical/high issues directly.
---

# Ultrareview: Deep Security-Focused Code Review

A thorough 5-pass review that examines all changed files via git diff. Each pass focuses on a distinct concern. Findings are classified by severity and critical/high issues are fixed directly.

## Phase 1: Identify Changes

1. Run git diff --stat to get an overview of changed files
2. Run git diff (or git diff HEAD if there are staged changes) for full content
3. If no git changes exist, review files mentioned or edited in this conversation
4. Note the scope: number of files, lines changed, areas of the codebase affected

## Phase 2: Five Review Passes

Perform all five passes sequentially on the changed code. For each pass, examine **every** changed file.

### Pass 1: Security Audit

Focus: OWASP Top 10 and common vulnerability patterns.

1. **Injection** (SQL, command, XSS, LDAP, template)
   - User input flowing into queries, shell commands, HTML, or templates without sanitization
   - String concatenation instead of parameterized queries or prepared statements
   - eval(), Function(), child_process.exec() with unsanitized input
   - Template literal injection in SQL, GraphQL, or shell contexts
2. **Authentication & Authorization**
   - Missing auth checks on protected routes or endpoints
   - Broken access control — horizontal or vertical privilege escalation
   - JWT validation gaps: missing expiry check, algorithm confusion, weak secrets
   - Session fixation or insecure session handling
3. **Secrets Exposure**
   - Hardcoded API keys, passwords, tokens, or connection strings
   - Secrets logged to console, error messages, or telemetry
   - Secrets committed to version control (check for .env values in diff)
   - Insufficient secret rotation or overly broad secret scope
4. **Path Traversal & File Access**
   - User-controlled paths without canonicalization or allowlist validation
   - Directory traversal via ../ sequences
   - Symlink following attacks
   - Unrestricted file upload types or destinations
5. **Data Protection**
   - Sensitive data in URLs, query strings, or logs
   - Missing encryption for data at rest or in transit
   - Overly permissive CORS, missing CSP headers
   - Error messages leaking stack traces or internal structure

### Pass 2: Correctness

Focus: Logic errors and runtime failures.

1. **Logic Errors**
   - Off-by-one in loops, slices, or range calculations
   - Incorrect boolean logic (De Morgan violations, short-circuit mistakes)
   - Wrong comparison operators (== vs ===, < vs <=)
   - Incorrect variable shadowing or scope capture in closures
2. **Null/Undefined Handling**
   - Property access on potentially null/undefined values
   - Missing optional chaining where needed
   - Incorrect nullish coalescing (?? vs || for falsy values)
   - Uninitialized variables used before assignment
3. **Async/Concurrency**
   - Missing await on async calls
   - Race conditions in shared state access
   - Unhandled promise rejections
   - Deadlocks from circular async dependencies
   - Concurrent modifications to collections during iteration
4. **Error Handling Gaps**
   - Catch blocks that swallow errors silently
   - Missing try/catch around operations that can throw
   - Incorrect error re-throwing (losing stack trace)
   - Error types not distinguished when different handling is needed

### Pass 3: Performance

Focus: Scalability and efficiency issues.

1. **Algorithmic Complexity**
   - O(n^2) or worse patterns: nested loops over the same collection, repeated find/indexOf inside loops
   - Linear search where a Set/Map lookup would work
   - Sorting when only min/max is needed
   - Redundant iterations that could be combined into one pass
2. **Memory Issues**
   - Unbounded data structures (arrays/maps that grow without limit)
   - Large string concatenation in loops (use array join or buffer)
   - Event listener or subscription leaks (registered without cleanup)
   - Closures capturing large scopes unnecessarily
3. **Unnecessary Work**
   - Redundant computations inside loops that could be hoisted
   - Repeated file reads, API calls, or database queries for the same data
   - Parsing/serializing the same data multiple times
   - Missing memoization for expensive pure functions called repeatedly
4. **Database & I/O**
   - N+1 query patterns (query per item instead of batch)
   - Missing indexes on frequently queried columns
   - Unbounded queries without LIMIT
   - Sequential I/O that could be parallelized

### Pass 4: Reliability

Focus: Error recovery and graceful degradation.

1. **Resource Cleanup**
   - File handles, database connections, or network sockets not closed in finally blocks
   - Missing cleanup in error paths (early returns skipping resource release)
   - Temporary files or directories not cleaned up
   - Timer/interval handles not cleared on teardown
2. **Timeout Handling**
   - Network requests without timeouts (can hang indefinitely)
   - Missing circuit breaker patterns for failing external services
   - Database query timeouts not configured
   - Background jobs without maximum execution time
3. **Retry & Recovery**
   - Retries without backoff (can overwhelm failing services)
   - Retries on non-idempotent operations
   - Missing dead-letter or fallback handling after max retries
   - Recovery logic that can itself fail, causing cascading failures
4. **Graceful Degradation**
   - Hard failures when partial results would be acceptable
   - Missing feature flags or fallback paths
   - Health check endpoints that don't reflect actual readiness
   - Startup dependencies without timeout or fallback

### Pass 5: API Contract

Focus: Breaking changes and boundary safety.

1. **Breaking Changes**
   - Removed or renamed fields in response objects
   - Changed parameter types, order, or optionality
   - Removed endpoints or methods
   - Changed default values or behavior without versioning
2. **Backward Compatibility**
   - New required fields without migration path
   - Changed serialization format (date formats, enum encoding)
   - Removed support for previously accepted input formats
   - Changed error codes or error response structure
3. **Schema & Validation**
   - Missing input validation at API boundaries
   - Accepting wider types than intended (e.g., any at boundaries)
   - Missing length/range limits on string/number inputs
   - Inconsistent validation between client and server
4. **Type Safety at Boundaries**
   - Unchecked type assertions on external data (as casts)
   - Missing runtime validation for data from network, files, or environment
   - Generic any types at module boundaries
   - Implicit type coercion across API layers

## Phase 3: Classify and Fix

### Severity Levels

| Severity | Criteria | Action |
|----------|----------|--------|
| **Critical** | Exploitable vulnerability, data loss, crash in production | Fix immediately |
| **High** | Significant bug, security weakness, major performance issue | Fix immediately |
| **Medium** | Minor bug, code smell, moderate performance concern | Report with fix suggestion |
| **Low** | Style issue, minor improvement opportunity | Report only |

### Fix Protocol

1. Fix all **critical** and **high** severity issues directly in the code
2. For each fix, verify it doesn't introduce new issues
3. For **medium** issues, provide a concrete code snippet showing the fix
4. For **low** issues, describe the improvement briefly

## Output Format

Report findings grouped by severity, then by pass:

### Scope
- **Files changed**: count
- **Lines changed**: +added / -removed
- **Areas**: affected modules/components

### Critical Issues
- **[file:line]** (Pass: Security) description
  **Fix applied**: what was changed

### High Issues
- **[file:line]** (Pass: Correctness) description
  **Fix applied**: what was changed

### Medium Issues
- **[file:line]** (Pass: Performance) description
  **Suggested fix**: code snippet showing the improvement

### Low Issues
- **[file:line]** (Pass: API Contract) description

### Pass Summary

| Pass | Findings | Critical | High | Medium | Low |
|------|----------|----------|------|--------|-----|
| Security | count | ... | ... | ... | ... |
| Correctness | count | ... | ... | ... | ... |
| Performance | count | ... | ... | ... | ... |
| Reliability | count | ... | ... | ... | ... |
| API Contract | count | ... | ... | ... | ... |

### Verdict: PASS / PARTIAL / FAIL
- **FAIL** if any critical or high issues remain unfixed
- **PARTIAL** if medium issues exist but all critical/high are resolved
- **PASS** if no issues found or only low-severity items remain

## Verification

After fixing critical/high issues:

1. Run the type checker if available (tsc --noEmit or equivalent)
2. Run tests if available (npm test or equivalent)
3. Re-run git diff to confirm fixes are correct
4. Report actual results — never claim clean output when errors exist
