## Stack
- TypeScript 5, Node 22 ESM, tsx
- `claude -p` — non-interactive Claude CLI (OAuth, no API key needed)
- vitest for unit + integration tests

## Commands
- Init setup: `npx @opslane/verify init [--project-dir .] [--base-url <url>]`
- Index app: `npx @opslane/verify index --project-dir /path/to/project`
- Dev (from source): `npx tsx src/cli.ts init`

## Verification (run before every commit)
1. `npx tsc --noEmit` — fix all type errors
2. `npx vitest run` — fix all failing tests

## Conventions
- **TypeScript strict**: no `any` — use `unknown` and narrow
- **Node 22 ESM**: use `import`, not `require`
- **Non-interactive Claude**: always use `claude -p`, never interactive mode
- **Stage permissions**: each stage gets minimal tool access via `STAGE_PERMISSIONS` in types.ts

## Don't
- Don't hardcode URLs — use config or env vars
- Don't commit `.verify/` contents — auth, evidence, and plans are gitignored
