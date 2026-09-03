# Don't trust your agent. Verify it.

<!--
Windows, in alt-tab order:
  1  this file, rendered (the diagrams live here)
  2  examples/agent-fail-v2/criteria.md, rendered, zoomed so one claim fills the screen
  3  examples/agent-fail-v2/report.html, opened as a local file
Budget: about 3:50 spoken. The comments hold the words; the room sees only the
headings, the diagrams, and the screenshot.
-->

**Abhishek Ray, founder of Opslane**

<!-- 0:00
"Hey everybody, my name is Abhishek. I'm the founder of Opslane. We're building
an open-source agent that finds user-facing issues, investigates them, and
opens PRs for them. I'm not going to talk about Opslane today. I'll talk about
a skill I built to check my own work while building it."
-->

## Verification is the bottleneck now

Write a spec with Claude. Have Codex implement it. The unit tests pass, because Claude does not write unit tests that fail. Then sit down and click through every edge case by hand.

The agent says done and the tests are green, and both of those came from the agent.

<!-- 0:20
"I'm guessing this is true for most of us. As the coding agents got better, the
bottleneck moved from writing code to trusting it. Here's my loop. Spec with
Claude, Codex implements, unit tests pass, and they always pass, because Claude
does not write unit tests that fail. Then I click through everything by hand
and find that half of it isn't what I asked for. The agent says done and the
tests are green, and both of those came from the agent."
-->

## Where the checks come from

```mermaid
flowchart TD
    plan["Your plan<br>what you meant"]
    old["The old code<br>how it behaved before"]
    diff["The diff<br>what the agent built"]
    ac["Acceptance criteria"]
    codex["Second model<br>flags what a stub would pass"]
    you["You approve"]
    run["Boot the stack<br>drive every criterion"]
    rep["Report<br>commands, verdicts, evidence"]

    plan --> ac
    old --> ac
    diff -.->|"gaps only, as questions for you"| ac
    ac --> codex --> you --> run --> rep
```

<!-- 0:50 · THE CORE IDEA. Slow down here.
"So I built a Claude Code skill called verify. This is the whole thing in one
picture."
Point at the two solid arrows on the left.
"The acceptance criteria come from my plan, and from how the code behaved
before the change."
Point at the dotted arrow.
"This is the only arrow coming from the diff. It's dotted, and it only carries
questions. If something in the change isn't explained by my plan, it asks me
about it. It never answers on its own."
"That's the whole trick. My first version wrote the criteria by reading the
diff, and they passed every single time. Of course they did. The code had
already told them what to expect. That's also why your agent's own tests pass:
the test and the code came from the same understanding, so they agree even
when they're both wrong."
Point at the second model and the approval box.
"Then a second model that hasn't seen my criteria attacks them, looking for
ones a lazy implementation would pass. And nothing runs until I say go."
-->

## What an acceptance criterion actually is

Opslane runs an AI investigation on every incident a customer reports. Sometimes that investigation dies halfway: the model runs out of turns, or the provider is down. The customer used to see "needs a human" for what was really our failure. That was the change.

It wrote five criteria from that plan. I wrote none of them. In plain language, one of them says:

> A transient dead letter is re-run once about an hour after it died, again about four hours after the next death, and again after sixteen; one that is a minute short of each boundary is left alone.

Underneath, it is a row of [`criteria.json`](../../examples/agent-fail-v2/criteria.json):

```json
{
  "id": "AC1",
  "plain": "A transient dead letter is re-run once about an hour after it died ...",
  "source":    { "kind": "plan", "ref": "Task 4: interval requeue 1h x 4^requeues" },
  "intent":    "changes",
  "baseline":  "not-applicable",
  "dependsOn": ["db"],
  "proof":     { "kind": "marker-in-data", "step": 2 },
  "drive": [
    { "verb": "run", "args": ["timeout","30","env","REAPER_INTERVAL_MS=5000","node","packages/worker/dist/index.js","--expect-exit","124"] },
    { "verb": "db",  "args": ["SELECT g.title, j.status, j.requeues FROM error_group_jobs j JOIN error_groups g ON g.id = j.error_group_id WHERE g.title LIKE 'AC1 {{marker}} %'"] }
  ]
}
```

Four verbs exist: `run`, `db`, `http`, `wait`. No shell strings, no assertions, no verbs specific to my app. The model writes this plan. A plain engine runs it, verbatim, with no model in the loop.

<!-- 1:35 · THE TECHNICAL BEAT. This is the part the room hasn't seen elsewhere.
"Here's a change from yesterday. My agent on Opslane runs an investigation on
every incident a customer reports, and sometimes it dies halfway. The model
runs out of turns, the provider is down. The customer used to see 'needs a
human' for what was really our failure."

"It wrote five criteria from that plan. I wrote none of them. In plain
language, here's one." Read the quote.

Point at the JSON. "But a criterion isn't a sentence. It's this."
Point at source. "Where it came from. This one traces back to a line in my
plan, so I can check it against what I actually asked for."
Point at dependsOn. "What it needs to be up. If the database is down, this one
comes back as 'could not run', not as my change being broken."
Point at proof. "How you'll know the check really happened. Step two's output
has to contain a marker unique to this run. If that string isn't there, it
doesn't pass, no matter what the model thinks."
Point at drive. "And the plan. There are exactly four verbs: run, db, http,
wait. No shell strings, no assertions, nothing specific to my app."

"That's the split that makes it reproducible. The model writes this plan. A
dumb engine runs it verbatim, and there's no model in the loop while it runs.
If a plan is wrong, it goes back through approval. It never gets patched
halfway through a run."
-->

## It boots your whole stack

```mermaid
flowchart TD
    seed["Seed through the front door<br>run marker in every record"]
    subgraph stack["Its own compose project, torn down after"]
        direction LR
        api["API"]
        db["Database"]
        worker["Worker"]
        browser["Real browser"]
    end
    probe["Probe each part"]
    drive["Drive the criteria"]
    verdict["Pass or fail"]
    cnr["Could not run"]

    seed --> stack --> probe
    probe -->|"part is up"| drive --> verdict
    probe -.->|"part is down"| cnr
```

<!-- 2:25
"Second thing. It doesn't test the code in isolation. Every run boots the whole
stack in its own compose project, so it never collides with my dev environment
or another run, and it tears it down afterwards, volumes and all."
"It seeds through the app's front door, and it weaves a marker unique to the
run into every record it creates, so a check that never actually ran can't
quietly pass."
Point at the dotted branch.
"Then it probes every part before judging anything. If the database is down,
those criteria come back as 'could not run'. They don't come back as my change
being broken. That distinction is the difference between a report I trust and
a flaky test suite I learn to ignore."
"Last night that meant a real Postgres, a real cloud sandbox, and a real model
running against a real repository. For the outage case it stood up a fake
provider that answers 529 to every call. I used to mock those parts, and the
failures just moved to staging."
-->

## It gives you the receipts

![A Verify report. The headline reads 4 of 5 proven, 1 failed, above a criterion card with its plain-language claim, its pass badges, and the two commands that ran with their exit codes](../../assets/report-receipts.png)

<!-- 3:05
"Third. A verdict you can't check is just another agent saying done. So every
criterion carries the commands that ran and what came back."
Point at the headline, then the badges, then the two commands.
"Four of five proven, one failed. Every claim in plain language, and underneath
it the actual commands, with exit codes."

SWITCH → report.html.
"And the one that failed is my favourite part."
Expand it. Read only the first sentence, flat:
"The expectation was built on a wrong premise, mine."
Paraphrase the rest: "It had assumed a feature worked one way. It works another
way. So instead of failing my code, it told me my criterion was wrong, and
showed me the log line that proves it."

Scroll to Not checked.
"And every report ends with what it did not check. This one noticed, without
being asked, that my plan and my code disagreed about how one failure gets
classified. This is the section I read first now."
-->

## Three things to steal

1. **Write the criteria from your spec, not the implementation.** Code that wrote its own test agrees with itself.
2. **Separate the part that thinks from the part that runs.** A model writes the plan. A deterministic engine executes it and records receipts. Nothing gets patched mid-run.
3. **Make a pass provable.** A marker unique to the run, woven into every record, so a check that never ran cannot quietly pass.

`github.com/opslane/verify`

<!-- 3:40
"Three things you can steal even if you never install this."
"One: write the criteria from your spec, not from the implementation. Code that
wrote its own test will always agree with itself."
"Two: separate the part that thinks from the part that runs. Let a model write
the plan, then let a boring engine execute it and keep the receipts. Nothing
gets patched halfway through a run."
"Three: make a pass provable. A marker unique to the run, woven into every
record it creates, so a check that never actually ran can't quietly pass."
"It's open source, and the run I just showed you is checked into the repo.
Thanks."
-->
