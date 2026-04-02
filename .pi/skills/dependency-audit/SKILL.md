---
name: dependency-audit
description: Audit project dependencies for security vulnerabilities, staleness, and license compliance. Checks for known CVEs, outdated packages, and unused dependencies. Use for security reviews or before releases.
---

# Dependency Audit

## Workflow

### Phase 1: Vulnerability Scan

```bash
# npm/Node.js
npm audit 2>&1 | tee /tmp/audit-results.txt
npm audit --json 2>&1 | head -100

# Python
pip audit 2>/dev/null || safety check 2>/dev/null || echo "Install: pip install pip-audit"

# Rust
cargo audit 2>/dev/null || echo "Install: cargo install cargo-audit"

# Go
govulncheck ./... 2>/dev/null || echo "Install: go install golang.org/x/vuln/cmd/govulncheck@latest"
```

### Phase 2: Staleness Check

```bash
# npm — check for outdated packages
npm outdated 2>&1

# Show major version bumps (breaking changes)
npm outdated --json 2>&1 | head -100
```

### Phase 3: Unused Dependencies

```bash
# JavaScript/TypeScript
npx depcheck 2>/dev/null || echo "Install: npm i -g depcheck"

# Manual check: search for imports of each dependency
for dep in $(cat package.json | grep -oP '"[^"]+":' | head -30 | tr -d '":'); do
  count=$(grep -r "from ['\"]${dep}" src/ --include="*.ts" --include="*.js" -l 2>/dev/null | wc -l)
  if [ "$count" -eq 0 ]; then
    echo "POSSIBLY UNUSED: $dep"
  fi
done
```

### Phase 4: License Check

```bash
# npm
npx license-checker --summary 2>/dev/null || echo "Install: npm i -g license-checker"

# Look for problematic licenses
npx license-checker --json 2>/dev/null | grep -i "gpl\|agpl\|sspl\|busl" | head -20
```

### Phase 5: Supply Chain Review

For any new dependency being added:
1. Check npm/PyPI/crates.io page — is it maintained?
2. Check GitHub stars, last commit date, open issues
3. Check for known typosquatting (similar names to popular packages)
4. Review the package's own dependencies (transitive risk)

## Output Format

```markdown
## Dependency Audit: <project>

### 🔴 Critical Vulnerabilities
| Package | Version | CVE | Severity | Fix |
|---------|---------|-----|----------|-----|
| lodash | 4.17.20 | CVE-2021-23337 | Critical | Upgrade to 4.17.21 |

### 🟡 Outdated Packages
| Package | Current | Latest | Type |
|---------|---------|--------|------|
| react | 17.0.2 | 18.2.0 | Major |
| axios | 0.27.2 | 1.6.0 | Major |

### 🔵 Unused Dependencies
- `package-name`: No imports found in src/

### ⚖️ License Concerns
- `package-name`: GPL-3.0 (copyleft — may affect distribution)

### Recommendations
1. <highest priority action>
2. <next priority>
```

## Severity Guide

| Level | Action | Timeline |
|-------|--------|----------|
| Critical CVE | Fix immediately | Today |
| High CVE | Fix soon | This sprint |
| Major version behind | Plan upgrade | Next sprint |
| Minor version behind | Update when convenient | — |
| Unused dependency | Remove | When touching nearby code |
