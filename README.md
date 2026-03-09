# opslane/verify

opslane/verify is a frontend verification pipeline for your coding agent, built as a Claude Code skill.

## How it works

You write a spec doc — plain Markdown with acceptance criteria. When you're done with a feature, instead of manually clicking around to check your work, you run `/verify`.

The pipeline reads your spec, extracts the testable criteria, and launches a Playwright browser agent for each one. The agents navigate to your running dev server, interact with the UI, and capture screenshots and logs as evidence. Then a judge reviews the evidence and renders a pass/fail verdict per AC.

The whole thing runs locally via `claude -p` — Claude Code's OAuth flow. No API keys, no extra charges beyond your normal Claude usage.

```
✓ ac1: Sidebar opens on Add to Cart
✓ ac2: Sidebar shows product name and price
✓ ac3: Order placed confirmation visible
✗ ac4: Close button not found in sidebar
✗ ac5: Quantity +/− buttons missing

Verdict: partial (3/5 passed)
```

You get exact failures, not "tests passed" — because the goal is to catch the thing that broke before your reviewer does.

## Installation

Requires [Claude Code](https://docs.anthropic.com/claude-code), Node.js (for Playwright), `jq`, and `coreutils` (macOS: `brew install coreutils jq`).

In Claude Code, register the marketplace and install:

```bash
/plugin marketplace add opslane/verify
/plugin install verify@verify
```

## Setup

**1. Configure for your project** — create `.verify/config.json`:

```json
{
  "baseUrl": "http://localhost:3000",
  "authCheckUrl": "/dashboard",
  "specPath": null
}
```

Set `authCheckUrl` to an endpoint that returns 200 only when the user is logged in. Use `/` for public apps. Set `specPath` to `null` to auto-detect from git diff, or provide a path.

**2. (If your app requires login)** capture a browser session once:

```
/verify-setup
```

This opens a browser for you to log in. The session is saved to `.verify/auth.json` — make sure this path is in your project's `.gitignore` to avoid committing credentials.

## Usage

Write a spec doc with explicit acceptance criteria:

```markdown
## Acceptance Criteria

- [ ] Clicking "Add to Cart" opens the cart sidebar
- [ ] The sidebar shows the product name and price
- [ ] A "Close" button is visible in the sidebar
- [ ] The total updates when quantity changes
```

Start your dev server, then:

```bash
/verify
```

The pipeline extracts the ACs, shows them to you for confirmation, then runs the browser agents. You review the report.

## How the pipeline works

**Stage 0 — Pre-flight:** Confirms the dev server is reachable, auth session is valid, and a spec doc exists.

**Stage 1 — Planner:** Sends the spec to Claude Opus to extract structured, testable ACs as JSON. You review the extracted list before anything runs.

**Stage 2 — Browser agents:** Each AC gets its own Playwright browser agent. Agents navigate, click, type, take screenshots, and write evidence logs. By default they run in parallel.

**Stage 3 — Judge:** Claude Opus reviews each agent's evidence and renders a verdict with reasoning.

**Report:** Pass/fail per AC, plus a summary verdict (`pass`, `partial`, or `fail`).

To debug a failure:

```bash
npx playwright show-report .verify/evidence/<id>/trace
open .verify/evidence/<id>/session.webm
```

## Evals

The `docs/evals/` directory has 10 hand-written spec docs for merged PRs from Cal.com, Formbricks, and Documenso. These are the ground truth for validating the pipeline — run `/verify` at the merge commit and all ACs should pass, run it at the base commit and they should fail.

See [docs/evals/README.md](docs/evals/README.md) for instructions.

## Contributing

Skills, prompts, and tools all live in this repository. The skills are in `skills/`, pipeline stages in `tools/verify/`, and prompt templates in `tools/verify/prompts/`.

1. Fork the repo and create a branch
2. Make your changes and run the test suite: `for f in tools/verify/tests/test_*.sh; do bash "$f"; done`
3. If you changed a prompt, validate against at least one eval case
4. Submit a PR

Adding eval cases (more spec docs for real open-source PRs) is especially valuable.

## License

MIT — see [LICENSE](LICENSE).
