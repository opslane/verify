---
name: break
description: Try to break a change the way the real world will - network faults, restarts, two things at once, users doing things out of order - on a disposable local stack, and report what broke with a reproduction.
---

# /break

`/verify` asks "does the change do what the plan said?". This skill asks the opposite:
"how does this change fail once it meets real networks, real users and the other
services around it?". Run it after `/verify` passes, on the same local stack.

It is not a unit test hunt. Empty strings, unicode and wrong types belong in unit tests.
The bugs this skill looks for only exist when the whole system is running:

- **Network and infrastructure:** a dependency that is slow, refuses connections or
  hangs; a reply lost after the side effect happened; a process killed or restarted
  mid-job.
- **Users:** double-clicking, two tabs, going back, refreshing mid-flow, leaving and
  coming back after something changed.
- **Services interacting:** two workers, or a background job running at the same
  moment as a request, events arriving twice or out of order, old and new versions running
  together, state changed by someone else between two steps.

## Hard rules

- Never fix what you break. Report only.
- Only the disposable local stack. Never inject faults into a shared, staging or
  production system.
- Use local stubs for model and paid-provider calls. Real paid calls happen only if the
  charter lists them with their cost and the user approves.
- A stub accepts whatever you send, so it cannot tell you the real provider would refuse
  the request. When the change alters what is sent to an outside service (a schema, a
  tool definition, a new field), check the request against the provider's real rules
  wherever that is free: a token-counting or validation endpoint, a dry-run mode, the
  provider's published schema. That is not a paid call.
- A finding is something you **made happen on the running system**. Something you
  can only argue from reading code is a *suspicion*: list it separately, with what it
  would take to demonstrate.
- Every finding reproduces twice before it is reported.
- A failure in your own harness is not a finding. If the fault you injected also broke
  the thing you use to observe, say so and fix the harness, not the verdict.

## Before you start

Reuse `/verify`'s setup: `.verify/setup.json`, the environment scripts and the run
marker. Boot with `env.sh up`, seed with `env.sh seed`, and arm `env.sh down` on every
exit path, exactly as `/verify` half two does. If there is no setup contract, stop and
ask for `/verify-setup`.

Create a run directory: `.verify/breaks/<YYYYMMDD-HHMMSS>/`. Everything you write goes
there.

Find the plan the same way `/verify` does. You also read the diff, and unlike `/verify`
you may read the changed code: this skill uses code to **aim**, never to **judge**.

### Read the app profile

`/verify-setup` writes `.verify/profile.json`: the app's services, background actors,
status transitions, outside services, behaviour-changing config and the chain in front
of production. Check it first:

```bash
VERIFY_PIPELINE="${VERIFY_PIPELINE:-$CLAUDE_PLUGIN_ROOT/pipeline}"
(cd "$VERIFY_PIPELINE" && npx --no-install tsx src/cli.ts profile-check --repo "$(pwd -P)")
```

If the file is missing or
the check fails (the code has moved on), rebuild it before anything else by following
section 7 of the `/verify-setup` skill; it takes a few minutes and asks at most one
question. If the rebuild fails, carry on without a profile and say so in the report.

Use only the slice that matters for this change:
the actors and transitions that touch the changed files or the tables they write, the
outside services the change calls, and the edge chain. Open each cited line you rely on
and drop any entry the code no longer supports. Entries are leads, not proof: a missing
entry never means nothing else does this.

### Reaching the state under test

The repo's seed usually creates tenants, not the mid-flight state you want to attack.
Getting there is most of the work, so do it cheaply:

- Use the product's own test doubles first: local sandbox, fake providers, stub servers.
- Point model and provider clients at a local stub you control when the attack is about
  how the system handles their answers (invalid, truncated, refused, slow, hanging). It
  costs nothing and lets you choose the bad answer.
- When an upstream stage is expensive (a real agent run, a paid pipeline), you may seed
  its output with SQL, writing the same rows the real code writes. Say so in the report.
- Give each attack its own project or tenant, so one attack's leftovers do not change
  the next one's outcome.

If the setup contract is missing something the stack needs (an env var, an image that
will not pull), work around it and list it under **Setup gaps** in the report.

## 1. Map the seams

A seam is anywhere the change hands work or state to something else. Write
`seams.md` with one short entry per seam:

- **Actors** that touch the changed state: API handlers, workers, the reaper or lease
  expiry, sweepers, schedulers, boot-time migrations, webhooks, the browser, external
  services. Include background actors the diff did not touch but that read or write
  the same rows. They are where the collisions come from.
- **State** each actor reads or writes, named as tables, keys, files or messages.
- **Moments between steps**: for each changed write, find its transaction boundary
  and every actor that can read or change the same state before the next write. After a
  commit and before a reply, between two transactions, between a claim and a
  completion, between a freeze and a publish. Write down the exact interleaving you
  would force ("write A commits, then another actor changes the same row, then write
  B runs") and what each actor should do. These interleavings are your best attacks.

### Other producers

A fresh stack holds only what the happy path wrote. Real systems hold what everyone
produced. For each piece of data the change consumes (rows, messages, files, headers,
payloads, config, URLs, anything it parses):

1. **List the producers.** Older versions of this code, other services and background
   jobs, people (manual fixes, imports, admin tools), outside systems (webhooks, SDKs,
   browsers, build tools), and failures (a write cut short, a retry, a duplicate
   delivery, a crash between two writes).
2. **List the shapes each producer could leave.** Ask for an exhaustive list with a source
   for each item (a tool and version, a doc, a named failure), never for "some sample
   data": samples cluster on the common case and miss the shape that breaks things.
   Include at least one shape that contradicts the plan's own examples.
3. **Produce each shape the cheapest honest way.** Run the real producer when you can
   (the base commit, the provider's CLI, a real build tool, a recorded browser session).
   Otherwise write the shape directly (SQL, a crafted request) and say so.

For your own infrastructure (the proxy in front, the deployed config), test the path
the profile names first. For inputs that vary by customer (their build tools, SDK
versions, proxies), try the few most common variants and name the ones you skipped.

Skip this for data the change does not consume. Run the attacks on top of this data,
and do restart and deploy attacks after it is loaded. Put the producers you covered,
and the ones you could not, in the charter.

### Other consumers

For each piece of data the change produces or changes the meaning of (a row, a stored
payload, a message, a status), find everything else that reads it: other endpoints,
tools, notifiers, the UI, reports, and older versions still running during a deploy.
Trace them in the code now, for this change; do not rely on a list from the profile.
After each attack, read the data through every consumer and check they agree on what
it means (whether it exists, what it holds, what state it is in), even if they show
it differently.


If the map is empty (no second actor, no gap in time, no outside call touches the
changed state), say so and stop. There is nothing for this skill to attack. A change
to copy, styling or docs usually ends here.

## 2. Write the charter, then stop

### Which attacks apply

Choose from what the change does. The categories are generic; turn each into concrete
cases for this app from the profile and the diff.

| If the change | Try |
| --- | --- |
| does two writes in a row | a crash between them |
| has a background job, retry or scheduler | a poison item, a crash mid-job, two workers |
| lets a person act on something a job is using | the person acts mid-job |
| calls an outside service | the service down, slow or hanging |
| reads config or a feature flag | the shipped defaults: flags unset, optional keys empty, exactly what the compose file and example env pass through |
| ships an operator script or deploy step | run it end to end on the stack, as the operator would |
| stores data others read | check all consumers agree |
| runs at startup | a restart on data left by older versions |

### Starting states

Run each attack from the starting states that apply, not only the clean default:

- retries: first attempt, and the last attempt before the job gives up
- concurrency: one run, and another run of the same thing already in progress
- data age: fresh, and data left behind by older versions or crashed runs
- config: filled in, and default or missing

Name the concrete state in the charter ("fix job at attempt 2 of 3"), and how you
reached it.

### Check a guard before building on it

When the profile, the plan or your own reading says a write has no guard, open the
code and confirm it before planning an attack around it. Reading gets these wrong.

### Hypotheses

Pick hypotheses from the attack list below. Each one reads:

> If **\<fault\>** happens during **\<moment\>**, then after the system settles,
> **\<settled-state rule\>** still holds.

Rank them by how bad the worst outcome would be for a real user. Run the two or three
highest-risk interleavings from section 1 first, then the rest as time and budget allow. Write `charter.md` with the hypotheses, the settled-state rules (section 3), the
stack you will use, and a rough time estimate. List every attack from the list below
that you considered and skipped, each with a one-line reason ("no second actor writes
this row"). Scale the effort to the change: a single-flow change gets two or three
attacks, a change to background jobs gets the full list. Show it to
the user and stop until they say go.

### The attack list

1. **Poison item.** One input that always fails, however many times it is retried.
   Count retries and spend, and check whether the work around it still finishes.
2. **Lose the reply after the side effect.** Let the write commit, then kill the
   process or drop the response before the caller hears back. Re-run, retry or
   redeliver. Count results: exactly one.
3. **Real network faults, not clean errors.** Point a dependency at a closed port, make
   it hang (`docker pause`), make it slow. A clean HTTP 500 is the easy case; hangs and
   refused connections are where the bugs are.
4. **Two at once.** Two actors on the same state at the same moment: two workers,
   a background job and a request, two tabs, a double-click, two users on one record.
5. **Restart or deploy mid-flight.** Restart the services the change touches while work
   is in progress.
   Boot-time migrations and sweepers run again. Run the old and new versions side by
   side where a deploy would.
6. **Change state between two steps.** Between the moments from section 1, let another
   actor act: a person clicks a button, a sweeper runs, retention deletes, an external
   service changes its mind.
7. **Crash at every commit point.** For each database write in the changed flow (from
   section 1), kill the process right after that write commits, restart, and check the
   rules. One commit point per attempt.
8. **Prod parity.** Compare the env vars and default hosts the change needs against
   what the deployed config provides. Put the profile's edge chain in front (a local
   proxy standing in for each hop) where the change handles requests.

### Optional: randomise the timing

Forcing the exact moment (below) is the main tool. Random fault times are a cheap extra
sweep for moments you did not think of, but they rarely land in a gap that is only a few
milliseconds wide, and they never create a starting state such as a last retry. If you
run a sweep:

1. Name the fault and the window it may land in, from one observable point to another
   ("SIGKILL the worker, any time between the job being claimed and it completing").
2. Run at least 20 attempts. Each one resets to the same starting state, picks a random
   time inside the window, records that time, injects the fault, lets the system
   settle, and checks every guarantee.
3. Save a short timeline per attempt: the fault time and the product's own log lines
   and state changes around it. The timeline of a failing attempt is its explanation.

Report the fault times of the failing attempts. Re-running at those times will usually,
not always, repeat the failure, because thread scheduling is not controlled; say so.
Use a forced window (below) when the random attempts point at a narrow gap you then want
to hit every time.

### Widening a race window

Real races are narrow. Two concurrent requests or a `docker pause` rarely land in the
gap by luck. Force the interleaving you wrote down in section 1, as long as the state you
force is one production can reach:

- Hold a row lock from a second `psql` session (`BEGIN; SELECT ... FOR UPDATE;`) so an
  actor blocks at the exact point you want, then release it.
- Move a lease or schedule time into the past with SQL so the reaper or scheduler acts
  now instead of in ten minutes.
- `docker pause` a container at the moment you care about and `docker unpause` it
  after the other actor has run.
- Run two requests together with `&` and `wait`, or with a barrier.

Check that the first write actually committed before you release the competing actor. A
lock can block the write you meant to race and give you a different interleaving than
you think. If a SQL edit or pause creates an ordering the application cannot reach,
discard the result.

Moving a lease, retry or schedule time into the past stands in for time passing and is
always fair. Setting a status column to a value the code would never write is not.

Record in the finding how you widened the window and what makes the same interleaving
happen in production (a slow query, a long pause, a timeout). A forced state production cannot reach is not a finding.

## 3. Guarantees

Name each guarantee (`diagnosis_kept`, `charged_once`, `no_stuck_jobs`) and give it the
query or request that checks it. Check every guarantee on every attempt, not only the one
the attack was aimed at, and report each as a count: "held on 17 of 20 attempts". Count
only attempts that actually exercised the guarantee, and list guarantees no attempt
exercised separately. A guarantee that held on every attempt is evidence; a failure rate
tells the reader how often a user would hit it.

`all_consumers_agree` is always one of them when the change stores data others read:
every consumer from section 1 agrees on what the data means.

Check two things: what each actor saw at each step (the response to the user, the
error the worker logged), and the state left behind after a stated recovery deadline.
A final row can look fine while a user got a 500 on the way. Write the rules in data
terms **before** attacking, from the plan and from common sense about the product,
never from what the code happens to do. For each workflow, write down its permitted
end states first.

- Each item reaches one of its permitted end states, or is still active with a live
  owner and deadline. `needs_human` is a failure only where the plan says the system
  recovers on its own.
- For each side effect, name what the product promises (at most once, at least once,
  exactly once) and what makes two of them "the same". Count duplicates against that
  promise, and keep attempts, committed effects and paid calls apart.
- Good data survives. A later failure never overwrites an earlier success.
- Spend is accounted: one ledger row per real paid call, and no loop of paid calls.
- The user was told the truth: no 500 for a normal action, no success shown for a
  failure, no spinner that never ends.
- The views agree once polling or caches have caught up: what the UI shows, what the
  API returns and what the database holds. Capture anything wrong shown before then.

Add rules specific to the change. Each rule names the query or request that checks it.

## 4. Attack

Go through the charter in order. For each hypothesis:

1. Record the steady state (the rule queries) before touching anything.
2. Inject the fault at the moment named.
3. Remove the fault and wait for the system to settle, with a deadline. Give the
   reaper, retries and schedulers the time they would take (shorten it with SQL if
   needed, and say so). Wait with a polling loop and a deadline, not a single sleep.
   A missed deadline is inconclusive until you show recovery cannot happen.
4. Run every guarantee's check again and save the raw output under `attacks/<n>/`.
5. Write down what happened: for each guarantee, how many attempts it held on, or
   could not run and why.

Keep an action log for each attack (`attacks/<n>/log.txt`): every action you took and
what came back, in order, with timestamps. Reproductions come from this log.

Weave the run marker into everything you create so the evidence is unambiguous. Do not
tweak an attack until it breaks something. If a hypothesis holds, it holds; move on.

## 5. Confirm each finding

Before a break becomes a finding:

- **Reproduce it a second time** from a clean state, with the same forced
  interleaving and a saved trace of the order things happened in. A failure seen on
  several randomised attempts already counts, with their timelines.
- **Cut it down** to the fewest steps that still cause it.
- **Check it against base.** Run the same attack on the base commit when the stack can
  boot there. Label the finding `new` (the change introduced it),
  `not fixed by the change` (the old behaviour survives in a case the plan promised to
  cover), `pre-existing` (unrelated to the plan), or `base not checked` with the reason.
- **Name who gets hurt and how.** Severity comes from that: lost or wrong data and
  money loops are high; a confusing message with a working retry is low.

## 6. Report

Write `report.md` in the run directory, in plain language:

- **Findings**, worst first. Each has: one-line headline, who gets hurt, a runnable
  reproduction script saved under `repro/`, the steps in words, how any race window was widened and why production can reach it,
  the settled-state rule it broke with the raw before and after, `new` or
  `pre-existing`, and severity.
- **Suspicions**: things you believe from the code but could not make happen, with
  what it would take.
- **Guarantees**: a table of every guarantee against every attack, as "held N of M".
- **Held**: every attack that did not break anything, one line each. This is what makes
  an empty findings list believable.
- **Not attempted**: each skipped hypothesis and the reason.
- **Spend**: paid calls made and roughly what they cost.
- **Setup gaps**: anything the setup contract was missing.
- **Data coverage**: the producers and shapes you produced, the consumers you checked, and the ones you could not.

If you cannot write files (for example, you are running as a subagent), return the
report as your final answer instead.

Tear the stack down and print the report path. Never file issues or fix anything. Offer
to draft an issue for each finding and let the user choose.
