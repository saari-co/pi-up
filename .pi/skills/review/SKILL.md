---
name: review
description: Review pull requests using the gh CLI. Fetches PR details and diff, then provides a thorough code review covering quality, security, performance, test coverage, and actionable suggestions. Use when asked to review a PR or with the /review command.
---

# PR Review

Review a pull request by fetching its metadata and diff via gh, then performing a structured code review.

## Phase 1: Identify the PR

If a PR number was provided, use it directly. Otherwise:

1. Run gh pr list --limit 20 to show open PRs.
2. Present the list to the user and ask which PR to review.
3. Wait for the user selection before proceeding.

## Phase 2: Gather PR Context

Run these commands to collect PR information:

1. **PR details**: gh pr view NUMBER -- captures title, description, author, base branch, labels, reviewers, and status checks.
2. **PR diff**: gh pr diff NUMBER -- captures the full diff of all changed files.
3. **PR files**: gh pr diff NUMBER --stat -- captures the file-level change summary (files changed, insertions, deletions).

Read the PR description carefully -- it defines the author intent and scope.

## Phase 3: Analyze the Diff

Review every changed file in the diff. Perform the following analysis passes:

### 3.1 Overview

Summarize what the PR does in 2-3 sentences. Identify:
- The core change (feature, fix, refactor, chore)
- Which components/modules are affected
- The scope and blast radius of the change

### 3.2 Code Quality and Style

- Naming clarity: are new variables, functions, and types well-named?
- Consistency with existing codebase patterns and conventions
- Appropriate abstraction level -- not too much, not too little
- Dead code, commented-out code, or unused imports introduced
- Proper error handling at system boundaries

### 3.3 Correctness

- Does the logic match the stated intent in the PR description?
- Edge cases: empty inputs, boundary values, concurrent access
- Off-by-one errors, null/undefined access, incorrect boolean logic
- Missing await on async calls, unhandled promise rejections
- Function signatures match their callers and return types

### 3.4 Security Considerations

- Input validation and sanitization at boundaries
- Injection risks: SQL, command, XSS, path traversal
- Hardcoded secrets, tokens, or credentials
- Authorization checks on protected paths
- Sensitive data in logs or error messages

### 3.5 Performance Implications

- O(n squared) or worse complexity in new code
- N+1 query patterns, unbounded collections, missing pagination
- Unnecessary work: redundant computations, repeated I/O
- Large imports or dependencies added to hot paths
- Missing caching opportunities for expensive operations

### 3.6 Test Coverage Gaps

- Are new code paths covered by tests?
- Are edge cases and error paths tested?
- Are existing tests updated to reflect changed behavior?
- Any test-only changes that weaken assertions?

### 3.7 Potential Issues and Risks

- Breaking changes to public APIs or interfaces
- Migration concerns: data, schema, or configuration changes
- Race conditions or ordering dependencies
- Platform or environment assumptions
- Backward compatibility with existing consumers

## Phase 4: Deliver the Review

Present findings using the output format below. Be specific -- reference file paths and line numbers from the diff. Suggest concrete fixes, not vague advice.

## Output Format

The review should follow this structure:

### PR Review: #NUMBER -- TITLE

**Author**: author | **Base**: base branch | **Files changed**: count

#### Overview
2-3 sentence summary of what the PR does and its scope

#### Issues

**Critical**
- [file:line] description
  Fix: concrete suggestion

**Warnings**
- [file:line] description
  Suggestion: what to change

**Nits**
- [file:line] description

#### Security
- Any security findings, or No security concerns identified

#### Performance
- Any performance findings, or No performance concerns identified

#### Test Coverage
- Gaps identified, or Test coverage looks adequate

#### Verdict: APPROVE / REQUEST_CHANGES / COMMENT
1-2 sentence reasoning

## Rules

- Never fabricate line numbers -- only reference lines visible in the diff.
- Distinguish between blocking issues (Critical/Warnings) and non-blocking feedback (Nits).
- If the PR is trivial (documentation, typos, config), keep the review proportionally brief.
- Acknowledge what the PR does well -- review is not just about finding faults.
- If gh is not available or not authenticated, tell the user and stop.
