---
name: skillify
description: Turn any session into a reusable skill. Analyzes the conversation to extract a repeatable process, interviews the user in 4 rounds to refine it, then writes a SKILL.md file with proper frontmatter, steps, success criteria, and argument placeholders. Use when a workflow should be captured for reuse.
---

# Skillify: Turn This Session Into a Reusable Skill

Analyze the current session to extract a repeatable workflow, then guide the user through 4 interview rounds to produce a polished SKILL.md file.

## Phase 1: Session Analysis

Before asking questions, silently analyze the conversation so far:

1. **Identify the repeatable process** — what task was performed? What problem was solved?
2. **Extract the steps** — what sequence of actions was taken? Include tool calls, commands, file reads, edits, and decisions.
3. **Note corrections and retries** — where did the process backtrack or adjust? These become rules or gotchas.
4. **List tools used** — which tools (read, edit, write, bash) were involved and how?
5. **Identify inputs** — what varied or could vary between runs? These become arguments.
6. **Identify outputs** — what artifacts were produced? Files, reports, commits?

Prepare a summary of your analysis before starting the interview.

## Phase 2: Interview (4 Rounds)

Ask questions as plain text. Wait for the user to respond before proceeding to the next round.

### Round 1: Name, Description, and Goals

Present your analysis summary, then ask:

1. **Proposed name** — suggest a lowercase-hyphen name based on the task. Ask user to confirm or rename.
2. **Description** — propose a one-line description (max 1024 chars) covering what the skill does and when to use it. Ask user to confirm or revise.
3. **Goals** — list the 2-4 primary goals you identified. Ask: "Are these the right goals? Anything to add or remove?"

### Round 2: Steps, Arguments, and Save Location

Present the step-by-step process you extracted, then ask:

1. **Steps** — show the ordered list of steps with brief descriptions. Ask: "Is this the right sequence? Any steps to add, remove, or reorder?"
2. **Arguments** — list the variable inputs you identified as {{argument_name}} placeholders. Ask: "Are these the right arguments? Any defaults to set?"
3. **Save location** — ask: "Where should this skill be saved?"
   - **Project-local**: .pi/skills/name/SKILL.md (available to this repo only)
   - **Personal**: ~/.pi/agent/skills/name/SKILL.md (available across all projects)

### Round 3: Step Details

For each step from Round 2, ask:

1. **Expected output** — what does this step produce? (files, console output, state change)
2. **Success criteria** — how do you know this step succeeded?
3. **Human checkpoint** — should the user be asked to confirm before proceeding? (yes/no)
4. **Parallelism** — can this step run concurrently with other steps? (yes/no)
5. **Rules** — any constraints, warnings, or "never do X" for this step?

Present all steps in a numbered list. The user can answer per-step or in bulk.

### Round 4: Triggers and Gotchas

Ask:

1. **Triggers** — when should someone use this skill? List the situations or commands that should invoke it. This becomes the description field's "Use when..." clause.
2. **Gotchas** — what tripped you up during the session? What would you warn someone about? These become a Rules section.
3. **Final confirmation** — present the complete skill outline and ask: "Ready to generate? Any last changes?"

## Phase 3: Generate SKILL.md

Write the SKILL.md file using the following template structure. Adapt section names and counts to fit the actual workflow.

### Template

The generated file must follow this structure:

    ---
    name: {{skill_name}}
    description: {{description}}. Use when {{triggers}}.
    ---

    # {{Title}}: {{Short Description}}

    {{Brief overview of what this skill does and why.}}

    ## Phase 1: {{First Phase Name}}

    {{Phase description.}}

    1. **{{Step name}}** — {{step instructions}}.
       - Success: {{success criteria}}
       - Output: {{expected output}}
       - Checkpoint: Ask user to confirm before proceeding. (only if flagged)
       - Rule: {{rule}} (only if applicable)

    2. **{{Next step}}** — {{instructions}}.
       ...

    ## Phase 2: {{Second Phase Name}}

    ...

    ## Rules

    - {{Gotcha or constraint from Round 4}}
    - {{Another gotcha}}
    - ...

    ## Output Format

    ## {{Skill Name}} Results

    ### Summary
    {{What was accomplished}}

    ### Steps Completed
    | Step | Result | Status |
    |------|--------|--------|
    | {{step}} | {{result}} | PASS/FAIL |

Guidelines for the generated SKILL.md:

- **Frontmatter**: name must be lowercase-hyphen and match the parent directory. description must be under 1024 chars.
- **Arguments**: Use {{argument_name}} syntax for variable inputs. Document them near the top or where first used.
- **Phases**: Group related steps into phases. Name phases clearly (not just "Phase 1").
- **Success criteria**: Every non-trivial step should have a way to verify it worked.
- **Rules section**: Consolidate all gotchas, constraints, and warnings.
- **Output format**: Include a results template so the skill produces consistent output.
- **Tone**: Write instructions as imperative commands ("Run X", "Check Y"), not descriptions.

## Phase 4: Save and Confirm

1. Show the complete generated SKILL.md to the user.
2. Ask: "Save to {{chosen_path}}? Any changes first?"
3. On confirmation, write the file using the write tool.
4. Verify the file was created by reading it back.
5. Report the saved location.

## Rules

- **Never skip the interview.** Even if the session is clear, all 4 rounds must happen. The user may have context you missed.
- **Wait for responses.** Ask one round of questions at a time. Do not proceed until the user answers.
- **Respect the user's save location choice.** Default to project-local if the user doesn't have a preference.
- **Don't invent steps.** Only extract what actually happened in the session. If the session is empty or too short, tell the user and ask them to describe the workflow manually.
- **Keep descriptions actionable.** Each step should tell someone exactly what to do, not just what the step is about.
- **Preserve corrections as rules.** If something was tried and then corrected during the session, capture the correct approach as a rule so future runs don't repeat the mistake.
- **Match existing skill style.** Before writing, check other skills in .pi/skills/ for tone and format conventions. Follow them.

## Output Format

    ## Skillify Results

    ### Skill Created
    - **Name**: {{skill_name}}
    - **Location**: {{file_path}}
    - **Phases**: {{count}}
    - **Steps**: {{count}}
    - **Arguments**: {{list or "none"}}

    ### Summary
    {{Brief description of the captured workflow}}
