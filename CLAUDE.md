## Project
opslane/verify — automated acceptance criteria verification for Claude Code changes. Runs browser agents against a spec, judges pass/fail, and reports results before you push.

## Stack
- Bash (3-compatible — macOS + Linux)
- `claude -p` — non-interactive Claude CLI (OAuth, no API key needed)
- Playwright MCP — browser automation for each AC check
- `jq` — JSON processing throughout
- `gtimeout` (macOS coreutils) / `timeout` (Linux)

## Structure
- `tools/verify/` — pipeline stages: `preflight.sh`, `planner.sh`, `orchestrate.sh`, `agent.sh`, `judge.sh`, `report.sh`
- `tools/verify/prompts/` — Claude prompt templates for each stage
- `tools/verify/tests/` — test scripts (one per stage)
- `skills/verify/SKILL.md` — the `/verify` Claude Code skill
- `skills/verify-setup/SKILL.md` — the `/verify-setup` skill
- `.verify/` — runtime output (gitignored): `config.json`, `plan.json`, `evidence/`, `auth.json`
- `docs/evals/` — eval sets for prompt quality testing

## Architecture
```
spec + PR → preflight → planner → orchestrate (parallel agents) → judge → report
```
Config lives in `.verify/config.json`. Env vars always override config.

## Commands
- Test a single stage: `bash tools/verify/tests/test_preflight.sh`
- Test all: `for f in tools/verify/tests/test_*.sh; do bash "$f"; done`
- Full run (needs dev server): `bash tools/verify/preflight.sh && bash tools/verify/planner.sh "$SPEC_PATH"`

## Conventions
- **Bash 3 compat**: use `while read` not `mapfile`. No bash 4+ features.
- **Env vars override config**: `VERIFY_BASE_URL`, `VERIFY_AUTH_CHECK_URL`, `VERIFY_SPEC_PATH`
- **Non-interactive Claude**: always use `claude -p`, never interactive mode
- **`--dangerouslySkipPermissions`**: only pass when the guard check in `preflight.sh` explicitly allows it

## Don't
- Don't use `mapfile` — use `while read -r line` for bash 3 compat
- Don't hardcode URLs — use `VERIFY_BASE_URL` or `.verify/config.json`
- Don't call `claude` interactively — always `claude -p "prompt"`
- Don't commit `.verify/` contents — auth, evidence, and plans are gitignored

## References
- Pipeline design: `docs/plans/2026-03-08-verify-implementation.md`
- Eval sets: `docs/evals/eval-set-v1.json`
- Prompt templates: `tools/verify/prompts/`
