# Eval Set v1 — 10 Frontend PRs

Three open-source Next.js repos, 10 merged PRs with clear frontend acceptance criteria.

## Repos

| Repo | Stars | Stack |
|------|-------|-------|
| [calcom/cal.com](https://github.com/calcom/cal.com) | 40K | Next.js + Tailwind |
| [formbricks/formbricks](https://github.com/formbricks/formbricks) | 12K | Next.js + Tailwind |
| [documenso/documenso](https://github.com/documenso/documenso) | 12K | Next.js + Tailwind |

## How to Run an Eval

For each eval item you clone the repo at the PR's **merge commit**, start the dev server, and run `/verify` with the spec from this repo.

```bash
# 1. Clone the target repo
git clone https://github.com/calcom/cal.com /tmp/calcom

# 2. Check out the merge commit of the PR
cd /tmp/calcom
gh pr checkout 28011

# 3. Install dependencies and start dev server
pnpm install
cp .env.example .env  # fill in required env vars
pnpm dx               # or pnpm dev — see repo README

# 4. Copy the spec into the project
cp /path/to/opslane-v3/docs/evals/calcom/pr-28011-spec.md docs/plans/eval-spec.md

# 5. Run /verify from inside the cloned repo
# (requires Claude Code CLI authenticated)
cd /tmp/calcom
/verify
```

The verify pipeline will:
1. Auto-detect the spec doc
2. Extract acceptance criteria (Planner stage)
3. Run browser agents against the local dev server
4. Judge evidence and print pass/fail per AC

## Expected Outcome

All 10 PRs are **merged** — their changes are live on main. Running `/verify` at the PR merge commit should return `pass` for all ACs.

You can also test the **failure case**: checkout the PR's *base commit* (before the change), run `/verify`, and expect the ACs to fail. This validates that the pipeline actually detects regressions.

```bash
# Failure case — checkout base before the PR was applied
git checkout $(gh pr view 28011 --json baseRefOid -q .baseRefOid)
# Then run /verify — ACs should fail
```

## Eval Index

| ID | Repo | PR | Title | Complexity |
|----|------|----|-------|-----------|
| eval-001 | cal.com | [#28011](https://github.com/calcom/cal.com/pull/28011) | Nav hover width fix | low |
| eval-002 | cal.com | [#27983](https://github.com/calcom/cal.com/pull/27983) | Dropdown chevron sync | low |
| eval-003 | cal.com | [#27965](https://github.com/calcom/cal.com/pull/27965) | Mobile banner hidden | low |
| eval-004 | formbricks | [#7422](https://github.com/formbricks/formbricks/pull/7422) | Feedback records table | medium |
| eval-005 | formbricks | [#7399](https://github.com/formbricks/formbricks/pull/7399) | AI toggle in settings | low |
| eval-006 | formbricks | [#7392](https://github.com/formbricks/formbricks/pull/7392) | Workflows in nav | low |
| eval-007 | formbricks | [#7387](https://github.com/formbricks/formbricks/pull/7387) | Theme preview open text | medium |
| eval-008 | documenso | [#2541](https://github.com/documenso/documenso/pull/2541) | Collapsible sidebar | medium |
| eval-009 | documenso | [#2506](https://github.com/documenso/documenso/pull/2506) | Button width fix | low |
| eval-010 | documenso | [#2519](https://github.com/documenso/documenso/pull/2519) | Per-recipient expiration | high |

## Setup Notes by Repo

### Cal.com
```bash
git clone https://github.com/calcom/cal.com
cd cal.com
pnpm install
cp .env.example .env
# Edit .env: set NEXTAUTH_SECRET, DATABASE_URL (postgres), etc.
pnpm dx  # runs docker postgres + next dev
```

### Formbricks
```bash
git clone https://github.com/formbricks/formbricks
cd formbricks
pnpm install
cp .env.example apps/web/.env
# Edit .env: DATABASE_URL, NEXTAUTH_SECRET, etc.
docker-compose -f docker-compose.dev.yml up -d  # postgres + redis
pnpm dev
```

### Documenso
```bash
git clone https://github.com/documenso/documenso
cd documenso
pnpm install
cp .env.example .env
# Edit .env: DATABASE_URL, NEXTAUTH_SECRET, etc.
pnpm dx  # runs docker postgres + next dev
```
