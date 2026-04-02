---
name: debug-session
description: Self-diagnose pi session issues by checking debug logs, settings, extensions, and environment. Works with or without log files. Use when pi behaves unexpectedly, extensions fail to load, or configuration seems wrong.
---

# Debug Session: Pi Self-Diagnosis

Diagnose pi session issues systematically -- log analysis, configuration validation, extension health, and environment checks.

## Phase 1: Check Debug Log Availability

Look for pi debug logs and determine what diagnostic data is available.

1. **Check for debug log locations**:
   ```bash
   # Check common log locations
   ls -la ~/.pi/logs/ 2>/dev/null
   ls -la /tmp/pi-*.log 2>/dev/null
   # Check if PI_DEBUG or PI_LOG env vars are set
   env | grep -i '^PI_'
   ```
2. **If no log exists**: inform the user they can restart pi with debug logging enabled (e.g., set PI_DEBUG=1 before running pi, or check pi docs for the correct flag). Continue with configuration and environment checks -- do not stop here.
3. **If a log exists**: proceed to Phase 2.

## Phase 2: Analyze Debug Logs

Only if a log file was found in Phase 1.

1. **Tail recent entries**:
   ```bash
   tail -50 <log-file>
   ```
2. **Extract errors and warnings**:
   ```bash
   grep -iE '\[error\]|\[warn\]|error:|warning:|failed|exception|panic' <log-file> | tail -30
   ```
3. **Check for extension load failures**:
   ```bash
   grep -iE 'extension|plugin|load|import|require' <log-file> | grep -iE 'error|fail|cannot|not found' | tail -20
   ```
4. **Check for permission or access issues**:
   ```bash
   grep -iE 'permission|denied|EACCES|EPERM|ENOENT' <log-file> | tail -10
   ```

## Phase 3: Validate Configuration

Check pi settings and project configuration for common misconfigurations.

1. **Check .pi/settings.json**:
   - Read the file with the read tool and validate JSON structure
   - Look for unknown keys, empty values, or obviously wrong paths
   - Verify model/provider settings reference valid values
   ```bash
   node -e "JSON.parse(require('fs').readFileSync('.pi/settings.json','utf8')); console.log('JSON valid')"
   ```
2. **Check AGENTS.md**:
   - Verify it exists and is non-empty
   - Check for malformed skill references in available_skills blocks
   - Look for path references that do not resolve
   ```bash
   wc -l AGENTS.md 2>/dev/null || echo 'AGENTS.md not found'
   ```
3. **Check skill files**:
   - For each directory under `.pi/skills/`, read its `SKILL.md` and verify:
   - The `name:` in frontmatter matches the directory name
   - A `description:` field is present and under 1024 characters

## Phase 4: Check Extension Health

Examine extensions for common issues.

1. **List extensions and check structure**:
   - Use the read tool to examine each .ts file in .pi/extensions/
   - Verify each has an `export default function` signature
   - Check that import paths reference known packages
2. **Check for common extension issues**:
   - Missing `export default function` -- extension will not load
   - Importing from non-existent packages -- will cause runtime errors
   - Duplicate command or tool name registrations across extensions -- last one wins silently
   ```bash
   grep -h 'registerCommand\|registerTool' .pi/extensions/*.ts 2>/dev/null
   ```

## Phase 5: Environment Check

Verify the runtime environment is healthy.

1. **Node.js version**:
   ```bash
   node --version
   ```
2. **Pi installation**:
   ```bash
   which pi 2>/dev/null || echo 'pi not in PATH'
   pi --version 2>/dev/null || echo 'pi --version failed'
   ```
3. **Working directory sanity**:
   ```bash
   git status --short 2>/dev/null | head -20
   df -h . | tail -1
   ```
4. **Check for conflicting processes**:
   ```bash
   pgrep -af pi 2>/dev/null | head -5
   ```

## Phase 6: Analyze and Report

Compile all findings into a clear diagnosis.

1. **Categorize issues** by severity:
   - **Critical**: pi cannot start, extensions fail to load, corrupt settings
   - **Warning**: deprecated settings, minor misconfigurations, missing optional files
   - **Info**: environment details, version info, suggestions for improvement
2. **Explain each issue in plain language** -- avoid jargon, describe what it means for the user
3. **Suggest concrete fixes** for each issue -- include exact commands or edits

## Output Format

```markdown
## Pi Session Diagnosis

### Log Status
<whether debug logs were found, and key errors if any>

### Configuration Issues
- [severity] <file:line> <issue description>
  Fix: <concrete fix>

### Extension Health
- [severity] <extension> <issue description>
  Fix: <concrete fix>

### Environment
- Node: <version>
- Pi: <version>
- Issues: <any environment problems>

### Summary
<plain-language overview of session health and prioritized action items>
```

## Rules

- Always complete all phases even if early phases find issues -- later phases may reveal the root cause
- Do not modify any configuration files during diagnosis -- only read and report
- If no issues are found, say so clearly -- a clean diagnosis is a valid result
- Prefer concrete fixes over vague advice: include the exact command to run or line to change
