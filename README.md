# Opslane Verify

Verification for Claude Code. You point it at the plan for your change. It turns that into acceptance criteria, shows them to you before running anything, then drives your real system to check each one and keeps the evidence.

It works on whatever surface the change touches: an HTTP API, a database, a CLI, a queue or webhook, or a web UI in a real browser.

## How it works

Two halves, with a stop in between.

**Half one writes the criteria and stops.** It finds the plan for your change, turns it into concrete checks, and prints them for you to correct. Every criterion says where it came from, what it is for, and what the code before your change would do with it. A criterion meant to prove the change works, that the old code would also have passed, is called out as a free pass:

```
| AC  | From | Intent    | Base | Shows   | Behaviour                                |
|-----|------|-----------|------|---------|------------------------------------------|
| AC1 | R1   | changes   | fail | success | an OAuth token reaches a tool and returns rows |
| AC2 | R2   | changes   | pass | refusal | a request with no credential is refused  |
| AC3 | R4   | preserves | pass | success | an existing API key still works          |

FREE PASS. These are declared as testing the change, and the base commit passes them too:
- AC2: a request with no credential is refused
Rewrite them or mark them as preserves. Do not approve as they stand.

What these criteria prove

            preserves  changes
  success           1        1
  refusal           0        1
```

That grid is there because a set where every row is a refusal is satisfied by an
implementation that refuses everything. An empty `changes`/`success` box means nothing in
the set shows the new behaviour working.

Nothing runs until you say go.

**Half two runs them and reports.** It drives the real system with real tools, keeps engine-recorded receipt transcripts and named evidence, and reports on four separate axes:

```
AC1  ✔  HTTP 401 at the HTTP layer, no tool dispatched
AC2  ✔  good Bearer + stale X-API-KEY authorized; bad Bearer + good key denied
AC3  ~  blocked, staging rejected the create

Proven     2 of 3
Behaviour  2 passed, 0 failed
Ran        3 criteria, 1 could not run
Covered    3 criteria, 2 changed files have none

Not checked
  the OAuth grant flow    needs a real identity; only the reject path ran
  vue3 settings UI        16 changed files, needs a logged-in session
```

Those axes are separate on purpose. "The check was substantiated", "your code is wrong", "the database container died", and "we never looked at half the branch" are different answers, and one word cannot carry all four.

`Not checked` is always printed, even when empty. A tool that quietly omits what it skipped is worse than one that finds nothing.

## What it will not do

It never fixes the code it is judging. A tool that repairs its own failures grades its own work.

It never takes an expectation from the diff. Criteria come from the plan, or from how the code behaved before your change, because a check derived from the diff confirms the implementation against itself and cannot fail. The diff is read once for what the plan does not explain, and each gap becomes a question for you rather than an answer it invents. If it cannot find a plan, it asks for one.

It never claims a pass it did not observe.

## Install

Requires Claude Code with `claude login`.

```
/plugin marketplace add opslane/opslane
/plugin install opslane-verify
```

The plugin registers the `/verify` command and a Playwright MCP server for browser criteria. On first run it installs the engine's dependencies inside the plugin directory, pinned to a lockfile.

Optional garnish for hand-driven terminal flows: `brew install asciinema agg`. Driven checks synthesize transcripts from receipts, so the run never depends on a recorder.

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
report.html      acceptance cards, evidence, and receipt transcripts
run.cast         optional asciinema garnish for hand-driven commands
run.gif
<named files>    screenshots, logs, JSON, or video cited by results.json
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
