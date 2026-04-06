## Stack
- TypeScript 5, Node 22 ESM, tsx
- `claude -p` — non-interactive Claude CLI (OAuth, no API key needed)
- gstack browse — headless browser for each AC check
- vitest for unit + integration tests

## Commands
- Run a stage: `npx tsx src/cli.ts run-stage <stage> --verify-dir .verify`
- Full run: `npx tsx src/cli.ts run --spec .verify/spec.md`
- Index app: `npx tsx src/cli.ts index-app --project-dir /path/to/project`

## Verification (run before every commit)
1. `npx tsc --noEmit` — fix all type errors
2. `npx vitest run` — fix all failing tests

## Conventions
- **TypeScript strict**: no `any` — use `unknown` and narrow
- **Node 22 ESM**: use `import`, not `require`
- **Non-interactive Claude**: always use `claude -p`, never interactive mode
- **Stage permissions**: each stage gets minimal tool access via `STAGE_PERMISSIONS` in types.ts
- **Deterministic > LLM**: Prisma column mappings and seed IDs are parsed deterministically, not by LLM

## Don't
- Don't hardcode URLs — use config or env vars
- Don't commit `.verify/` contents — auth, evidence, and plans are gitignored
- Don't use Prisma field names in SQL — always look up the Postgres column name from `app.json`
