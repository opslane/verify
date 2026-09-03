# Opslane Verify

Don't trust your agent. Verify it.

Coding agents write more code than anyone can read. Reviewing the diff does not run it. And the agent's own tests pass because the agent wrote them to pass. So the check that tells you a change actually works is still you, clicking through the app after every change.

Opslane Verify does that check, with three things between the agent and "done" that the agent does not control. It reads the plan the change was meant to implement and turns it into acceptance criteria. A second model, Codex when installed, reviews those criteria and flags the ones a lazy implementation could pass. You approve them. Then it boots your app, drives every criterion against the running system, and writes a report with every step it took and the evidence behind every verdict. You check its work instead of trusting it.

It is a Claude Code plugin. You run it locally, after the agent finishes implementing and before you open the PR.

## Before and after

**Without Verify.** The agent says done. Tests are green. You boot the stack, seed an incident, kill the model mid-investigation, and read the job row by hand. Forty minutes later you notice the failure is labelled as the customer's problem when the plan said it was yours.

**With Verify.** Five criteria you approved. One run. The report names the label mismatch, with the row that proves it.

That run is real, and it is walked through [below](#an-example-from-a-real-run).

## What it does

```
1. Takes the plan for the change.
2. Works out what the change was meant to do. From the plan, not the diff.
3. Writes acceptance criteria from that. A second model reviews them.
4. Stops and asks you to approve them.
5. Drives the real system against each criterion and writes a report.
```

The criteria are the part that matters. Written before anything looks at the code, they are the one definition of "correct" the implementation had no say in. Criteria written from the diff pass every time, because the code already told them what to expect.

## Requirements

- Claude Code, logged in with `claude login`.
- Node.js and npm. The engine runs from TypeScript source.
- A plan for the change: a file under `docs/plans/` or `.omx/plans/`, a PR body, or the conversation you wrote the change in.
- A way to start your app on this machine. A compose file is the best case. A start command plus a health URL also works.

Optional: the Codex CLI for the second-model review. Without it, a fresh Claude session that has seen only the plan and the criteria does the review.

## Install

```
/plugin marketplace add opslane/verify
/plugin install opslane-verify
```

This registers `/verify` and `/verify-setup`, plus a Playwright MCP server for browser criteria. In your repository it writes only to `.verify/`, and adds that directory to `.gitignore` if it is not there already.

## Quick start

From your repository, on a branch with a change and a plan:

```
/verify
```

The first time in a repository, it asks you to run `/verify-setup`. Setup looks for a compose file, seed scripts, and env files, asks one question per thing it could not decide, and writes `.verify/setup.json`. It never asks for or stores a secret. Commit that file and your teammates skip the interview.

After that, `/verify` writes the criteria, has them reviewed, and stops. Read them. If one is wrong, say so. When they look right, say:

```
go
```

It boots the stack, seeds it, drives each criterion, tears the stack down, and prints the report. Everything it produced is in `.verify/runs/<timestamp>/`.

## An example, from a real run

The change, to Opslane's own worker: when the AI worker fails to investigate an incident, that is Opslane's failure, not the customer's. It should retry on its own instead of showing the customer "needs a human". The agent implemented it and its tests were green. The files from the run are in [`examples/agent-fail-v2/`](examples/agent-fail-v2/).

Verify proposed five criteria, Codex reviewed them, the user approved. Then it ran with nothing mocked in process: a real Postgres, a real E2B sandbox, and a real model against a real repository with its turn budget cut to one. For the outage case it stood up a local stand-in for the model provider that answers 529 to every call. After each criterion it read the job and incident rows and kept them as evidence.

Four criteria passed. But the report flagged something no criterion had asked about: the plan said this failure should be classed as a limit, and the code classed it as an agent error. Same behaviour, wrong label, and the label is what the Slack event and the health endpoint report. The agent's tests were green because the code did what it was written to do. Nobody had checked it against what the plan said.

The fifth criterion failed, and the report blamed the criterion, not the code:

> Job completed; route_map has 2 rows, not 40-120. The expectation was built on a wrong premise: the route classifier does not discover routes from the repository, it classifies the routes observed in the project's incidents.

Verify had marked that criterion as uncertain before the run, and Codex had flagged it too, because its check compared the worker's output against the worker's own count. The user approved it anyway. The report says all of that, so nobody mistakes it for a bug.

The summary at the bottom of every report keeps those cases apart:

```
Proven     4 of 5
Behaviour  4 passed, 1 failed
Ran        5 criteria, 0 could not run
Covered    5 criteria, 1 changed files have none
```

Proven is how many verdicts the evidence supports. A pass with no receipt behind it does not count. Behaviour is what the code did. Ran is whether the check itself could run; a database container dying shows up here, not as a code failure. Covered is whether every changed file has at least one criterion touching it.

Below the summary, the report always prints a section called "Not checked", even when it is empty. It lists what did not run and why, plus anything the run noticed that no criterion asked about. The label mismatch above was one of its entries.

## Why the agent's tests are not enough

A unit test checks that the code does what its author expected. When the author is the agent that wrote the code, the test and the code share the same misunderstanding, and both pass. Verify takes its expectations from the plan and from how the old code behaved, never from the implementation.

A unit test runs a function with the collaborators mocked out. The bugs that reach staging live in the parts that were mocked: the webhook that fires twice, the migration that runs against real rows, the page that renders before its data resolves. Verify runs the whole system and drives it from the outside, the way a user or a client would.

And green tests say nothing about what was never tested. Verify reports every changed file that no criterion touches, every criterion it could not run, and everything it noticed along the way.

## How it keeps itself honest

Every expectation comes from the plan, or from how the code behaved before the change. Verify reads the diff once, to find things the plan does not explain, and each of those becomes a question for you. Each criterion records whether the old code would have passed it, and a criterion meant to prove new behaviour that the old code already passes is flagged before you approve. Each criterion also names how a reader will know it actually ran, and one with no such proof is not run.

It never edits the code it is judging. Writing to a shared system, or spending money, needs your yes first. If a criterion is expensive to drive, it tells you what it would take and lets you decide. When a criterion fails and you doubt the verdict, it can run the same criterion against the code before your change, so a failure on both sides is not blamed on the change.

## Going deeper

- [What it can test](docs/what-it-can-test.md): APIs, databases, CLIs, queues and webhooks, and web UIs in a real browser, and what each one needs from you.
- [How it runs your stack](docs/how-it-runs-your-stack.md): the throwaway compose project per run, seeding, liveness probes, teardown, login capture, what lands on disk, and what makes a repository easy to verify.

## License

MIT
