# What it can test

Verify drives whatever the change touches, from the outside, the way a user or a client would. This page says how it drives each kind of surface and what each one needs from you. Setup collects most of it once per repository.

| Change touches | How Verify drives it | What it needs from you |
|----------------|----------------------|------------------------|
| An HTTP API | Calls the real route through the public auth path and checks the side effect, not only the status code. | The base URL, and if requests need auth, the header name and the env var that holds the value. |
| A database | Diffs the affected rows before and after. A migration is tested in the direction the plan claims, not assumed reversible. | The name of the env var that holds the connection string. |
| A CLI | Runs the real binary. The exit code and the output shape are checked separately. | Nothing beyond the binary being buildable. |
| A queue, webhook, or background job | Fires the trigger and waits on the effect with a deadline and a correlation id. A local sink, a small endpoint that receives what the app sends, proves the app emitted the event. The report says whether delivery to the real destination was also proven. | A one-line command that proves the worker or sink is alive. |
| A web UI | Drives a real browser through Playwright, interacts the way the criterion describes, and screenshots at the moment of observation. Fetching the HTML with curl is never counted as a UI check. | If the app needs login, one login by you. |

## Login

Setup opens a browser through Playwright. You log in, close the window, and the session cookies are saved to `.verify/auth.json`. Verify never sees your password. The file is gitignored, and deleting it revokes the session. A per-repo store under `~/.verify/` lets your other worktrees inherit it.

## Arriving at state

Verify does not plant state to reach a page. It does not set a cookie or local storage and then load the page it cares about. It arrives there the way a user would, because the bugs that survive unit tests live in the transitions. What a page does on its first render, before its data resolves, on the way in from somewhere else, is where they sit.

At least one criterion per run walks a real path end to end in one browser session: land on the first page, click through, observe on the last one.

## Proof that a check ran

Every criterion names how a reader will know it actually ran. Verify weaves a marker unique to the run into every record it creates. A row in the database or a payload at the sink that carries the marker proves the check happened in this run and not an earlier one. For a refusal, the proof is the rejection paired with the marked request. For a read, it is a value read live during the run rather than a stale capture. A status code alone, or the absence of an error, is never proof.

## What it will not do

It never edits the code it is judging. Writing to a shared or staging system needs your yes first, with the exact mutation described. Provisioning anything that costs money needs your yes first. If a criterion is drivable but expensive, because it needs a failure induced, a long job, or a service stood up that nothing else needs, Verify says what it would take and lets you decide. It does not skip on your behalf, and a skipped criterion is reported as "could not run", never as a pass.
