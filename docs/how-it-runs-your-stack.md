# How it runs your stack

Verify does not run your code in isolation. Each run boots the whole stack, seeds it, checks that every part is alive, drives the criteria, and tears everything down. This page says how, what setup records to make it work, and what makes a repository easy to verify.

## The setup contract

`/verify-setup` runs once per repository. It looks through the repository for a compose file, seed scripts, and env files. Then it asks one question for each thing it could not decide on its own: how to boot the app, what data to seed, the base URL, and how API requests authenticate. It also asks for a one-line liveness command for any worker, sink, or storage the criteria might rely on. It writes the answers to `.verify/setup.json`:

```json
{
  "mode": "compose",
  "compose_file": "compose.yaml",
  "boot": "docker compose -f compose.yaml up -d --wait",
  "teardown": "docker compose -f compose.yaml down -v",
  "seed": ["scripts/seed-e2e.sql"],
  "seed_data_files": [],
  "health_url": "",
  "base_url": "http://localhost:${APP_PORT:-3000}",
  "auth": {"header": "", "value_env": ""},
  "env_file": ".env.example",
  "observe": {"db_url_env": "DATABASE_URL"},
  "probes": {"worker": "", "sink": "", "storage": ""}
}
```

The file is meant to be committed, so nobody on the team answers the questions twice. It never holds a secret. The most it records is the name of a header, the name of an env var, and at most one of the repository's own local env files. That env file is parsed for `KEY=VALUE` lines and never executed.

Ports and hosts go through environment variables with defaults, `${APP_PORT:-3000}` rather than `3000`, so one committed file works in every checkout and worktree.

## Boot

With a compose file, every run gets its own compose project name, so it never collides with your dev stack or with another run. Boot is `docker compose up -d --wait`. Teardown is `down -v`, so volumes go too and no data from one run leaks into the next.

Without a compose file, setup can record a start command and a health URL. Verify runs the command in its own process group, polls the health URL until it answers, and kills the group at teardown.

You can also point it at a stack you already have running. It will warn you that isolation is gone. Or, for a repository with no runnable stack, it runs criteria as plain commands.

Teardown is armed before anything else can fail. A seed failure or a crash mid-run does not leave a stack behind.

## Seed

Seeding happens in two layers. Your repository's own seed scripts, `.sh` or `.sql`, run first. Then, if any criterion needs specific data, Verify writes a seed script for the run that creates that data through the app's front door, with the run's marker woven into every record. You see that script before you say `go`. A seed failure aborts the run, because judging against a half-seeded system produces wrong verdicts.

## Probe

Before judging anything, Verify probes each part of the stack the criteria depend on. The database gets a marker round trip. The API gets an HTTP request. A worker, an event sink, or object storage gets the one-line command you gave setup. If a part is down, the criteria that depend on it are recorded as "could not run" with the probe's output attached, and the rest of the run continues. A part with no probe does not block anything, but a failure that relies on it is marked as possibly environmental rather than blamed on the change.

## Login

If the app needs a login for browser criteria, setup opens a browser through Playwright. You log in, close the window, and the session cookies are saved to `.verify/auth.json`. Verify never sees your password. The file is gitignored, and deleting it revokes the session. A per-repo store under `~/.verify/` lets your other worktrees inherit it.

## What lands on disk

Each run writes to `.verify/runs/<timestamp>/` in your repository. The directory is gitignored, and the newest five runs are kept.

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

A checked-in example of a full run directory, redacted, is at [`examples/agent-fail-v2/`](../examples/agent-fail-v2/).

## Comparing against base

When a criterion fails and you doubt the verdict, ask for a comparison against base. Verify checks out the code before your change in a separate worktree, boots it on its own stack, and runs the same criterion there. A criterion that fails on both sides is not this change's fault. One that passes on both sides would have passed before the change and proves nothing.

## Getting the most out of it

Most of what makes a repository easy to verify is what makes it easy to run.

- A compose file that boots everything, with health checks on each service so `up --wait` means ready. If your services have no health checks, `--wait` returns before the app can answer.
- Ports and hosts through environment variables with defaults, so one committed `setup.json` works in every checkout and worktree.
- A seed script that creates data through the API or CLI rather than raw SQL. Data that came in through the front door exercises the same code a user would.
- A health endpoint, and a one-line liveness check for anything that is not the API or the database: a worker, a queue consumer, a storage bucket.
- A plan for each change, in `docs/plans/` or the PR body, that says what the change should do rather than how. Verify reads the plan first and the diff only for gaps, so the plan is where the criteria come from.
- `.verify/setup.json` committed.
- Optional: `asciinema` and `agg` installed, for a terminal recording of criteria you drive by hand.
