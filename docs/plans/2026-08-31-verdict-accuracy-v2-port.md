# Verdict accuracy: the v2.5 port map

The design (`2026-08-31-verdict-accuracy-design.md`) was implemented once against a
stale checkout of this repo (the pre-2.0 bash pipeline) and then ported onto v2.5's
two-halves skill and TypeScript engine. This file records where each feature lives now.

| Feature | Where it landed |
| --- | --- |
| Setup contract + sniffer | `skills/verify-setup/SKILL.md`, `scripts/sniff.sh` |
| Throwaway env, rotation (keep 5) | `scripts/env.sh` (up/seed/down; run id from `.verify/current-run`) |
| Pipeline checks + taint | `scripts/precheck.sh` → `$RUN_DIR/precheck.json`; enforced in `verdict.ts applyTaint` via `report --precheck` and the `html` verb |
| Criteria schema | `criteria.ts`: `dependsOn` (parts) + `proof` (kind/detail), validated; rendered in the approval artifact |
| Proof-of-run | `verdict.ts`: `proofSeen` on results; proven = pass AND proof seen; "not proven" rendering |
| Headline eligibility | `verdict.ts headline()`: PASS only when all proven; could-not-run never disappears; violation poisons the line |
| Reviewed seed script | half one step 6 writes `$RUN_DIR/seed.sh`, shown at approval; half two runs it with the marker |
| Second opinion | `scripts/review.sh` + `scripts/prompts/reviewer.txt`, v2.5 vocabulary (intent/baseline/witness/dependsOn/proof) |
| Compare against base | `scripts/compare.sh up/down` — environment plumbing only; the skill drives criteria in the worktree; external mode refused |
| Visual report | `html.ts` + the `html` CLI verb; served locally per the skill's report section |
| Clean-repo check | skill half two: diff + untracked hashes before/after; flag file read by the `html` verb |
| Codify | skill closing section, driven by `review.json`'s `codify` flags |

Decisions that override anything older: run history keeps the newest 5; the report is
a locally served page (no cloud artifact); a clean-repo violation is a poisoned
headline plus non-zero exit, not just a banner; seeding is a reviewed script, never a
live agent; `unknown` probe results never taint (fails on unknown-depending criteria
are flagged "may be environmental" instead); one verify run per repo at a time.
