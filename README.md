# Opslane Verify

Coding agents write more code than anyone can read. Reviewing the diff does not run it. And the agent's own tests pass because the agent wrote them to pass. So the check that tells you a change actually works is still you, clicking through the app after every change.

Opslane Verify does that check, with three things between the agent and "done" that the agent does not control. It reads the plan the change was meant to implement and turns it into acceptance criteria. A second model, Codex when installed, reviews those criteria and flags the ones a lazy implementation could pass. You approve them. Then it boots your app, drives every criterion against the running system, and writes a report with every step it took and the evidence behind every verdict. You check its work instead of trusting it.

It is a Claude Code plugin. You run it locally, after the agent finishes implementing and before you open the PR.

## Requirements

- Claude Code, logged in with `claude login`.
- Node.js and npm. The engine runs from TypeScript source.
- A plan for the change: a file under `docs/plans/` or `.omx/plans/`, a PR body, or the conversation you wrote the change in.
- A way to start your app on this machine. A compose file is the best case. A start command plus a health URL also works.

Optional: the Codex CLI, for the second-model review of the criteria. Without it, a fresh Claude session that has seen only the plan and the criteria does the review instead. Also optional: `asciinema` and `agg`, for a terminal recording of criteria you drive by hand.

## Install

```
/plugin marketplace add opslane/verify
/plugin install opslane-verify
```

This registers `/verify` and `/verify-setup`, plus a Playwright MCP server for browser criteria. The first run installs the engine's dependencies inside the plugin directory from a lockfile. In your repository it writes only to `.verify/`, and adds that directory to `.gitignore` if it is not there already.

## Quick start

From your repository, on a branch with a change and a plan:

```
/verify
```

The first time you run it in a repository, it stops and asks you to run `/verify-setup`. Setup looks through the repository for a compose file, seed scripts, and env files. Then it asks one question for each thing it could not decide on its own: how to boot the app, what data to seed, the base URL, how API requests authenticate. It writes the answers to `.verify/setup.json` and offers to commit that file so your teammates skip the interview. It never asks for or stores a secret. The most it will record is the name of a header and the name of an env var.

After setup, `/verify` finds the plan, writes the acceptance criteria, has them reviewed, and stops. Read them. If one is wrong, say so and it rewrites that one. When they look right, say:

```
go
```

It boots the stack, seeds it, drives each criterion, tears the stack down, and prints the report. Everything it produced is in `.verify/runs/<timestamp>/`.

## An example, from a real run

The plan changed how a background worker handles failed jobs: which failures get retried, which get shown to the customer, and which are labelled as the vendor's own fault. The agent implemented it and its tests were green.

Verify proposed five criteria, Codex reviewed them, the user approved. Verify then drove a real investigation against a real repository with the model's turn budget cut to one, and read the job row after it died.

Four criteria passed. But the report flagged something no criterion had asked about: the plan said this failure should be classed as a limit, and the code classed it as an agent error. Same behaviour, wrong label, and the label is what the Slack event and the health endpoint report. The agent's tests were green because the code did what it was written to do. Nobody had checked it against what the plan said.

The fifth criterion failed, and the report blamed the criterion, not the code:

> Job completed; route_map has 2 rows, not 40-120. The expectation was built on a wrong premise: the route classifier does not discover routes from the repository, it classifies the routes observed in the project's incidents.

Codex had flagged that criterion before the run, because its check compared the worker's output against the worker's own count. The user approved it anyway. The report says all of that, so nobody mistakes it for a bug.

The summary at the bottom of every report keeps those cases apart:

```
Proven     4 of 5
Behaviour  4 passed, 1 failed
Ran        5 criteria, 0 could not run
Covered    5 criteria, 1 changed files have none
```

Proven is how many verdicts the evidence supports. A pass with no receipt behind it does not count. Behaviour is what the code did. Ran is whether the check itself could run; a database container dying shows up here, not as a code failure. Covered is whether every changed file has at least one criterion touching it.

Below the summary, the report always prints a section called "Not checked", even when it is empty. It lists what did not run and why, plus anything the run noticed that no criterion asked about. The label mismatch above was one of its entries.

## Why the agent's tests are not enough

A unit test checks that the code does what its author expected. When the author is the agent that wrote the code, the test and the code share the same misunderstanding, and both pass. Verify takes its expectations from the plan and from how the old code behaved, never from the implementation.

A unit test runs a function with the collaborators mocked out. The bugs that reach staging live in the parts that were mocked: the webhook that fires twice, the migration that runs against real rows, the page that renders before its data resolves. Verify runs the whole system and drives it from the outside, the way a user or a client would.

And green tests say nothing about what was never tested. Verify reports every changed file that no criterion touches, every criterion it could not run, and everything it noticed along the way.

## What it runs against

Verify does not run your code in isolation. Each run boots the whole stack, seeds it, checks that every part is alive, drives the criteria, and tears everything down.

With a compose file, every run gets its own compose project name, so it never collides with your dev stack or with another run. Boot is `docker compose up -d --wait`. Teardown is `down -v`, so volumes go too and no data from one run leaks into the next.

Without a compose file, setup can record a start command and a health URL. Verify runs the command in its own process group, polls the health URL until it answers, and kills the group at teardown. You can also point it at a stack you already have running, and it will warn you that isolation is gone, or run criteria as plain commands with no stack at all.

Seeding happens in two layers. Your repository's own seed scripts, `.sh` or `.sql`, run first. Then, if any criterion needs specific data, Verify writes a seed script for the run that creates that data through the app's front door, with the run's marker woven into every record. You see that script before you say `go`. A seed failure aborts the run, because judging against a half-seeded system produces wrong verdicts.

Before judging anything, Verify probes each part of the stack the criteria depend on. The database gets a marker round trip. The API gets an HTTP request. A worker, an event sink, or object storage gets whatever one-line command you gave setup to prove it is alive. If a part is down, the criteria that depend on it are recorded as "could not run" with the probe's output attached, and the rest of the run continues.

## What kinds of changes it can test

| Change touches | How Verify drives it | What it needs from you |
|----------------|----------------------|------------------------|
| An HTTP API | Calls the real route through the public auth path and checks the side effect, not only the status code. | The base URL, and if requests need auth, the header name and the env var that holds the value. |
| A database | Diffs the affected rows before and after. A migration is tested in the direction the plan claims, not assumed reversible. | The name of the env var that holds the connection string. |
| A CLI | Runs the real binary. The exit code and the output shape are checked separately. | Nothing beyond the binary being buildable. |
| A queue, webhook, or background job | Fires the trigger and waits on the effect with a deadline and a correlation id. A local sink, a small endpoint that receives what the app sends, proves the app emitted the event. The report says whether delivery to the real destination was also proven. | A one-line command that proves the worker or sink is alive. |
| A web UI | Drives a real browser through Playwright, interacts the way the criterion describes, and screenshots at the moment of observation. Fetching the HTML with curl is never counted as a UI check. | If the app needs login, one login by you. |

For login, setup opens a browser through Playwright. You log in, close the window, and the session cookies are saved to `.verify/auth.json`. Verify never sees your password. The file is gitignored, and deleting it revokes the session. A per-repo store under `~/.verify/` lets your other worktrees inherit it.

Verify does not plant state to reach a page. It arrives there the way a user would, because the bugs that survive unit tests live in the transitions: what a page does on its first render, before its data resolves. At least one criterion per run walks a real path end to end in one session.

## Getting the most out of it

Most of what makes a repository easy to verify is what makes it easy to run.

- A compose file that boots everything, with health checks on each service so `up --wait` means ready. If your services have no health checks, `--wait` returns before the app can answer.
- Ports and hosts through environment variables with defaults, so one committed `setup.json` works in every checkout and worktree. Setup writes `http://localhost:${APP_PORT:-3000}`, not `http://localhost:3000`.
- A seed script that creates data through the API or CLI rather than raw SQL. Data that came in through the front door exercises the same code a user would.
- A health endpoint, and a one-line liveness check for anything that is not the API or the database: a worker, a queue consumer, a storage bucket.
- A plan for each change, in `docs/plans/` or the PR body, that says what the change should do rather than how. Verify reads the plan first and the diff only for gaps, so the plan is where the criteria come from.
- `.verify/setup.json` committed, so nobody on the team answers the setup questions twice.

## How it keeps itself honest

Every expectation comes from the plan, or from how the code behaved before the change. Verify reads the diff once, to find things the plan does not explain, and each of those becomes a question for you. It never takes an expectation from the diff, because a check derived from the implementation confirms the implementation against itself.

Each criterion records whether the old code would have passed it. A criterion meant to prove new behaviour that the old code already passes proves nothing, and Verify flags those before you approve.

Each criterion also names how a reader will know it actually ran: a marker written into the data it created, or a value read live during the run. A criterion with no such proof is not run.

When a criterion fails and you doubt the verdict, ask for a comparison against base. Verify checks out the code before your change in a separate worktree, boots it, and runs the same criterion there. A criterion that fails on both sides is not this change's fault.

It never edits the code it is judging. Writing to a shared or staging system, or spending money, needs your yes first. If a criterion is expensive to drive, it tells you what it would take and lets you decide rather than skipping it on your behalf. And it never asks for or stores passwords, API keys, or connection strings.

## What lands on disk

Each run writes to `.verify/runs/<timestamp>/` in your repository. The directory is gitignored.

```
criteria.md, criteria.json    the criteria you approved
review.json                   the second model's verdict on each criterion, and what it said was missing
report.md, report.html        the report; the HTML version has a card per criterion with evidence and transcripts
results.json                  one observation per criterion, checked against a schema before rendering
evidence/AC1 ... AC5          receipts, screenshots, logs, and JSON the report cites
seed.sh, seed.log             how the stack was seeded and what happened
precheck.json, prechecks/     whether each part of the stack was alive before anything was judged
tests/                        generated regression tests; they stay here until you choose to check one in
run.cast, run.gif             terminal recording, only for criteria driven by hand and only if asciinema is installed
```

## License

MIT
