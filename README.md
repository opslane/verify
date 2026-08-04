# Opslane Verify

Verification for Claude Code. You point it at the plan for your change. It turns that into acceptance criteria, shows them to you before running anything, then drives your real system to check each one and keeps the evidence.

It works on whatever surface the change touches: an HTTP API, a database, a CLI, a queue or webhook, or a web UI in a real browser.

## How it works

Two halves, with a stop in between.

**Half one writes the criteria and stops.** It finds the plan for your change, turns it into concrete checks, and prints them for you to correct. Every criterion says where it came from — a line in the plan, an inference from the diff, or an assumption it made and is telling you about:

```
AC1  an SDK ingest key can no longer read incidents
     Do        curl -H 'X-API-KEY: <key>' /api/v1/projects/<id>/incidents
     Expect    HTTP 401
     From      Stage 1 QA gate, item 1

AC4  opslane errors list still works for a logged-in human
     From      INVENTED. Plan item 4 says "per whichever option Task 1.2 chose"
               and does not say which. I assumed session login.
```

Nothing runs until you say go.

**Half two runs them and reports.** It drives the real system with real tools, records the run, and reports on four separate axes:

```
AC1  ✔  HTTP 401 at the HTTP layer, no tool dispatched
AC2  ✔  good Bearer + stale X-API-KEY authorized; bad Bearer + good key denied
AC3  ~  could not run, staging rejected the create

Behaviour  2 passed, 0 failed
Ran        3 criteria, 1 could not run
Covered    3 criteria, 2 changed files have none

Not checked
  the OAuth grant flow    needs a real identity; only the reject path ran
  vue3 settings UI        16 changed files, needs a logged-in session
```

Those axes are separate on purpose. "Your code is wrong", "the database container died", and "we never looked at half the branch" are three different answers, and one word cannot carry all three.

`Not checked` is always printed, even when empty. A tool that quietly omits what it skipped is worse than one that finds nothing.

## What it will not do

It never fixes the code it is judging. A tool that repairs its own failures grades its own work.

It never invents acceptance criteria from the diff alone. Criteria come from a plan, because a check derived from the diff confirms the implementation against itself. If it cannot find a plan, it asks for one.

It never claims a pass it did not observe.

## Install

Requires Claude Code with `claude login`.

```
/plugin marketplace add opslane/opslane
/plugin install opslane-verify
```

The plugin registers the `/verify` command and a Playwright MCP server for browser criteria. On first run it installs the engine's dependencies inside the plugin directory, pinned to a lockfile.

Optional, for terminal recordings: `brew install asciinema agg`. Without them the run still completes and records the absence.

## Use

From your repo, on a branch with a change and a plan:

```
/verify
```

It prints the criteria and stops. Correct anything wrong, then say `go`.

Artifacts land in `.verify/runs/<timestamp>/`:

```
criteria.md      what you approved
report.md        results per criterion, four axes, what was not checked
run.cast         asciinema recording of the real commands
run.gif
run.sh           re-runnable by hand
```

## Surfaces

**API** — calls the real route, authenticates through the public path, and checks the side effect rather than the status code alone.

**Datastore** — diffs affected rows before and after. For migrations it tests the direction actually claimed rather than assuming reversibility.

**CLI** — runs the real binary, checking the exit code separately from the output shape.

**Async** — fires the trigger and waits on the effect with a deadline and a correlation id. A local sink proves the app emitted; it does not prove public delivery, and the report says which one it proved.

**UI** — drives a real browser through Playwright, interacts the way the criterion describes, and screenshots at the moment of observation. Fetching HTML with `curl` is not a UI check.

## Requirements

A plan describing the change: `docs/plans/`, `.omx/plans/`, a PR body, or the conversation. Whatever the change needs in order to actually run, which usually means your normal local stack. Nothing else.

## License

MIT
