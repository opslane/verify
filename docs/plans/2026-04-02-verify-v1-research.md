# Verify V1 Research Notes

**Date:** 2026-04-02
**Status:** Decisions made, implementation in progress
**Scope:** Simplify `/verify` into a more reliable local frontend verification workflow

## Goal

Make `/verify` much simpler and more reliable by focusing only on frontend verification, while preserving the best parts of the current product:

- use a local plan/spec as the source of truth
- verify against the running app
- collect strong evidence
- keep the user in the loop for ambiguity and missing state

---

## Decisions Made (CEO + Eng Review, 2026-04-02)

### Architecture: 2-stage pipeline
- **Stage 1: AC Extractor** (opus) — parse spec into structured ACs, classify will_verify / needs_clarification / out_of_scope
- **Stage 2: Executor** (sonnet, per AC) — self-navigating, self-judging browser agent
- **Report:** terminal summary + HTML evidence report

### What was removed
- Planner stage (was failing on dynamic URL resolution)
- Setup-writer (biggest reliability sink — schema parsing, seed IDs, SQL generation)
- Judge stage (merged into executor)
- Learner stage (self-poisoning issues)
- Parallel AC execution (simplified to sequential)
- App indexing as a /verify prerequisite

### What was added
- HTML evidence report with embedded screenshots
- Structured blocker summary in terminal output
- Diff-guided route hints for executor navigation
- Smart spec auto-discovery in SKILL.md
- Navigation budget constraint (max 10 browse commands per AC)

### Target user
Developer with a running dev server, basic seed data, and authenticated session (`/verify-setup` done).

### Spikes completed
- **Executor prompt:** 3/3 ACs passed on Documenso (tabs, filter, navigation)
- **Diff hints:** Reduced navigation steps by ~40% vs no hints
- **E2E runs:** 2 full pipeline runs on Documenso. Simple UI checks: 2/3 pass. Complex navigation: 3/4 timeout (addressed by nav budget).

---

## Execution Architecture Direction

### Current model (v1 shipped)
```
orchestrator → claude -p per AC → browse CLI → result
```
- One subprocess per AC, 90s timeout
- No state between ACs, cold-start overhead per AC
- Black-box execution (no streaming)

### Next step: Single-session model
```
orchestrator → one claude -p for all ACs → browse CLI → results streamed
```
- One subprocess processes all ACs sequentially
- State preserved between ACs (learned nav patterns, URL structure)
- No cold-start waste (~5-10s saved per AC)
- Still black-box but much faster

### Future: Agent SDK + browse binary
```
orchestrator → Agent SDK stream → browse CLI (via Bash tool) → real-time updates
```
- Streaming visibility into agent progress
- Can abort/redirect mid-execution
- State preserved naturally
- One new dependency (Agent SDK)

### Long-term: Agent SDK + Playwright MCP
```
orchestrator → Agent SDK stream → Playwright MCP → structured tool calls
```
- Structured browser responses (not text parsing)
- Full MCP ecosystem benefits
- Two new dependencies (Agent SDK + MCP server)

### Why this order
1. Single-session fixes the biggest pain (cold starts + state loss) with zero new dependencies
2. Agent SDK adds streaming/monitoring when we need it
3. Playwright MCP replaces the browse binary if/when structured responses matter

### Alternatives considered and rejected
- **Vercel agent-browser:** Too new, unclear screenshot/evidence support
- **Inline in SKILL.md (like /qa):** Works for local but breaks CI
- **Computer use:** Ruled out for v1, too unpredictable

---

## Comparison: /verify vs Expect vs gstack /qa

| | /verify v1 | Expect | gstack /qa |
|---|---|---|---|
| LLM invocation | claude -p subprocess | Agent SDK stream | Claude Code session |
| Browser tool | browse CLI binary | Playwright MCP | browse CLI binary |
| Per-AC model | 1 subprocess per AC | 1 stream per feature | free exploration |
| Observability | stdout after finish | real-time streaming | real-time (same session) |
| Recovery | nav budget + timeout | grace period | self-regulation |
| State between ACs | lost | preserved | preserved |
| CI support | yes | yes | no |

### Key Expect architecture details (from source review)
- `ALL_STEPS_TERMINAL_GRACE_MS`: 120s grace after all steps complete
- `EXECUTION_CONTEXT_FILE_LIMIT`: 12 files max in diff context
- `EXECUTION_RECENT_COMMIT_LIMIT`: 5 commits max
- Supervisor monitors agent stream via Effect-TS, synthesizes run-finish if grace expires
- Adversarial test instructions (not step lists) — "Submit empty, invalid, and correct credentials" not "click login button"
- Monorepo: packages/supervisor (orchestration), packages/agent (LLM), packages/browser (Playwright)

### Key /qa architecture details (from skill review)
- Phase-based execution (Orient → Explore → Document → Triage → Fix)
- Self-regulation checkpoint: if WTF (wasted failed attempts) > 20%, stop and escalate
- Evidence: before/after screenshot pairs per issue
- No per-step timeout — single Claude Code session duration
- browse binary shared with /verify (same `$B` commands)

---

## Open questions

- Exact normalized AC schema fields for v1
- Whether to support targeted session resets between ACs
- Exact bounded retry behavior in single-session model
- HTML report layout refinements based on user feedback
- When to trigger Agent SDK migration (after N successful single-session runs?)
