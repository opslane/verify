import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterEach } from 'vitest';
import { execCapture, OUTPUT_LIMIT, runHttp, truncateBytes, type StepContext } from '../src/lib/steps.js';

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
