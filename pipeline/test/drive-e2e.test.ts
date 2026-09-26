import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { validateCriteria } from '../src/lib/criteria.js';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(pkgRoot, 'src', 'cli.ts');
let server: Server | undefined;
const savedEnv = { ...process.env };

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  process.env = { ...savedEnv };
});

function runCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['--no-install', 'tsx', cli, ...args], {
      cwd: pkgRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`cli exited ${code}: ${stderr}`));
    });
  });
}

function baseCriterion(id: string) {
  return {
    id,
    title: `${id} behavior`,
    doIt: 'send a marked request and observe storage',
    expectIt: 'the public behavior and stored data agree',
    source: { kind: 'plan', ref: id, quote: `${id} text` },
    why: 'fixture',
    intent: 'changes',
    baseline: 'fail',
    witness: 'success',
    dependsOn: ['api', 'db'],
  };
}

async function fixture() {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => {
      if (req.url === '/refuse') {
        res.statusCode = 401;
        res.end(`refused ${body}`);
      } else if (req.url === '/ready') {
        res.end('ready');
      } else {
        res.end(`accepted ${body}`);
      }
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');

  const repo = mkdtempSync(join(tmpdir(), 'verify-drive-e2e-'));
  const verifyDir = join(repo, '.verify');
  const runDir = join(verifyDir, 'runs', 'r1');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(verifyDir, 'current-run'), 'r1\n');
  writeFileSync(join(verifyDir, 'run-env.json'), JSON.stringify({ run_id: 'r1', marker: 'verify-m1' }));
  writeFileSync(join(verifyDir, 'setup.json'), JSON.stringify({
    mode: 'none', base_url: `http://127.0.0.1:${address.port}`,
    auth: { header: '', value_env: '' }, observe: { db_url_env: 'TESTDB' },
  }));
  writeFileSync(join(repo, 'event.json'), '{"marker":"{{marker}}"}\n');
  const criteria = [
    {
      ...baseCriterion('AC1'),
      drive: [
        { verb: 'http', args: ['POST', '/happy', '--json', '@event.json'] },
        { verb: 'wait', args: ['--url', '/ready', '--contains', 'ready', '--timeout', '5'] },
        { verb: 'db', args: ['select happy marker {{marker}}'] },
      ],
      proof: { kind: 'marker-in-data', detail: 'created row', step: 3, expect: 'present' },
    },
    {
      ...baseCriterion('AC2'),
      witness: 'refusal',
      drive: [
        { verb: 'http', args: ['POST', '/refuse', '--json', '{"marker":"{{marker}}"}', '--expect-status', '401'] },
        { verb: 'db', args: ['select refusal marker {{marker}}'] },
      ],
      proof: { kind: 'marker-in-data', detail: 'no created row', step: 2, expect: 'absent' },
    },
  ];
  writeFileSync(join(runDir, 'criteria.json'), JSON.stringify({ criteria }));
  writeFileSync(join(runDir, 'precheck.json'), JSON.stringify({
    parts: { api: 'ok', db: 'ok' }, tainted: {}, unchecked: [],
  }));
  const results = join(runDir, 'results.json');
  writeFileSync(results, JSON.stringify({
    results: criteria.map(({ id }) => ({ id, outcome: 'pass', proofSeen: false, observed: 'behavior matched' })),
    coverage: { filesWithoutCriterion: 0 }, notChecked: [],
  }));

  const stubDir = mkdtempSync(join(tmpdir(), 'verify-drive-e2e-psql-'));
  const psql = join(stubDir, 'psql');
  writeFileSync(psql, `#!/bin/sh\ncase "$5" in\n  *happy*) printf 'row verify-m1\\n' ;;\n  *refusal*) : ;;\nesac\n`);
  chmodSync(psql, 0o755);
  process.env.PATH = `${stubDir}:${savedEnv.PATH ?? ''}`;
  process.env.TESTDB = 'postgres://test:test@localhost/test';
  return { repo, runDir, results };
}

describe('drive CLI end to end', () => {
  it('receipts successful and refused flows without crossing proof channels', async () => {
    const { repo, runDir, results } = await fixture();
    const happy = JSON.parse(await runCli(['drive', 'AC1', '--repo-root', repo, '--run-dir', runDir]));
    expect(happy).toMatchObject({ finalized: true, proof: { result: 'present', seen: true } });
    const refusal = JSON.parse(await runCli(['drive', 'AC2', '--repo-root', repo, '--run-dir', runDir]));
    expect(refusal).toMatchObject({ finalized: true, proof: { result: 'absent', seen: true } });

    const refusalDir = join(runDir, 'evidence', 'AC2', refusal.attempt);
    const refusalReceipt = JSON.parse(readFileSync(join(refusalDir, 'step-1.json'), 'utf8'));
    expect(refusalReceipt.diagnostics).toContain('verify-m1');
    expect(refusalReceipt).toMatchObject({ output: '', proofEligible: false });

    const report = await runCli(['report', '--repo-root', repo, '--run-dir', runDir, '--results', results]);
    expect(report).toContain('PASS — 2 of 2 proven.');
    expect(report).toMatch(/^AC1.*\[machine-checked\].*receipt trail \(3 steps\)$/m);
    expect(report).toMatch(/^AC2.*\[machine-checked\].*receipt trail \(2 steps\)$/m);

    const outputPath = (await runCli(['html', '--repo-root', repo, '--run-dir', runDir, '--results', results])).trim();
    expect(outputPath).toBe(join(runDir, 'report.html'));
    expect(readFileSync(outputPath, 'utf8')).toContain('machine-checked');
    expect(readFileSync(outputPath, 'utf8')).toContain('recorded invocation');
  }, 20_000);

  it('drives with the contract env file, the same values boot and precheck used', async () => {
    const { repo, runDir } = await fixture();
    const address = server!.address();
    if (!address || typeof address === 'string') throw new Error('missing server address');
    // The documented contract: the port and the DSN live in env_file, not in
    // the shell that runs the engine. A stale shell value must not win either.
    writeFileSync(join(repo, '.verify', 'setup.json'), JSON.stringify({
      mode: 'none', base_url: 'http://127.0.0.1:${VERIFY_E2E_PORT:-9}', env_file: '.env.verify',
      auth: { header: '', value_env: '' }, observe: { db_url_env: 'TESTDB' },
    }));
    writeFileSync(join(repo, '.env.verify'),
      `# throwaway stack\nVERIFY_E2E_PORT=${address.port}\nTESTDB="postgres://file:file@localhost/throwaway"\n`);
    delete process.env.TESTDB;
    process.env.VERIFY_E2E_PORT = '9';

    const happy = JSON.parse(await runCli(['drive', 'AC1', '--repo-root', repo, '--run-dir', runDir]));
    expect(happy.steps.map((step: { state: string }) => step.state)).toEqual(['completed', 'completed', 'completed']);
    expect(happy).toMatchObject({ finalized: true, proof: { result: 'present', seen: true } });
    const dbReceipt = JSON.parse(readFileSync(join(runDir, 'evidence', 'AC1', happy.attempt, 'step-3.json'), 'utf8'));
    expect(JSON.stringify(dbReceipt)).not.toContain('file:file');
  }, 20_000);

  it('structurally rejects a refusal-status HTTP step as proof', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-invalid-refusal-'));
    const fixturePath = join(dir, 'criteria.json');
    writeFileSync(fixturePath, JSON.stringify({ criteria: [{
      ...baseCriterion('AC1'),
      drive: [{ verb: 'http', args: ['POST', '/refuse', '--expect-status', '401'] }],
      proof: { kind: 'marker-in-data', detail: 'refusal body', step: 1 },
    }] }));
    const input = JSON.parse(readFileSync(fixturePath, 'utf8'));
    expect(validateCriteria(input.criteria).join('\n')).toContain('cannot be a proof step');
  });
});
