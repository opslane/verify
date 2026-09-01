---
name: verify-setup
description: One-time setup for /verify. Sniffs the repo, confirms boot/seed/health with you, writes .verify/setup.json. Also captures auth if the app needs login.
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
  "base_url": "http://localhost:3000",
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
BASE_URL=$(jq -r '.base_url' .verify/setup.json)
curl -sf "$BASE_URL" > /dev/null 2>&1 || echo "⚠ Dev server not running at $BASE_URL. Start it before logging in."
```

If the app requires login, open Playwright codegen and let the user authenticate:

```bash
BASE_URL=$(jq -r '.base_url' .verify/setup.json)
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

Finish with: `✓ Setup complete. Run /verify before your next PR.`

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
