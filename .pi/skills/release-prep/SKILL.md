---
name: release-prep
description: Pre-release checklist and preparation workflow. Runs tests, checks changelog, validates version bumps, audits dependencies, and verifies build artifacts. Use before publishing a release or tagging a version.
---

# Release Preparation

## Pre-Release Checklist

### Phase 1: State Check (parallel)

```bash
# Current version
cat package.json | grep '"version"'
# OR
cat Cargo.toml | grep '^version'

# Git state
git status
git log --oneline -10
git diff --stat

# Branch check
git branch --show-current
```

### Phase 2: Verification (parallel)

```bash
# Full test suite
npm test 2>&1 | tee /tmp/release-tests.txt
echo "Exit: $?" >> /tmp/release-tests.txt

# Type check
npx tsc --noEmit 2>&1 | tee /tmp/release-types.txt

# Lint
npx eslint . 2>&1 | tee /tmp/release-lint.txt

# Build
npm run build 2>&1 | tee /tmp/release-build.txt

# Dependency audit
npm audit --production 2>&1 | tee /tmp/release-audit.txt
```

### Phase 3: Changelog Review

1. Check if CHANGELOG.md exists and is up to date
2. Review all commits since last release:
   ```bash
   git log $(git describe --tags --abbrev=0 2>/dev/null || echo "HEAD~20")..HEAD --oneline
   ```
3. Categorize changes: Features, Fixes, Breaking Changes, Dependencies

### Phase 4: Version Bump

Determine version bump type:
- **MAJOR** (x.0.0): Breaking API changes
- **MINOR** (0.x.0): New features, backwards compatible
- **PATCH** (0.0.x): Bug fixes only

```bash
# Check for breaking changes
git log $(git describe --tags --abbrev=0 2>/dev/null || echo "HEAD~20")..HEAD --oneline | grep -i "break\|BREAKING"
```

### Phase 5: Final Validation

```bash
# Clean install test
rm -rf node_modules
npm ci
npm test
npm run build

# Package size check
npm pack --dry-run 2>&1 | tail -5
```

## Output Format

```markdown
## Release Readiness: v<version>

### Verification Results
| Check | Status | Details |
|-------|--------|---------|
| Tests | ✅ PASS | 142/142 passing |
| Types | ✅ PASS | No errors |
| Lint | ✅ PASS | No warnings |
| Build | ✅ PASS | Built in 3.2s |
| Audit | ⚠️ WARN | 2 low severity |

### Changes Since Last Release
#### Features
- <feature description>

#### Fixes
- <fix description>

#### Breaking Changes
- <breaking change description>

### Recommended Version
`<current>` → `<recommended>` (<major/minor/patch>)

### Release Blockers
- <any blocking issues>

### Ready to Release: YES / NO
```
