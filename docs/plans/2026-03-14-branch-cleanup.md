# Branch Cleanup Plan

**Date:** 2026-03-14

Changes made during the formbricks debugging session. Categorized as keep, modify, or remove.

Note: This plan separates generic v2 migration work from formbricks-specific tasks. The v2 migration applies to all repos; formbricks is just the first customer.

## Code Changes (Keep)

These changes are valuable regardless of the v2 redesign:

### `src/db.ts` — Keep
- Added `sandbox_template`, `login_script` fields to `RepoConfig` interface
- These fields are already in the DB and used by the pipeline
- `browser_auth_state` can be removed (not used, login_script replaced it)

### `src/verify/browser-agent.ts` — Keep
- `loginAndInjectAuth()` function — core auth approach, works well
- Updated agent prompt (tells agent browser is pre-authenticated)
- `NODE_PATH` fix for custom templates
- All of this carries forward to v2

### `src/verify/pipeline.ts` — Keep
- `sandbox_template` support in sandbox creation
- Custom template clone flow (fetch + checkout vs. fresh clone)
- `loginAndInjectAuth` integration in the AC loop
- Playwright package install check
- All carries forward to v2

### `src/verify/sandbox-setup.ts` — Keep
- Health check fix: removed `-f` flag, increased timeout to 10s
- Wrapper script approach for app startup (avoids nohup/quoting issues)
- Both are improvements regardless of v2

### `src/index.ts` — Keep
- `process.exit(0)` in shutdown handler — needed for clean Railway deploys

## Code Changes (Modify for V2)

### `src/db.ts`
- Remove `browser_auth_state` from `RepoConfig` (unused)
- Rename `startup_command` → `dev_command` (v2 migration)
- Add `compose_file`, `schema_command`, `seed_command` fields
- Remove `detected_infra` (replaced by compose_file)
- Remove `pre_start_script` (replaced by schema_command + seed_command)

### `src/verify/sandbox-setup.ts`
- Rewrite startup flow for dev mode
- Add `docker compose up -d --wait` step (generic — works with any compose file)
- Fallback: if no healthchecks in compose, 15s delay + retry on schema push
- Remove `infra-services.ts` dependency (no more manual service install)
- Add explicit schema_command + seed_command steps

### `src/verify/pipeline.ts`
- Update to use new config field names
- Remove standalone-specific logic

## Scripts (Remove)

Debug/one-off scripts created during the session. None needed going forward:

- `scripts/debug-app-error.ts` — one-off debugging
- `scripts/debug-formbricks-api.ts` — one-off debugging
- `scripts/debug-formbricks-routing.ts` — one-off debugging
- `scripts/debug-formbricks-static.ts` — one-off debugging
- `scripts/debug-standalone.ts` — one-off debugging
- `scripts/fix-prestart-script.ts` — one-off DB fix
- `scripts/fix-prestart-v2.ts` — one-off DB fix
- `scripts/fix-startup-command.ts` — one-off DB fix
- `scripts/capture-sandbox-auth.ts` — superseded by loginAndInjectAuth
- `scripts/store-auth-state.ts` — superseded by loginAndInjectAuth
- `scripts/set-login-script.ts` — one-off DB setup
- `scripts/test-standalone-start.ts` — standalone approach abandoned

## Scripts (Keep)

Useful for ongoing testing:

- `scripts/test-pipeline-formbricks.ts` — e2e pipeline test (update for v2: new config field names)
- `scripts/test-docker-in-sandbox-v2.ts` — validates Docker-in-E2B works
- `scripts/test-e2b-sandbox.ts` — basic sandbox smoke test
- `scripts/test-seed.ts` — validates DB seeding works (update: reference `seed_command` not `pre_start_script`)
- `scripts/check-env.ts` — env var validation utility

### Test file updates needed
Kept scripts that reference old config fields must be updated alongside the code changes:
- `test-pipeline-formbricks.ts`: `startup_command` → `dev_command`, remove `pre_start_script`/`detected_infra` refs
- `test-seed.ts`: update if it references `pre_start_script`

## Scripts (Remove — Redundant)

- `scripts/test-docker-in-sandbox.ts` — superseded by v2
- `scripts/test-e2b-direct.ts` — superseded by test-e2b-sandbox.ts

## E2B Templates (Formbricks-Specific)

### `e2b-templates/formbricks/` — Rewrite
- Strip out build step, static file copying, .env at build time
- Keep: clone + pnpm install + prisma generate
- Update entrypoint: start Docker daemon (not Postgres/Redis directly)
- Postgres + Redis come from docker-compose.dev.yml at runtime

This is formbricks-specific. Other customers will either use the base `opslane-verify-v2` template or get their own per-app template following the same pattern.

## DB Migration

Need a migration to:
1. Add columns: `compose_file`, `schema_command`, `seed_command`, `dev_command`
2. Migrate data: `startup_command` → `dev_command`
3. Drop columns: `pre_start_script`, `detected_infra`, `browser_auth_state` (step 8, after validation)
4. Rename in application code accordingly

### Rollback plan
- Migration is split: steps 1-2 are additive (safe), step 3 is destructive (deferred)
- If v2 breaks after step 2: revert application code to read `startup_command` again, old columns still exist
- Step 3 (drop columns) only runs after: successful e2e test against formbricks with the full v2 pipeline
- Rollback SQL for step 3: `ALTER TABLE repo_configs ADD COLUMN pre_start_script text, ADD COLUMN detected_infra text, ADD COLUMN browser_auth_state text;`

## Execution Order

### Generic v2 migration (applies to all repos)
1. Delete debug/one-off scripts (safe, no dependencies)
2. Write DB migration (add new columns, keep old ones temporarily)
3. Update `RepoConfig` interface + sandbox-setup for v2 flow
4. Update pipeline.ts for v2 flow
5. Update kept test scripts for new field names

### Formbricks validation
6. Rewrite formbricks template (Dockerfile + entrypoint)
7. Rebuild E2B template
8. Test e2e with formbricks — "confirmed working" = full pipeline runs, browser agent verifies at least one AC
9. Drop old DB columns (only after step 8 passes)
