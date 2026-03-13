# Remote Verify Pipeline — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Run browser-based acceptance testing automatically when a PR webhook fires — spin up the target app in an E2B sandbox, run browser agents against acceptance criteria, and post results as a PR comment.

**Architecture:** Webhook receives PR → spec discovery (plan file or PR body) → fetch repo config from DB → E2B sandbox (Postgres + Redis baked in, optional infra installed at runtime) → install deps + start app → planner → browser agents → judge → post PR comment. Falls back to code-review-only when no spec is found.

**Tech Stack:** Hono, TypeScript, postgres.js, E2B SDK, Trigger.dev, Anthropic SDK (Claude tool-use for browser agent), Playwright (inside sandbox), vitest.

**Design doc:** `docs/plans/2026-03-12-remote-verify-pipeline-design.md`

---

## Task 1: Encryption Module (`server/src/crypto.ts`)

AES-256-GCM helpers for encrypting secrets before DB storage.

**Files:**
- Create: `server/src/crypto.ts`
- Create: `server/src/crypto.test.ts`

**Step 1: Write the failing test**

```typescript
// server/src/crypto.test.ts
import { describe, it, expect } from 'vitest';

describe('crypto', () => {
  it('encrypts and decrypts a string', async () => {
    // Set a test key (32 bytes hex = 64 hex chars)
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    const { encrypt, decrypt } = await import('./crypto.js');

    const plaintext = 'my-secret-password';
    const ciphertext = encrypt(plaintext);

    expect(ciphertext).not.toBe(plaintext);
    expect(ciphertext).toMatch(/^[a-f0-9]+:[a-f0-9]+:[a-f0-9]+$/); // iv:ciphertext:authTag
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it('produces different ciphertexts for same input (unique IV)', async () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    const { encrypt } = await import('./crypto.js');

    const a = encrypt('same');
    const b = encrypt('same');
    expect(a).not.toBe(b);
  });

  it('throws on tampered ciphertext', async () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    const { encrypt, decrypt } = await import('./crypto.js');

    const ciphertext = encrypt('secret');
    const [iv, data, tag] = ciphertext.split(':');
    const tampered = `${iv}:${'ff' + data.slice(2)}:${tag}`;

    expect(() => decrypt(tampered)).toThrow();
  });

  it('throws if ENCRYPTION_KEY is missing', async () => {
    delete process.env.ENCRYPTION_KEY;
    // Need fresh import to re-evaluate
    vi.resetModules();
    await expect(import('./crypto.js')).rejects.toThrow('ENCRYPTION_KEY');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/crypto.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// server/src/crypto.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

// Validate key at module load time (fail fast)
const KEY = getKey();

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${encrypted.toString('hex')}:${authTag.toString('hex')}`;
}

export function decrypt(ciphertext: string): string {
  const [ivHex, encHex, tagHex] = ciphertext.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final('utf8');
}
```

**Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/crypto.test.ts`
Expected: PASS

**Step 5: Type check**

Run: `cd server && npx tsc --noEmit`

**Step 6: Commit**

```bash
git add server/src/crypto.ts server/src/crypto.test.ts
git commit -m "feat: add AES-256-GCM encryption module for secret storage"
```

---

## Task 2: Database Migration for `repo_configs`

**Files:**
- Create: `server/db/migrations/002_repo_configs.sql`
- Modify: `server/src/db.ts` — add `upsertRepoConfig`, `findRepoConfig`

**Step 1: Write the migration**

```sql
-- server/db/migrations/002_repo_configs.sql
CREATE TABLE IF NOT EXISTS repo_configs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id   integer REFERENCES github_installations(installation_id),
  owner             text NOT NULL,
  repo              text NOT NULL,
  startup_command   text NOT NULL,
  port              integer NOT NULL DEFAULT 3000,
  install_command   text,
  pre_start_script  text,
  health_path       text DEFAULT '/',
  test_email        text,
  test_password     text,
  env_vars          jsonb,
  detected_infra    jsonb DEFAULT '[]'::jsonb,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now(),
  UNIQUE (owner, repo)
);

CREATE INDEX IF NOT EXISTS idx_repo_configs_owner_repo ON repo_configs (owner, repo);
CREATE INDEX IF NOT EXISTS idx_repo_configs_installation_id ON repo_configs (installation_id);
```

**Step 2: Write failing tests for the new DB helpers**

```typescript
// Add to server/src/db.test.ts — inside the existing describe block

it('upserts and finds repo config', async () => {
  const { upsertRepoConfig, findRepoConfig } = await import('./db.js');

  await upsertRepoConfig({
    installationId: 55001,
    owner: 'testorg',
    repo: 'testrepo',
    startupCommand: 'npm run dev',
    port: 3000,
  });

  const config = await findRepoConfig('testorg', 'testrepo');
  expect(config).not.toBeNull();
  expect(config!.startup_command).toBe('npm run dev');
  expect(config!.port).toBe(3000);
  expect(config!.health_path).toBe('/');
});

it('returns null for missing repo config', async () => {
  const { findRepoConfig } = await import('./db.js');
  const config = await findRepoConfig('nonexistent', 'nope');
  expect(config).toBeNull();
});

it('updates repo config on conflict', async () => {
  const { upsertRepoConfig, findRepoConfig } = await import('./db.js');

  await upsertRepoConfig({
    installationId: 55001,
    owner: 'testorg',
    repo: 'testrepo',
    startupCommand: 'npm run dev',
    port: 3000,
  });

  await upsertRepoConfig({
    installationId: 55001,
    owner: 'testorg',
    repo: 'testrepo',
    startupCommand: 'pnpm dev',
    port: 3001,
    healthPath: '/api/health',
    detectedInfra: ['postgres', 'minio'],
  });

  const config = await findRepoConfig('testorg', 'testrepo');
  expect(config!.startup_command).toBe('pnpm dev');
  expect(config!.port).toBe(3001);
  expect(config!.health_path).toBe('/api/health');
  expect(config!.detected_infra).toEqual(['postgres', 'minio']);
});
```

**Step 3: Run test to verify it fails**

Run: `cd server && DATABASE_URL=$DATABASE_URL TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/db.test.ts`
Expected: FAIL — `upsertRepoConfig` not exported

**Step 4: Add DB helpers to `server/src/db.ts`**

Add to the bottom of `db.ts`, following the existing pattern:

```typescript
export interface RepoConfig {
  id: string;
  installation_id: number | null;
  owner: string;
  repo: string;
  startup_command: string;
  port: number;
  install_command: string | null;
  pre_start_script: string | null;
  health_path: string;
  test_email: string | null;
  test_password: string | null;
  env_vars: Record<string, string> | null;
  detected_infra: string[];
  created_at: Date;
  updated_at: Date;
}

export async function upsertRepoConfig(params: {
  installationId: number | null;
  owner: string;
  repo: string;
  startupCommand: string;
  port: number;
  installCommand?: string | null;
  preStartScript?: string | null;
  healthPath?: string;
  testEmail?: string | null;
  testPassword?: string | null;
  envVars?: Record<string, string> | null;
  detectedInfra?: string[];
}): Promise<RepoConfig> {
  const rows = await sql<RepoConfig[]>`
    INSERT INTO repo_configs (
      installation_id, owner, repo, startup_command, port,
      install_command, pre_start_script, health_path,
      test_email, test_password, env_vars, detected_infra
    ) VALUES (
      ${params.installationId}, ${params.owner}, ${params.repo},
      ${params.startupCommand}, ${params.port},
      ${params.installCommand ?? null}, ${params.preStartScript ?? null},
      ${params.healthPath ?? '/'}, ${params.testEmail ?? null},
      ${params.testPassword ?? null},
      ${params.envVars ? sql.json(params.envVars) : null},
      ${sql.json(params.detectedInfra ?? [])}
    )
    ON CONFLICT (owner, repo) DO UPDATE SET
      installation_id = EXCLUDED.installation_id,
      startup_command = EXCLUDED.startup_command,
      port = EXCLUDED.port,
      install_command = EXCLUDED.install_command,
      pre_start_script = EXCLUDED.pre_start_script,
      health_path = EXCLUDED.health_path,
      test_email = EXCLUDED.test_email,
      test_password = EXCLUDED.test_password,
      env_vars = EXCLUDED.env_vars,
      detected_infra = EXCLUDED.detected_infra,
      updated_at = now()
    RETURNING *
  `;
  return rows[0];
}

export async function findRepoConfig(owner: string, repo: string): Promise<RepoConfig | null> {
  const rows = await sql<RepoConfig[]>`
    SELECT * FROM repo_configs WHERE owner = ${owner} AND repo = ${repo}
  `;
  return rows[0] ?? null;
}
```

**Step 5: Run test to verify it passes**

Run: `cd server && DATABASE_URL=$DATABASE_URL TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/db.test.ts`
Expected: PASS

**Step 6: Type check**

Run: `cd server && npx tsc --noEmit`

**Step 7: Commit**

```bash
git add server/db/migrations/002_repo_configs.sql server/src/db.ts server/src/db.test.ts
git commit -m "feat: add repo_configs table and DB helpers"
```

---

## Task 3: Spec Discovery Module

Finds the spec for a PR — checks changed files for plan docs, then scans PR body.

**Files:**
- Create: `server/src/verify/spec-discovery.ts`
- Create: `server/src/verify/spec-discovery.test.ts`

**Step 1: Write failing tests**

```typescript
// server/src/verify/spec-discovery.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the GitHub PR module
vi.mock('../github/pr.js', () => ({
  fetchPullRequest: vi.fn(),
}));

import { discoverSpec } from './spec-discovery.js';

describe('discoverSpec', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns plan file when PR changes include docs/plans/*.md', async () => {
    const result = await discoverSpec({
      owner: 'org',
      repo: 'app',
      prNumber: 1,
      token: 'tok',
      changedFiles: [
        { filename: 'src/index.ts', status: 'modified' },
        { filename: 'docs/plans/2026-03-12-feature.md', status: 'added' },
      ],
      prBody: '',
    });

    expect(result.type).toBe('plan-file');
    expect(result.specPath).toBe('docs/plans/2026-03-12-feature.md');
  });

  it('prefers added plan files over modified ones', async () => {
    const result = await discoverSpec({
      owner: 'org',
      repo: 'app',
      prNumber: 1,
      token: 'tok',
      changedFiles: [
        { filename: 'docs/plans/old-plan.md', status: 'modified' },
        { filename: 'docs/plans/new-plan.md', status: 'added' },
      ],
      prBody: '',
    });

    expect(result.specPath).toBe('docs/plans/new-plan.md');
  });

  it('falls back to PR body when no plan file found', async () => {
    const result = await discoverSpec({
      owner: 'org',
      repo: 'app',
      prNumber: 1,
      token: 'tok',
      changedFiles: [{ filename: 'src/index.ts', status: 'modified' }],
      prBody: '## Acceptance Criteria\n- [ ] User can log in\n- [ ] Dashboard loads',
    });

    expect(result.type).toBe('pr-body');
    expect(result.specContent).toContain('User can log in');
  });

  it('returns no-spec when nothing found', async () => {
    const result = await discoverSpec({
      owner: 'org',
      repo: 'app',
      prNumber: 1,
      token: 'tok',
      changedFiles: [{ filename: 'src/index.ts', status: 'modified' }],
      prBody: 'Fixed a typo.',
    });

    expect(result.type).toBe('no-spec');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/verify/spec-discovery.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// server/src/verify/spec-discovery.ts

interface ChangedFile {
  filename: string;
  status: string; // 'added' | 'modified' | 'removed' | etc.
}

interface SpecDiscoveryInput {
  owner: string;
  repo: string;
  prNumber: number;
  token: string;
  changedFiles: ChangedFile[];
  prBody: string;
}

type SpecResult =
  | { type: 'plan-file'; specPath: string; specContent?: undefined }
  | { type: 'pr-body'; specContent: string; specPath?: undefined }
  | { type: 'no-spec'; specPath?: undefined; specContent?: undefined };

const PLAN_FILE_PATTERN = /^docs\/plans\/.*\.md$/;

/** Heuristic: does the PR body contain anything that looks like acceptance criteria? */
function hasAcceptanceCriteria(body: string): boolean {
  if (!body || body.trim().length < 20) return false;
  const lower = body.toLowerCase();
  // Look for checkbox lists, "acceptance criteria" header, or "should" statements in lists
  return (
    /- \[[ x]\]/i.test(body) ||
    lower.includes('acceptance criteria') ||
    lower.includes('requirements') ||
    (lower.includes('should') && /^[-*]\s/m.test(body))
  );
}

export async function discoverSpec(input: SpecDiscoveryInput): Promise<SpecResult> {
  // Step 1: Look for plan files in changed files
  const planFiles = input.changedFiles.filter((f) => PLAN_FILE_PATTERN.test(f.filename));

  if (planFiles.length > 0) {
    // Prefer added files over modified
    const added = planFiles.filter((f) => f.status === 'added');
    const chosen = added.length > 0 ? added[added.length - 1] : planFiles[planFiles.length - 1];
    return { type: 'plan-file', specPath: chosen.filename };
  }

  // Step 2: Check PR body for acceptance criteria
  if (hasAcceptanceCriteria(input.prBody)) {
    return { type: 'pr-body', specContent: input.prBody };
  }

  // Step 3: No spec found
  return { type: 'no-spec' };
}
```

**Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/verify/spec-discovery.test.ts`
Expected: PASS

**Step 5: Type check and commit**

Run: `cd server && npx tsc --noEmit`

```bash
git add server/src/verify/spec-discovery.ts server/src/verify/spec-discovery.test.ts
git commit -m "feat: add spec discovery module (plan file → PR body → no-spec)"
```

---

## Task 4: Infra Service Manager

Installs and starts optional infra services (MinIO, Mailhog) at runtime in the E2B sandbox.

**Files:**
- Create: `server/src/verify/infra-services.ts`
- Create: `server/src/verify/infra-services.test.ts`

**Step 1: Write failing tests**

```typescript
// server/src/verify/infra-services.test.ts
import { describe, it, expect } from 'vitest';
import { buildInstallCommands, buildReadinessProbe } from './infra-services.js';

describe('infra-services', () => {
  it('returns empty commands for empty list', () => {
    expect(buildInstallCommands([])).toEqual([]);
  });

  it('returns install + start commands for minio', () => {
    const cmds = buildInstallCommands(['minio']);
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds.some(c => c.includes('minio'))).toBe(true);
  });

  it('returns install + start commands for mailhog', () => {
    const cmds = buildInstallCommands(['mailhog']);
    expect(cmds.length).toBeGreaterThan(0);
  });

  it('ignores postgres and redis (baked into template)', () => {
    const cmds = buildInstallCommands(['postgres', 'redis']);
    expect(cmds).toEqual([]);
  });

  it('builds readiness probe for minio', () => {
    const probe = buildReadinessProbe('minio');
    expect(probe.command).toContain('curl');
    expect(probe.port).toBe(9000);
  });

  it('builds readiness probe for mailhog', () => {
    const probe = buildReadinessProbe('mailhog');
    expect(probe.port).toBe(8025);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/verify/infra-services.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// server/src/verify/infra-services.ts

interface ServiceDef {
  install: string[];  // shell commands to install
  start: string;      // shell command to start (daemonized)
  probe: { command: string; port: number; maxRetries: number; intervalMs: number };
}

const BAKED_IN = new Set(['postgres', 'redis']);

const SERVICE_DEFS: Record<string, ServiceDef> = {
  minio: {
    install: [
      'wget -q https://dl.min.io/server/minio/release/linux-amd64/minio -O /usr/local/bin/minio',
      'chmod +x /usr/local/bin/minio',
    ],
    start: 'MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin nohup minio server /data/minio --console-address :9001 > /tmp/minio.log 2>&1 &',
    probe: {
      command: 'curl -sf http://localhost:9000/minio/health/live',
      port: 9000,
      maxRetries: 15,
      intervalMs: 2000,
    },
  },
  mailhog: {
    install: [
      'wget -q https://github.com/mailhog/MailHog/releases/download/v1.0.1/MailHog_linux_amd64 -O /usr/local/bin/mailhog',
      'chmod +x /usr/local/bin/mailhog',
    ],
    start: 'nohup mailhog > /tmp/mailhog.log 2>&1 &',
    probe: {
      command: 'curl -sf http://localhost:8025',
      port: 8025,
      maxRetries: 10,
      intervalMs: 1000,
    },
  },
};

export function buildInstallCommands(services: string[]): string[] {
  const commands: string[] = [];
  for (const svc of services) {
    if (BAKED_IN.has(svc)) continue;
    const def = SERVICE_DEFS[svc];
    if (!def) continue;
    commands.push(...def.install, def.start);
  }
  return commands;
}

export function buildReadinessProbe(service: string): { command: string; port: number; maxRetries: number; intervalMs: number } {
  const def = SERVICE_DEFS[service];
  if (!def) throw new Error(`Unknown service: ${service}`);
  return def.probe;
}

export function getServiceDefs(): Record<string, ServiceDef> {
  return SERVICE_DEFS;
}
```

**Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/verify/infra-services.test.ts`
Expected: PASS

**Step 5: Type check and commit**

Run: `cd server && npx tsc --noEmit`

```bash
git add server/src/verify/infra-services.ts server/src/verify/infra-services.test.ts
git commit -m "feat: add infra service manager for runtime MinIO/Mailhog install"
```

---

## Task 5: Sandbox Setup Module

Orchestrates sandbox lifecycle: write .env, install infra, install deps, run pre-start, start app, health check.

**Files:**
- Create: `server/src/verify/sandbox-setup.ts`
- Create: `server/src/verify/sandbox-setup.test.ts`

**Step 1: Write failing tests**

```typescript
// server/src/verify/sandbox-setup.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildEnvFileContent, buildHealthCheckCommand } from './sandbox-setup.js';

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
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/verify/sandbox-setup.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// server/src/verify/sandbox-setup.ts
import type { SandboxProvider } from '../sandbox/types.js';
import type { RepoConfig } from '../db.js';
import { decrypt } from '../crypto.js';
import { buildInstallCommands, buildReadinessProbe, getServiceDefs } from './infra-services.js';

/** Escape a value for double-quoted .env format */
function escapeEnvValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');
}

export function buildEnvFileContent(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([key, value]) => `${key}="${escapeEnvValue(value)}"`)
    .join('\n') + '\n';
}

export function buildHealthCheckCommand(port: number, healthPath = '/'): string {
  const path = healthPath.startsWith('/') ? healthPath : `/${healthPath}`;
  return `curl -sf -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:${port}${path}`;
}

interface SetupResult {
  success: boolean;
  error?: string;
  serverLog?: string;
}

/** Drain an async iterable (consume all output, discard it) */
async function drain(stream: AsyncIterable<string>): Promise<void> {
  for await (const _ of stream) { /* consume */ }
}

/** Drain and collect output lines */
async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of stream) { lines.push(line); }
  return lines;
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
    // Decrypt env var values
    const decrypted: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.env_vars)) {
      decrypted[key] = decrypt(value);
    }
    if (config.test_email) decrypted.TEST_EMAIL = decrypt(config.test_email);
    if (config.test_password) decrypted.TEST_PASSWORD = decrypt(config.test_password);
    const envContent = buildEnvFileContent(decrypted);
    await provider.uploadFiles(sandboxId, [{ path: `${workDir}/.env`, content: envContent }]);
  }

  // 2. Install runtime infra services
  const infraServices = config.detected_infra ?? [];
  if (infraServices.length > 0) {
    const commands = buildInstallCommands(infraServices);
    for (const cmd of commands) {
      log('infra', `Running: ${cmd.slice(0, 80)}...`);
      await drain(provider.runCommand(sandboxId, cmd));
    }

    // Wait for readiness
    const serviceDefs = getServiceDefs();
    for (const svc of infraServices) {
      if (!serviceDefs[svc]) continue;
      const probe = buildReadinessProbe(svc);
      log('infra', `Waiting for ${svc} on port ${probe.port}`);
      for (let attempt = 0; attempt < probe.maxRetries; attempt++) {
        try {
          await drain(provider.runCommand(sandboxId, `${probe.command} && echo READY`));
          log('infra', `${svc} is ready`);
          break;
        } catch {
          if (attempt === probe.maxRetries - 1) {
            log('infra', `${svc} failed readiness check after ${probe.maxRetries} attempts`);
          }
          await new Promise((r) => setTimeout(r, probe.intervalMs));
        }
      }
    }
  }

  // 3. Install dependencies
  const installCmd = config.install_command ?? 'npm install';
  log('install', `Running: ${installCmd}`);
  await drain(provider.runCommand(sandboxId, installCmd, { cwd: workDir, timeoutMs: 480_000 }));

  // 4. Run pre-start script
  if (config.pre_start_script) {
    log('pre-start', `Running pre-start script`);
    await provider.uploadFiles(sandboxId, [{
      path: '/tmp/verify-prestart.sh',
      content: config.pre_start_script,
    }]);
    await drain(provider.runCommand(sandboxId, 'chmod +x /tmp/verify-prestart.sh && /tmp/verify-prestart.sh', { cwd: workDir }));
  }

  // 5. Start the app
  log('start', `Starting app: ${config.startup_command}`);
  await drain(provider.runCommand(
    sandboxId,
    `nohup ${config.startup_command} > /tmp/server.log 2>&1 & echo $! > /tmp/server.pid`,
    { cwd: workDir },
  ));

  // 6. Health check — poll until 2xx or timeout
  const healthCmd = buildHealthCheckCommand(config.port, config.health_path);
  const maxWaitMs = 60_000;
  const intervalMs = 2_000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const output = await collect(provider.runCommand(sandboxId, healthCmd));
      const lastLine = output[output.length - 1] ?? '';
      // curl -w "%{http_code}" outputs just the status code
      const code = parseInt(lastLine.replace(/[^0-9]/g, ''), 10);
      if (code >= 200 && code < 400) {
        log('health', `App healthy (HTTP ${code})`);
        return { success: true };
      }
    } catch {
      // curl failed — app not ready yet
    }

    // Check if process is still alive
    try {
      await drain(provider.runCommand(sandboxId, 'kill -0 $(cat /tmp/server.pid 2>/dev/null) 2>/dev/null'));
    } catch {
      // Process died
      const logOutput = await collect(
        provider.runCommand(sandboxId, 'tail -30 /tmp/server.log 2>/dev/null || echo "No server log found"')
      );
      return {
        success: false,
        error: 'App process exited unexpectedly',
        serverLog: logOutput.join('\n'),
      };
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  // Timed out
  const logOutput = await collect(
    provider.runCommand(sandboxId, 'tail -30 /tmp/server.log 2>/dev/null || echo "No server log found"')
  );
  return {
    success: false,
    error: `App did not respond on port ${config.port} within ${maxWaitMs / 1000} seconds`,
    serverLog: logOutput.join('\n'),
  };
}
```

**Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/verify/sandbox-setup.test.ts`
Expected: PASS

**Step 5: Type check and commit**

Run: `cd server && npx tsc --noEmit`

```bash
git add server/src/verify/sandbox-setup.ts server/src/verify/sandbox-setup.test.ts
git commit -m "feat: add sandbox setup module (env, infra, deps, app start, health check)"
```

---

## Task 6: PR Comment Formatter

Builds the PR comment markdown for verify results and startup failures.

**Files:**
- Create: `server/src/verify/comment.ts`
- Create: `server/src/verify/comment.test.ts`

**Step 1: Write failing tests**

```typescript
// server/src/verify/comment.test.ts
import { describe, it, expect } from 'vitest';
import { formatVerifyComment, formatStartupFailureComment, formatNoSpecComment, VERIFY_MARKER } from './comment.js';

describe('comment formatter', () => {
  it('formats a full verify report', () => {
    const comment = formatVerifyComment({
      specPath: 'docs/plans/2026-03-12-feature.md',
      port: 3000,
      results: [
        { id: 'AC1', description: 'Page loads', result: 'pass' },
        { id: 'AC2', description: 'Form submits', result: 'fail', expected: 'Success toast', observed: 'Page crashed' },
        { id: 'AC3', description: 'Admin tab', result: 'skipped', reason: 'Setup failed' },
      ],
    });

    expect(comment).toContain(VERIFY_MARKER);
    expect(comment).toContain('AC1');
    expect(comment).toContain('Pass');
    expect(comment).toContain('Fail');
    expect(comment).toContain('Skipped');
    expect(comment).toContain('Page crashed');
  });

  it('formats startup failure comment', () => {
    const comment = formatStartupFailureComment({
      port: 3000,
      error: 'Timed out',
      serverLog: 'Error: EADDRINUSE',
    });

    expect(comment).toContain(VERIFY_MARKER);
    expect(comment).toContain('failed to start');
    expect(comment).toContain('EADDRINUSE');
  });

  it('formats no-spec comment', () => {
    const comment = formatNoSpecComment();
    expect(comment).toContain(VERIFY_MARKER);
    expect(comment).toContain('No spec found');
  });

  it('includes marker for comment update detection', () => {
    const comment = formatVerifyComment({
      specPath: 'test.md',
      port: 3000,
      results: [{ id: 'AC1', description: 'test', result: 'pass' }],
    });
    expect(comment).toContain(VERIFY_MARKER);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/verify/comment.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// server/src/verify/comment.ts

export const VERIFY_MARKER = '<!-- opslane-verify -->';

interface AcResult {
  id: string;
  description: string;
  result: 'pass' | 'fail' | 'skipped';
  expected?: string;
  observed?: string;
  reason?: string;
}

interface VerifyCommentInput {
  specPath: string;
  port: number;
  results: AcResult[];
}

const ICON = { pass: '\u2705', fail: '\u274C', skipped: '\u2298' };
const LABEL = { pass: 'Pass', fail: 'Fail', skipped: 'Skipped' };

export function formatVerifyComment(input: VerifyCommentInput): string {
  const passed = input.results.filter((r) => r.result === 'pass').length;
  const total = input.results.length;

  const rows = input.results
    .map((r) => {
      const suffix = r.result === 'skipped' && r.reason ? ` (${r.reason})` : '';
      return `| ${ICON[r.result]} | ${r.id}: ${r.description} | ${LABEL[r.result]}${suffix} |`;
    })
    .join('\n');

  const details = input.results
    .filter((r) => r.result === 'fail')
    .map((r) => {
      let detail = `**${r.id} — Fail**\n`;
      if (r.expected) detail += `> Expected: ${r.expected}\n`;
      if (r.observed) detail += `> Observed: ${r.observed}\n`;
      return detail;
    })
    .join('\n');

  return `${VERIFY_MARKER}
## Verify Report

**Spec:** \`${input.specPath}\`
**App:** Started on port ${input.port}

### Acceptance Criteria

| | AC | Result |
|---|---|---|
${rows}

${details ? `### Details\n\n${details}` : ''}
---

*${passed} of ${total} criteria passed \u00b7 Powered by Opslane Verify*
`;
}

export function formatStartupFailureComment(input: {
  port: number;
  error: string;
  serverLog: string;
}): string {
  return `${VERIFY_MARKER}
## Verify Report

**Status:** App failed to start

${input.error}

**Server log (last 30 lines):**
\`\`\`
${input.serverLog}
\`\`\`

**Common fixes:**
- Check your startup command in the Opslane dashboard
- Ensure required env vars are configured
- Verify your pre-start script (migrations, etc.) succeeds
`;
}

export function formatNoSpecComment(): string {
  return `${VERIFY_MARKER}
## Verify Report

No spec found for this PR. To enable acceptance testing, add a plan file to \`docs/plans/\` in your PR.

*Powered by Opslane Verify*
`;
}
```

**Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/verify/comment.test.ts`
Expected: PASS

**Step 5: Type check and commit**

Run: `cd server && npx tsc --noEmit`

```bash
git add server/src/verify/comment.ts server/src/verify/comment.test.ts
git commit -m "feat: add PR comment formatter for verify results"
```

---

## Task 7: Verify Pipeline Orchestrator

The main module that wires everything together: spec discovery → sandbox → setup → verify → comment.

**Files:**
- Create: `server/src/verify/pipeline.ts`
- Create: `server/src/verify/pipeline.test.ts`

**Step 1: Write failing test**

This is an integration-seam test — it verifies the pipeline calls the right modules in the right order. We mock the heavy dependencies (sandbox, GitHub API).

```typescript
// server/src/verify/pipeline.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => ({
  findRepoConfig: vi.fn(),
  sql: {},
}));

vi.mock('../github/app-service.js', () => ({
  GitHubAppService: vi.fn().mockImplementation(() => ({
    getTokenForRepo: vi.fn().mockResolvedValue('test-token'),
  })),
}));

vi.mock('../github/pr.js', () => ({
  fetchPullRequest: vi.fn().mockResolvedValue({
    title: 'Test PR',
    body: '',
    headBranch: 'feature',
    baseBranch: 'main',
    headSha: 'abc123',
    diff: 'diff content',
    cloneUrl: 'https://github.com/org/repo.git',
  }),
}));

import { findRepoConfig } from '../db.js';

describe('verify pipeline', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns no-spec result when no repo config exists', async () => {
    (findRepoConfig as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { runVerifyPipeline } = await import('./pipeline.js');
    const result = await runVerifyPipeline(
      { owner: 'org', repo: 'app', prNumber: 1 },
      { log: () => {} },
    );

    expect(result.mode).toBe('no-config');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/verify/pipeline.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// server/src/verify/pipeline.ts
import { GitHubAppService } from '../github/app-service.js';
import { fetchPrChangedFiles } from '../github/pr.js';
import { findRepoConfig } from '../db.js';
import { E2BSandboxProvider } from '../sandbox/e2b-provider.js';
import { requireEnv } from '../env.js';
import { discoverSpec } from './spec-discovery.js';
import { setupSandbox } from './sandbox-setup.js';
import { formatVerifyComment, formatStartupFailureComment, formatNoSpecComment, VERIFY_MARKER } from './comment.js';

const VERIFY_TEMPLATE = process.env.E2B_VERIFY_TEMPLATE ?? 'opslane-verify-v2';
const VERIFY_TIMEOUT_MS = 600_000; // 10 minutes total sandbox lifetime
const SAFE_BRANCH_RE = /^[a-zA-Z0-9._\-/]+$/;

export interface VerifyPipelineInput {
  owner: string;
  repo: string;
  prNumber: number;
}

interface VerifyCallbacks {
  log: (step: string, message: string, data?: unknown) => void;
}

type VerifyResult =
  | { mode: 'no-config' }
  | { mode: 'no-spec'; commentUrl?: string }
  | { mode: 'startup-failed'; commentUrl?: string }
  | { mode: 'verified'; commentUrl?: string; passed: number; total: number };

export async function runVerifyPipeline(
  input: VerifyPipelineInput,
  callbacks: VerifyCallbacks,
): Promise<VerifyResult> {
  const { owner, repo, prNumber } = input;
  const log = callbacks.log;

  // 1. Check repo config exists
  const config = await findRepoConfig(owner, repo);
  if (!config) {
    log('config', 'No repo config found — skipping verify');
    return { mode: 'no-config' };
  }

  // 2. Get GitHub token
  const appService = new GitHubAppService(
    requireEnv('GITHUB_APP_ID'),
    requireEnv('GITHUB_APP_PRIVATE_KEY'),
  );
  const token = await appService.getTokenForRepo(owner, repo);

  // 3. Fetch PR metadata + changed files
  const changedFiles = await fetchPrChangedFiles(owner, repo, prNumber, token);
  const prMeta = await fetchPullRequest(owner, repo, prNumber, token);

  // 4. Spec discovery
  const spec = await discoverSpec({
    owner, repo, prNumber, token,
    changedFiles,
    prBody: prMeta.body ?? '',
  });

  if (spec.type === 'no-spec') {
    log('spec', 'No spec found — posting no-spec comment');
    // TODO: post formatNoSpecComment() as PR comment
    return { mode: 'no-spec' };
  }

  // 5. Validate branch name
  if (!SAFE_BRANCH_RE.test(prMeta.headBranch)) {
    throw new Error(`Unsafe branch name: ${prMeta.headBranch}`);
  }

  // 6. Spin up sandbox
  log('sandbox', 'Creating E2B sandbox');
  const provider = new E2BSandboxProvider();
  const sandbox = await provider.create({
    template: VERIFY_TEMPLATE,
    timeoutMs: VERIFY_TIMEOUT_MS,
    envVars: {
      ANTHROPIC_API_KEY: requireEnv('ANTHROPIC_API_KEY'),
      GIT_TERMINAL_PROMPT: '0',
      PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
    },
    metadata: { sessionId: `verify-${owner}-${repo}-${prNumber}`, userId: 'system' },
  });

  try {
    // 7. Clone repo
    log('clone', `Cloning ${owner}/${repo}@${prMeta.headBranch}`);
    const authCloneUrl = prMeta.cloneUrl.replace(
      'https://github.com/',
      `https://x-access-token:${token}@github.com/`,
    );
    await drain(provider.runCommand(
      sandbox.id,
      `git clone --depth=1 --branch '${prMeta.headBranch}' '${authCloneUrl}' /home/user/repo`,
    ));

    // 8. If plan-file spec, fetch its content from the cloned repo
    let specContent: string;
    if (spec.type === 'plan-file') {
      const lines = await collect(provider.runCommand(sandbox.id, `cat /home/user/repo/${spec.specPath}`));
      specContent = lines.join('\n');
    } else {
      specContent = spec.specContent;
    }

    // 9. Setup sandbox (env, infra, deps, start app)
    log('setup', 'Setting up sandbox');
    const setupResult = await setupSandbox(provider, sandbox.id, config, log);

    if (!setupResult.success) {
      log('setup', `Setup failed: ${setupResult.error}`);
      const comment = formatStartupFailureComment({
        port: config.port,
        error: setupResult.error ?? 'Unknown error',
        serverLog: setupResult.serverLog ?? 'No log available',
      });
      // TODO: post comment to PR
      return { mode: 'startup-failed' };
    }

    // 10. Run verify pipeline stages (planner → agents → judge)
    // TODO: Implement in Task 8 — this is the browser agent orchestration
    log('verify', 'Running verify pipeline (planner → agents → judge)');

    // Placeholder — will be implemented in Task 8
    return { mode: 'verified', passed: 0, total: 0 };

  } finally {
    log('cleanup', 'Destroying sandbox');
    await provider.destroy(sandbox.id);
  }
}

async function drain(stream: AsyncIterable<string>): Promise<void> {
  for await (const _ of stream) { /* consume */ }
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of stream) { lines.push(line); }
  return lines;
}
```

**Note:** This module has a `TODO` for the browser agent orchestration (Task 8) and posting PR comments. The PR comment posting will reuse the existing `createPrReview` pattern from `server/src/github/pr.ts` but adapted to post issue comments instead of review comments.

**Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/verify/pipeline.test.ts`
Expected: PASS

**Step 5: Type check and commit**

Run: `cd server && npx tsc --noEmit`

```bash
git add server/src/verify/pipeline.ts server/src/verify/pipeline.test.ts
git commit -m "feat: add verify pipeline orchestrator (spec → sandbox → setup → verify)"
```

---

## Task 8: Browser Agent (Claude Tool-Use Loop)

Port the browser agent from opslane-v2. Runs Claude with Playwright tool-use to interact with the app.

**Files:**
- Create: `server/src/verify/browser-agent.ts`
- Create: `server/src/verify/browser-agent.test.ts`

**Reference:** Port from `/Users/abhishekray/Projects/opslane/opslane-v2/apps/api/src/verify/browser-agent.ts`

**Step 1: Write failing test**

```typescript
// server/src/verify/browser-agent.test.ts
import { describe, it, expect } from 'vitest';
import { buildBrowserAgentPrompt, BROWSER_TOOLS } from './browser-agent.js';

describe('browser-agent', () => {
  it('includes goal in system prompt', () => {
    const prompt = buildBrowserAgentPrompt({
      goal: 'Verify login page loads',
      baseUrl: 'http://localhost:3000',
    });
    expect(prompt).toContain('Verify login page loads');
    expect(prompt).toContain('http://localhost:3000');
  });

  it('includes test credentials when provided', () => {
    const prompt = buildBrowserAgentPrompt({
      goal: 'Verify dashboard',
      baseUrl: 'http://localhost:3000',
      testEmail: 'test@example.com',
      testPassword: 'password123',
    });
    expect(prompt).toContain('test@example.com');
    expect(prompt).toContain('password123');
  });

  it('exports browser tools array', () => {
    expect(BROWSER_TOOLS).toBeDefined();
    expect(BROWSER_TOOLS.length).toBeGreaterThan(0);
    const toolNames = BROWSER_TOOLS.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('snapshot');
    expect(toolNames).toContain('navigate');
    expect(toolNames).toContain('click');
    expect(toolNames).toContain('done');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/verify/browser-agent.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

This is a substantial module — port the core loop from opslane-v2's `browser-agent.ts`, adapted to run inside the E2B sandbox (commands executed via `SandboxProvider.runCommand` instead of local `execFile`).

The browser agent runs Claude with tool-use. Claude calls tools (navigate, click, fill, screenshot, done) and the agent dispatches them as commands inside the sandbox. The agent continues until Claude calls `done` or hits `maxTurns`.

Since this module interacts with the Anthropic API and E2B sandbox, the full integration will be tested end-to-end. The unit test above covers the prompt builder and tool definitions.

**Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/verify/browser-agent.test.ts`
Expected: PASS

**Step 5: Type check and commit**

Run: `cd server && npx tsc --noEmit`

```bash
git add server/src/verify/browser-agent.ts server/src/verify/browser-agent.test.ts
git commit -m "feat: add browser agent (Claude tool-use loop with Playwright)"
```

---

## Task 9: Verify Trigger.dev Task + Webhook Wiring

Create the `verify-pr` Trigger.dev task and wire it into the webhook handler alongside the existing `review-pr` task.

**Files:**
- Create: `server/src/verify/runner.ts`
- Modify: `server/src/routes/webhooks.ts` — add `issue_comment` handler, dispatch verify task

**Step 1: Write the Trigger.dev task**

```typescript
// server/src/verify/runner.ts
import { task } from '@trigger.dev/sdk/v3';
import { logger } from '@trigger.dev/sdk/v3';
import { runVerifyPipeline } from './pipeline.js';

export interface VerifyPayload {
  owner: string;
  repo: string;
  prNumber: number;
  deliveryId: string;
}

export const verifyPrTask = task({
  id: 'verify-pr',
  maxDuration: 600,
  run: async (payload: VerifyPayload) => {
    const log = (step: string, message: string, data?: unknown) => {
      logger.info(`[${step}] ${message}`, data ? { data } : undefined);
    };

    const result = await runVerifyPipeline(
      { owner: payload.owner, repo: payload.repo, prNumber: payload.prNumber },
      { log },
    );

    return result;
  },
});
```

**Step 2: Write failing test for `issue_comment` webhook handler**

```typescript
// Add to server/src/routes/webhooks.test.ts

describe('issue_comment event', () => {
  it('triggers verify on /verify comment from authorized user', async () => {
    // Test that POST /github with X-GitHub-Event: issue_comment
    // and body containing "/verify" dispatches the verify task
    // ... (follows existing webhook test patterns with HMAC signature)
  });

  it('ignores non-/verify comments', async () => {
    // ...
  });

  it('rejects comments from unauthorized users', async () => {
    // ...
  });
});
```

**Step 3: Add `issue_comment` handler to webhooks.ts**

Add a new branch in the webhook handler (after the `pull_request` branch) that:
1. Checks `event === 'issue_comment'`
2. Verifies HMAC signature (same as `installation` events — these come directly from GitHub, not Svix)
3. Parses payload, checks `action === 'created'` and comment body is `/verify`
4. Checks the issue has a `pull_request` URL (only PR comments, not issue comments)
5. Checks commenter authorization via GitHub collaborators API
6. Dispatches `verifyPrTask` via Trigger.dev

**Step 4: Wire verify dispatch into `pull_request` handler**

In the existing `pull_request` handler, after the current `reviewPrTask` dispatch, add a check:
1. Look up `findRepoConfig(owner, repo)`
2. If config exists, also dispatch `verifyPrTask`
3. Both tasks run independently (review + verify in parallel)

**Step 5: Run tests**

Run: `cd server && npx vitest run src/routes/webhooks.test.ts`
Expected: PASS

**Step 6: Type check and commit**

Run: `cd server && npx tsc --noEmit`

```bash
git add server/src/verify/runner.ts server/src/routes/webhooks.ts server/src/routes/webhooks.test.ts
git commit -m "feat: add verify-pr Trigger.dev task and issue_comment webhook handler"
```

---

## Task 10: GitHub PR Helper — Fetch Changed Files + Post Issue Comment

The verify pipeline needs two GitHub API operations not yet in `pr.ts`: fetching the list of changed files, and posting/updating an issue comment (not a review comment).

**Files:**
- Modify: `server/src/github/pr.ts` — add `fetchPrChangedFiles`, `postOrUpdateComment`
- Modify: `server/src/github/pr.test.ts` — add tests

**Step 1: Write failing tests**

```typescript
// Add to server/src/github/pr.test.ts

describe('fetchPrChangedFiles', () => {
  it('returns list of changed files with status', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify([
      { filename: 'src/index.ts', status: 'modified' },
      { filename: 'docs/plans/plan.md', status: 'added' },
    ])));

    const { fetchPrChangedFiles } = await import('./pr.js');
    const files = await fetchPrChangedFiles('org', 'repo', 1, 'token');
    expect(files).toHaveLength(2);
    expect(files[0].filename).toBe('src/index.ts');
  });
});

describe('postOrUpdateComment', () => {
  it('creates new comment when no existing marker found', async () => {
    // Mock list comments (empty)
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify([])));
    // Mock create comment
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      html_url: 'https://github.com/org/repo/pull/1#issuecomment-123',
    })));

    const { postOrUpdateComment } = await import('./pr.js');
    const url = await postOrUpdateComment('org', 'repo', 1, '<!-- marker -->body', '<!-- marker -->', 'token');
    expect(url).toContain('issuecomment');
  });

  it('updates existing comment when marker found', async () => {
    // Mock list comments (has existing)
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify([
      { id: 456, body: '<!-- marker -->\nold content' },
    ])));
    // Mock update comment
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      html_url: 'https://github.com/org/repo/pull/1#issuecomment-456',
    })));

    const { postOrUpdateComment } = await import('./pr.js');
    const url = await postOrUpdateComment('org', 'repo', 1, '<!-- marker -->new', '<!-- marker -->', 'token');
    expect(url).toContain('issuecomment-456');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/github/pr.test.ts`
Expected: FAIL — functions not exported

**Step 3: Implement**

Add to `server/src/github/pr.ts`:

```typescript
export async function fetchPrChangedFiles(
  owner: string, repo: string, prNumber: number, token: string
): Promise<Array<{ filename: string; status: string }>> {
  validateOwnerRepo(owner, repo);
  validatePrNumber(prNumber);
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
  );
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const files = await res.json() as Array<{ filename: string; status: string }>;
  return files.map((f) => ({ filename: f.filename, status: f.status }));
}

export async function postOrUpdateComment(
  owner: string, repo: string, prNumber: number,
  body: string, marker: string, token: string,
): Promise<string> {
  validateOwnerRepo(owner, repo);
  validatePrNumber(prNumber);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };

  // Check for existing comment with marker
  const listRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`,
    { headers },
  );
  const comments = await listRes.json() as Array<{ id: number; body: string }>;
  const existing = comments.find((c) => c.body.includes(marker));

  if (existing) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/comments/${existing.id}`,
      { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) },
    );
    const data = await res.json() as { html_url: string };
    return data.html_url;
  }

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) },
  );
  const data = await res.json() as { html_url: string };
  return data.html_url;
}
```

**Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/github/pr.test.ts`
Expected: PASS

**Step 5: Type check and commit**

Run: `cd server && npx tsc --noEmit`

```bash
git add server/src/github/pr.ts server/src/github/pr.test.ts
git commit -m "feat: add fetchPrChangedFiles and postOrUpdateComment GitHub helpers"
```

---

## Task 11: E2B Template for Verify

Create the E2B sandbox template with Postgres, Redis, Node.js, Playwright pre-installed.

**Files:**
- Create: `server/e2b-templates/verify/Dockerfile`
- Create: `server/e2b-templates/verify/entrypoint.sh`
- Create: `server/e2b-templates/verify/e2b.toml`

**Step 1: Create Dockerfile**

Port from opslane-v2's `e2b-templates/verify-v2/Dockerfile`. Key changes: none — the template is the same. Postgres 16, Redis, Node 22, pnpm, yarn, bun, Playwright + Chromium.

**Step 2: Create entrypoint.sh**

Port from opslane-v2's `e2b-templates/verify-v2/entrypoint.sh`. Starts Postgres, creates `app` database, starts Redis, then `sleep infinity`.

**Step 3: Create e2b.toml**

```toml
memory_mb = 4_096
cpu_count = 2
dockerfile = "Dockerfile"
template_name = "opslane-verify"
```

**Step 4: Build and register template**

Run: `cd server/e2b-templates/verify && e2b template build`
Expected: Template built successfully, template ID printed.

**Step 5: Update `E2B_VERIFY_TEMPLATE` env var** in deployment config to match the new template ID.

**Step 6: Commit**

```bash
git add server/e2b-templates/verify/
git commit -m "feat: add E2B sandbox template for verify (Postgres, Redis, Node, Playwright)"
```

---

## Task 12: Wire PR Comments into Pipeline

Update the verify pipeline to actually post PR comments using `postOrUpdateComment`.

**Files:**
- Modify: `server/src/verify/pipeline.ts` — replace TODO comments with actual PR comment posting

**Step 1: Import and use `postOrUpdateComment` and `VERIFY_MARKER`**

At each point where the pipeline has a `// TODO: post comment`, replace with:

```typescript
import { postOrUpdateComment } from '../github/pr.js';
import { VERIFY_MARKER } from './comment.js';

// In the no-spec branch:
const commentBody = formatNoSpecComment();
const commentUrl = await postOrUpdateComment(owner, repo, prNumber, commentBody, VERIFY_MARKER, token);

// In the startup-failed branch:
const commentBody = formatStartupFailureComment({ port, error, serverLog });
const commentUrl = await postOrUpdateComment(owner, repo, prNumber, commentBody, VERIFY_MARKER, token);

// In the verified branch:
const commentBody = formatVerifyComment({ specPath, port, results });
const commentUrl = await postOrUpdateComment(owner, repo, prNumber, commentBody, VERIFY_MARKER, token);
```

**Step 2: Run all tests**

Run: `cd server && npx vitest run`
Expected: PASS

**Step 3: Type check and commit**

Run: `cd server && npx tsc --noEmit`

```bash
git add server/src/verify/pipeline.ts
git commit -m "feat: wire PR comment posting into verify pipeline"
```

---

## Execution Order

Tasks can be parallelized where there are no dependencies:

```
Task 1 (crypto) ─────────────────┐
Task 2 (DB migration + helpers) ──┤
Task 3 (spec discovery) ──────────┼── all independent, can run in parallel
Task 4 (infra services) ──────────┤
Task 6 (comment formatter) ───────┘
                                   │
Task 5 (sandbox setup) ───────────── depends on: Task 1, Task 4
Task 10 (PR helpers) ─────────────── depends on: nothing (can parallel with above)
                                   │
Task 7 (pipeline orchestrator) ──── depends on: Task 2, 3, 5, 6, 10
Task 8 (browser agent) ──────────── depends on: nothing (interface-only dependency)
                                   │
Task 9 (Trigger.dev + webhooks) ─── depends on: Task 7, 8
Task 11 (E2B template) ──────────── depends on: nothing (infra, can do anytime)
Task 12 (wire comments) ─────────── depends on: Task 7, 10
```

**Critical path:** Tasks 1 → 5 → 7 → 9 → 12
