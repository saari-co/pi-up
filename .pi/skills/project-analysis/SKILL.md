---
name: project-analysis
description: Deep codebase analysis and understanding. Performs recursive exploration of project structure, dependency mapping, architecture pattern detection, and generates comprehensive project summaries. Use when exploring a new codebase or needing to understand project architecture.
---

# Project Analysis

Systematic codebase exploration following Claude Code's "explore before modify" pattern from `src/constants/prompts.ts`: "Do not propose changes to code you haven't read."

## Workflow

### Phase 1: Project Overview (parallel)

Run these simultaneously to build a mental model:

```bash
# Project structure (top 3 levels)
find . -maxdepth 3 -type f | grep -v node_modules | grep -v .git | grep -v __pycache__ | head -100

# Package/dependency info
cat package.json 2>/dev/null || cat Cargo.toml 2>/dev/null || cat go.mod 2>/dev/null || cat pyproject.toml 2>/dev/null || cat requirements.txt 2>/dev/null || echo "No standard package file found"

# Git info
git log --oneline -20 2>/dev/null
git remote -v 2>/dev/null
```

### Phase 2: Architecture Detection

Read key files to identify patterns:

1. **Entry points**: `main.ts`, `index.ts`, `app.ts`, `main.py`, `main.go`, `src/lib.rs`
2. **Configuration**: `tsconfig.json`, `.eslintrc`, `vite.config.*`, `webpack.config.*`
3. **CI/CD**: `.github/workflows/`, `.gitlab-ci.yml`, `Dockerfile`
4. **Documentation**: `README.md`, `CONTRIBUTING.md`, `docs/`
5. **Tests**: `__tests__/`, `test/`, `spec/`, `*_test.go`

### Phase 3: Dependency Map

```bash
# JavaScript/TypeScript
cat package.json | grep -A 100 '"dependencies"'
cat package.json | grep -A 100 '"devDependencies"'

# Python
pip list 2>/dev/null || cat requirements.txt 2>/dev/null

# Rust
cat Cargo.toml | grep -A 50 '\[dependencies\]'

# Go
cat go.mod | grep -v '^$' | head -30
```

### Phase 4: Code Patterns

Analyze source files for:
- **Framework**: React, Vue, Express, FastAPI, Actix, etc.
- **State management**: Redux, Zustand, Pinia, etc.
- **Testing**: Jest, Vitest, pytest, Go testing, etc.
- **Database**: Prisma, TypeORM, SQLAlchemy, GORM, etc.
- **API style**: REST, GraphQL, gRPC, tRPC

### Phase 5: Report

Generate a structured report:

```markdown
# Project Analysis: <name>

## Overview
- Language: <primary language>
- Framework: <framework>
- Package manager: <manager>
- Repo type: <monorepo/single>

## Architecture
- Pattern: <MVC/Clean/Hexagonal/etc>
- Entry point: <path>
- Source layout: <description>

## Key Dependencies
- <dep>: <purpose>
- <dep>: <purpose>

## Testing
- Framework: <framework>
- Coverage: <if detectable>
- Test location: <path>

## Build & Deploy
- Build: <command>
- Test: <command>
- CI/CD: <platform>

## Key Files
- <path>: <purpose>
- <path>: <purpose>

## Observations
- <architectural decision or pattern worth noting>
- <potential issues or tech debt>
```

## Guidelines

- **Read before proposing**: Never suggest changes to code you haven't read
- **Follow existing patterns**: Match the project's established conventions
- **Respect gitignore**: Don't explore `node_modules/`, `.git/`, build outputs
- **Minimize context**: Use `grep` for targeted searches, don't read entire large files
- **Parallel exploration**: Read independent files simultaneously
