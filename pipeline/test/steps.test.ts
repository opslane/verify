import { createServer, type Server } from 'node:http';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterEach } from 'vitest';
import {
  execCapture,
  OUTPUT_LIMIT,
  runDb,
  runHttp,
  runRun,
  runWait,
  truncateBytes,
  type StepContext,
} from '../src/lib/steps.js';

let server: Server | undefined;
const savedEnv = { ...process.env };

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  process.env = { ...savedEnv };
});

async function listen(handler: Parameters<typeof createServer>[0]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
  return `http://127.0.0.1:${address.port}`;
}

function context(baseUrl: string, overrides: Partial<StepContext> = {}): StepContext {
  return {
    baseUrl,
    repoRoot: mkdtempSync(`${tmpdir()}/verify-steps-`),
    timeoutSeconds: 5,
    ...overrides,
  };
}

function installPsql(body: string): string {
  const dir = mkdtempSync(`${tmpdir()}/verify-psql-`);
  const executable = `${dir}/psql`;
  writeFileSync(executable, `#!/bin/sh\n${body}\n`);
  chmodSync(executable, 0o755);
  process.env.PATH = `${dir}:${savedEnv.PATH ?? ''}`;
  return dir;
}

describe('http receipts', () => {
  it('captures a successful proof body while redacting authentication', async () => {
    process.env.VERIFY_TEST_TOKEN = 'Bearer secret-value';
    const baseUrl = await listen((req, res) => {
      expect(req.headers.authorization).toBe('Bearer secret-value');
      res.end('row verify-m1');
    });
    const receipt = await runHttp(
      ['POST', '/events', '--json', '{"marker":"verify-m1"}'],
      context(baseUrl, { authHeader: 'Authorization', authValueEnv: 'VERIFY_TEST_TOKEN' }),
    );
    expect(receipt.state).toBe('completed');
    expect(receipt.output).toBe('row verify-m1');
    expect(receipt.proofEligible).toBe(true);
    expect(receipt.request?.body).toBe('{"marker":"verify-m1"}');
    expect(JSON.stringify(receipt)).toContain('[redacted]');
    expect(JSON.stringify(receipt)).not.toContain('secret-value');
  });

  it('keeps an expected refusal body in diagnostics and out of proof', async () => {
    const baseUrl = await listen((_req, res) => {
      res.statusCode = 401;
      res.end('echo verify-m1');
    });
    const receipt = await runHttp(['POST', '/', '--expect-status', '401'], context(baseUrl));
    expect(receipt).toMatchObject({ state: 'completed', proofEligible: false, output: '', status: 401 });
    expect(receipt.diagnostics).toContain('verify-m1');
  });

  it('reports an unexpected server response as a command error', async () => {
    const baseUrl = await listen((_req, res) => {
      res.statusCode = 500;
      res.end('broken');
    });
    const receipt = await runHttp(['GET', '/'], context(baseUrl));
    expect(receipt.state).toBe('command-error');
    expect(receipt.diagnostics).toContain('broken');
  });

  it('reports a dead socket as a command error', async () => {
    const receipt = await runHttp(['GET', '/'], context('http://127.0.0.1:1'));
    expect(receipt.state).toBe('command-error');
  });

  it('times out a hanging request', async () => {
    const baseUrl = await listen(() => undefined);
    const receipt = await runHttp(['GET', '/'], context(baseUrl, { timeoutSeconds: 1 }));
    expect(receipt.state).toBe('timeout');
  }, 15_000);
});

describe('capture primitives', () => {
  it('truncates multibyte content by bytes', () => {
    const result = truncateBytes('é'.repeat(OUTPUT_LIMIT));
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(OUTPUT_LIMIT);
  });

  it('returns a nonzero exit without throwing', async () => {
    const result = await execCapture(['node', '-e', 'process.exit(3)'], { cwd: process.cwd(), timeoutMs: 5_000 });
    expect(result).toMatchObject({ exit: 3, timedOut: false });
  });

  it('distinguishes a missing executable from a timeout', async () => {
    const result = await execCapture(['definitely-not-a-real-verify-binary'], { cwd: process.cwd(), timeoutMs: 5_000 });
    expect(result.startFailed).toBeTruthy();
    expect(result.timedOut).toBe(false);
  });

  it('kills a process when its budget expires', async () => {
    const result = await execCapture(['node', '-e', 'setInterval(() => {}, 1000)'], {
      cwd: process.cwd(),
      timeoutMs: 500,
    });
    expect(result.timedOut).toBe(true);
  }, 10_000);
});

describe('db receipts', () => {
  it('runs psql read-only and uses stdout as the proof channel', async () => {
    installPsql(`printf 'row verify-m1\\n'\nprintf '%s\\n' "$PGOPTIONS" >&2`);
    process.env.TESTDB = 'postgres://user:secret@localhost/test';
    const receipt = await runDb(['select marker from rows'], context('', { dbUrlEnv: 'TESTDB' }));
    expect(receipt).toMatchObject({ state: 'completed', proofEligible: true, output: 'row verify-m1\n' });
    expect(receipt.diagnostics).toContain('default_transaction_read_only=on');
    expect(receipt.command?.argv[1]).toBe('$TESTDB');
  });

  it('rejects metacommands and multiple statements before execution', async () => {
    for (const sql of ['\\dt', 'select 1; select 2']) {
      const receipt = await runDb([sql], context('', { dbUrlEnv: 'TESTDB' }));
      expect(receipt.state).toBe('command-error');
    }
  });

  it('names a missing DSN environment variable without exposing a value', async () => {
    delete process.env.TESTDB;
    const receipt = await runDb(['select 1'], context('', { dbUrlEnv: 'TESTDB' }));
    expect(receipt.state).toBe('command-error');
    expect(JSON.stringify(receipt)).toContain('$TESTDB');
  });

  it('redacts a DSN echoed by psql on failure', async () => {
    installPsql(`printf 'connection to %s failed\\n' "$1" >&2\nexit 2`);
    const dsn = 'postgres://user:very-secret@localhost/test';
    process.env.TESTDB = dsn;
    const receipt = await runDb(['select 1'], context('', { dbUrlEnv: 'TESTDB' }));
    expect(receipt.state).toBe('command-error');
    expect(receipt.diagnostics).toContain('$TESTDB');
    expect(JSON.stringify(receipt)).not.toContain(dsn);
  });
});

describe('run receipts', () => {
  it('lets an approved expected exit complete and keeps stderr out of output', async () => {
    const receipt = await runRun(
      ['node', '-e', "console.log('proof'); console.error('diagnostic'); process.exit(2)", '--expect-exit', '2'],
      context(''),
    );
    expect(receipt).toMatchObject({ state: 'completed', proofEligible: true, exit: 2 });
    expect(receipt.output).toContain('proof');
    expect(receipt.output).not.toContain('diagnostic');
    expect(receipt.diagnostics).toContain('diagnostic');
  });

  it('reports a missing binary as a command error', async () => {
    const receipt = await runRun(['definitely-not-a-real-verify-binary'], context('', { timeoutSeconds: 1 }));
    expect(receipt.state).toBe('command-error');
  });
});

describe('wait receipts', () => {
  it('polls until a URL response matches and never becomes proof eligible', async () => {
    const began = Date.now();
    const baseUrl = await listen((_req, res) => {
      res.statusCode = 200;
      res.end(Date.now() - began >= 2_500 ? 'ready' : 'pending');
    });
    const receipt = await runWait(
      ['--url', '/ready', '--contains', 'ready', '--timeout', '8'],
      context(baseUrl, { timeoutSeconds: 8 }),
    );
    expect(receipt).toMatchObject({ state: 'completed', proofEligible: false, output: 'ready' });
  }, 10_000);

  it('times out within the declared wait budget', async () => {
    const baseUrl = await listen((_req, res) => res.end('pending'));
    const began = Date.now();
    const receipt = await runWait(
      ['--url', '/ready', '--contains', 'ready', '--timeout', '3'],
      context(baseUrl, { timeoutSeconds: 10 }),
    );
    expect(receipt.state).toBe('timeout');
    expect(Date.now() - began).toBeLessThan(5_000);
  }, 8_000);

  it('uses the smaller step timeout as its deadline', async () => {
    const baseUrl = await listen((_req, res) => res.end('pending'));
    const began = Date.now();
    const receipt = await runWait(
      ['--url', '/ready', '--contains', 'ready', '--timeout', '60'],
      context(baseUrl, { timeoutSeconds: 1 }),
    );
    expect(receipt.state).toBe('timeout');
    expect(Date.now() - began).toBeLessThan(1_500);
  }, 5_000);

  it('does not treat an empty successful SQL result as ready', async () => {
    installPsql(`exit 0`);
    process.env.TESTDB = 'postgres://localhost/test';
    const receipt = await runWait(
      ['--sql', 'select marker from rows', '--timeout', '1'],
      context('', { dbUrlEnv: 'TESTDB', timeoutSeconds: 1 }),
    );
    expect(receipt.state).toBe('timeout');
  }, 5_000);

  it('keeps polling SQL until a row appears', async () => {
    const stateDir = mkdtempSync(`${tmpdir()}/verify-wait-state-`);
    const count = `${stateDir}/count`;
    writeFileSync(count, '0');
    installPsql(`n=$(cat '${count}')\nn=$((n + 1))\nprintf '%s' "$n" > '${count}'\n[ "$n" -lt 2 ] || printf 'row verify-m1\\n'`);
    process.env.TESTDB = 'postgres://localhost/test';
    const receipt = await runWait(
      ['--sql', 'select marker from rows', '--contains', 'verify-m1', '--timeout', '5'],
      context('', { dbUrlEnv: 'TESTDB', timeoutSeconds: 5 }),
    );
    expect(receipt).toMatchObject({ state: 'completed', proofEligible: false });
    expect(receipt.output).toContain('verify-m1');
  }, 8_000);
});
