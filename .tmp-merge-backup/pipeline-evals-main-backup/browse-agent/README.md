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
