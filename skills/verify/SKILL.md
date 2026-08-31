---
name: verify
description: Verify any change surface against approved acceptance criteria, run the real system, and preserve the report and test artifacts.
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
- An expectation comes from the plan or from the base commit. Never from the diff. The diff can only expose gaps, and a gap is a question for the user, not a criterion you answer yourself.
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

The environment helpers are bash scripts resolved the same way:

```bash
VERIFY_SCRIPTS="${VERIFY_SCRIPTS:-$CLAUDE_PLUGIN_ROOT/scripts}"
bash "$VERIFY_SCRIPTS/<name>.sh" [arguments]
```

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

### 0. The setup contract

`.verify/setup.json` records how this repo boots, seeds, and reports health
(written once by `/verify-setup` from sniffed candidates). If it is missing,
ask once: "No setup contract found. Run `/verify-setup` (recommended), or
continue in plain-command mode without a managed stack?" On plain-command
consent, write a minimal contract inline:

```json
{"mode": "none", "compose_file": null, "boot": "", "teardown": "", "seed": [],
 "seed_data_files": [], "health_url": "", "base_url": "", "env_file": "",
 "observe": {}, "probes": {}}
```

Never silently proceed without one. Verify never asks for or stores sensitive
credentials; the contract may at most name one of the repo's own local `.env`
files.

### 1. Find the plan

Look in this order:

1. The current conversation, including an explicit path supplied with `/verify`.
2. `docs/plans/`.
3. `.omx/plans/`.
4. The current pull request body, when available.

Use the newest plan that clearly describes the current change. If no plan is available, ask the user for one and stop. Do not derive criteria from the diff alone.

**The diff raises questions. It never answers them.**

This is the line that keeps verification black box. An expectation comes from the plan, or
from the behavior that existed before the change, or from an assumption you label
`invented` so the user can correct it. Never from the implementation you are verifying.

That is what the `source` field records, and why `invented` is a legitimate value rather
than an admission of failure. A plan that says "field values persist" without naming a
field leaves you a choice. Making it and flagging it loudly is honest. Resolving it by
opening the code and testing whatever it happens to do is not, because that criterion
cannot fail.

So do not go reading the implementation for things to test. If the plan says "bound every
outbound call with a timeout" and does not say what the budget is, the criterion is not
"raises at 30 seconds" because you found `DEFAULT_TIMEOUT = (5, 30)` in the diff. That
criterion passes by construction. Ask what the budget should be.

**What the diff is for.** Once the criteria are drafted from the plan, read the diff once
to find gaps. Mark two things:

- additions the plan never asked for
- anything removed or narrowed: a deleted route, a dropped case, a tightened pattern, a
  reordered rule, a changed default

Each one goes in the approval artifact **as a question**, naming the change that prompted
it and asking what the behavior should be. You do not answer it yourself. A question the
user answers becomes a criterion with `{"kind": "inferred", "from": "..."}` whose
expectation is theirs. A question they wave off goes in the uncovered list, where it stays
visible.

The difference is between asking "the `/confluence/*` route was deleted and the plan never
mentions it, was that intended?" and deciding for yourself what that route ought to do. The
first found a production regression. The second writes a criterion that agrees with
whatever the code now does.

Two real examples of what one pass catches. A diff added two `clear()` calls, in an early
return and an error handler, that the plan never asked for; one of them was the bug, and it
was on screen while the criteria were being drafted. A different diff deleted an ingress
route in the same hunk that added a new one, while the backend still served it; nothing in
the plan mentioned the deletion, because a plan records what someone meant to add and is
silent on what went out with it.

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
- `intent`: `"changes"` or `"preserves"`. What the criterion is for.
- `baseline`: `"fail"`, `"pass"`, `"not-applicable"`, or `"unknown"`. What you expect the
  base commit to do with it.
- `witness`: `"success"` or `"refusal"`. Does this criterion show something working, or
  show something correctly turned away?
- `dependsOn`: the parts of the system the criterion drives or observes, from exactly
  `"api"`, `"db"`, `"worker"`, `"browser"`, `"sink"`, `"storage"`. Half two probes each
  named part once before judging; a down part marks only its dependents "could not run".
- `proof`: how a reader will know the check actually ran. One of
  `{"kind": "marker-in-data", "detail": "..."}` (the run marker woven into created data —
  the strongest form), `{"kind": "marked-request-rejected", "detail": "..."}` (the
  rejection paired with the marked request), or `{"kind": "live-read", "detail": "..."}`
  (a value read fresh during the run, not a stale capture). A criterion you cannot name
  a proof for is defective: move it to `skipped` with the reason "no way to prove it ran".

**`intent` is what the criterion is for. `baseline` is a separate claim about the base
commit.** Keeping them apart matters, because the obvious shortcut of defining `changes` as
"fails on base" is wrong for real criteria:

- *A v1 worker consumes a job written by v2, and a v2 worker consumes a job written by v1.*
  A legitimate criterion for a schema change. It needs both versions running at once, so
  the base commit alone cannot pass or fail it. `intent: changes`, `baseline: not-applicable`.
- *With the new flag off, the old behavior is unchanged.* Preservation. But the base binary
  rejects the unknown flag and will not start. `intent: preserves`, `baseline: not-applicable`.

`changes` means the criterion exists to prove the change did something. Its normal baseline
is `fail`.

`preserves` means it guards something the change could have broken. Its normal baseline is
`pass`, and that is the point rather than a defect. A `preserves` criterion names what it
guards against: the changed route, setting, or file that could plausibly have broken it.

**The check is one line: `intent: changes` with `baseline: pass` is a defect.** That
criterion passed before the change existed, so it proves nothing. Everything else is a
question of honesty about the baseline, not a rule violation.

Declaring a baseline obliges you to picture the base commit while you are drafting. That is
the whole mechanism. Most free passes are visible the moment you ask "would this have
passed last week?" and invisible three steps later when the run comes back green.

`unknown` is a real answer and a cheap one. It goes in the approval artifact as a question.
An honest `unknown` is a much smaller failure than a confident `fail` that turns out to be
a free pass.

**`witness` exists because a set can be all-refusal and look complete.** Six criteria that
all check something is rejected are satisfied by an implementation that rejects everything.
Count the boxes before you submit:

|  | preserves | changes |
|---|---|---|
| **success** | the old path still works | **the new capability works** |
| **refusal** | the old guard still holds | the new guard holds |

Every new capability needs at least one `success` + `changes` criterion: the thing works,
end to end, driven the way a user drives it. That box being empty is the most common way a
criteria set passes while proving nothing.

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

**Ask what the laziest implementation that passes would look like.** For every criterion,
before it goes in the table: could a stub, a constant, or a function that always does the
same thing pass this? If yes, the criterion is an observation, not a check.

Real example. A criterion read *"a stale selection is cleared from state, URL, and local
storage."* It passed. Code that clears the selection **unconditionally, always** passes it
just as cleanly, and that was the bug: a valid selection was being thrown away on every
page load. The criterion tested the rule in one direction only, and the broken build
satisfied it.

**So every rule with an on and an off gets both criteria.** If a criterion says something
is cleared, hidden, rejected, disabled, filtered, or logged out, write its opposite: a
valid one is kept, shown, accepted, enabled, passed through, stayed logged in.

The negative side is nearly always where the bug lives, because over-eager code satisfies
the positive side by accident:

| the plan says | the obvious criterion | the one that catches bugs |
|---|---|---|
| clear a stale selection | a stale one is cleared | a **valid** one survives |
| reject an invalid key | an invalid key gets 401 | a **valid** key still works |
| hide the panel when empty | empty hides it | **non-empty still shows it** |
| retry on failure | a failure retries | a **success does not** retry |

A plan describes what a change adds. Criteria copied from a plan inherit that blind spot,
and nothing in the plan describes what must not break. Writing the opposite criterion is
how you get it back.

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

### 6. Seed script and second opinion, then stop

If any criterion needs volume or precondition data (thresholds, grouping, "with 6
users..."), write a literal `$RUN_DIR/seed.sh` now: real commands (curl, CLI) that
create that data through the application's front door, taking the run marker as `$1`
and weaving it into every entity. No LLM runs at seed time; this script IS the seed,
and the user reviews it. An entry that genuinely needs browser interaction is flagged
"needs an agent — approve separately?".

Then get the second opinion — a reviewer that did not write these criteria:

```bash
VERIFY_SCRIPTS="${VERIFY_SCRIPTS:-$CLAUDE_PLUGIN_ROOT/scripts}"
VERIFY_ALLOW_DANGEROUS=1 bash "$VERIFY_SCRIPTS/review.sh"
```

It uses Codex when installed (a different vendor, different blind spots), else a fresh
`claude -p` that sees only the spec and the criteria, and writes
`$RUN_DIR/review.json` (`keep`/`why`/`codify` per criterion plus a `missing` list).
Its output is advice; the user is the tiebreaker. If the reviewer is `unavailable`,
say so verbatim: the criteria were reviewed only by the model that wrote them.

Also compute which relied-on parts have no probe, so the user sees it before
approving:

```bash
jq -r --slurpfile s .verify/setup.json '
  [.criteria[].dependsOn[]?] | unique
  | map(select(IN("worker","sink","storage") and (($s[0].probes[.] // "") == "")))
  | if length > 0 then "Unprobed parts this run relies on: " + join(", ") else empty end' \
  "$RUN_DIR/criteria.json"
```

Print `criteria.md`, the seed script (verbatim), the reviewer's table and missing
list, and the unprobed-parts line, including invented specifics and uncovered
changed files. Ask the user to edit, correct, or say `go`.

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

### 0. Snapshot, boot, seed, pipeline check

First record what the working tree looks like, so the run can prove it changed
nothing outside `.verify/` (staged changes included):

```bash
git diff HEAD > .verify/pre-run.diff
git ls-files -o --exclude-standard | grep -v '^\.verify/' | while IFS= read -r f; do printf '%s %s\n' "$(git hash-object "$f" 2>/dev/null || echo missing)" "$f"; done > .verify/pre-run-untracked.txt
```

Then boot a throwaway environment and arm teardown before anything else can fail:

```bash
VERIFY_SCRIPTS="${VERIFY_SCRIPTS:-$CLAUDE_PLUGIN_ROOT/scripts}"
bash "$VERIFY_SCRIPTS/env.sh" up
```

From this point every exit path must run `bash "$VERIFY_SCRIPTS/env.sh" down` —
run the rest of half two inside a subshell opening with
`trap 'bash "$VERIFY_SCRIPTS/env.sh" down' EXIT`, or tear down explicitly on
every failure branch. Boot and seed are separate verbs precisely so a seed
failure cannot leak the stack. `up` writes `.verify/run-env.json` with this
run's `marker` and rotates old runs (newest 5 kept).

Seed, in order:

```bash
bash "$VERIFY_SCRIPTS/env.sh" seed          # repo seed scripts + user data files
```

If the approved `$RUN_DIR/seed.sh` exists, run it with the marker — a failure
aborts before judging, because judging against a half-seeded system is how
wrong verdicts happen:

```bash
MARKER=$(jq -r '.marker' .verify/run-env.json)
VERIFY_BASE_URL="$(jq -r '.base_url // empty' .verify/setup.json)" \
  bash "$RUN_DIR/seed.sh" "$MARKER" 2>&1 | tee "$RUN_DIR/seed.log"
```

Then prove the pipes work before judging anything:

```bash
bash "$VERIFY_SCRIPTS/precheck.sh"
```

Every part named by any criterion's `dependsOn` gets one probe (a marker
round-trip for the database; any HTTP response for the API; configured
commands for worker/sink/storage). A down part taints only its dependent
criteria: do NOT drive those — record each as `could-not-run` with the
pre-check's evidence (`$RUN_DIR/prechecks/<part>.log`). A part with no probe
reports `unknown` and never taints; a FAIL on a criterion relying on an
unknown part gets "the failure may be environmental: <part> was never
health-checked" appended to its observation.

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

**Weave the run marker into everything you create.** `.verify/run-env.json`
holds this run's `marker`. Every entity a criterion creates carries it (form
fields, payloads, names). Each criterion's declared `proof` says which
artifact must show the check ran: capture that artifact verbatim in the
evidence — the marker-bearing row, the rejection paired with the marked
request, or the fresh live read. Status codes alone and absence-of-error are
never evidence.

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

**Arrive at state, do not plant it.** It is tempting to set local storage, cookies, or
query parameters and then load the page you care about. That is faster, and it hides every
bug that lives in the transition: what the page does on its first pass, before something
has resolved, is exactly where these sit.

At least one criterion per run should walk a real path end to end in a single session —
land on the first page, click through, and observe on the last one — rather than loading
each page cold with values planted by hand.

Real example. Every check for one change opened a single page with local storage set
directly. The bug was in what the sessions page did on its first pass, before the project
id resolved, on the way in from the issues page. Nobody ever made that journey, so nobody
saw it.

Mutation in a disposable local system is allowed. Before writing to a shared or staging system, describe the exact mutation and obtain a specific yes. Before provisioning anything that costs money, obtain a specific yes. If permission is not given, record the criterion as `could-not-run`; do not count it as a behavior failure.

### When driving a criterion is expensive

Some criteria are drivable but costly: they need a failure induced, a long-running job,
a fixture built, or a service stood up that nothing else in the run needs.

**Cost is the user's decision, not yours.** Do not quietly move a criterion to
`Not checked` because it would take a while. Present it, with what it would cost, and let
them choose:

```
AC5 needs a job that fails with a key in its error text before the admin endpoint
    shows anything. Roughly 15 minutes on the local stack: seed a job, force it to
    fail with a key in the message, then read it back through the admin surface.

    Drive it, or record it as not checked?
```

Note what that does not say. It does not say "needs production". The cost is the
fifteen minutes of setup, and naming the setup is what lets the user judge it. Naming an
environment instead hides the real reason and sounds like a wall.

Ask before half two finishes, while the stack is still up and the answer is still cheap
to act on. If the user declines, the `Not checked` reason is what it would have taken,
not a judgement that it did not matter.

If several criteria are expensive, list them together with their costs and let the user
pick which ones are worth it. Say which one you would drive if they only pick one, and
why — usually the one whose failure would be worst.

### Assume it can be reproduced locally

Before writing that a criterion needs production, staging, a live service, or "a real
failure", ask what actually stops you from causing that locally. Usually nothing does.

A job that fails with a key in its error text is a job you can make fail. A worker run is
a worker you can start. A queue message is a message you can publish. The stack is already
up, because half two brought it up.

Only these are real blockers, and each has to be named specifically:

- A credential or identity only a human can obtain (a real OAuth grant, an SSO login).
- A third-party service you do not control and cannot fake at the boundary that matters.
- An action that is irreversible or visible to others: a real publish, a real payment, a
  message into a channel people read.
- Something that genuinely cannot be induced in this environment, where you say why.

"Needs production" is almost never one of these. If the reason you wrote names an
environment, replace it with the specific thing that environment has and yours does not.
If you cannot name that thing, the blocker is effort, and effort is the user's decision
(see above).

### Citing coverage you did not observe

A `Not checked` reason explains why the criterion was not driven here. That is all it is
required to do.

If you also believe something else covers it, that claim has to be checkable by a reader
who was not present. Name it, and state plainly that this run did not re-run it:

```
GOOD  not driven: the user declined the 15 minutes of fixture setup it needed.
      A test exists: TestRedactAdminErrorSwallowsEndpointBearingProjectKey
      (Go handler suite). This run did not execute it.

BAD   covered by unit canaries

BAD   needs a production job to fail with a key in its error text
      (an environment standing in for setup work; see the section above)
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
  "proofSeen": true,
  "observed": "50 rows containing marker verify-<run> (was HTTP 500)"
}
```

`outcome` is `pass`, `fail`, or `could-not-run`. `observed` describes only what
the command showed. `proofSeen` is true only when the criterion's declared
proof is quotable from the evidence; a pass without it renders "not proven"
and never counts toward the headline. Never set it optimistically.

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
  --results "$RUN_DIR/results.json" --precheck "$RUN_DIR/precheck.json") > "$RUN_DIR/report.md"
```

The `--precheck` flag enforces taint mechanically: a tainted criterion renders
`could-not-run` no matter what was recorded for it. The report opens with the
headline — checks that did not run never disappear from the count, and `PASS`
appears only when every criterion is proven (pass WITH its declared proof
observed).

Then render and serve the visual page:

```bash
(cd "$VERIFY_PIPELINE" && npx --no-install tsx src/cli.ts html \
  --criteria "$RUN_DIR/criteria.json" --results "$RUN_DIR/results.json" \
  --precheck "$RUN_DIR/precheck.json" --review "$RUN_DIR/review.json" \
  --run-dir "$RUN_DIR" --run-id "$RUN_ID")
```

Serve it so the user opens a browser, not a file path — kill the previous
run's server first, fall back through ports, and confirm the new server
actually answers before printing the URL:

```bash
[ -f .verify/server.pid ] && kill "$(cat .verify/server.pid)" 2>/dev/null || true
for PORT in 8123 8124 8125; do
  python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$RUN_DIR" > /dev/null 2>&1 &
  echo $! > .verify/server.pid
  sleep 1
  curl -sf "http://127.0.0.1:$PORT/report.html" -o /dev/null && { echo "Report: http://127.0.0.1:$PORT/report.html"; break; }
  kill "$(cat .verify/server.pid)" 2>/dev/null || true
done
```

(On a remote box, forward the port or bind explicitly if the user asks.)

After judging, verify the clean-repo promise:

```bash
git diff HEAD > .verify/post-run.diff
git ls-files -o --exclude-standard | grep -v '^\.verify/' | while IFS= read -r f; do printf '%s %s\n' "$(git hash-object "$f" 2>/dev/null || echo missing)" "$f"; done > .verify/post-run-untracked.txt
if ! diff -q .verify/pre-run.diff .verify/post-run.diff > /dev/null \
   || ! diff -q .verify/pre-run-untracked.txt .verify/post-run-untracked.txt > /dev/null; then
  touch "$RUN_DIR/clean-repo-violation"
  echo "✗ verify modified your repo during the run — this is a verify bug."
fi
```

The flag makes the report headline read "CANNOT TRUST THIS RUN" and the exit
status non-zero; the report still renders because the diff is exactly what the
user needs to file the bug.

Print `report.md` and the artifact paths. When recording succeeded, confirm `run.cast` and `run.gif` exist and that the cast contains real commands and output. Confirm `criteria.json`, `criteria.md`, `claims.json`, `coverage.json`, `results.json`, `report.md`, and `tests/` exist. Confirm the target repository has no verification changes outside `.verify/`.

For each generated test, print its artifact path and the source-tree path where it would belong. Ask separately whether the user wants that test checked in. Do not move or commit any test without that explicit choice.

## Compare against base

When a criterion fails and the user questions the verdict, offer the manual
comparison — it settles "the change broke this" vs "the harness or spec is
wrong" by running the OLD code through the identical checks:

```bash
VERIFY_SCRIPTS="${VERIFY_SCRIPTS:-$CLAUDE_PLUGIN_ROOT/scripts}"
bash "$VERIFY_SCRIPTS/compare.sh" up <merge-base>
# drive the chosen criteria in the printed worktree exactly as on the candidate
bash "$VERIFY_SCRIPTS/compare.sh" down
```

The base stack is separately seeded (setup contract, auth state, and the
reviewed seed script are carried over) and never reuses the candidate's
environment. Read the results side by side: fails on base too → not this
change's fault; fails only on the candidate → likely a regression; passes on
base too for an `intent: changes` criterion → it would have passed before the
change and proves nothing; base could not run → say exactly that, never
reinterpret. Never run this automatically.

## Codify: keep the checks that earned it

After the report renders (never before — "never fix what you judge" survives
because a regression test for a delivered verdict is not tampering):

1. Read `$RUN_DIR/review.json`. Criteria the reviewer marked `codify: true`
   are candidates; a criterion that caught a real bug this run is an automatic
   candidate.
2. Inspect the repo's existing e2e suite first (find the test directory, grep
   for the feature's route or component). Name overlaps; never suggest a test
   the suite already has.
3. Ask per criterion: "Keep this as a permanent test? (y/n)". On yes, write
   the test in the repo's own framework and conventions as an uncommitted
   file, run it once (if it cannot run here, say so plainly), and report
   exactly which files were created. Never commit. On silence or n, the
   suggestion stays in the run artifacts only.

## One run at a time

Cross-stage state (`.verify/current-run`, `run-env.json`, the setup contract)
is repo-global: run one verification per repository at a time. A second
concurrent run would repoint the shared state mid-run.
