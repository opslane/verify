# Sandbox V2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current baked-in infra + production-build sandbox setup with Docker Compose + dev mode, per the [design doc](./2026-03-14-sandbox-v2-design.md).

**Architecture:** DB migration renames `startup_command` → `dev_command`, replaces `detected_infra` with `compose_file`, replaces `pre_start_script` with `schema_command` + `seed_command`. `sandbox-setup.ts` is rewritten to run `docker compose up` then `dev_command`. `infra-services.ts` is deleted entirely.

**Tech Stack:** PostgreSQL (migration), TypeScript (Hono server), vitest (tests)

**Milestones (prove design incrementally):**
1. DB migration applies cleanly on real Postgres
2. TypeScript compiles with new schema — all consumers updated
3. Sandbox setup works with compose — infra-services deleted
4. Full pipeline compiles, all tests pass

---

## Milestone 1: DB Migration

### Task 1: Write + Apply Migration

**Files:**
- Create: `server/db/migrations/003_sandbox_v2.sql`

**Step 1: Write the migration SQL**

```sql
-- Sandbox V2: dev mode + docker compose
-- Renames startup_command → dev_command
-- Replaces detected_infra with compose_file
-- Replaces pre_start_script with schema_command + seed_command
-- Adds login_script, sandbox_template

ALTER TABLE repo_configs RENAME COLUMN startup_command TO dev_command;

ALTER TABLE repo_configs DROP COLUMN detected_infra;
ALTER TABLE repo_configs DROP COLUMN pre_start_script;

ALTER TABLE repo_configs ADD COLUMN compose_file text;
ALTER TABLE repo_configs ADD COLUMN schema_command text;
ALTER TABLE repo_configs ADD COLUMN seed_command text;
ALTER TABLE repo_configs ADD COLUMN login_script text;
ALTER TABLE repo_configs ADD COLUMN sandbox_template text;
```

**Step 2: Verify migration applies cleanly**

Run: `cd server && DATABASE_URL=$DATABASE_URL node --import tsx/esm src/migrate.ts`
Expected: `Migration applied: 003_sandbox_v2.sql` — no errors.

**Step 3: Verify column rename preserved data**

Run: `cd server && psql $DATABASE_URL -c "SELECT column_name FROM information_schema.columns WHERE table_name = 'repo_configs' ORDER BY ordinal_position;"`
Expected: `dev_command` present, `startup_command`/`detected_infra`/`pre_start_script` absent, new columns present.

**Step 4: Commit**

```bash
git add server/db/migrations/003_sandbox_v2.sql
git commit -m "feat: add migration 003 for sandbox v2 schema (dev_command, compose_file)"
```

**Milestone 1 gate:** Migration applies without errors. Column check confirms schema is correct.

---

## Milestone 2: TypeScript Compiles with New Schema

### Task 2: Update RepoConfig Interface + DB Helpers

**Files:**
- Modify: `server/src/db.ts`
- Modify: `server/src/db.test.ts`

**Step 1: Write the failing test**

Add in `server/src/db.test.ts` inside the `repo configs` describe block:

```typescript
it('upserts repo config with v2 fields (compose_file, schema_command, seed_command)', async () => {
  const { upsertRepoConfig, findRepoConfig } = await import('./db.js');

  await upsertRepoConfig({
    installationId: 55001,
    owner: 'v2org',
    repo: 'v2repo',
    devCommand: 'pnpm --filter @app/web dev',
    port: 3000,
    composeFile: 'docker-compose.dev.yml',
    schemaCommand: 'npx prisma db push --accept-data-loss',
    seedCommand: 'pnpm db:seed',
    loginScript: 'await page.goto("/login"); await page.fill("#email", "test@test.com");',
    sandboxTemplate: 'opslane-formbricks',
  });

  const config = await findRepoConfig('v2org', 'v2repo');
  expect(config).not.toBeNull();
  expect(config!.dev_command).toBe('pnpm --filter @app/web dev');
  expect(config!.compose_file).toBe('docker-compose.dev.yml');
  expect(config!.schema_command).toBe('npx prisma db push --accept-data-loss');
  expect(config!.seed_command).toBe('pnpm db:seed');
  expect(config!.login_script).toContain('page.goto');
  expect(config!.sandbox_template).toBe('opslane-formbricks');
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && DATABASE_URL=$DATABASE_URL TEST_DATABASE_URL=$TEST_DATABASE_URL npm test -- --run src/db.test.ts`
Expected: FAIL — `devCommand` doesn't exist on upsertRepoConfig params.

**Step 3: Update RepoConfig interface in `server/src/db.ts`**

Replace the `RepoConfig` interface (line 78-94):

```typescript
export interface RepoConfig {
  id: string;
  installation_id: number | null;
  owner: string;
  repo: string;
  dev_command: string;
  port: number;
  install_command: string | null;
  health_path: string;
  test_email: string | null;
  test_password: string | null;
  env_vars: Record<string, string> | null;
  compose_file: string | null;
  schema_command: string | null;
  seed_command: string | null;
  login_script: string | null;
  sandbox_template: string | null;
  created_at: Date;
  updated_at: Date;
}
```

**Step 4: Update upsertRepoConfig function in `server/src/db.ts`**

Replace the function (line 96-139):

```typescript
export async function upsertRepoConfig(params: {
  installationId: number | null;
  owner: string;
  repo: string;
  devCommand: string;
  port: number;
  installCommand?: string | null;
  healthPath?: string;
  testEmail?: string | null;
  testPassword?: string | null;
  envVars?: Record<string, string> | null;
  composeFile?: string | null;
  schemaCommand?: string | null;
  seedCommand?: string | null;
  loginScript?: string | null;
  sandboxTemplate?: string | null;
}): Promise<RepoConfig> {
  const rows = await sql<RepoConfig[]>`
    INSERT INTO repo_configs (
      installation_id, owner, repo, dev_command, port,
      install_command, health_path,
      test_email, test_password, env_vars,
      compose_file, schema_command, seed_command,
      login_script, sandbox_template
    ) VALUES (
      ${params.installationId}, ${params.owner}, ${params.repo},
      ${params.devCommand}, ${params.port},
      ${params.installCommand ?? null},
      ${params.healthPath ?? '/'},
      ${params.testEmail ?? null}, ${params.testPassword ?? null},
      ${params.envVars ? sql.json(params.envVars) : null},
      ${params.composeFile ?? null}, ${params.schemaCommand ?? null},
      ${params.seedCommand ?? null}, ${params.loginScript ?? null},
      ${params.sandboxTemplate ?? null}
    )
    ON CONFLICT (owner, repo) DO UPDATE SET
      installation_id = EXCLUDED.installation_id,
      dev_command = EXCLUDED.dev_command,
      port = EXCLUDED.port,
      install_command = EXCLUDED.install_command,
      health_path = EXCLUDED.health_path,
      test_email = EXCLUDED.test_email,
      test_password = EXCLUDED.test_password,
      env_vars = EXCLUDED.env_vars,
      compose_file = EXCLUDED.compose_file,
      schema_command = EXCLUDED.schema_command,
      seed_command = EXCLUDED.seed_command,
      login_script = EXCLUDED.login_script,
      sandbox_template = EXCLUDED.sandbox_template,
      updated_at = now()
    RETURNING *
  `;
  return rows[0];
}
```

**Step 5: Fix existing tests in `server/src/db.test.ts`**

Update the "upserts and finds repo config" test (~line 151):
- `startupCommand` → `devCommand`
- `config!.startup_command` → `config!.dev_command`

Update the "updates repo config on conflict" test (~line 175):
- `startupCommand` → `devCommand`
- Remove `detectedInfra: ['postgres', 'minio']`
- `config!.startup_command` → `config!.dev_command`
- Remove `expect(config!.detected_infra)` assertion

**Step 6: Run DB tests to verify they pass**

Run: `cd server && DATABASE_URL=$DATABASE_URL TEST_DATABASE_URL=$TEST_DATABASE_URL npm test -- --run src/db.test.ts`
Expected: ALL PASS

**Step 7: Commit**

```bash
git add server/src/db.ts server/src/db.test.ts
git commit -m "feat: update RepoConfig interface and upsertRepoConfig for sandbox v2 fields"
```

---

### Task 3: Update All Consumers of RepoConfig

**Files:**
- Modify: `server/src/verify/pipeline.ts`
- Modify: `server/src/verify/pipeline.test.ts`
- Modify: `server/src/routes/webhooks.test.ts`

**Step 1: Update pipeline.ts — use per-repo sandbox_template**

In `server/src/verify/pipeline.ts` line 84, change:
```typescript
  template: VERIFY_TEMPLATE,
```
to:
```typescript
  template: config.sandbox_template ?? VERIFY_TEMPLATE,
```

**Step 2: Verify no old field references in pipeline.ts**

Run: `cd server && grep -n 'startup_command\|pre_start_script\|detected_infra' src/verify/pipeline.ts`
Expected: No results.

**Step 3: Update mock RepoConfig in `server/src/routes/webhooks.test.ts`**

Find the mock config object (~line 224-229):
```typescript
{ id: 'cfg-uuid', installation_id: 1, owner: 'org', repo: 'repo',
  startup_command: 'npm start', port: 3000, install_command: null,
  pre_start_script: null, health_path: '/', test_email: null,
  test_password: null, env_vars: null, detected_infra: [],
  created_at: new Date(), updated_at: new Date() }
```

Replace with:
```typescript
{ id: 'cfg-uuid', installation_id: 1, owner: 'org', repo: 'repo',
  dev_command: 'npm run dev', port: 3000, install_command: null,
  health_path: '/', test_email: null, test_password: null,
  env_vars: null, compose_file: null, schema_command: null,
  seed_command: null, login_script: null, sandbox_template: null,
  created_at: new Date(), updated_at: new Date() }
```

**Step 4: Run TypeScript compile check**

Run: `cd server && npx tsc --noEmit`
Expected: No errors. If there are errors, they will be from remaining references to old field names — fix each one.

**Step 5: Run all affected tests**

Run: `cd server && npm test -- --run src/verify/pipeline.test.ts src/routes/webhooks.test.ts`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add server/src/verify/pipeline.ts server/src/verify/pipeline.test.ts server/src/routes/webhooks.test.ts
git commit -m "feat: update pipeline + webhook consumers for sandbox v2 RepoConfig"
```

**Milestone 2 gate:** `npx tsc --noEmit` passes. All tests pass. No references to `startup_command`, `detected_infra`, or `pre_start_script` remain in `src/`.

---

## Milestone 3: Sandbox Setup Works with Compose

### Task 4: Rewrite sandbox-setup.ts + Delete infra-services

**Files:**
- Modify: `server/src/verify/sandbox-setup.ts`
- Modify: `server/src/verify/sandbox-setup.test.ts`
- Delete: `server/src/verify/infra-services.ts`
- Delete: `server/src/verify/infra-services.test.ts` (if exists)

**Step 1: Write tests for the new setup flow**

Replace `server/src/verify/sandbox-setup.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('../crypto.js', () => ({
  decrypt: vi.fn((v: string) => v),
}));

import { buildEnvFileContent, buildHealthCheckCommand, validateComposeFile } from './sandbox-setup.js';

describe('sandbox-setup helpers', () => {
  it('builds .env content from key-value pairs', () => {
    const content = buildEnvFileContent({
      DATABASE_URL: 'postgres://localhost/app',
      SECRET: 'has "quotes" and $vars',
    });
    expect(content).toContain('DATABASE_URL="postgres://localhost/app"');
    expect(content).toContain('SECRET="has \\"quotes\\" and \\$vars"');
  });

  it('builds health check curl command', () => {
    const cmd = buildHealthCheckCommand(3000, '/api/health');
    expect(cmd).toContain('curl');
    expect(cmd).toContain('3000');
    expect(cmd).toContain('/api/health');
  });

  it('defaults health path to /', () => {
    const cmd = buildHealthCheckCommand(3000);
    expect(cmd).toContain('localhost:3000/');
  });

  it('rejects invalid health paths', () => {
    expect(() => buildHealthCheckCommand(3000, '/path; rm -rf /')).toThrow('Invalid health path');
  });

  describe('validateComposeFile', () => {
    it('accepts valid compose file names', () => {
      expect(validateComposeFile('docker-compose.yml')).toBe(true);
      expect(validateComposeFile('docker-compose.dev.yml')).toBe(true);
      expect(validateComposeFile('docker-compose.dev.yaml')).toBe(true);
      expect(validateComposeFile('compose.yml')).toBe(true);
      expect(validateComposeFile('infra/docker-compose.yml')).toBe(true);
    });

    it('rejects compose file names with shell injection', () => {
      expect(validateComposeFile('foo.yml; curl evil.com')).toBe(false);
      expect(validateComposeFile('$(whoami).yml')).toBe(false);
      expect(validateComposeFile('file.txt')).toBe(false);
      expect(validateComposeFile('../../../etc/passwd')).toBe(false);
    });
  });
});
```

**Step 2: Run tests to verify validateComposeFile test fails (not yet implemented)**

Run: `cd server && npm test -- --run src/verify/sandbox-setup.test.ts`
Expected: FAIL — `validateComposeFile` not exported.

**Step 3: Rewrite sandbox-setup.ts**

Replace `server/src/verify/sandbox-setup.ts` entirely:

```typescript
import type { SandboxProvider } from '../sandbox/types.js';
import type { RepoConfig } from '../db.js';
import { decrypt } from '../crypto.js';
import { drain, collect } from '../sandbox/stream.js';

/** Escape a value for double-quoted .env format */
function escapeEnvValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/\n/g, '\\n');
}

export function buildEnvFileContent(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([key, value]) => `${key}="${escapeEnvValue(value)}"`)
    .join('\n') + '\n';
}

const VALID_PATH = /^\/[a-zA-Z0-9\/_.-]*$/;

export function buildHealthCheckCommand(port: number, healthPath = '/'): string {
  const path = healthPath.startsWith('/') ? healthPath : `/${healthPath}`;
  if (!VALID_PATH.test(path)) {
    throw new Error(`Invalid health path: ${path}`);
  }
  return `curl -sf -o /dev/null -w "HEALTH_STATUS:%{http_code}" --max-time 5 http://localhost:${port}${path}`;
}

const SAFE_COMPOSE = /^[a-zA-Z0-9._\-/]+\.ya?ml$/;

/** Validate compose_file path is safe for shell interpolation. Exported for testing. */
export function validateComposeFile(path: string): boolean {
  return SAFE_COMPOSE.test(path) && !path.includes('..');
}

interface SetupResult {
  success: boolean;
  error?: string;
  serverLog?: string;
}

export async function setupSandbox(
  provider: SandboxProvider,
  sandboxId: string,
  config: RepoConfig,
  log: (step: string, msg: string) => void,
): Promise<SetupResult> {
  const workDir = '/home/user/repo';

  // 1. Write .env file
  if (config.env_vars && Object.keys(config.env_vars).length > 0) {
    log('env', 'Writing .env file');
    const decrypted: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.env_vars)) {
      decrypted[key] = decrypt(value);
    }
    if (config.test_email) decrypted.TEST_EMAIL = decrypt(config.test_email);
    if (config.test_password) decrypted.TEST_PASSWORD = decrypt(config.test_password);
    const envContent = buildEnvFileContent(decrypted);
    await provider.uploadFiles(sandboxId, [{ path: `${workDir}/.env`, content: envContent }]);
  }

  // 2. Docker Compose (if compose_file configured)
  if (config.compose_file) {
    if (!validateComposeFile(config.compose_file)) {
      return { success: false, error: `Invalid compose_file path: ${config.compose_file}` };
    }
    log('compose', `Starting infra: docker compose -f ${config.compose_file} up -d --wait`);
    try {
      await drain(provider.runCommand(
        sandboxId,
        `docker compose -f ${config.compose_file} up -d --wait`,
        { cwd: workDir, timeoutMs: 180_000, rawOutput: true },
      ));
      log('compose', 'Docker Compose services are up');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Docker Compose failed: ${msg}` };
    }
  }

  // 3. Install dependencies (always — idempotent, fast no-op if unchanged)
  const installCmd = config.install_command ?? 'npm install';
  log('install', `Running: ${installCmd}`);
  await drain(provider.runCommand(sandboxId, installCmd, { cwd: workDir, timeoutMs: 480_000, rawOutput: true }));

  // 4. Schema push (if schema_command configured — idempotent)
  if (config.schema_command) {
    log('schema', `Running: ${config.schema_command}`);
    await drain(provider.runCommand(sandboxId, config.schema_command, { cwd: workDir, timeoutMs: 120_000, rawOutput: true }));
  }

  // 5. Seed DB (if seed_command configured)
  if (config.seed_command) {
    log('seed', `Running: ${config.seed_command}`);
    await drain(provider.runCommand(sandboxId, config.seed_command, { cwd: workDir, timeoutMs: 120_000, rawOutput: true }));
  }

  // 6. Start dev server (fire-and-forget — health check validates it started)
  log('start', `Starting dev server: ${config.dev_command}`);
  try {
    await drain(provider.runCommand(
      sandboxId,
      `nohup ${config.dev_command} > /tmp/server.log 2>&1 & echo $! > /tmp/server.pid && sleep 1`,
      { cwd: workDir, rawOutput: true, timeoutMs: 10_000 },
    ));
  } catch (err) {
    if (err instanceof Error && 'ptyOutput' in err) {
      log('start', 'PTY exited (expected for background commands)');
    } else {
      throw err;
    }
  }

  // 7. Health check — poll until 2xx or timeout
  const healthCmd = buildHealthCheckCommand(config.port, config.health_path);
  const maxWaitMs = 120_000;
  const intervalMs = 2_000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const output = await collect(provider.runCommand(sandboxId, healthCmd, { rawOutput: true }));
      const statusLine = output.find(l => l.includes('HEALTH_STATUS:'));
      const code = statusLine ? parseInt(statusLine.split('HEALTH_STATUS:')[1], 10) : NaN;
      if (code >= 200 && code < 400) {
        log('health', `App healthy (HTTP ${code})`);
        return { success: true };
      }
    } catch {
      // curl failed — app not ready yet
    }

    // Check if process is still alive
    try {
      await drain(provider.runCommand(sandboxId, 'kill -0 $(cat /tmp/server.pid 2>/dev/null) 2>/dev/null', { rawOutput: true }));
    } catch {
      const logOutput = await collect(
        provider.runCommand(sandboxId, 'tail -30 /tmp/server.log 2>/dev/null || echo "No server log found"', { rawOutput: true })
      );
      return {
        success: false,
        error: 'App process exited unexpectedly',
        serverLog: logOutput.join('\n'),
      };
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  const logOutput = await collect(
    provider.runCommand(sandboxId, 'tail -30 /tmp/server.log 2>/dev/null || echo "No server log found"', { rawOutput: true })
  );
  return {
    success: false,
    error: `App did not respond on port ${config.port} within ${maxWaitMs / 1000} seconds`,
    serverLog: logOutput.join('\n'),
  };
}
```

**Step 4: Delete infra-services files**

```bash
rm server/src/verify/infra-services.ts
# Also delete the test file if it exists:
rm -f server/src/verify/infra-services.test.ts
```

**Step 5: Verify no remaining imports**

Run: `cd server && grep -r 'infra-services' src/`
Expected: No results.

**Step 6: Run tests**

Run: `cd server && npm test -- --run src/verify/sandbox-setup.test.ts`
Expected: ALL PASS

**Step 7: Commit**

```bash
git add server/src/verify/sandbox-setup.ts server/src/verify/sandbox-setup.test.ts
git add -u server/src/verify/infra-services.ts server/src/verify/infra-services.test.ts
git commit -m "feat: rewrite sandbox-setup for docker compose + dev mode, delete infra-services"
```

**Milestone 3 gate:** `validateComposeFile` tests pass. `infra-services.ts` deleted with no orphaned imports. sandbox-setup helper tests pass.

---

## Milestone 4: Full Pipeline Green

### Task 5: Final Verification

**Files:** None (verification only — no commit if clean)

**Step 1: TypeScript compile check**

Run: `cd server && npx tsc --noEmit`
Expected: No errors. If errors remain, fix them — they're from old field names in files like `test-steps.ts` or other consumers.

**Step 2: Full test suite**

Run: `cd server && npm test -- --run`
Expected: ALL PASS

**Step 3: Grep for any remaining old field references**

Run: `cd server && grep -rn 'startup_command\|detected_infra\|pre_start_script' src/`
Expected: No results. If any remain, update them.

**Step 4: Commit only if fixes were needed**

```bash
# Only if Step 1-3 required fixes:
git add server/src/
git commit -m "fix: resolve remaining references to old sandbox v1 field names"
```

**Milestone 4 gate:** `tsc --noEmit` clean. `npm test` all pass. Zero grep results for old field names in `src/`.

---

## Summary of Changes

| What | Before (V1) | After (V2) |
|------|-------------|------------|
| DB column | `startup_command` | `dev_command` |
| DB column | `detected_infra` (jsonb array) | Dropped |
| DB column | `pre_start_script` | Dropped |
| DB column | — | `compose_file` (text, nullable) |
| DB column | — | `schema_command` (text, nullable) |
| DB column | — | `seed_command` (text, nullable) |
| DB column | — | `login_script` (text, nullable) |
| DB column | — | `sandbox_template` (text, nullable) |
| Infra setup | `infra-services.ts` (manual install/start/probe) | `docker compose -f {compose_file} up -d --wait` |
| Pre-start | arbitrary shell script | explicit `schema_command` + `seed_command` |
| App start | `nohup {startup_command}` (production build) | `nohup {dev_command}` (dev mode) |
| Template selection | env var only | per-repo `sandbox_template` field |
| Security | no compose_file validation | `validateComposeFile()` — safe filename regex |
| Files deleted | — | `server/src/verify/infra-services.ts`, `server/src/verify/infra-services.test.ts` |
