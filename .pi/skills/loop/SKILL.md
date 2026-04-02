---
name: loop
description: Natural-language syntax for scheduling recurring prompts. Parses intervals from leading tokens, trailing 'every' clauses, or defaults to 10m. Wraps the cron-scheduler extension via /cron add. Use when the user wants to repeat a prompt on a schedule.
---

# Loop: Recurring Prompt Scheduling

Parse the user's `/loop` input into an interval and a prompt, then schedule it with `/cron add`.

## Phase 1: Parse Input

Apply these rules in priority order on the text after `/loop `:

### Rule 1: Leading Time Token

If the first whitespace-delimited token matches the pattern `<N><unit>` where `<N>` is one or more digits and `<unit>` is one of `s`, `m`, `h`, `d` (case-insensitive):

- **Interval** = that token (e.g. `5m`, `2h`, `30s`, `1d`)
- **Prompt** = everything after that token, trimmed

### Rule 2: Trailing every Clause

If Rule 1 did not match, check whether the input ends with `every <time-expression>` where `<time-expression>` is either:

- `<N><unit>` (e.g. `every 20m`, `every 1h`)
- `<N> <unit-word>` where `<unit-word>` is one of: `seconds`, `second`, `minutes`, `minute`, `hours`, `hour`, `days`, `day` (e.g. `every 5 minutes`, `every 1 hour`)

Only match when what follows `every` is a valid time expression -- do not match phrases like "every time" or "every file".

- **Interval** = the normalized short form (e.g. `5 minutes` -> `5m`, `1 hour` -> `1h`)
- **Prompt** = everything before `every ...`, trimmed

### Rule 3: Default

If neither Rule 1 nor Rule 2 matched:

- **Interval** = `10m`
- **Prompt** = the entire input, trimmed

## Phase 2: Validate

If the resulting prompt is empty after trimming, show usage and stop:

```
Usage: /loop [interval] <prompt> [every <interval>]

Examples:
  /loop 5m run tests
  /loop check deploy status every 20m
  /loop lint and typecheck          (defaults to every 10m)

Intervals: <number><s|m|h|d>  e.g. 30s, 5m, 2h, 1d
```

## Phase 3: Schedule

Run the following command to schedule the recurring prompt:

```
/cron add <interval> <prompt>
```

Then confirm to the user what was scheduled:

```
Scheduled: "<prompt>" every <interval>
```

## Unit Normalization Table

| Input | Normalized |
|-------|-----------|
| `s`, `second`, `seconds` | `s` |
| `m`, `minute`, `minutes` | `m` |
| `h`, `hour`, `hours` | `h` |
| `d`, `day`, `days` | `d` |

## Examples

| Input | Interval | Prompt | Command |
|-------|----------|--------|---------|
| `/loop 5m run tests` | `5m` | `run tests` | `/cron add 5m run tests` |
| `/loop check deploy every 20m` | `20m` | `check deploy` | `/cron add 20m check deploy` |
| `/loop check deploy status every 5 minutes` | `5m` | `check deploy status` | `/cron add 5m check deploy status` |
| `/loop 30s health check` | `30s` | `health check` | `/cron add 30s health check` |
| `/loop lint and typecheck` | `10m` | `lint and typecheck` | `/cron add 10m lint and typecheck` |
| `/loop 1h summarize git log` | `1h` | `summarize git log` | `/cron add 1h summarize git log` |

## Rules

- Always apply parsing rules in priority order: leading token first, then trailing clause, then default.
- Never schedule an empty prompt -- show usage instead.
- Normalize long-form units (`minutes` -> `m`) before passing to `/cron add`.
- The `/cron add` command is provided by the cron-scheduler extension -- do not implement scheduling directly.
