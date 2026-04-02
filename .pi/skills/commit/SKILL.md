---
name: commit
description: Analyze staged and unstaged changes, draft a smart commit message matching the repo style, stage relevant files, and commit. Follows Claude Code commit safety rules. Use when the user wants to commit their work with a well-crafted message.
---

# Smart Commit

Analyze the current changes and create a well-crafted git commit with a message that matches the repo's existing style.

## Phase 1: Gather Context

Run these commands in parallel to understand the current state:

```bash
git status                        # Working tree state
git diff HEAD                     # All changes (staged + unstaged)
git branch --show-current         # Current branch name
git log --oneline -10             # Recent commits for style reference
```

If there are no changes at all (clean working tree, nothing staged), **stop** and tell the user there is nothing to commit.

## Phase 2: Analyze Changes

1. **Categorize the change type**: feature, fix, refactor, docs, test, chore, style, perf, ci, build.
2. **Identify the scope**: which module, component, or area of the codebase is affected.
3. **Understand the "why"**: what problem does this solve, what behavior changes, what was the motivation.
4. **Check for sensitive files**: skip any `.env`, `.env.*`, `credentials.json`, `*.pem`, `*.key`, `secrets.*`, or similar files -- do NOT stage these. Warn the user if detected.

## Phase 3: Determine Commit Style

Examine the output of `git log --oneline -10` to detect the repo's commit convention:

- **Conventional Commits**: `type(scope): description` (e.g., `feat(auth): add OAuth2 flow`)
- **Prefix style**: `[type] description` or `type: description`
- **Freeform**: plain English sentences
- **Emoji-prefixed**: starts with an emoji

Match whatever style the repo already uses. If there is no clear convention or the repo is new, default to **Conventional Commits**.

## Phase 4: Draft Commit Message

Write a commit message following these rules:

1. **Focus on "why", not "what"** -- the diff already shows what changed; explain the motivation or effect.
2. **Keep it concise** -- 1-2 sentences for the subject line. Add a body only if the change is complex.
3. **Match the detected style** from Phase 3.
4. **Use imperative mood** for the subject: "Add feature" not "Added feature" or "Adds feature".
5. **Do not reference issue numbers** unless the user mentioned one.

Present the draft message to the user and ask for approval before committing.

## Phase 5: Stage and Commit

1. **Stage specific files** -- prefer `git add <file1> <file2> ...` over `git add -A` or `git add .`. Only use broad staging if the user explicitly asks or all changes are related.
2. **Exclude sensitive files** identified in Phase 2.
3. **Commit** with the approved message:

```bash
git add <specific-files>
git commit -m "commit message here"
```

4. **Verify** the commit succeeded:

```bash
git log --oneline -1
git status
```

## Phase 6: Handle Hook Failures

If a pre-commit hook fails:

1. The commit **did not happen** -- do NOT use `--amend`.
2. Read the hook output to understand what failed (lint errors, formatting, type checks).
3. Fix the issues.
4. Re-stage the fixed files.
5. Create a **new** commit attempt -- never amend, never use `--no-verify`.

## Rules

- **NEVER** update git config.
- **NEVER** skip hooks (`--no-verify` is forbidden).
- **ALWAYS** create new commits -- never `--amend` unless the user explicitly asks.
- **NEVER** commit `.env`, credentials, private keys, or secrets files.
- **NEVER** create empty commits (no staged changes).
- **NEVER** use interactive flags (`-i`, `-p`).
- **NEVER** commit without showing the user the proposed message first.
- If the branch name contains an issue number (e.g., `feat/123-login`), mention it in the message only if it fits naturally.

## Output Format

```markdown
## Commit Summary

### Changes
- [file] brief description of change

### Proposed Message
`type(scope): description`

### Result
- Commit: `abc1234`
- Branch: `branch-name`
- Files committed: N
```
