# Verify

A verification layer for Claude Code. Reads your spec, runs a browser agent against your local dev server for each acceptance criterion, and returns pass/fail with screenshots — before you push. No CI. No infrastructure.

## Install

### Prerequisites

- Node 22+
- Claude Code with OAuth login (`claude login`)
- Playwright MCP configured (see below)

```bash
npx @opslane/verify --version
```

**Manual (contributors):**
```bash
git clone https://github.com/opslane/verify.git
cd verify/pipeline && npm install
```

> Manual clone gives you the pipeline CLI but not the `/verify` slash commands. See [CLAUDE.md](./CLAUDE.md) for contributor setup.

## Usage

### Claude Code Skills

```bash
# One-time setup — auto-detects dev server, indexes app
/verify-setup

# Run verification against a spec
/verify
```

`/verify` asks for your spec, reviews it for ambiguities, then verifies each acceptance criterion using Playwright MCP. Results appear inline with screenshots.

### CLI (setup only)

```bash
# One-time setup (auto-detects dev server, indexes app)
npx @opslane/verify init

# Re-index the app after schema/route changes
npx @opslane/verify index --project-dir .
```

### Playwright MCP Setup

```bash
claude mcp add playwright -- npx @playwright/mcp@latest --storage-state .verify/auth.json --isolated
```

Restart Claude Code after adding the MCP server.

## Debugging failures

After a run, evidence lives in `.verify/runs/<run_id>/`:

```bash
# Browse raw evidence for a specific AC
ls .verify/runs/*/evidence/<ac_id>/
```

Each AC's evidence directory contains:
- `result.json` — verdict, confidence, reasoning, steps taken
- `*.png` — screenshots captured during execution

## Architecture

`/verify` runs as a Claude Code skill using Playwright MCP for browser interaction:

1. **Spec Interpreter** — reviews acceptance criteria for ambiguities, asks clarifying questions
2. **AC Extractor** — parses the spec into concrete, testable acceptance criteria using seed data and known routes
3. **Browser Verification** — navigates the app via Playwright MCP, checks each AC, collects screenshots
4. **Report** — writes per-AC `result.json` and a combined `verdicts.json`

### Dev setup

See [CLAUDE.md](./CLAUDE.md) for full dev commands, conventions, and test instructions.
