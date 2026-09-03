# A run, walked through

This is a real `/verify` run against Opslane's own worker, from 2026-09-02. The raw files are checked in at [`examples/agent-fail-v2/`](../examples/agent-fail-v2/): the criteria that were approved, the report as text, and the HTML report with a card and evidence per criterion. Four things are redacted, a sandbox id, a template id, a dev database password, and one private repository name. Everything else is as the run left it.

## The change

Opslane runs an AI investigation on every incident a customer reports. Sometimes that investigation dies halfway: the model runs out of turns, or the provider is down. Before this change, the customer saw "needs a human" on their dashboard for what was really Opslane's own failure.

The change makes those failures Opslane's. Retry them quietly, on a widening interval, and never show them to the customer. The agent implemented it across seven commits. Its unit tests were green.

## The criteria

Verify read the plan and wrote five criteria. Nobody wrote them by hand.

| | What it claims | Would the old code pass it? |
|---|---|---|
| 1 | A transient dead letter is re-run once about an hour after it died, again about four hours after the next death, and again after sixteen; one that is a minute short of each boundary is left alone. | Not applicable |
| 2 | With a real sandbox but no GitHub credential, a private repository cannot be cloned, and the incident lands in needs_human for the customer with the repo_access_denied reason. | Yes, and that is the point |
| 3 | When the model runs out of room on a real investigation of a real repository, the job is not retried, the incident is not shown to the customer, and the failure is labelled as ours. | No |
| 4 | If the model provider answers 529 to every call, the job is retried with backoff and finally dead-lettered as transient; the incident is never written to the customer as an evidence verdict. | No |
| 5 | The daily route map for a real app finishes within its budget instead of dying, and every discovered route gets a row. | Unknown |

None of them name a file or a function. Each one can be observed from outside the code, which is the test of whether a criterion belongs in the set.

The third column matters as much as the claim. A criterion meant to prove new behaviour that the old code already passes proves nothing, so Verify records its expectation about the old code and shows it to you. The second one is deliberately a criterion the old code passes: it guards behaviour the change could have broken. The fifth says "unknown", and Verify printed that as a question above the table rather than guessing:

```
Unknown against the base commit. Confirm before approving:
- AC5: The route classifier completes on a real Vue repository and writes one
  route_map row per discovered route
```

## What the second model said

Codex reviewed the five before anything ran, having seen the plan and the criteria but not the diff. It marked the first, second, and fourth as load-bearing, and two as unreachable.

On the fifth it was blunt: the check compared the row count in the database against the count the worker itself reported, which is circular, so an implementation that always found one route would pass. On the third it pointed out that the criterion accepted either of two outcomes, so a stub that always parked the incident in "awaiting approval" would satisfy it without ever hitting the turn limit.

It also listed eleven checks the set was missing, including a controlled clock exactly at the retry boundaries and a provider that fails once and then succeeds.

The user read all of that and approved the criteria as they were.

## The run

Nothing was mocked inside the process. The run used a real Postgres, a real E2B sandbox, and a real model against a real repository with its turn budget cut to one so the failure would happen on purpose. For the outage case it stood up a local stand-in for the model provider that answers 529 to every call, and that stub logged 37 requests.

Each criterion was driven as a short sequence of steps: wait for the seeded job to become claimable, run the worker binary for a bounded number of seconds, then read the job and incident rows. Every record the run created carried a marker unique to the run, so the rows it read back could only have come from this run.

## What came out

Four criteria passed. One failed.

The one that failed was the fifth, and the report blamed the criterion rather than the code:

> Job completed; route_map has 2 rows, not 40-120. The expectation was built on a wrong premise: the route classifier does not discover routes from the repository, it classifies the routes observed in the project's incidents.

The code was doing what the plan described. The criterion had assumed the feature worked a different way, Verify had said it was unsure, Codex had said the check was circular, and the run settled it. The report carries all three facts next to each other, so nobody reads that red mark as a bug.

The summary keeps the different kinds of outcome apart:

```
Proven     4 of 5
Behaviour  4 passed, 1 failed
Ran        5 criteria, 0 could not run
Covered    5 criteria, 1 changed files have none
```

## What it found without being asked

The most useful line in the report came from no criterion at all. Under "Not checked":

> Finding: turn exhaustion in a friction investigation is classed agent, not limit. Behavior is identical, but the plan's failure table says limit, and the Slack event and /health count it under agent.

The plan said one thing, the code did another, and the difference shows up in the operator's Slack alert and the health endpoint. No test would have caught it, because the code did exactly what it was written to do. Nothing had asked Verify to compare the two.

The same section recorded more. A second finding about how long a provider outage takes to surface. The three reviewer asks that were not driven. One changed file no criterion covered. And every deviation the harness made along the way, including a typo in one drive attempt that was corrected and re-driven.
