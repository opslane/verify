# Browse Agent Evals V1

This directory contains the deterministic, browse-only eval baseline for the browse agent.

V1 is intentionally narrow:
- one AC per case
- no judge stage
- no learner stage
- no real browser daemon
- no live dev server

Each case has three files:
- `plan.json` - the single planned AC in the existing planner shape
- `browse-script.json` - scripted command responses for the fake browse CLI
- `expected.json` - scoring assertions for the eval runner

Expected file shape:

```json
{
  "ac_id": "ac1",
  "expect_parseable_result": true,
  "expect_result_kind": "normal",
  "required_commands": ["goto", "snapshot", "hover", "screenshot"],
  "required_evidence_substrings": ["Tooltip: 14 days left in your trial"],
  "forbidden_shell_patterns": ["rg ", "grep ", "find ", "git ", "ls "],
  "required_observed_substrings": ["tooltip", "days left"],
  "forbidden_observed_substrings": ["login", "error"],
  "max_command_count": 6,
  "max_duration_ms": 20000
}
```

Initial cases:
- `tooltip-hover-success`
- `tooltip-hover-timeout`
- `dialog-css-required`
- `keyboard-nav`
- `wait-for-data`
- `auth-redirect`

The goal of this suite is to establish a fast local baseline before any browse-agent hardening work lands.

Current baseline:
- `v1-baseline.json` records the first measured run before browse hardening.
- The current recorded baseline is `1/6` passing with a `20.4s` median duration.
- The only passing case is `tooltip-hover-success`.
- The current failures cluster around slow interaction paths and incorrect failure reporting.

Current best hardening run:
- `2026-03-22-hardening-pass-1.json` records the first hardened browse-agent run.
- That run passed `6/6` cases with a `12.3s` median duration and `0` timeout-like failures.

Gate for future browse-agent changes:
- A browse-agent hardening change only counts as an improvement if `npm run eval:browse`
  increases the total pass count or reduces the median duration without introducing a
  new regression in an already-passing case.

Deferred for v2:
- real DOM harness app
- frozen real-repo cases
- judge-in-the-loop evaluation
- cross-run trend dashboard
