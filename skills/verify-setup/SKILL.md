---
name: verify-setup
description: One-time setup for /verify and /break. Sniffs the repo, confirms boot/seed/health with you, writes .verify/setup.json, captures auth if the app needs login, and builds .verify/profile.json, a model of how the app runs.
---

# /verify-setup

Run once per repo. Later `/verify` runs read `.verify/setup.json` and ask nothing.

**Hard rule: never ask for or store passwords, API keys, or connection strings.**
The one exception is captured browser session state (`.verify/auth.json`,
written by the auth step below): it holds reusable cookies for the app under
test, is gitignored, and deleting the file revokes it. Treat it like a logged-in
browser profile, not a secret store. No production
connection strings, no cloud keys. The most this file may reference is one of the
repo's own local `.env` files, chosen by the user. If a user pastes a secret,
refuse to write it and tell them to keep it in their environment.

## 1. Ignore rules

```bash
grep -qxF ".verify/" .gitignore 2>/dev/null || echo ".verify/" >> .gitignore
```

`.verify/setup.json` is the one file meant to be shared. After writing it, offer:
"Commit `.verify/setup.json` so your team skips this interview? (y/n)" — on yes,
`git add -f .verify/setup.json` and commit it.

## Write the recipe, not the resolved values

The contract must work in every checkout and worktree of the repo, or the
interview repeats forever. Two rules:

- **Ports and hosts go through environment variables.** When the repo
  documents per-worktree port variables (an AGENTS.md export block, a
  `.env.example`), write `http://localhost:${INGESTION_PORT:-8082}` — the
  repo's own variable name with the repo's default — never the number the
  current worktree happens to use. URL fields (`base_url`, `health_url`)
  support exactly `${VAR}` and `${VAR:-default}` — no nesting, no command
  substitution — expanded identically by the scripts and the engine at run
  time. Probes and boot are shell programs and expand everything the shell
  does, for free.
- **Nothing run-scoped.** A probe that names a specific run's container
  (`verify-20260901-042757-worker-1`) is dead the moment that run ends. Key
  probes to the compose service via the current run's project instead:

  ```
  docker ps --filter "label=com.docker.compose.project=$(jq -r .project .verify/run-env.json)" \
    --filter "label=com.docker.compose.service=worker" --format '{{.State}}' | grep -q running
  ```

Before offering the commit, re-read the drafted contract and reject your own
draft if any field contains a resolved port number that has a documented
variable, or any name containing a run id.

## 2. Sniff the repo

```bash
VERIFY_SCRIPTS="${VERIFY_SCRIPTS:-$CLAUDE_PLUGIN_ROOT/scripts}"
bash "$VERIFY_SCRIPTS/sniff.sh" > /tmp/verify-sniff.json
cat /tmp/verify-sniff.json
```

## 3. Confirm, one question per unknown

Use AskUserQuestion. Every option must come from the sniff output; the user
corrects rather than authors. A single unambiguous candidate is taken silently
and shown in the final summary.

- Boot: options = each `.boot[]` candidate (label with its `cmd`), plus
  "it's already running (breaks isolation — not recommended)" which selects
  `"mode": "external"`. **The chosen candidate's `mode` and `compose_file`
  are copied into the contract — never mix a process boot with a compose
  teardown.** For `"process"` mode, `health_url` is required — do not write
  the contract until the user supplies the URL to poll. For `"compose"`
  mode, write `teardown: "docker compose -f <file> down -v"` — a throwaway
  stack that keeps its volumes is not throwaway.
- Seed: options = `.seed[]`, plus "no seeding" and "I have a data file to load"
  (if chosen, ask for the path and put it in `seed_data_files`; it is a plain
  file the user produced themselves — how they made it is outside verify).
- Env file: options = `.env_files[]`, plus "none". The chosen file is sourced
  by the environment manager before boot, seeds, and probes.
- Base URL: default `http://localhost:3000`, or the value in the env file if
  it names one.
- How do API requests authenticate? A) a header whose value lives in an env
  var — name the header (for example, `X-API-Key`) and the env var name; or B)
  no auth. The value itself is never written anywhere: the contract stores
  only the header name and the env var name.
- Probes: for each of `worker`, `sink`, `storage`, ask "is there a one-line
  command that proves your <part> is alive? (leave blank to skip)". Explain:
  a part with no probe still runs its criteria, but a failure on it will be
  reported as possibly environmental rather than blamed on the change.
  (`api`, `browser`, and `db` have built-in probes; don't ask about them.)

If `.has_stack` is false: plain-command mode. Write the contract with
`"mode": "none"` and empty boot/teardown/health, and say: "No runnable stack
found; /verify will run criteria as plain commands."

## 4. Write the contract

Write `.verify/setup.json`. The shape (this example is load-bearing — a test
parses it):

```json setup-contract
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

Valid modes: `"compose"`, `"process"` (health_url required), `"external"`, `"none"`.

Show the written file and the summary of silently-taken single candidates.

## 5. Capture authentication, if needed

Keep authentication as Playwright storage state. It contains no password entry
flow or credential capture by Verify; the user logs in directly in the browser.

Check whether the selected base URL is running:

```bash
VERIFY_SCRIPTS="${VERIFY_SCRIPTS:-$CLAUDE_PLUGIN_ROOT/scripts}"
BASE_URL=$(jq -r '.base_url' .verify/setup.json | bash "$VERIFY_SCRIPTS/expand.sh" --load-env .verify/setup.json)
curl -sf "$BASE_URL" > /dev/null 2>&1 || echo "⚠ Dev server not running at $BASE_URL. Start it before logging in."
```

If the app requires login, open Playwright codegen and let the user authenticate:

```bash
VERIFY_SCRIPTS="${VERIFY_SCRIPTS:-$CLAUDE_PLUGIN_ROOT/scripts}"
BASE_URL=$(jq -r '.base_url' .verify/setup.json | bash "$VERIFY_SCRIPTS/expand.sh" --load-env .verify/setup.json)
mkdir -p .verify
echo "A browser will open. Log in, then close the browser window."
npx playwright codegen --save-storage=.verify/auth.json "$BASE_URL"
chmod 600 .verify/auth.json
```

Verify the capture:

```bash
if [ -f .verify/auth.json ] && [ -s .verify/auth.json ]; then
  COOKIE_COUNT=$(jq '.cookies | length' .verify/auth.json 2>/dev/null || echo 0)
  echo "✓ Auth state captured: $COOKIE_COUNT cookies"
else
  echo "✗ auth.json is empty. Log in when the browser opens, then close it."
  exit 1
fi
```

## 6. Share with your worktrees

A git worktree gets the committed contract for free but not the gitignored
files. Push them to the per-repo shared store so every worktree inherits them:

```bash
VERIFY_SCRIPTS="${VERIFY_SCRIPTS:-$CLAUDE_PLUGIN_ROOT/scripts}"
bash "$VERIFY_SCRIPTS/shared-store.sh" push
```

This copies `.verify/auth.json` and the chosen env file to
`~/.verify/<repo-slug>/` (permissions 700/600). Tell the user: deleting that
folder stops NEW worktrees inheriting the login; copies already pulled into
worktrees remain until their `.verify/` is deleted. Run `push` again whenever auth is
recaptured or the env file changes.

## 7. Build the app profile

`/break` attacks a change on a local copy of the app. To pick attacks that match how the
app really runs, it reads a profile of the app: what runs in the background, which
tables have statuses and what moves them, which outside services it calls, which
settings change behaviour when empty, and what sits in front of it in production.

Always build it; it is part of setup, not a question for the user. Build it from the
code alone: read the repo, do not boot anything, use no network. It takes a few minutes.
If it fails, say so in the summary and finish setup anyway: `/break` works without it.

Fill exactly this shape and write it to `.verify/profile.json` (this example is
load-bearing: a test checks it against the engine's validator):

```json app-profile
{
  "version": 1,
  "services": [
    {"name": "api", "kind": "api", "run": "compose service api", "source": "compose.yaml:3"}
  ],
  "actors": [
    {"name": "job-reaper", "kind": "reaper", "service": "worker", "interval_s": 60,
     "interval_env": "REAPER_INTERVAL_MS", "touches": ["jobs"], "source": "worker/src/index.ts:191"}
  ],
  "entities": [
    {"table": "jobs", "status_field": "status", "statuses": ["pending", "claimed", "completed", "dead_letter"],
     "transitions": [
       {"from": "claimed", "to": "pending", "by": "job-reaper", "source": "worker/src/db.ts:1323"},
       {"from": "any", "to": "pending", "by": "request:POST /api/jobs", "source": "api/handler/jobs.go:40"}
     ],
     "source": "migrations/001_jobs.sql:5"}
  ],
  "external": [
    {"name": "anthropic", "kind": "llm", "env": ["ANTHROPIC_API_KEY"], "stubbable": "yes",
     "stub_how": "ANTHROPIC_BASE_URL", "source": "worker/src/llm.ts:12"}
  ],
  "config": [
    {"name": "OPENAI_API_KEY", "default": null, "effect": "empty: no embeddings, duplicates are never merged",
     "source": ".env.example:20"}
  ],
  "edge": {"hops": ["cloudflare", "load_balancer"], "source": "answered by the user"}
}
```

- **services**: every process, from compose files, Procfiles, package scripts or
  manifests. `kind` is one of `api`, `worker`, `web`, `db`, `queue`, `storage`, `other`.
- **actors**: every loop, timer, scheduler, poller, reaper, sweeper, cron job, queue
  consumer, boot-time task and startup migration runner. `kind` is one of `scheduler`,
  `poller`, `reaper`, `sweeper`, `consumer`, `boot_task`, `migration`. `touches` lists
  the tables or queues it writes; `/break` uses it to find the actors that matter for a
  change.
- **entities**: only tables with a status or state field. List the transitions you can
  find; `by` is an actor name, `request:<METHOD /path>`, or `unknown`.
- **external**: every outside API or SDK. `stubbable` says whether a local stand-in can
  replace it and `stub_how` names the setting that points it elsewhere (or null).
- **config**: only settings where an empty or default value changes behaviour, with
  the effect in one line. Never record a secret value.
- **edge**: the chain in front of production, outermost first, each hop one of
  `cloudflare`, `cdn`, `vercel`, `load_balancer`, `nginx_or_ingress`, `none`,
  `unknown`. Detect it from deploy files and docs when you can.

Rules:

- Every item cites `source` as `path:line` in this repo. No source, no item.
- What the code does not show is `"unknown"`, never a guess. Unknowns are fine: `/break`
  tests both ways when that is cheap.
- Do not record which writes lack a guard, who else reads shared data, or how many
  replicas run. They are easy to get wrong from reading, so `/break` works them out
  fresh for each change.
- Ask the user only when an unknown field would block a likely, valuable attack and
  their answer changes how it is tested. Use AskUserQuestion with the field's allowed
  values as the options, never an open question. In practice this is usually one
  question: confirm the edge chain. Decisions about how to test (whether to point a
  test tenant at a stub, for example) are yours to make, not questions for the user.
- Record an answer as `"source": "answered by the user"`.

Check it with the engine and fix every error it reports:

```bash
VERIFY_PIPELINE="${VERIFY_PIPELINE:-$CLAUDE_PLUGIN_ROOT/pipeline}"
(cd "$VERIFY_PIPELINE" && npx --no-install tsx src/cli.ts profile-check --repo "$(pwd -P)")
```

Show the user a short summary: counts per section, the edge chain, and the few config
settings with the biggest effect. Then offer: "Commit `.verify/profile.json` so your team
and future runs share it? (y/n)". On yes, `git add -f .verify/profile.json` and commit it.

Finish with: `✓ Setup complete. Run /verify before your next PR.`
