# The bottleneck moved

<!--
Windows, in alt-tab order: 1 this file · 2 examples/agent-fail-v2/criteria.md · 3 examples/agent-fail-v2/report.html (local file)
Budget: 2:30 spoken. Comments hold the words.
-->

**Abhishek · Opslane · `/verify`**

<!-- 0:00
"I'm Abhishek, I build Opslane. This isn't about that. It's about a skill I use to check my own work."
-->

## Writing code is solved. Trusting it isn't.

Spec with Claude → Codex builds → tests green → me clicking for an hour. Half of it isn't what I asked for.

<!-- 0:10
"Everyone's loop now. Tests pass, because Claude doesn't write tests that fail. Then I click for an hour and half of it isn't what I asked for."
-->

## Three things I got wrong

### 1. I wrote the checks from the diff.

They passed every time. The code had already told them what to expect.

**Now:** criteria come from the spec, before anyone looks at the code. Pre-registered intent. The judge never reads the source.

<!-- 0:30
"First mistake: I had it write acceptance criteria from the diff. They always passed. Of course. Now it reads the spec, writes plain claims from the intent, and stops for me to approve. It is not allowed to read the code to decide pass or fail."
SWITCH → criteria.md. Read AC3 aloud. "Nothing in there you couldn't observe from outside." SWITCH back.
-->

### 2. I mocked the expensive parts.

The failures moved to staging.

**Now:** one `docker compose`, every port an env var, real Postgres, real sandbox, real model. Twins only where the real thing can't be hit.

<!-- 1:15
"Second: I mocked the sandbox, the model, Slack. The failures just moved to staging. Now it boots the real stack. Last night: real E2B sandbox, real model on a real repo, and a fake provider answering 529 to everything."
-->

### 3. I never read the report.

A folder of logs is a green check with extra steps.

**Now:** one page. What held, what didn't, what it did not check.

<!-- 1:40
SWITCH → report.html.
"Third: the report was logs nobody read. Now it's one page. Four held, one didn't. Read what it wrote about the one." Read flat: "The expectation was built on a wrong premise, mine."
"It blamed its own assumption. And here, Not checked, unprompted: my plan says this failure is 'limit', my code says 'agent'. Nobody asked it to look. This is the section I read first now."
SWITCH back.
-->

## If you take one thing

> Tests written from the code can't fail. Write the criteria first. Keep the judge blind to the code.

`github.com/opslane/verify` · the run is in `examples/agent-fail-v2/`

<!-- 2:20
"Tests written from the code can't fail. Write the criteria first, keep the judge blind to the code. It's open source. Thanks."
-->
