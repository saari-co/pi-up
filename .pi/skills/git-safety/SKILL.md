---
name: git-safety
description: Git operation safety protocols and commit workflow. Enforces read-only command validation, blocks dangerous git patterns, provides safe commit and PR creation workflows. Use for any git operations.
---

# Git Safety

Derived from Claude Code CLI `src/tools/BashTool/prompt.ts` commit/PR instructions and `src/utils/shell/readOnlyCommandValidation.ts`.

## Git Safety Protocol

**ALWAYS follow these rules for ALL git operations:**

1. **NEVER** update git config
2. **NEVER** run destructive git commands unless the user explicitly requests:
   - `push --force`
   - `reset --hard`
   - `checkout .`
   - `restore .`
   - `clean -f`
   - `branch -D`
3. **NEVER** skip hooks (`--no-verify`, `--no-gpg-sign`) unless explicitly asked
4. **NEVER** force push to `main`/`master` — warn the user if they request it
5. **ALWAYS** create NEW commits rather than amending (unless explicitly asked)
6. When staging files, prefer specific files over `git add -A` or `git add .`
7. **NEVER** commit unless the user explicitly asks

## Safe Commit Workflow

### Step 1: Gather State (parallel)
```bash
git status                           # See all untracked files (NEVER use -uall)
git diff --cached --stat             # See staged changes
git diff --stat                      # See unstaged changes
git log --oneline -5                 # Recent commit style reference
```

### Step 2: Analyze & Draft
- Summarize the nature of changes (feature, fix, refactor, etc.)
- Do NOT commit files that likely contain secrets (`.env`, `credentials.json`)
- Draft a concise 1-2 sentence commit message focusing on "why" not "what"

### Step 3: Commit (sequential)
```bash
git add <specific-files>             # Stage specific files
git commit -m "$(cat <<'EOF'
Commit message here.
EOF
)"
git status                           # Verify success
```

### Step 4: Handle Hook Failures
If pre-commit hook fails:
- The commit **DID NOT HAPPEN**
- `--amend` would modify the PREVIOUS commit (WRONG!)
- Fix the issue, re-stage, create a NEW commit

## Safe PR Workflow

### Step 1: Gather State (parallel)
```bash
git status
git diff --cached --stat
git log --oneline main..HEAD         # All commits for this branch
git diff main...HEAD --stat          # Full diff from base
```

### Step 2: Create PR
```bash
gh pr create --title "title" --body "$(cat <<'EOF'
## Summary
- Change 1
- Change 2

## Test plan
- [ ] Test case 1
- [ ] Test case 2
EOF
)"
```

## Read-Only Commands (auto-approve)

These are always safe — no confirmation needed:

```
git status [--porcelain] [--short] [--branch]
git log [--oneline] [--graph] [--author=X] [--since=X]
git diff [--stat] [--name-only] [--cached]
git show [--stat] [--name-only] [--format=X]
git branch --list [--all] [--remote]
git tag --list [--contains=X]
git rev-parse [--show-toplevel] [--git-dir]
git ls-files [--cached] [--deleted] [--modified]
git blame [-L X,Y] [--date=X]
git stash list [--date=X]
git reflog [--all] [--date=X]
git describe [--tags] [--always]
git shortlog [-s] [-n]
git for-each-ref [--format=X] [--sort=X]
git rev-list [--count] [--max-count=N]
git merge-base [--all] [--is-ancestor]
```

## Dangerous Git Patterns (require confirmation)

```
git push [any]                  # Pushes to remote
git commit [any]                # Creates commit
git merge [any]                 # Merges branches
git rebase [any]                # Rebases (NEVER use -i)
git cherry-pick [any]           # Applies commits
git reset [any]                 # Resets state
git revert [any]                # Creates revert commit
git stash drop/pop/clear        # Destroys stash entries
git tag <name> (without --list) # Creates tag
git branch -d/-D/-m/-M          # Deletes/renames branch
```

## Interactive Commands (NEVER use)

These require terminal interaction — always use non-interactive alternatives:
- `git rebase -i` → use `git rebase` without `-i`
- `git add -i` / `git add -p` → use `git add <specific-files>`
- `git stash -p` → use `git stash` without `-p`

## GitHub CLI (`gh`) Operations

Use `gh` for all GitHub operations:
```bash
gh pr list                       # List PRs
gh pr view <number>              # View PR details
gh pr checks <number>            # View CI status
gh issue list                    # List issues
gh issue view <number>           # View issue details
gh api repos/owner/repo/pulls/N/comments  # View PR comments
```
