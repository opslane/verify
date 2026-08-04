---
name: verify
description: Verify any change surface against approved acceptance criteria, run the real system, and preserve a four-axis report and test artifacts.
---

# /verify

Verify that a change does what its plan said. Report what you observe and keep the receipts. Never fix the code being judged.

This workflow has exactly two halves. Half one creates acceptance criteria and stops for approval. Half two runs only after the user approves those criteria by saying `go` or an equally explicit instruction.

## Hard rules

- Never fix what you judge. Report only.
- Mutation is allowed. Writing to shared or staging systems needs the user to say yes first.
- Provisioning anything that costs money needs the user to say yes first.
- `Not checked` is always printed, even when empty.
- Expense is not a reason to skip. If a criterion can be driven but costs real setup, say what it would take and let the user decide. Never decide that on their behalf.
- A `Not checked` reason states why it was not driven. It never asserts that something else covers it, unless it names that thing and says plainly this run did not re-run it.
- Drive the system the way a user does. This workflow does not read or run the repository's unit tests.
- Never invent acceptance criteria from the diff alone. The diff can refine or expose gaps in criteria sourced from a plan.
- Generated tests stay under the run's `tests/` directory until the user explicitly chooses to check them in.
- Make one observation per approved criterion. Do not collapse a harness failure into a behavior failure.

## Engine calls

The engine is a local TypeScript package with no installed `verify` binary. Every invocation must be self-contained because shell variables and working directories do not survive between tool calls.

Use this exact resolution rule at every call site, replacing the verb and arguments as needed:

```bash
VERIFY_PIPELINE="${VERIFY_PIPELINE:-$CLAUDE_PLUGIN_ROOT/pipeline}"
(cd "$VERIFY_PIPELINE" && npx --no-install tsx src/cli.ts <verb> [arguments])
```

`CLAUDE_PLUGIN_ROOT` is set by Claude Code for an installed plugin. Set `VERIFY_PIPELINE`
yourself only when running from a development checkout. Never hardcode a path to someone's
home directory; if neither variable resolves, stop and say so rather than guessing.

**Once per machine, install the engine's dependencies.** The plugin ships TypeScript source
and no `node_modules`, so the first call fails without this. It is a lockfile-pinned install
inside the plugin's own directory, it touches nothing in the target repository, and it is
safe to re-run:

```bash
VERIFY_PIPELINE="${VERIFY_PIPELINE:-$CLAUDE_PLUGIN_ROOT/pipeline}"
if [ ! -x "$VERIFY_PIPELINE/node_modules/.bin/tsx" ]; then
  (cd "$VERIFY_PIPELINE" && npm ci)
fi
```

Run that before the first engine call of a session. Do not fall back to plain `npx`, which
would fetch an unpinned package from the network.

**Optional recorders.** `asciinema` and `agg` produce `run.cast` and `run.gif`. Neither is
required: when either is missing, run the verification anyway and record the absence under
`Not checked`. On a fresh box: `brew install asciinema agg`, or the equivalent for the
platform.

The skill runs in the target repository, not the plugin repository. Resolve every target-repository path with `pwd -P` and pass absolute paths for `--repo`, `--dir`, `--criteria`, `--results`, and `--claims`.

## Half one: criteria, then stop

### 1. Find the plan

Look in this order:

1. The current conversation, including an explicit path supplied with `/verify`.
2. `docs/plans/`.
3. `.omx/plans/`.
4. The current pull request body, when available.

Use the newest plan that clearly describes the current change. If no plan is available, ask the user for one and stop. Do not derive criteria from the diff alone.

If an earlier run on the current branch has a `criteria.md`, show its path and offer to start from it. Stop for the user's choice before replacing or reusing it.

### 2. Create the run

Ensure `.verify/` is ignored by the target repository. Add `.verify/` to its `.gitignore` when missing.

Create the run and persist its identity in one tool call:

```bash
TARGET_REPO="$(pwd -P)"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$TARGET_REPO/.verify/runs/$RUN_ID/tests"
printf '%s\n' "$RUN_ID" > "$TARGET_REPO/.verify/current-run"
```

The empty `tests/` directory is intentional and must exist even when no test is generated.

### 3. List changed behavior files

Choose the branch's merge base. Prefer the PR base or upstream merge base; do not guess a different branch when repository metadata supplies one.

Run:

```bash
TARGET_REPO="$(pwd -P)"
RUN_ID="$(cat "$TARGET_REPO/.verify/current-run")"
VERIFY_PIPELINE="${VERIFY_PIPELINE:-$CLAUDE_PLUGIN_ROOT/pipeline}"
(cd "$VERIFY_PIPELINE" && npx --no-install tsx src/cli.ts changed-files \
  --repo "$TARGET_REPO" --base <merge-base>) \
  > "$TARGET_REPO/.verify/runs/$RUN_ID/changed-files.json"
```

The result includes committed branch changes, staged and unstaged changes, and untracked behavior files. Test files are excluded.

### 4. Draft criteria

Translate the plan into concrete, observable criteria. Each criterion has:

- `id`: stable `AC1`, `AC2`, and so on.
- `title`: one behavior.
- `doIt`: the real action to perform.
- `expectIt`: a measurable observation.
- `source`: `{ "kind": "plan", "ref": "..." }`, `{ "kind": "inferred", "from": "..." }`, or `{ "kind": "invented", "note": "..." }`.

**Write every criterion as a user would experience it, not as the code is structured.** A
criterion names a request, a command, a message, or a screen, and the observable it
produces. It never names a function, a class, or an internal call. If a criterion cannot be
checked without reading source, it is the wrong criterion: rewrite it as something a
customer could do.

Good: `POST /api/v1/events with a staging key, then read the row: environment_id is the
staging environment.`

Bad: `resolvePayloadEnvironment returns the key-bound environment.`

This is why the workflow does not inspect the repository's existing tests. Whether a unit
test exists, and whether it mocks something, is a question about the test suite. This
workflow answers one question only: does the change work when driven the way a user drives
it.

### 5. Compute criterion coverage

Write `.verify/runs/<id>/claims.json` as a mapping from criterion id to changed files it claims, for example:

```json
{
  "AC1": ["src/assets.ts"],
  "AC2": ["src/auth.ts"]
}
```

Then compute uncovered files from that artifact:

```bash
TARGET_REPO="$(pwd -P)"
RUN_ID="$(cat "$TARGET_REPO/.verify/current-run")"
RUN_DIR="$TARGET_REPO/.verify/runs/$RUN_ID"
VERIFY_PIPELINE="${VERIFY_PIPELINE:-$CLAUDE_PLUGIN_ROOT/pipeline}"
(cd "$VERIFY_PIPELINE" && npx --no-install tsx src/cli.ts changed-files \
  --repo "$TARGET_REPO" --base <merge-base> --claims "$RUN_DIR/claims.json") \
  > "$RUN_DIR/coverage.json"
```

Write `.verify/runs/<id>/criteria.json` in this shape, copying `coverage.json.uncovered` into `uncoveredFiles`:

```json
{
  "criteria": [],
  "uncoveredFiles": []
}
```

Render the approval artifact:

```bash
TARGET_REPO="$(pwd -P)"
RUN_ID="$(cat "$TARGET_REPO/.verify/current-run")"
RUN_DIR="$TARGET_REPO/.verify/runs/$RUN_ID"
VERIFY_PIPELINE="${VERIFY_PIPELINE:-$CLAUDE_PLUGIN_ROOT/pipeline}"
(cd "$VERIFY_PIPELINE" && npx --no-install tsx src/cli.ts criteria \
  --criteria "$RUN_DIR/criteria.json") > "$RUN_DIR/criteria.md"
```

Print `criteria.md`, including invented specifics and uncovered changed files. Ask the user to edit it, identify corrections, or say `go`.

**Stop here. Run no verification command and perform no system mutation until the user approves the criteria.**

## Half two: run and report

Enter this half only after explicit approval. Read the persisted run id; never rely on an earlier shell variable:

```bash
TARGET_REPO="$(pwd -P)"
RUN_ID="$(cat "$TARGET_REPO/.verify/current-run")"
RUN_DIR="$TARGET_REPO/.verify/runs/$RUN_ID"
test -f "$RUN_DIR/criteria.json" && test -f "$RUN_DIR/criteria.md"
```

If the user requested changes to the criteria instead of approving them, update and re-render half one, then stop again.

### 1. Prepare recording

Check both optional recorders:

```bash
command -v asciinema >/dev/null || echo "asciinema missing: brew install asciinema"
command -v agg >/dev/null || echo "agg missing: brew install agg"
```

If either is missing, run verification anyway and add a `Not checked` entry saying no terminal recording was made and why. A missing recorder never blocks the run.

When both exist, record the actual commands and their output from start to finish. Either:

- run all verification commands in one persistent PTY after starting `asciinema rec <absolute-run.cast>`, then exit that PTY cleanly; or
- generate a bounded verification script under the run directory and use `asciinema rec --command "bash <absolute-script>" <absolute-run.cast>`.

Do not start `asciinema` in one shell and run the evidence commands through unrelated shell tool calls; those commands will not be captured. After recording, render:

```bash
agg <absolute-run.cast> <absolute-run.gif>
```

If recording or rendering fails, keep running the criteria and add the failure to `Not checked`.

### 2. Drive the real system

Choose the cheapest way to *actually check* each criterion, using the repository's own
commands. Cheapest sufficient proof means the least setup that still observes the
behaviour. It does not mean skipping a criterion because driving it is inconvenient.

- API: call the real route, authenticate through the public path, and observe the side effect rather than status alone.
- Datastore: inspect affected rows before and after; for migrations, test the direction actually claimed.
- CLI: run the real binary, checking exit code separately from output shape. Avoid a PTY when machine-readable output is the criterion.
- Async: fire the trigger, wait with a deadline and correlation id, then inspect the real effect. A local sink proves emission, not public delivery.
- UI: drive a real browser. See below.

**UI criteria, in detail.** A web interface is the surface where "drive it the way a user
does" is most literal, so it gets a real browser rather than an HTTP client. The plugin
declares Playwright MCP, so `mcp__playwright__*` tools are available once the plugin is
installed.

1. Confirm the tools are present. If they are not, record every UI criterion as
   `could-not-run` with the reason, exactly as with a missing recorder. Never substitute
   a `curl` against the page and call it a UI check: fetching HTML does not prove a user
   can complete the flow.
2. Navigate to the page named in the criterion. Prefer a route the criterion states over
   one you infer.
3. Interact the way the criterion describes: click, type, select. Read the page between
   steps rather than assuming a click landed.
4. Read the observable the criterion names. Prefer text and state a user could see over
   internal attributes.
5. Capture a screenshot at the moment of observation and keep it under the run's
   directory. The screenshot is the evidence for that criterion, not decoration.

A UI criterion that cannot be judged without reading the page source is the wrong
criterion. Rewrite it as something a person could confirm by looking.

Mutation in a disposable local system is allowed. Before writing to a shared or staging system, describe the exact mutation and obtain a specific yes. Before provisioning anything that costs money, obtain a specific yes. If permission is not given, record the criterion as `could-not-run`; do not count it as a behavior failure.

### When driving a criterion is expensive

Some criteria are drivable but costly: they need a failure induced, a long-running job,
a fixture built, or a service stood up that nothing else in the run needs.

**Cost is the user's decision, not yours.** Do not quietly move a criterion to
`Not checked` because it would take a while. Present it, with what it would cost, and let
them choose:

```
AC5 needs a production job to fail with a key in its error text before the admin
    endpoint will show anything. Roughly 15 minutes: force a job failure on the local
    stack, then read it back through the admin surface.

    Drive it, or record it as not checked?
```

Ask before half two finishes, while the stack is still up and the answer is still cheap
to act on. If the user declines, the `Not checked` reason is what it would have taken,
not a judgement that it did not matter.

If several criteria are expensive, list them together with their costs and let the user
pick which ones are worth it. Say which one you would drive if they only pick one, and
why — usually the one whose failure would be worst.

### Citing coverage you did not observe

A `Not checked` reason explains why the criterion was not driven here. That is all it is
required to do.

If you also believe something else covers it, that claim has to be checkable by a reader
who was not present. Name it, and state plainly that this run did not re-run it:

```
GOOD  not driven: needs a production job to fail with a key in its error text.
      A test exists: TestRedactAdminErrorSwallowsEndpointBearingProjectKey
      (Go handler suite). This run did not execute it.

BAD   covered by unit canaries
```

Never write that something is covered by tests you did not run without naming them. An
unnamed claim of coverage cannot be checked, reads as reassurance, and is exactly the
thing this report exists to avoid. A named test that turns out to be inadequate is a
finding; an unnamed one is noise.

Record exactly one result for every approved criterion:

```json
{
  "id": "AC1",
  "outcome": "pass",
  "observed": "50 rows (was HTTP 500)"
}
```

`outcome` is `pass`, `fail`, or `could-not-run`. `observed` describes only what the command showed.

### 3. Preserve generated tests

If a useful regression test is generated, write it only to `.verify/runs/<id>/tests/`. Never put it in the source tree during verification. Preserve an empty `tests/` directory when no test is generated.

### 4. Render the report

Write `.verify/runs/<id>/results.json`:

```json
{
  "results": [],
  "coverage": { "filesWithoutCriterion": 0 },
  "notChecked": []
}
```

There must be one result per approved criterion. Set `coverage.filesWithoutCriterion` from the persisted `coverage.json`, not from memory. Include every skipped surface, permission denial, harness problem, recorder problem, and uncovered file in `notChecked`. Keep the list present even when empty.

Render:

```bash
TARGET_REPO="$(pwd -P)"
RUN_ID="$(cat "$TARGET_REPO/.verify/current-run")"
RUN_DIR="$TARGET_REPO/.verify/runs/$RUN_ID"
VERIFY_PIPELINE="${VERIFY_PIPELINE:-$CLAUDE_PLUGIN_ROOT/pipeline}"
(cd "$VERIFY_PIPELINE" && npx --no-install tsx src/cli.ts report \
  --results "$RUN_DIR/results.json") > "$RUN_DIR/report.md"
```

Print `report.md` and the artifact paths. When recording succeeded, confirm `run.cast` and `run.gif` exist and that the cast contains real commands and output. Confirm `criteria.json`, `criteria.md`, `claims.json`, `coverage.json`, `results.json`, `report.md`, and `tests/` exist. Confirm the target repository has no verification changes outside `.verify/`.

For each generated test, print its artifact path and the source-tree path where it would belong. Ask separately whether the user wants that test checked in. Do not move or commit any test without that explicit choice.
