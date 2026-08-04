## Project
opslane-verify — a Claude Code plugin that verifies a change works. It turns the change's
plan into acceptance criteria, stops for approval, then drives the real system and reports
what it observed.

## Architecture
```
skills/verify/SKILL.md   the workflow. Claude is the control loop.
pipeline/                the engine. Three CLI verbs over three pure modules.
```

The skill decides what to check and judges the result. The engine only does plumbing that
would be silly to do in markdown:

- `criteria`      renders the approval artifact from JSON
- `report`        renders the four-axis report from JSON
- `changed-files` lists behaviour-bearing changed files, and coverage gaps given claims

Run artifacts land in the target repository under `.verify/runs/<id>/` and are gitignored
there. The engine holds no state.

## Boundaries
The skill never fixes what it judges. It never derives acceptance criteria from the diff
alone. It never reads source to decide pass or fail — a criterion that cannot be checked
without reading code is the wrong criterion.

## Skill sync
`skills/` is the source of truth. A `PostToolUse` hook (`.claude/hooks/sync-skill.sh`)
copies the skill to `~/.claude/skills/` after every Write or Edit. Never edit the copy
under `~/.claude/` directly.

Note: an installed plugin resolves the engine through `CLAUDE_PLUGIN_ROOT`. Set
`VERIFY_PIPELINE` only when running from a development checkout.

## Engine work
```
cd pipeline && npm ci
npm test          # vitest
npm run typecheck # tsc --noEmit, expected clean
```
The three lib modules are pure functions over plain data. Keep them that way: everything
that touches the filesystem, git, or the network lives in `cli.ts`.
