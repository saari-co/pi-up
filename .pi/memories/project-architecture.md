# Pi-Up Project Architecture
**Updated:** 2026-04-02

## What it is
A workspace that transforms pi (coding agent by @mariozechner) into a Claude Code-class agent through extensions, skills, and prompt engineering patterns reverse-engineered from Claude Code CLI source.

## Repository
- GitHub: saari-co/pi-up
- Owner: bobbybones

## Structure
- 23 extensions in `.pi/extensions/`
- 20 skills in `.pi/skills/`
- 1 agent in `.pi/agents/` (batch-worker)
- AGENTS.md serves as the system prompt
- IDEAS.md tracks feature roadmap (36 features, 28 built)

## Key custom infrastructure
- `parallel-batch.ts` — spawns parallel pi subagent workers in isolated git worktrees
- `custom-compaction.ts` — 9-section structured compaction (Claude Code pattern)
- `todo-tool.ts` — LLM-driven task management tool
- `plan-mode.ts` — read-only exploration then tracked execution
- `auto-dream.ts` — memory extraction via detached pi subagent on agent_end (Claude Code pattern: fire-and-forget, --mode json -p --no-session, 1-min cooldown). Also provides `/dream` (foreground) and `/dream-bg` (background) commands.

## Claude Code source reference
- Location: GCloud VM at 35.196.68.142 (e2-small-instance, us-east1-c)
- Access: `ssh -i ~/.ssh/google_compute_engine_nopass bobbybones@35.196.68.142`
- Container: `docker exec mom-sandbox`
- Source path: `/workspace/C0AMW683YFP/scratch/claude-code/src/`
- SSH key passphrase: 1474 (passphrase-free copy at google_compute_engine_nopass)
