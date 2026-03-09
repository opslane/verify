# Release Notes

## v1.0.0 (2026-03-09)

Initial release.

### What's included

**Pipeline stages:**
- Pre-flight checks (dev server health, auth validity, spec detection)
- Planner — extracts testable ACs from Markdown specs via Claude Opus
- Browser agents — Playwright MCP agents per AC, running in parallel
- Judge — evidence review and verdict rendering via Claude Opus
- Report — pass/fail summary with per-AC reasoning

**Claude Code skills:**
- `/verify` — run the full pipeline
- `/verify setup` — one-time browser auth capture

**Eval set:**
- 10 spec docs for merged frontend PRs across Cal.com, Formbricks, and Documenso
- Covers low/medium/high complexity UI changes

**Test suite:**
- 6 bash test scripts covering all pipeline stages

### Configuration

`.verify/config.json` controls base URL, auth check endpoint, and spec path. All pipeline artifacts are gitignored by default; only the config is committed.
