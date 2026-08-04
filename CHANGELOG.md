# Changelog

All notable changes to opslane/verify are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.3.0] - 2026-08-04

### Changed
- Criteria render as a table with the source requirement in its own column, so the mapping
  from criterion to requirement can be scanned rather than read. Anything not straight from
  the plan is marked INVENTED or INFERRED in the table and explained underneath, where the
  assumption is stated in full. Pipes inside a cell are escaped so a command containing one
  cannot silently corrupt the table.


## [2.2.0] - 2026-08-04

### Changed
- Assume a criterion can be reproduced locally until something specific stops it. A job
  that fails with a key in its error text is a job you can make fail; a worker run is a
  worker you can start. Only four things count as real blockers: a credential a human must
  obtain, a third-party service that cannot be faked at the boundary that matters, an
  irreversible or publicly visible action, or something that genuinely cannot be induced
  here, with the reason named. "Needs production" is almost never one of them. Observed in
  the wild alongside the 2.1.0 fixes: two criteria skipped for needing "a production job"
  and "a live worker run", both reproducible on the stack the run had already started.


## [2.1.0] - 2026-08-04

### Changed
- Cost is the user's decision. A criterion that can be driven but needs real setup is
  presented with what it would take, while the stack is still up, rather than being moved
  to `Not checked` unilaterally. "Cheapest sufficient proof" means the least setup that
  still observes the behaviour, not permission to skip inconvenient checks.
- A `Not checked` reason must say why the criterion was not driven. If it also claims
  something else covers it, that thing must be named, with a plain statement that this run
  did not re-run it. Observed in the wild: three entries reading "covered by unit
  canaries", where the workflow had not run those tests and could not know.


## [2.0.0] - 2026-08-04

### Changed
- `/verify` works on any change surface, not only a browser. API, datastore, CLI, async,
  and UI each get a real check driven the way a user would drive it.
- The workflow is two halves with a stop between them. Half one writes acceptance criteria
  from the change's plan and waits for approval. Half two runs them and reports.
- Criteria record where they came from: a plan line, an inference from the diff, or an
  assumption the tool made and is telling you about.
- Results report on four separate axes. Whether the code is right, whether the harness
  worked, how much of the branch was covered, and whether causality was established are
  four different answers.
- `Not checked` is always printed, even when empty.

### Removed
- `/verify-setup`. The repository already declares how to run itself; a separate
  onboarding step was skipped in practice and its artifacts never survived a worktree.
- The pipeline: orchestrator, staged prompts, and the headless `claude -p` runner. That is
  a different control loop from a skill, and the skill never called it.
- Existing-test inspection. Whether a unit test exists, and whether it mocks something, is
  a question about the test suite. This plugin answers whether the change works.

### Fixed
- `changed-files` reports an unknown revision with the available refs instead of a stack
  trace, and refuses a base that git would read as an option.
- Files inside `tests/`, `__tests__/`, and `spec/` are excluded, not only files whose name
  ends in `.test.ts`.


## [1.1.0] — 2026-04-23

### Added
- Per-AC video + trace evidence on non-pass verdicts. Each failing AC's directory now contains a Playwright video and trace alongside screenshots, making it easy to diff what the agent saw vs. expected. (#12)
- Inline `/verify-setup` skill — auto-detects dev server port, indexes routes and selectors from your codebase, writes `.verify/config.json` and `.verify/app.json`. No `npm install` needed. (#11)
- Playwright MCP-based `/verify` skill — drives the browser via Playwright MCP directly from Claude Code, no CLI binary required. (#7)

### Changed
- `/verify` skill now uses Playwright MCP directly instead of an external browse binary, simplifying the install path to one `claude mcp add` command. (#7)
- Cookie-based auth replaces credential-based auth — log in once via your normal browser, `/verify-setup` reads the cookie. (#5)

### Removed
- Server directory and SaaS backend — opslane/verify is now a pure Claude Code plugin with no server dependency. Auth state lives in `.verify/auth.json` locally. (#10)
- Standalone CLI package (`@opslane/verify`) — replaced by inline Claude Code skills. (#11)
- Browse binary and v1 pipeline code — superseded by Playwright MCP. (#8)

### Fixed
- `/verify-setup` cookie import flow, `auth.json` export path, and browse-binary download fallback. (#9)

[Unreleased]: https://github.com/opslane/verify/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/opslane/verify/releases/tag/v1.1.0
