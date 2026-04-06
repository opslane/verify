# Design: Standalone CLI (@opslane/verify)

**Date:** 2026-04-05
**Branch:** abhishekray07/check-latest
**Status:** REVIEWED (CEO review complete, HOLD SCOPE)

## Goal

Extract the verify pipeline from its Claude Code skill wrapper into a standalone npm package (`@opslane/verify`) that can be invoked from any terminal, agent, or environment with `claude` and `node` installed.

## Architecture

```
┌─────────────────────┐    ┌──────────────────────────┐
│  Claude Code        │    │  Any terminal / agent     │
│  ┌───────────────┐  │    │                           │
│  │ /verify skill │──┼───▶│  npx @opslane/verify run  │
│  │ (spec prep)   │  │    │    ├── orchestrator.ts     │
│  └───────────────┘  │    │    ├── stages/*            │
│                     │    │    ├── prompts/*            │
│  ┌───────────────┐  │    │    └── lib/*               │
│  │ /verify-setup │──┼───▶│  npx @opslane/verify init  │
│  │ (discovery)   │  │    │                            │
│  └───────────────┘  │    └───────────┬────────────────┘
└─────────────────────┘                │
                            ┌──────────▼──────────────┐
                            │ claude -p (OAuth)        │
                            │ browse daemon (auto-DL)  │
                            │ psql                     │
                            └─────────────────────────┘
```

**Key principle:** Skills own the conversation. CLI owns the execution. A user who already has a spec and config can skip the skill entirely.

## Package

- **Name:** `@opslane/verify` (scoped, public, npm)
- **Ships:** Compiled JS (tsc) + prompt templates
- **Browse binary:** Auto-downloaded from GitHub releases on first run, cached at `~/.cache/verify/browse`
- **Integrity:** SHA256 checksum verification on browse binary
- **Concurrency:** Atomic download (temp file + rename) for parallel safety
- **Platforms:** macOS (arm64, x64), Linux (x64). Windows unsupported.

## Commands

```
npx @opslane/verify run      # execute pipeline against a spec
npx @opslane/verify init     # one-time project setup
npx @opslane/verify index    # re-index the app (regenerate app.json)
```

### `run` flags
```
--spec <path>                 # default: .verify/spec.md
--verify-dir <path>           # default: .verify
```

### `init` flags
```
--url <base-url>              # default: http://localhost:3000
--email <email>
--password <password>
--login-steps <path>          # skip login discovery, use saved steps
--project-dir <path>          # default: cwd
```

### Exit codes
- `0` — all pass
- `1` — failures
- `2` — spec unclear

## Skill Responsibilities After Migration

### /verify-setup (first-time setup)
1. Ask user for base URL and credentials
2. Run `npx @opslane/verify init --url ... --email ... --password ...`
3. If no --login-steps, CLI runs login discovery agent
4. Run `npx @opslane/verify index`

### /verify (verification runs)
1. Read diff, discover what changed
2. Draft spec from changes (or accept user-provided spec)
3. Clarification loop
4. Write `.verify/spec.md`
5. Run `npx @opslane/verify run --spec .verify/spec.md`
6. Display results

## Migration (Phased)

### Phase 1 (now)
- Rename `pipeline/package.json` to `@opslane/verify`, set `private: false`
- Add `bin` entry pointing to compiled CLI
- Build with `tsc`, output to `dist/`
- Bundle prompt templates via `files` field
- Add browse auto-download with SHA256 checksums and atomic writes
- Add `init` command
- Remove `@anthropic-ai/claude-agent-sdk` dependency (SDK path removed for clean package)
- Update skills to invoke `npx @opslane/verify`
- Remove pipeline sync from PostToolUse hook (keep skill sync)
- Publish from `pipeline/` subdirectory

### Phase 2 (when server moves out)
- Move server to separate repo
- Lift `pipeline/src/` to `src/`, `pipeline/test/` to `test/`
- Root `package.json` becomes the package
- Clean up legacy `scripts/`

## Dependencies

- `claude` CLI (Claude Code, OAuth)
- Browse binary (gstack, auto-downloaded)
- `psql` (for DB queries during index/init)
- Node 22+
- macOS or Linux

## What Doesn't Change

- Pipeline stages, orchestrator, prompts
- Config format (`.verify/config.json`, `.verify/app.json`)
- Evidence output (`.verify/runs/{runId}/evidence/`)
- Exit codes
- LLM access via `claude -p`

## Security Model

- **Credentials:** Login email/password stored in plaintext in `.verify/config.json`. These are test account credentials for localhost dev servers. `.verify/` is gitignored.
- **Prompt logs:** Credential values appear in prompt files written to `.verify/runs/`. These are local-only, gitignored.
- **Permissions:** The CLI uses `claude -p --dangerously-skip-permissions` for non-interactive execution. This allows the LLM to run Bash commands without user approval. The pipeline only connects to localhost dev servers.
- **Binary integrity:** Browse binary downloads are verified via SHA256 checksums stored in the package.

## Browse Binary

- Built from gstack source (pinned to a specific commit SHA)
- Built via existing `.github/workflows/build-browse.yml`
- Hosted on opslane/verify GitHub releases
- Auto-downloaded on first `run` or `init`
- Cached at `~/.cache/verify/browse`
- `BROWSE_BIN` env var overrides for custom installs

## Review Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Implementation approach | Phased (A then B) | Ship fast, restructure when server moves |
| Review mode | HOLD SCOPE | Brainstorm scoped well, priority is shipping |
| Build tooling | tsc | Already configured, no new tooling |
| Browse auto-download | Include in v1 | Better first-run experience |
| Checksum verification | SHA256 | Supply chain trust boundary for binary execution |
| SDK path | Remove before publish | Ship clean, re-add when migration ready |
| Credential security | Document, don't encrypt | Test creds, low threat, transparency |
| PostToolUse hook | Keep skill sync, drop pipeline sync | Clean cut, only user |

## Codex Review Findings (resolved)

1. CLI surface is new product work, not just extraction → User chose to include init + auto-download
2. Credential handling needs security model → Documented above
3. SDK path should be removed or supported → Removing for clean package
4. Unix-only assumptions → Documented platform support
5. Browse downloader is overengineering → User chose to include for better UX
6. Repo-layout assumptions in orchestrator → Low priority, .verify/ in project root is the convention

## Eng Review Findings

1. **Prompt template path resolution** — `import.meta.url` points to `dist/` after tsc build, but prompt templates live in `src/prompts/`. Fix: add `postbuild: cp -r src/prompts dist/prompts` to package.json. All 7 stage files use this pattern.
2. **SDK removal** — 8 files reference `claude-agent-sdk` or `VERIFY_SETUP_SDK`. Clean removal, no shared code with non-SDK paths.
3. **Test coverage** — 17 new codepaths at 0% coverage. Plan: 14 test cases across 4 files (cli, browse, orchestrator, publish-smoke).
4. **No performance concerns** — browse download is one-time cached. No new hot paths.
5. **Failure modes** — all covered: download failure, checksum mismatch, missing binary, missing prompts all produce clear errors.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | PASS | 6 findings resolved, HOLD SCOPE decision, 3 TODOs |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | PASS | 6 findings, all resolved in CEO review |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | PASS | 5 findings, 1 fix (postbuild copy), 14 test cases, 4 TODOs |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |

**VERDICT:** CEO + Codex + Eng reviews complete. Ready to implement. Run `/plan-design-review` if CLI has user-facing output formatting to review (optional, low priority for a CLI tool).
