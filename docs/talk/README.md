# The bottleneck moved

<!--
Windows, in alt-tab order:
  1  this file, rendered
  2  examples/agent-fail-v2/criteria.md, rendered
  3  examples/agent-fail-v2/report.html, opened as a local file
Budget: about 3:00 spoken. Q&A takes the rest. The comments hold the words.
-->

**Abhishek Ray, founder of Opslane**

<!-- 0:00
"Hey everybody, my name is Abhishek. I'm the founder of Opslane. We're building
an open-source agent that finds user-facing issues, investigates them, and
opens PRs for them. I'm not going to talk about Opslane today. I'll talk about
a skill I built that helps me iterate faster while building it."
-->

## Verification is the bottleneck now

My loop before: write a spec with Claude, have Codex implement it, then sit down and test every edge case by hand.

The unit tests pass. Claude does not write unit tests that fail. Then I find that a lot of the feature is not built the way I asked for.

<!-- 0:15
"I'm guessing this is true for all of us. As the coding agents got better, the
bottleneck moved from writing code to checking that the code does what we
wanted. Here's what my loop looked like. Spec with Claude. Codex implements.
Unit tests pass, and they always pass, because Claude does not write unit
tests that fail. Then I sit down, test by hand, and find that a lot of it is
not what I asked for."
-->

## What `/verify` does

A Claude Code skill. Five steps.

1. Takes the spec for the change.
2. Works out the intent of the change from the spec, not from the diff.
3. Writes acceptance criteria from that intent.
4. Stops and asks me to approve them, or runs on its own if I tell it to.
5. Drives the real system against the criteria and writes a report.

Why acceptance criteria? Because they are how I check I'm testing the right thing. Written before I look at the code, they are the one version of "correct" the implementation had no say in. Criteria written from the diff always pass, since the code already told them what to expect.

<!-- 0:50
"So I built a skill called verify. Five steps. It takes the spec. It works out
the intent of the change, from the spec, not from the diff. It writes
acceptance criteria from that intent. Then it stops and asks me to approve
them, or runs on its own if I tell it to. Then it drives the real system and
writes a report.

The acceptance criteria are the important part, and I don't see many people
talking about them. They are how I make sure I'm testing the right thing. My
first version wrote them by reading the diff, and they passed every time. The
code had already told them what to expect. Now they come from the spec, before
anything looks at the code, so the implementation gets no say in what correct
means."
-->

## A real run

The change: when Opslane's AI worker fails to investigate an incident, that is our failure. It should retry on its own instead of showing the customer "needs a human."

Files from the run are in [`examples/agent-fail-v2/`](../../examples/agent-fail-v2/).

<!-- 1:35
"Here's a run from last night. The change: when our AI worker fails to
investigate an incident, that's our failure, not the customer's. It should
retry quietly instead of putting 'needs a human' on the customer's dashboard."

SWITCH → criteria.md, plain claim column visible.
"It wrote five criteria. I wrote none of them. Read AC3."
Read it: "When the model runs out of room on a real investigation of a real
repository, the job is not retried, the incident is not shown to the customer,
and the failure is labelled as ours."
"There are no file names or function names in there. Everything in it can be
observed from outside the code."
Scroll to the yellow line, "Unknown against the base commit. Confirm before
approving: AC5."
"It also told me it wasn't sure about AC5. I said run it anyway."
-->

Then it ran, with nothing mocked in process: a real Postgres, a real E2B sandbox, a real model on a real repository, and a local stand-in for the model provider that answers 529 to every call.

<!-- 2:15
SWITCH → report.html, top.
"Then it ran. Real Postgres. It booted a real E2B sandbox. It ran a real model
against a real repo with the model capped at one turn. For the outage case it
stood up a fake provider that answers 529 to everything. I used to mock those
parts, and the failures just showed up in staging instead."

"Four criteria held. One failed. AC5, the one it warned me about."
Expand AC5 and read it flat:
"The expectation was built on a wrong premise, mine."
"It did not blame the code. It blamed its own assumption, and it showed me the
log line that proves it."

Scroll to Not checked.
"And every report ends with what it did not check. This one found, without
being asked, that my plan and my code disagree about a failure class. This is
the section I read first now."
-->

## What I'd want you to take from this

Write the acceptance criteria first, from what you meant. Do not let the judge read the code.

`github.com/opslane/verify`

<!-- 2:50
"If you take one thing: write the acceptance criteria first, from what you
meant, and don't let the judge read the code. The skill is open source and the
run I just showed is in the repo. Thanks."
-->
