# Verify Pipeline v2: gstack Browse Integration

**Date:** 2026-03-15
**Status:** Design
**Goal:** Make `/verify` reliable enough to be a habitual pre-push gate for frontend changes.

## Problem

The v1 proof-of-concept works end-to-end but has three issues blocking regular use:

1. **Auth/state setup is the #1 failure point.** Automating login flows breaks on 2FA, CAPTCHA, SSO redirects, and session token formats. If setup fails, nothing downstream runs.
2. **Not enough reps yet.** The pipeline needs to be easy and reliable enough to run repeatedly so we can surface the next layer of failure patterns.
3. **Frontend-only scope.** Needs to grow toward full E2E (API, data mutations, multi-page flows) — but only after the foundation is solid.

## Key Insight from gstack

[gstack](https://github.com/garrytan/gstack) is Garry Tan's Claude Code workflow toolkit. Its browser component solves problems we're hitting:

- **Persistent browser daemon** — Chromium runs as a long-lived localhost HTTP server. First call ~3s, subsequent calls ~100ms. Cookies, tabs, and login sessions persist between commands.
- **CLI over MCP** — Plain bash commands (`$B goto`, `$B click @e3`) instead of MCP tool calls. Zero schema overhead. A 20-command session that burns 30-40K tokens on MCP framing costs ~0 tokens with the CLI.
- **Cookie import from real browsers** — Instead of automating login, import cookies from Chrome/Arc/Edge. The developer is already logged in — just reuse that state.
- **Ref-based element selection** — `@e1`, `@e2` refs from the accessibility tree instead of brittle CSS selectors. No DOM mutation needed.
- **Snapshot diffs** — `snapshot -D` shows a unified diff of what changed in the accessibility tree after an action. Concrete before/after evidence.

## Design

### Three Changes

1. **gstack browse binary** for persistent browser interaction
2. **Cookie import** from developer's real browser for auth
3. **Agent prompts rewritten** for `$B` CLI commands instead of Playwright MCP

### What's NOT Changing

- Planner logic (AC extraction, clarifying questions)
- Report format
- Server/SaaS pipeline (this is local-first)
- Scope (frontend-focused; API/backend testing comes after this is solid)

---

## 1. gstack Browse Binary

We vendor only the compiled browse binary (~58MB). Not the full gstack skill suite — no QA, ship, review, retro skills.

### File Layout

```
~/.cache/verify/
├── browse               # gstack compiled binary (global, shared across projects)
└── browse.version       # pinned version string

.verify/
├── config.json          # existing
├── browse.json          # daemon state (pid, port, token) — written by daemon
├── plan.json            # existing
├── spec.md              # existing
└── evidence/            # existing
```

### Acquisition

Pin to a specific gstack release. Download the pre-compiled binary from gstack GitHub releases on first run. Cache globally at `~/.cache/verify/browse` (avoids redundant ~58MB downloads per project).

```bash
GSTACK_VERSION="v1.1.0"  # pin this
BROWSE_BIN="$HOME/.cache/verify/browse"
if [ ! -x "$BROWSE_BIN" ] || [ "$(cat ~/.cache/verify/browse.version 2>/dev/null)" != "$GSTACK_VERSION" ]; then
  mkdir -p ~/.cache/verify
  # download from gstack releases for current platform
  curl -fsSL "https://github.com/garrytan/gstack/releases/download/$GSTACK_VERSION/browse-$(uname -s)-$(uname -m)" -o "$BROWSE_BIN"
  chmod +x "$BROWSE_BIN"
  echo "$GSTACK_VERSION" > ~/.cache/verify/browse.version
fi
```

Fallback: if no pre-compiled binary exists for the platform, build from source (requires Bun).

The daemon auto-starts on first call and auto-stops after 30 min idle. State file (`.verify/browse.json`) tracks pid, port, bearer token.

### Rollback

Environment variable `VERIFY_ENGINE=browse|mcp` selects the execution engine. Default: `browse`. Set `VERIFY_ENGINE=mcp` to fall back to the v1 Playwright MCP approach. This toggle affects `agent.sh` and `preflight.sh` only — planner, judge prompt format, and report are engine-agnostic.

### Why the Binary, Not MCP

| | Playwright MCP | gstack browse |
|---|---|---|
| First call | ~3-5s | ~3s |
| Subsequent calls | ~1-3s | ~100-200ms |
| Token overhead per call | ~1500 (JSON schema) | 0 (plain text stdout) |
| 20-command session overhead | ~30,000 tokens | ~0 tokens |
| State persistence | None (fresh per session) | Full (cookies, tabs, localStorage) |
| Auth | Must automate login each time | Import once, persists |

---

## 2. Cookie Import for Auth

### Current Approach (v1)

`/verify-setup` launches interactive Playwright, user logs in manually, session state saved to `.verify/auth.json`. Fragile — breaks on 2FA, CAPTCHA, SSO, and session expiry.

### New Approach (v2)

Import cookies directly from the developer's real browser. gstack's `cookie-import-browser` command reads Chromium's SQLite cookie database, decrypts via macOS Keychain, and loads cookies into the Playwright context.

### New `/verify-setup` Flow

```
/verify-setup
→ "Which browser are you logged in with? (Chrome / Arc / Edge)"
→ "What domain? (e.g. localhost:3000)"
→ $B cookie-import-browser chrome --domain localhost:3000
→ $B goto http://localhost:3000
→ $B snapshot -i
→ "I can see the dashboard. Auth is working."
```

First cookie import per browser triggers a macOS Keychain dialog (user must click Allow). Cookies are decrypted in-memory, never written to disk in plaintext.

### Auth Validation (replaces preflight.sh auth check)

v1's `preflight.sh` validates auth by reading `.verify/auth.json` and curling the auth check URL. With cookie import, cookies live inside the browse daemon's Playwright context — no `.verify/auth.json` file exists.

New auth validation:
```bash
$BROWSE goto "$VERIFY_BASE_URL"
SNAPSHOT=$($BROWSE snapshot -i)
# Check if we're on a login/redirect page vs the actual app
if echo "$SNAPSHOT" | grep -qi "login\|sign.in\|password"; then
  echo "✗ Auth cookies expired or invalid. Re-run /verify-setup."
  exit 1
fi
echo "✓ Auth valid"
```

### Limitations

- **macOS only** (Keychain decryption). Linux/Windows support is possible but not implemented in gstack. The cloud/SaaS pipeline (`server/src/unified/pipeline.ts`) will need a different auth strategy — likely env-var session tokens injected via `$BROWSE header` or `$BROWSE cookie`. This is explicitly out of scope for v2.
- **Cookie-based auth only.** Token-based auth (Bearer headers) would need `$BROWSE header Authorization:Bearer <token>` — add later if needed.

---

## 3. Agent Prompt Rewrite

### Current Agent Prompt (v1 — Playwright MCP)

```
You have access to Playwright MCP tools. Navigate to {url}, find the element
matching {description}, verify that {expected behavior}. Take a screenshot.
```

Open-ended — the agent can use any MCP tool, wander, retry indefinitely.

### New Agent Prompt (v2 — browse CLI commands)

The browse binary path is injected as a literal string in the prompt by `agent.sh`. No shell variable expansion needed — the agent sees the actual path and uses it in bash commands.

```
You are verifying: {ac_description}

Browser is ready at {base_url}. Auth cookies are loaded.
Browse binary: {browse_binary_path}

Run browser commands via bash. Each command returns plain text to stdout.

Steps:
1. {browse_binary_path} goto {start_url}
2. {browse_binary_path} snapshot -i              # find interactive elements
3. Locate the element for: {target_description}
4. Interact and verify using snapshot -D          # diff confirms state change
5. {browse_binary_path} screenshot .verify/evidence/{ac_id}/result.png
6. Write finding to .verify/evidence/{ac_id}/result.json

Evidence JSON format:
{
  "ac_id": "{ac_id}",
  "result": "pass|fail",
  "expected": "what the AC says should happen",
  "observed": "what actually happened (include snapshot diff)",
  "screenshots": ["before.png", "after.png"],
  "commands_run": ["goto ...", "snapshot -i", "click @e3", ...]
}
```

### How `agent.sh` Changes

v1 launches `claude -p` with `--mcp-config` pointing to a Playwright MCP server config. The agent uses structured MCP tool calls.

v2 launches `claude -p` with `--dangerouslySkipPermissions` (already required). No `--mcp-config`. The agent uses the Bash tool to run browse CLI commands. The browse binary path is interpolated directly into the prompt template by `agent.sh`:

```bash
# v1 (removed)
claude -p "$PROMPT" --mcp-config "$MCP_CONFIG_FILE" --dangerouslySkipPermissions

# v2
BROWSE_BIN="$HOME/.cache/verify/browse"
PROMPT=$(sed "s|{browse_binary_path}|$BROWSE_BIN|g" "$PROMPT_TEMPLATE")
claude -p "$PROMPT" --dangerouslySkipPermissions
```

### Key Differences

- **Constrained action space** — only browse CLI commands via Bash, not arbitrary Playwright API calls
- **Plain text output** — each command returns text, not JSON schema blobs
- **Snapshot diffs as evidence** — `snapshot -D` gives concrete before/after proof
- **Ref-based selection** — `click @e3` not `click .css-selector-that-might-change`
- **Structured evidence** — each agent writes `result.json` with a fixed schema
- **No MCP config** — drops `--mcp-config` entirely; browse daemon manages its own Chromium lifecycle

### Concurrency Model

Sequential, foreground execution. The browser daemon handles one page at a time (single active tab). AC checks run one after another. The SKILL.md Stage 2 runs orchestrate.sh in the foreground (not background with polling — that was unnecessary overhead).

This is fine because:
- Eliminates race conditions between agents
- Browser state is predictable
- Each check is ~10-20s with persistent daemon (vs ~30-60s with cold-start MCP)
- Total time for 5 ACs: ~1-2 min (vs ~3-5 min today)

If speed becomes a bottleneck, gstack supports multiple tabs (`$B newtab`) but that's premature.

### Tradeoff: Video Recording

v1 captures session videos (`.webm`) and traces via Playwright MCP's `--save-video` and `--save-trace` flags. gstack browse does not support video recording. This capability is lost in v2.

Mitigation: screenshots + snapshot diffs + `commands_run` log provide equivalent debugging value for verification purposes. Annotated screenshots (`snapshot -i -a -o`) with ref labels are arguably more useful than video for understanding what the agent saw. If video becomes critical, Playwright MCP remains available via `VERIFY_ENGINE=mcp`.

---

## 4. Judge & Evidence

### Current Judge (v1)

`judge.sh` reads `agent.log` files and embeds screenshots. Must parse what the agent did from free-form text.

### New Judge (v2)

`judge.sh` reads structured `result.json` per AC, plus snapshot diffs and screenshots.

Changes to `judge.sh`:
- Read `result.json` instead of `agent.log` for each AC evidence directory
- Include snapshot diffs as text evidence alongside screenshots
- Handle missing/malformed `result.json` (agent crashed before writing) — treat as `inconclusive`
- Fall back to `agent.log` parsing if `result.json` is absent (graceful degradation)

Judge prompt:
```
For each AC, you have:
- The spec requirement
- The agent's result.json (expected, observed, screenshots, commands run)
- Snapshot diffs showing what changed in the accessibility tree

Confirm or override the agent's assessment.
Override only when the evidence contradicts the agent's claim.

Output per AC:
{
  "ac_id": "ac1",
  "agent_said": "pass",
  "judge_says": "pass",
  "reasoning": "Snapshot diff confirms modal appeared with expected text"
}
```

Snapshot diffs are the key improvement — the judge gets concrete tree-level evidence, not just "the agent said it saw a modal."

**Note:** Accessibility tree diffs can be noisy (focus changes, ARIA live regions, scroll position). Empirical validation with real apps is needed to determine if the diffs are clean enough to serve as primary evidence, or if they need filtering.

---

## 5. Revised Pipeline Stages

```
/verify
  Turn 1: Spec intake                              (unchanged)
  Turn 2: Preflight                                (changed)
    → Check browse binary exists at ~/.cache/verify/browse
    → Start daemon if not running (browse status)
    → Validate auth via browse goto + snapshot (replaces auth.json check)
    → Check dev server reachable (unchanged)
  Turn 3: Spec interpreter                          (unchanged)
  Turn 4: Clarification loop                        (unchanged)
  Turn 5: Plan + setup
    → Cookie import if not done (browse cookie-import-browser)
    → Data seeding (curl commands against app API)
    → Confirm with user
  Stage 2: Sequential AC checks (foreground)        (changed — browse CLI, not MCP)
    → orchestrate.sh runs in foreground, not background
    → Each agent gets browse binary path in prompt
    → No --mcp-config, agents use Bash tool
  Stage 3: Judge reviews structured evidence        (changed — reads result.json)
  Report                                            (unchanged)
```

---

## 6. Useful $B Commands for Verify Agents

Subset of gstack's 50+ commands that verify agents need:

| Command | Purpose |
|---------|---------|
| `$B goto <url>` | Navigate to page |
| `$B snapshot -i` | List interactive elements with @e refs |
| `$B snapshot -D` | Diff against previous snapshot (verify action worked) |
| `$B snapshot -i -a -o <path>` | Annotated screenshot with ref labels |
| `$B click @e3` | Click element by ref |
| `$B fill @e4 "value"` | Fill input by ref |
| `$B select @e5 "option"` | Select dropdown option |
| `$B is visible ".selector"` | Assert element visibility |
| `$B is enabled "#button"` | Assert element enabled |
| `$B text` | Get page text content |
| `$B console --errors` | Check for JS errors |
| `$B screenshot <path>` | Save screenshot |
| `$B js "expression"` | Run JS expression (for API calls, state checks) |
| `$B cookie-import-browser <browser> --domain <d>` | Import auth cookies |
| `$B status` | Health check daemon |

---

## Implementation Sequence

1. **Browse binary acquisition** — download/build script, add to `/verify-setup`
2. **Cookie import flow** — rewrite `/verify-setup` to use `$B cookie-import-browser`
3. **Agent prompt rewrite** — update `scripts/prompts/agent.md` for `$B` commands
4. **Evidence schema** — define `result.json` format, update agent prompt to write it
5. **Judge prompt rewrite** — update `scripts/prompts/judge.md` to read structured evidence
6. **Preflight update** — check for browse binary, daemon status
7. **Orchestrator update** — sequential execution, pass `$B` path to agents
8. **Test on real app** — run against a real frontend to surface next failure patterns

## Decisions (resolved from review)

- **Binary distribution:** Download from gstack GitHub releases. Cache globally at `~/.cache/verify/browse`.
- **gstack versioning:** Pin to a specific release tag. Update explicitly.
- **Rollback:** `VERIFY_ENGINE=browse|mcp` env var toggles between v2 and v1 execution.
- **Video recording:** Lost in v2. Screenshots + snapshot diffs + command logs replace it. Playwright MCP available via `VERIFY_ENGINE=mcp` if video is needed.

## Open Questions

- **Linux support:** Cookie import is macOS-only. Cloud pipeline will need env-var session tokens — out of scope for v2.
- **Bun dependency:** Only needed if building from source. Pre-compiled binary is the default path.
- **gstack release availability:** Need to verify gstack publishes pre-compiled binaries per platform. If not, we may need to build and self-host.

## References

- [gstack repo](https://github.com/garrytan/gstack)
- [gstack ARCHITECTURE.md](https://github.com/garrytan/gstack/blob/main/ARCHITECTURE.md) — persistent daemon design, ref system, security model
- [gstack BROWSER.md](https://github.com/garrytan/gstack/blob/main/BROWSER.md) — command reference, snapshot system
- Current verify design: `docs/plans/2026-03-08-verify-implementation.md`
