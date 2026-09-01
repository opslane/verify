import { spawn } from 'node:child_process';
import { TextDecoder } from 'node:util';
import { parseStepArgs, type DriveVerb, type ParsedHttp } from './step-args.js';

export type StepState = 'completed' | 'command-error' | 'timeout' | 'not-attempted';

export interface StepReceipt {
  verb: DriveVerb;
  display: string;
  state: StepState;
  proofEligible: boolean;
  startedAt: string;
  endedAt: string;
  exit?: number;
  signal?: string;
  status?: number;
  request?: { url: string; method: string; body?: string; headers: Record<string, string> };
  command?: { argv: string[]; cwd: string };
  timeoutSeconds: number;
  output: string;
  diagnostics?: string;
  outputTruncated: boolean;
  diagnosticsTruncated: boolean;
}

export interface StepContext {
  baseUrl: string;
  authHeader?: string;
  authValueEnv?: string;
  dbUrlEnv?: string;
  repoRoot: string;
  timeoutSeconds: number;
}

export const OUTPUT_LIMIT = 1024 * 1024;

export function truncateBytes(value: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.length <= OUTPUT_LIMIT) return { text: value, truncated: false };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let end = OUTPUT_LIMIT;
  while (end > 0) {
    try {
      return { text: decoder.decode(bytes.subarray(0, end)), truncated: true };
    } catch {
      end -= 1;
    }
  }
  return { text: '', truncated: true };
}

export function execCapture(
  argv: string[],
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<{
  exit: number | null;
  signal: string | null;
  timedOut: boolean;
  startFailed?: string;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: opts.cwd,
        env: opts.env,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        exit: null,
        signal: null,
        timedOut: false,
        startFailed: error instanceof Error ? error.message : 'process failed to start',
        stdout: '',
        stderr: '',
      });
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let startFailed: string | undefined;
    let settled = false;

    const collect = (chunks: Buffer[], current: number, chunk: Buffer): number => {
      if (current >= OUTPUT_LIMIT) return current;
      const keep = Math.min(chunk.length, OUTPUT_LIMIT - current);
      if (keep > 0) chunks.push(chunk.subarray(0, keep));
      return current + keep;
    };
    child.stdout.on('data', (chunk: Buffer) => { stdoutBytes = collect(stdout, stdoutBytes, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes = collect(stderr, stderrBytes, chunk); });
    child.on('error', (error) => { startFailed = error.message; });

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          if (process.platform === 'win32') child.kill('SIGKILL');
          else process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    }, Math.max(1, Math.ceil(opts.timeoutMs)));

    child.on('close', (exit, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exit,
        signal,
        timedOut,
        ...(startFailed ? { startFailed } : {}),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function receiptText(value: string): { text: string; truncated: boolean } {
  return truncateBytes(value);
}

function baseReceipt(
  verb: DriveVerb,
  display: string,
  timeoutSeconds: number,
  startedAt: string,
): Omit<StepReceipt, 'state' | 'proofEligible' | 'endedAt' | 'output' | 'outputTruncated' | 'diagnosticsTruncated'> {
  return { verb, display, timeoutSeconds, startedAt };
}

export async function runHttp(args: string[], ctx: StepContext): Promise<StepReceipt> {
  const startedAt = new Date().toISOString();
  const parsed = parseStepArgs('http', args);
  const fallbackDisplay = `http ${args.join(' ')}`;
  if (!parsed.ok) {
    const diagnostics = receiptText(parsed.problem);
    return {
      ...baseReceipt('http', fallbackDisplay, ctx.timeoutSeconds, startedAt),
      state: 'command-error', proofEligible: false, endedAt: new Date().toISOString(),
      output: '', outputTruncated: false,
      diagnostics: diagnostics.text, diagnosticsTruncated: diagnostics.truncated,
    };
  }
  const request = parsed.parsed as ParsedHttp;
  const display = `http ${request.method} ${request.path}` +
    (request.json === undefined ? '' : ` --json <${Buffer.byteLength(request.json)} bytes>`) +
    (request.expectStatus === undefined ? '' : ` --expect-status ${request.expectStatus}`);
  const url = new URL(request.path, ctx.baseUrl.endsWith('/') ? ctx.baseUrl : `${ctx.baseUrl}/`).toString();
  const headers: Record<string, string> = {};
  const serializedHeaders: Record<string, string> = {};
  if (request.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    serializedHeaders['Content-Type'] = 'application/json';
  }
  if (ctx.authHeader || ctx.authValueEnv) {
    if (!ctx.authHeader || !ctx.authValueEnv) {
      const diagnostics = receiptText('http authentication requires both a header and value environment variable');
      return {
        ...baseReceipt('http', display, ctx.timeoutSeconds, startedAt),
        state: 'command-error', proofEligible: false, endedAt: new Date().toISOString(),
        request: { url, method: request.method, ...(request.json === undefined ? {} : { body: request.json }), headers: serializedHeaders },
        output: '', outputTruncated: false, diagnostics: diagnostics.text,
        diagnosticsTruncated: diagnostics.truncated,
      };
    }
    const value = process.env[ctx.authValueEnv];
    if (value === undefined) {
      const diagnostics = receiptText(`http authentication environment variable $${ctx.authValueEnv} is not set`);
      return {
        ...baseReceipt('http', display, ctx.timeoutSeconds, startedAt),
        state: 'command-error', proofEligible: false, endedAt: new Date().toISOString(),
        request: { url, method: request.method, ...(request.json === undefined ? {} : { body: request.json }), headers: serializedHeaders },
        output: '', outputTruncated: false, diagnostics: diagnostics.text,
        diagnosticsTruncated: diagnostics.truncated,
      };
    }
    headers[ctx.authHeader] = value;
    serializedHeaders[ctx.authHeader] = '[redacted]';
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.ceil(ctx.timeoutSeconds * 1000)));
  try {
    const response = await fetch(url, {
      method: request.method,
      headers,
      ...(request.json === undefined ? {} : { body: request.json }),
      signal: controller.signal,
    });
    const body = await response.text();
    const matched = request.expectStatus === undefined ? response.ok : response.status === request.expectStatus;
    const eligible = matched && response.status >= 200 && response.status < 300;
    const output = receiptText(eligible ? body : '');
    const diagnostics = receiptText(eligible ? '' : body);
    return {
      ...baseReceipt('http', display, ctx.timeoutSeconds, startedAt),
      state: matched ? 'completed' : 'command-error',
      proofEligible: eligible,
      endedAt: new Date().toISOString(),
      status: response.status,
      request: { url, method: request.method, ...(request.json === undefined ? {} : { body: request.json }), headers: serializedHeaders },
      output: output.text,
      outputTruncated: output.truncated,
      ...(diagnostics.text ? { diagnostics: diagnostics.text } : {}),
      diagnosticsTruncated: diagnostics.truncated,
    };
  } catch {
    const diagnostics = receiptText(controller.signal.aborted ? 'request timed out' : 'request failed');
    return {
      ...baseReceipt('http', display, ctx.timeoutSeconds, startedAt),
      state: controller.signal.aborted ? 'timeout' : 'command-error',
      proofEligible: false,
      endedAt: new Date().toISOString(),
      request: { url, method: request.method, ...(request.json === undefined ? {} : { body: request.json }), headers: serializedHeaders },
      output: '', outputTruncated: false,
      diagnostics: diagnostics.text, diagnosticsTruncated: diagnostics.truncated,
    };
  } finally {
    clearTimeout(timer);
  }
}
