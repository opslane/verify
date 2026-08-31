# Verdict accuracy and the visual report

Decisions from a design grill on 2026-08-31, informed by ~20 real verification runs on
opslane-oss and an adversarial review of the plan by Codex. One release; the ordering
below is build order inside it, not separate ships.

Priority: fix the verdicts. Wrong verdicts are the expensive failure; every incident
class below produced a confident wrong answer that cost hours.

Incident classes this design answers:

- Test suite printed `ok` while ~30 database-gated tests silently skipped on a missing env var.
- A starved worker (dirty shared DB, legacy job backlog) turned "feature works" into false fails.
- A cleanup job nulled seeded fixtures mid-run; a criterion was judged against ghost state.
- Three false vetoes stood until someone manually ran the base commit through the same checks.
- Quiet, unrealistic data let threshold-gated features pass trivially.
- Criteria sets ballooned past 20 items with equal apparent weight.
- Reports written in in-house vocabulary readers do not share, on machines readers cannot
  reach: runs happen on a remote box, and `run.cast` files nobody can play are not evidence.

## 1. Setup contract (`.verify/setup.yaml`)

First run on a repo: sniff, confirm, write.

- Sniff compose files, `package.json` scripts, Makefile, `.env.example`, `scripts/seed-*`,
  README run instructions.
- Confirm via AskUserQuestion, one question per unknown, options pre-filled from the sniff
  (boot command, seed command, health signal, observe points such as the database URL).
  The user corrects rather than authors.
- Write the answers to `.verify/setup.yaml`, show it, offer to commit it. Later runs read
  it and ask nothing.
- Repos with no runnable stack (bare libraries): plain-command mode, no config file forced.

Credentials: verify never holds or asks for sensitive credentials. No production
connection strings, no cloud keys, nothing in any config file. The extent of its
credential awareness is a repo's existing local `.env` files, which the setup interview
asks about and may reuse as-is.

## 2. Throwaway environment per run

Fresh containers and fresh volumes every run, torn down after. Never reuse a stack that
looks idle; half the dirty-state incidents came from one that wasn't.

## 3. Pre-checks before judging

At drafting time, each criterion lists the parts of the system it depends on (API,
database, worker, browser, message sink, object store...). The lists are printed in the
approval doc, one line per criterion, so a missing dependency can catch the reviewer's
eye; the second-opinion reviewer also checks the lists ("could this criterion pass or
fail while something not on its list is down?"). That review-plus-second-opinion is the
agreed guard against a forgotten dependency; no mechanical derivation for now.

Before judging anything, every part named by any criterion is tested once: write a row
and read it back, submit a marked job and watch it get consumed, load a page and see real
content, deliver one message to the sink.

A failed pre-check taints only the criteria that depend on that part. Those render
"could not verify: <part> down" with the pre-check's own evidence. Criteria on healthy
parts are judged normally. No full-run stops.

When a criterion fails but its parts all checked healthy and the failure smells
infrastructural (timeout, connection refused, empty response), the report says "failed,
and the failure shape suggests an environment issue" rather than a bare fail. Never
silently reclassify; never overstate.

## 4. Proof-of-run on every pass

The marker proves the action happened, not that data was created. Each criterion declares
its own proof-of-run at drafting time, reviewed at approval with everything else:

- creates data: the run's unique marker woven into what it creates (the row, the message,
  the page) — the strongest form
- refusal checks: the request carries the marker; evidence is the actual rejection paired
  with that marked request, plus, where available, a log line or request ID showing it
  reached the system, and no marked row appearing
- read-only checks: the observation plus proof it was live this run (a fresh timestamp or
  ID fetched during the run, not a screenshot that could be stale)

A pass whose evidence lacks its declared proof renders "not proven", never "pass". Status
codes alone and absence-of-error are not evidence. A criterion whose drafter cannot name
any proof-of-run is a defective criterion, not an exemption.

## 5. Seeding, kept simple

In order, and they stack:

1. A data file the user provides. If someone has their own trusted read-only path to
   real data (for opslane, an AWS read-only user already on the machine), they export
   and scrub a sample themselves and point verify at the file. To verify it is just
   another seed input; how it was produced is outside verify entirely.
2. The repo's seed script, run at boot.
3. Neither available, or a brand-new feature: the seed plan is co-authored during
   drafting and printed in the approval doc ("I'll create 6 users, 2 sessions each,
   3 with the flag on, through the API"). Data is created through the front door, not SQL
   inserts, same rule as arriving at UI state.

Criteria that need volume state it in their own text ("with 6 distinct users across 2
sessions, ..."), reviewed at approval like everything else.

## 6. Compare-against-base button

Manual, never automatic. On request, boot a second throwaway stack on the base commit,
separately seeded, never the candidate's migrated environment, and run the chosen
criteria there. Report raw observations side by side:

- fails on base too: not the change's fault (harness, spec, or pre-existing issue)
- fails only on candidate: likely regression
- base could not run: reported as exactly that, never reinterpreted

History it answers: the slice-9 false vetoes, the MCP preserves-criteria dispute, and the
day an upstream API change made every run fail and it looked like the branch's fault.

## 7. Second-opinion review of the criteria

No hardcoded criteria cap. After drafting, the criteria set plus the spec goes to a
second reviewer:

- Codex when installed (different vendor, doesn't share the drafter's blind spots).
- Otherwise a fresh-context subagent that receives only the spec and the draft, nothing
  from the conversation that produced them.

The reviewer returns, per criterion: load-bearing / redundant with ACx / tests something
unreachable, plus any checks the set is missing, plus the dependency-list check from
section 3, plus a "worth codifying as a permanent test?" opinion used by section 9.
Guardrails ride in its instructions: cutting one half of an on/off pair is not a valid
prune; a set with no end-to-end "the new capability works" check is incomplete regardless
of what it keeps. Its output is advice with reasons in the approval doc; the user is the
tiebreaker. The report names which kind of reviewer ran.

## 8. The report is a visual page

Runs happen on remote machines. The user must be able to *look at* the evidence in a
browser without installing players or fetching files. The rendered report is an HTML page
(published as a Claude Code artifact when available; always also written to
`.verify/runs/<id>/report.html` as a self-contained fallback), containing:

- Headline verdict first: "11 of 14 proven. 2 couldn't run (Slack sink down). 1 failed:
  AC7 (no job created)."
- The eligibility rule, enforced at render time: if any criterion is unproven or
  could-not-verify, the headline cannot say "pass". Checks that didn't run never
  disappear from the count.
- Per criterion: what was done, what was observed, verdict, and the evidence inline —
  screenshots viewable in place, the terminal recording playable in the page (embed the
  cast with a player, or the rendered gif; never a bare `run.cast` path), Playwright
  browser recordings playable in the page.
- Plain English throughout: "proves the new behavior" / "guards existing behavior" for
  intent; "my guess, please confirm" for invented; "would have passed before your
  change" for free pass; "pipeline check" not "canary". Diagnostic grids appear only
  when they signal a problem.
- The codify block (section 9) at the end.

`report.md` remains as a text artifact for grepping, but the page is the deliverable.

## 9. Codify: ACs into the repo's e2e suite

After the report renders, never before. The clean-repo assertion is scoped in time:
while drafting and judging, any change outside `.verify/` is a bug in verify, asserted
as today. Codification then runs with the user's explicit yes per test, writes tests in
the repo's own conventions as uncommitted changes visible in `git status`, and the report
lists exactly which files were created. Nothing is ever auto-committed.

- The reviewer's "worth codifying" signal drives the suggestions (an AC that caught a
  real bug: yes; the end-to-end new-capability AC: usually yes; one already covered by an
  existing e2e test: no, with that test named).
- The skill reads the repo's existing e2e suite before suggesting, so suggestions never
  duplicate coverage.
- On silence, suggestions stay in the run artifacts and the repo is untouched.
- Codified tests use the suite's own isolation, not the run marker; they will run in CI.

## Out of scope, deliberately

- Automatic base-commit runs on failure (button only, for now).
- Verify connecting to production or holding any sensitive credential, ever.
- Any hard AC count limit.
- Mechanical derivation of dependency lists (review + second opinion instead).

## Evidence trail

Distilled outcomes in `~/.claude/projects/-home-claude-dev-opslane-oss/memory/`
(slice 5/6/8/9/10 verify outcomes, no-digest and digest-v4 rigs, error-context and M1
outcomes, placeholder-verdicts, empty-digest funnel, window-title judge leak). Raw
sessions grepped for `.verify/runs/`: heaviest in slice-6, slice-8, error-tracking,
no-digest, why-no-issues; singles across ~14 more branches including
verification-sandbox-failures-burn-fix-attempts.
