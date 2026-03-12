# Human-in-the-Loop Browser Agent — Design

**Date:** 2026-03-12
**Status:** Exploration / future planning

## Problem

Autonomous browser agents (Playwright MCP, Vercel Agent Browser) run non-interactively.
When they hit a point requiring human judgment — OAuth consent screens, CAPTCHAs, 2FA
prompts, unexpected modals — the agent is stuck with no way to ask for help. The run
either times out or fails.

This is an architectural gap: current agent frameworks treat the browser as owned by the
agent process, making it impossible to inject a human mid-run.

## Current State

| Framework | How it sees | Can click OAuth "Authorize"? | Can hand off to human? |
|-----------|-------------|------------------------------|------------------------|
| Playwright MCP | DOM snapshots / accessibility tree | Maybe (if button has identifiable selector) | No |
| Vercel Agent Browser | Screenshots (pixels) | Likely (sees button visually) | No |
| Playwright codegen | Human-driven | Yes (human clicks) | N/A — fully manual |

The `/verify` pipeline hit this exact problem: AC2 (GitHub OAuth flow) and AC4 (App
install page) failed because the agent reached GitHub's consent screen and couldn't
proceed. The auth cookies from `/verify-setup` were present, but GitHub still showed
the consent screen requiring an explicit "Authorize" click.

## Core Insight

**Don't embed the browser in the agent process.** Keep the browser as a separate
long-lived service that both agents and humans connect to. Turn-taking becomes a
mutex with notifications.

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Agent SDK  │────▶│  Browser Server   │◀────│  Human UI   │
│  (Claude)   │     │  (Playwright CDP) │     │  (noVNC/web)│
└──────┬──────┘     └──────────────────┘     └──────┬──────┘
       │                                             │
       └──────────── Control Plane ──────────────────┘
                     (who has the turn?)
```

### Three Components

**1. Shared browser via CDP (Chrome DevTools Protocol)**

Browser runs as a long-lived process, not embedded in the agent. Both the agent and
the human connect to the same browser via CDP:
- Agent: `browserType.connectOverCDP()` (Playwright supports this natively)
- Human: web-based viewer (noVNC, or a page that streams the browser tab)

**2. Control plane (the new part)**

A lightweight state machine managing turn-taking:

```
AGENT_ACTIVE ──yield(reason)──▶ HUMAN_ACTIVE ──resume()──▶ AGENT_ACTIVE
     │                              │
     └── observe/decide/act         └── human sees live browser,
         loop runs normally              interacts directly
```

When the agent calls `yield("OAuth consent screen — please click Authorize")`:
- Agent loop pauses (keeps LLM context)
- Control plane notifies the human (webhook, Slack, push notification, terminal bell)
- Human sees the live browser, does their thing
- Human clicks "Resume" in the UI
- Agent takes a fresh screenshot, re-orients, continues

**3. Human notification channel**

Options in order of complexity:
- **Terminal**: print URL to live browser view, wait for Enter
- **Web dashboard**: show browser stream + "Resume" button
- **Slack/push**: "Agent needs help — click here to take over"

## Primitives

```
Agent Loop
  ├── observe (screenshot / DOM snapshot)
  ├── decide (LLM call)
  ├── act (click, type, navigate)
  └── yield(reason)        ← NEW: hand control to human

Human Loop
  ├── see (live browser stream)
  ├── interact (mouse/keyboard forwarded to browser)
  └── resume(context?)     ← signal agent to take back control
```

## Minimal Local Version

For the `/verify` pipeline, the minimal version is surprisingly simple:

```typescript
async function agentLoop(page: Page, task: Task) {
  while (!task.done) {
    const screenshot = await page.screenshot();
    const action = await claude.decide(screenshot, task);

    if (action.type === 'yield') {
      console.log(`⏸ Agent paused: ${action.reason}`);
      console.log(`  Browser: http://localhost:9222`);  // CDP debug URL
      await waitForHumanResume();  // blocks until human signals
      continue;  // re-observe after human is done
    }

    await executeAction(page, action);
  }
}
```

`waitForHumanResume()` could be:
- File watch: `touch .verify/resume` to continue
- WebSocket message from a tiny web UI
- Reading stdin in interactive mode (simplest for local dev)

## Hard Problems at Scale (Cloud-Hosted)

1. **Browser streaming latency** — noVNC adds 100-200ms (sluggish). WebRTC is
   better but more complex to set up.

2. **Human availability** — agent might yield at 3am. Need queueing, timeouts,
   and fallback (skip step after N minutes, or retry without human).

3. **Context preservation** — if the human takes 10+ minutes, the agent's LLM
   context might expire. Need to re-hydrate from screenshots + action log.

4. **Multi-tenant routing** — multiple agents yielding to multiple humans
   simultaneously. Need session routing and assignment.

5. **Security** — sharing a browser session means the human sees whatever the
   agent sees (cookies, tokens, page content). Fine for local dev, needs
   access control for multi-user cloud.

## Possible Implementation Phases

### Phase 1: Local stdin-based (for /verify)
- Agent writes "⏸ Need human help: {reason}" to stdout
- Human interacts with the browser directly (headed mode)
- Human presses Enter in terminal to resume
- No infrastructure needed — just a flag in `agent.sh`

### Phase 2: Web-based handoff (for teams)
- Browser runs in a Docker container with VNC
- Small web UI shows browser stream + "Resume" button
- Agent posts to a webhook when yielding
- Control plane tracks sessions

### Phase 3: Cloud-native (for SaaS)
- Browser pool (Browserbase, AWS browser instances)
- WebRTC streaming for low-latency human interaction
- Queue system for human handoff requests
- Timeout + fallback policies

## Open Questions

- Should the agent detect *when* to yield automatically (e.g., "I see a CAPTCHA")
  or should yield points be declared in the plan?
- Should the human be able to give the agent instructions when resuming
  (e.g., "I clicked Authorize, now you should see a redirect")?
- Can we avoid the problem entirely for OAuth by using machine tokens or
  pre-authorized sessions?
- What's the right timeout before giving up on human input?
