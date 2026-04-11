## Project
opslane/verify — automated acceptance criteria verification for Claude Code changes. Runs browser agents against a spec, judges pass/fail, and reports results before you push.

Also contains `server/` — a SaaS backend (Hono + TypeScript + Postgres) for GitHub OAuth sign-in, GitHub App installation tracking, and PR webhook handling.

## Architecture

### Pipeline
```
/verify-setup → init (port detection + 2 LLM agents → app.json)
/verify → spec interpreter → AC extractor → Playwright MCP verification → report
```
Config lives in `.verify/config.json`. App index lives in `.verify/app.json`. Env vars always override config.
`.verify/` is runtime output (gitignored) — config, plans, evidence, auth.

### Server
```
/auth/github → GitHub OAuth → /auth/callback → JWT session cookie → GitHub App install page
GitHub App webhook → /webhooks/github → HMAC verify → installation.created handler
```

## Skill sync
The skills in `skills/` are the source of truth. A `PostToolUse` hook (`.claude/hooks/sync-skill.sh`) automatically copies them to `~/.claude/skills/` after every Write or Edit. Never edit `~/.claude/skills/verify/SKILL.md` directly — edit the project copy instead.

## Module-specific instructions
Pipeline and server have their own conventions, commands, and verification steps:
- For pipeline work, see `pipeline/CLAUDE.md`
- For server work, see `server/CLAUDE.md`

## References
- Design docs and implementation plans: `docs/plans/`
- Prompt templates: `pipeline/src/prompts/`
