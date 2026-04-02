---
name: bash-security
description: Validates bash commands against security rules before execution. Detects command injection, dangerous patterns, data exfiltration vectors, and parser differential vulnerabilities. Use when running untrusted or complex bash commands.
---

# Bash Security Validation

Derived from Claude Code CLI `src/utils/bash/commands.ts`, `src/utils/shell/readOnlyCommandValidation.ts`, and `src/utils/permissions/dangerousPatterns.ts`.

## When to Use

Apply this skill whenever you need to:
- Validate a bash command before execution
- Check if a command is read-only safe
- Detect command injection attempts
- Validate git commands for safety

## Security Rules

### 1. Blocked Patterns (ALWAYS reject)

These patterns indicate command injection or substitution:

- **Command substitution**: `$(...)`, `` `...` ``, `${...}` with non-variable content
- **Process substitution**: `<(...)`, `>(...)`
- **Dangerous zsh builtins**: `zmodload`, `emulate`, `sysopen`, `ztcp`, `zf_rm`
- **PowerShell comment injection**: `<#`
- **Incomplete fragments**: Commands starting with tab, bare flags, or operators

### 2. Destructive Commands (CONFIRM before execution)

```
rm -rf, rm -r, rm --recursive
sudo <anything>
chmod 777, chown 777
git push --force
git reset --hard
git checkout .
git clean -f/-d/-x
dd (disk destroyer)
mkfs (make filesystem)
kill -9, pkill
shutdown, reboot
DROP TABLE, DROP DATABASE, TRUNCATE
```

### 3. Git Commit Message Validation

Before executing `git commit -m`:
- Check for command substitution in the message: `$(...)`, backticks
- Reject messages starting with `-` (flag injection)
- Validate remainder after `-m 'message'` for shell metacharacters

### 4. CVE-Class Parser Differential Patches

From Claude Code's documented exploit chains:

#### `git diff -S` (ARBITRARY FILE WRITE)
```
# ATTACK: git diff -S -- --output=/tmp/pwned
# Validator sees -S as no-arg, advances, breaks on --, --output unchecked
# Git sees -S requires arg, consumes -- as pickaxe string, --output writes file
# FIX: Treat -S, -G, -O as 'string' argument type (consumes next token)
```

#### `git ls-remote --server-option` (DATA EXFILTRATION)
```
# ATTACK: git ls-remote --server-option="sensitive-data" origin
# Transmits arbitrary string to remote git server
# FIX: --server-option and -o excluded from safe flags
```

#### `git cat-file --batch` (OBJECT EXFILTRATION)
```
# ATTACK: echo <sensitive-hash> | git cat-file --batch
# Dumps arbitrary git object content
# FIX: Only --batch-check (metadata only) is allowed
```

#### `git branch --abbrev` (BRANCH CREATION)
```
# ATTACK: git branch --abbrev newbranch
# PARSE_OPT_OPTARG: detached N becomes positional → creates branch
# FIX: Two-layer defense:
#   1. Accept --abbrev=N (attached, safe)
#   2. Callback catches detached N as positional without --list → dangerous
```

### 5. Data Exfiltration Vectors

Block or flag these patterns:
- `curl -d` / `curl --data` with sensitive paths
- `wget --post-data` / `wget --post-file`
- `git ls-remote --server-option`
- Any command piping to `nc`, `ncat`, `netcat`
- `scp` to unknown hosts

### 6. Safe Heredoc Detection

Only allow heredocs with:
- Single-quoted or escaped delimiters: `<<'EOF'`, `<<\EOF`
- Delimiter in argument position (not command name)
- No nesting
- Remaining command passes all validators

## Validation Workflow

```
1. Parse command into subcommands (split on ;, &&, ||, |)
2. For each subcommand:
   a. Check against blocked patterns → REJECT if matched
   b. Check against destructive patterns → CONFIRM if matched
   c. If git command:
      - Extract subcommand (status, log, push, etc.)
      - Check if read-only → ALLOW without confirmation
      - Check if mutating → CONFIRM
      - Validate flags against safe flag whitelist
      - Run additionalCommandIsDangerousCallback if defined
   d. Check for data exfiltration vectors → FLAG
3. Return: ALLOW, CONFIRM, or REJECT with reason
```

## Git Read-Only Command Whitelist

These git subcommands are safe to run without confirmation:

| Command | Key Safe Flags |
|---------|---------------|
| `git status` | `--porcelain`, `--short`, `--branch` |
| `git log` | `--oneline`, `--graph`, `--author`, `-S` (string!) |
| `git diff` | `--stat`, `--name-only`, `--cached`, `-S` (string!) |
| `git show` | `--stat`, `--name-only`, `--format` |
| `git branch --list` | `--all`, `--remote`, `--contains` |
| `git tag --list` | `--contains`, `--sort`, `--format` |
| `git rev-parse` | `--show-toplevel`, `--git-dir` |
| `git ls-files` | `--cached`, `--deleted`, `--modified` |
| `git blame` | `-L`, `--date`, `--porcelain` |
| `git stash list` | `--date`, `--format` |

**Critical**: `git branch` without `--list` and with positional args → CREATES a branch. Always check for the `--list` flag.
