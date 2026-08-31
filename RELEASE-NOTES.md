# Release Notes

## Verdict accuracy release (2026-08-31)

- **Setup contract:** `/verify-setup` sniffs each repo and records confirmed boot, seed, health, env-file, observation, and probe choices in `.verify/setup.json`.
- **Throwaway stacks:** every run gets a unique Compose project or process group, fresh run artifacts, bounded history, and volume-removing teardown.
- **Pipeline checks with taint:** built-in API, browser, and Postgres probes plus optional worker, sink, and storage probes mark only dependent criteria as `could_not_verify`.
- **Proof of execution:** every criterion declares proof, every run carries a unique marker, and evidence without proof becomes `not_proven`.
- **Reviewed seed script:** Verify shows a literal front-door seed script at approval and runs it with the marker before judging.
- **Compare button:** users can rerun selected criteria on a separately seeded base worktree to distinguish regressions from existing failures.
- **Second-opinion review:** Codex or a fresh Claude context challenges the plan's coverage, dependencies, and permanent-test candidates.
- **HTML report:** one canonical result set drives the headline and escaped criterion cards, with relative screenshot and video assets under `.verify/runs/<run_id>/`.
- **Codify:** after the report renders, users may approve permanent tests one at a time; Verify writes no commits.
- **Design deviation:** the setup contract uses `.verify/setup.json`, not the design's `.verify/setup.yaml`, because the Bash pipeline already validates configuration with `jq`.

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
