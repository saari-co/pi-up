---
name: remember
description: Review and reorganize memory layers. Gathers memories from AGENTS.md, .pi/settings.json, and auto-memory, classifies each by best destination, detects duplicates and conflicts, and presents a structured report for user approval before making any changes.
---

# Remember: Memory Layer Review and Reorganization

Review all memory layers, classify entries by best destination, detect issues, and present a structured report. Do NOT modify any files without explicit user approval.

## Phase 1: Gather Memory Layers

Read all memory sources. Skip any that don't exist.

1. **Project memory (AGENTS.md)** -- Read AGENTS.md from the project root. Extract any project conventions, behavioral rules, or coding standards defined there.
2. **Personal config (.pi/settings.json)** -- Read .pi/settings.json from the project root. Extract user preferences, model settings, or custom configuration.
3. **Auto-memory (system prompt)** -- Review any memories injected into the current system prompt by the memory-system extension. These are typically recent, ad-hoc memories saved via /remember.
4. **Skill-level memory** -- Check for memory-like content embedded in skill files under .pi/skills/.

List every distinct memory entry found, noting its current source layer.

## Phase 2: Classify Entries

For each memory entry, determine the best destination using this reference table:

| Destination | What Belongs | Examples |
|---|---|---|
| **AGENTS.md** (project conventions) | Project-wide rules, coding standards, architecture decisions, team conventions | "Use single quotes in TypeScript", "All API endpoints require auth", "Run tests before committing" |
| **Personal config** (.pi/settings.json) | User preferences, editor settings, model choices, personal workflow habits | "Preferred model: claude-sonnet", "Always show line numbers", "Use dark theme" |
| **Auto-memory** (keep as-is) | Temporary context, uncertain entries, session-specific notes, entries needing more evidence | "User is working on auth refactor", "Debugging issue #42", "Try approach X next session" |

For each entry, assign a classification:
- **Promote** -- entry should move to a more permanent layer
- **Keep** -- entry is in the right place
- **Duplicate** -- entry exists in multiple layers
- **Outdated** -- entry is stale or superseded
- **Conflict** -- entry contradicts another entry in a different layer
- **Ambiguous** -- unclear where it belongs; needs user input

## Phase 3: Detect Issues

Scan across all layers for:

1. **Duplicates** -- Same or near-identical entries in different layers. Note both locations.
2. **Outdated entries** -- References to removed files, old dependency versions, deprecated patterns, or conventions that conflict with current code.
3. **Conflicts** -- Contradictory instructions across layers (e.g., AGENTS.md says "use tabs" but a memory says "use spaces").
4. **Orphaned entries** -- Memories referencing projects, files, or tools that no longer exist in the workspace.

## Phase 4: Present Report

Present ALL proposals in a structured report before making any changes.

```markdown
## Memory Review Report

### Promotions (entries to move to a better layer)
| # | Entry | Current Layer | Proposed Destination | Reason |
|---|-------|---------------|---------------------|--------|
| 1 | "..." | auto-memory | AGENTS.md | Project-wide convention |

### Cleanup (duplicates, outdated, orphaned)
| # | Entry | Layer(s) | Issue | Suggested Action |
|---|-------|----------|-------|-----------------|
| 1 | "..." | AGENTS.md + auto-memory | Duplicate | Remove from auto-memory |

### Ambiguous (need user input)
| # | Entry | Current Layer | Options | Question |
|---|-------|---------------|---------|----------|
| 1 | "..." | auto-memory | AGENTS.md or keep | Is this a permanent project rule? |

### No Action Needed
- [count] entries are correctly placed and current.
```

If there are no entries in a category, say "None" -- don't omit the section.

## Phase 5: Apply Changes (only with approval)

After presenting the report:

1. **Wait for explicit user approval.** Do not proceed without it.
2. **Ask about each ambiguous entry** individually if the user doesn't address them.
3. **Apply approved changes one layer at a time:**
   - For AGENTS.md promotions: add entries to the appropriate section.
   - For config changes: update .pi/settings.json fields.
   - For cleanup: remove duplicate/outdated entries from the specified layer.
4. **Show a summary of what was changed** after applying.

## Rules

- **Present ALL proposals before making ANY changes.** Never modify files preemptively.
- **Do NOT modify files without explicit user approval.** Even obvious cleanups need a "yes."
- **Ask about ambiguous entries.** Don't guess -- the user knows their intent.
- **Preserve formatting.** When editing AGENTS.md or settings.json, match the existing style.
- **One change at a time for conflicts.** If two entries conflict, present both and let the user choose which to keep.
- **Be conservative with "outdated" labels.** Only flag entries as outdated if you have clear evidence (missing file, removed dependency, contradicted by current code). Don't flag entries just because they seem old.
- **Group related entries.** If multiple memories are about the same topic, note this -- the user may want to consolidate them into one.
