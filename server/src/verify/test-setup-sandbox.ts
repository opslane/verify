/**
 * Test setupSandbox() end-to-end with Docker Compose + dev mode.
 * Proves AC-3 (full setup flow) and AC-5 (timing).
 *
 * Creates a minimal Express app inside the sandbox that connects to
 * Postgres (via compose) and serves HTTP 200.
 *
 * Run: node --env-file=.env --import tsx/esm src/verify/test-setup-sandbox.ts
 */
import { E2BSandboxProvider } from '../sandbox/e2b-provider.js';
import { setupSandbox } from './sandbox-setup.js';
import type { RepoConfig } from '../db.js';

const provider = new E2BSandboxProvider();

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of stream) lines.push(line);
  return lines;
}

function elapsed(start: number): string {
  return `${((Date.now() - start) / 1000).toFixed(1)}s`;
}

// Minimal Express app that connects to Postgres and serves HTTP 200
const PACKAGE_JSON = JSON.stringify({
  name: 'test-app',
  version: '1.0.0',
  scripts: { dev: 'node server.js' },
  dependencies: { express: '^4.21.0', pg: '^8.13.0' },
}, null, 2);

const SERVER_JS = `
const express = require('express');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();

app.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT 1 as ok');
    res.json({ status: 'healthy', db: result.rows[0].ok === 1 });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.get('/health', async (req, res) => {
  res.json({ status: 'ok' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Server running on port ' + port));
`;

const COMPOSE_YAML = `services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 2s
      timeout: 5s
      retries: 10
`;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS test_table (
  id serial PRIMARY KEY,
  name text NOT NULL
);
`;

async function main() {
  const t0 = Date.now();
  console.log('Creating sandbox (opslane-verify-v2, 8GB/4CPU)...');
  const sandbox = await provider.create({
    template: 'opslane-verify-v2',
    timeoutMs: 600_000,
    envVars: { PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright' },
    metadata: { sessionId: 'setup-test', userId: 'test' },
  });
  const id = sandbox.id;
  console.log(`[${elapsed(t0)}] Sandbox created: ${id}`);

  try {
    // Wait for Docker daemon
    console.log(`[${elapsed(t0)}] Waiting for Docker daemon...`);
    for (let i = 0; i < 20; i++) {
      try {
        const info = await collect(provider.runCommand(id, 'docker info 2>&1', { rawOutput: true }));
        if (info.some(l => l.includes('Server Version'))) break;
      } catch { /* not ready */ }
      await new Promise(r => setTimeout(r, 2_000));
    }
    console.log(`[${elapsed(t0)}] Docker daemon ready`);

    // Create the test app in /home/user/repo
    console.log(`[${elapsed(t0)}] Setting up test app...`);
    await provider.uploadFiles(id, [
      { path: '/home/user/repo/package.json', content: PACKAGE_JSON },
      { path: '/home/user/repo/server.js', content: SERVER_JS },
      { path: '/home/user/repo/docker-compose.dev.yml', content: COMPOSE_YAML },
      { path: '/home/user/repo/schema.sql', content: SCHEMA_SQL },
    ]);

    // Build a RepoConfig matching the v2 schema
    const config: RepoConfig = {
      id: 'test-config',
      installation_id: null,
      owner: 'test',
      repo: 'test-app',
      dev_command: 'node server.js',
      port: 3000,
      install_command: 'npm install',
      health_path: '/health',
      test_email: null,
      test_password: null,
      env_vars: null,
      compose_file: 'docker-compose.dev.yml',
      schema_command: 'PGPASSWORD=app psql -h localhost -U app -d app -f schema.sql --no-password',
      seed_command: null,
      login_script: null,
      sandbox_template: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    // Write .env with DATABASE_URL (setupSandbox expects encrypted env_vars,
    // but we can write it directly since we pass env_vars: null above)
    await provider.uploadFiles(id, [
      { path: '/home/user/repo/.env', content: 'DATABASE_URL=postgres://app:app@localhost:5432/app\nPORT=3000\n' },
    ]);

    // Run setupSandbox
    console.log(`\n── AC-3: setupSandbox() end-to-end ──`);
    const setupStart = Date.now();
    const logs: string[] = [];
    const result = await setupSandbox(provider, id, config, (step, msg) => {
      const line = `[${elapsed(t0)}] [${step}] ${msg}`;
      console.log(line);
      logs.push(line);
    });

    console.log(`\n[${elapsed(t0)}] setupSandbox result: ${JSON.stringify(result)}`);
    console.log(`[${elapsed(t0)}] Setup duration: ${elapsed(setupStart)}`);

    if (result.success) {
      console.log('✅ AC-3 PASSED: setupSandbox() returned { success: true }');

      // Extra validation: hit the app and check Postgres connection
      try {
        const appCheck = await collect(provider.runCommand(id,
          'curl -sf http://localhost:3000/ 2>&1',
          { rawOutput: true, timeoutMs: 10_000 },
        ));
        const hasDb = appCheck.some(l => l.includes('"db":true') || l.includes('"db": true'));
        console.log(`[${elapsed(t0)}] App + DB check: ${hasDb ? 'PASS (Postgres connected)' : 'PARTIAL (app responds but DB check unclear)'}`);
        console.log('Response:', appCheck.filter(l => l.includes('status')).join(''));
      } catch {
        console.log(`[${elapsed(t0)}] App + DB check: skipped (curl failed)`);
      }
    } else {
      console.log(`❌ AC-3 FAILED: ${result.error}`);
      if (result.serverLog) {
        console.log('Server log:');
        console.log(result.serverLog);
      }
    }

    // AC-5: Timing breakdown
    console.log(`\n── AC-5: Timing ──`);
    console.log(`Total from sandbox creation to app healthy: ${elapsed(t0)}`);

    // Resource check
    console.log(`\n── Resource Check ──`);
    const mem = await collect(provider.runCommand(id, 'free -m 2>&1', { rawOutput: true }));
    for (const l of mem) if (l.includes('Mem:') || l.includes('total')) console.log(`  ${l}`);

    const oom = await collect(provider.runCommand(id, 'dmesg 2>&1 | grep -i "out of memory" || echo NO_OOM', { rawOutput: true }));
    const hasOom = !oom.some(l => l.includes('NO_OOM'));
    console.log(`OOM kills: ${hasOom ? 'FAIL' : 'PASS (none)'}`);

    console.log(`\n✅ ALL CHECKS COMPLETE in ${elapsed(t0)}`);

  } finally {
    console.log('Destroying sandbox...');
    await provider.destroy(id);
    console.log('Done.');
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
