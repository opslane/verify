import { spawn } from 'node:child_process';
import { TextDecoder } from 'node:util';
import {
  parseStepArgs,
  type DriveVerb,
  type ParsedDb,
  type ParsedHttp,
  type ParsedRun,
  type ParsedWait,
} from './step-args.js';

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
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
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
        stdoutTruncated: false,
        stderrTruncated: false,
      });
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let startFailed: string | undefined;
    let settled = false;

    const collect = (chunks: Buffer[], current: number, chunk: Buffer, truncated: (value: boolean) => void): number => {
      if (current >= OUTPUT_LIMIT) {
        truncated(true);
        return current;
      }
      const keep = Math.min(chunk.length, OUTPUT_LIMIT - current);
      if (keep > 0) chunks.push(chunk.subarray(0, keep));
      if (keep < chunk.length) truncated(true);
      return current + keep;
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes = collect(stdout, stdoutBytes, chunk, (value) => { stdoutTruncated = value; });
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes = collect(stderr, stderrBytes, chunk, (value) => { stderrTruncated = value; });
    });
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
        stdoutTruncated,
        stderrTruncated,
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
  // The path must be a same-origin path: an absolute or scheme-relative URL in
  // an approved plan would send the auth header to an arbitrary host, and a
  // redirect would let proof come from a different endpoint than the receipt
  // records.
  if (!request.path.startsWith('/') || request.path.startsWith('//')) {
    const diagnostics = receiptText(`http path must start with "/" and stay on the configured origin, got ${JSON.stringify(request.path)}`);
    return {
      ...baseReceipt('http', display, ctx.timeoutSeconds, startedAt),
      state: 'command-error', proofEligible: false, endedAt: new Date().toISOString(),
      output: '', outputTruncated: false,
      diagnostics: diagnostics.text, diagnosticsTruncated: diagnostics.truncated,
    };
  }
  const url = new URL(request.path, ctx.baseUrl.endsWith('/') ? ctx.baseUrl : `${ctx.baseUrl}/`).toString();
  if (new URL(url).origin !== new URL(ctx.baseUrl).origin) {
    const diagnostics = receiptText(`http url ${url} escapes the configured origin ${new URL(ctx.baseUrl).origin}`);
    return {
      ...baseReceipt('http', display, ctx.timeoutSeconds, startedAt),
      state: 'command-error', proofEligible: false, endedAt: new Date().toISOString(),
      output: '', outputTruncated: false,
      diagnostics: diagnostics.text, diagnosticsTruncated: diagnostics.truncated,
    };
  }
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
      // A redirect is receipted as what it is, never silently followed: the
      // origin lock above would be meaningless if the response could hop hosts.
      redirect: 'manual',
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

function parseFailure(verb: DriveVerb, args: string[], ctx: StepContext, startedAt: string, problem: string): StepReceipt {
  const diagnostics = receiptText(problem);
  return {
    ...baseReceipt(verb, `${verb} ${args.join(' ')}`, ctx.timeoutSeconds, startedAt),
    state: 'command-error', proofEligible: false, endedAt: new Date().toISOString(),
    output: '', outputTruncated: false,
    diagnostics: diagnostics.text, diagnosticsTruncated: diagnostics.truncated,
  };
}

function replaceSecret(value: string, secret: string, envName: string): string {
  return secret === '' ? value : value.split(secret).join(`$${envName}`);
}

export async function runDb(args: string[], ctx: StepContext): Promise<StepReceipt> {
  const startedAt = new Date().toISOString();
  const parsed = parseStepArgs('db', args);
  if (!parsed.ok) return parseFailure('db', args, ctx, startedAt, parsed.problem);
  const { sql } = parsed.parsed as ParsedDb;
  const envName = ctx.dbUrlEnv;
  const display = `db ${sql}`;
  const renderedDsn = `$${envName ?? 'UNCONFIGURED'}`;
  const command = { argv: ['psql', renderedDsn, '-X', '-tA', '-c', sql], cwd: ctx.repoRoot };
  if (!envName) {
    const diagnostics = receiptText('db requires a configured DSN environment variable');
    return {
      ...baseReceipt('db', display, ctx.timeoutSeconds, startedAt), command,
      state: 'command-error', proofEligible: false, endedAt: new Date().toISOString(),
      output: '', outputTruncated: false, diagnostics: diagnostics.text,
      diagnosticsTruncated: diagnostics.truncated,
    };
  }
  const dsn = process.env[envName];
  if (dsn === undefined) {
    const diagnostics = receiptText(`db environment variable $${envName} is not set`);
    return {
      ...baseReceipt('db', display, ctx.timeoutSeconds, startedAt), command,
      state: 'command-error', proofEligible: false, endedAt: new Date().toISOString(),
      output: '', outputTruncated: false, diagnostics: diagnostics.text,
      diagnosticsTruncated: diagnostics.truncated,
    };
  }
  const capture = await execCapture(['psql', dsn, '-X', '-tA', '-c', sql], {
    cwd: ctx.repoRoot,
    timeoutMs: Math.ceil(ctx.timeoutSeconds * 1000),
    env: { ...process.env, PGOPTIONS: '-c default_transaction_read_only=on' },
  });
  const output = receiptText(replaceSecret(capture.stdout, dsn, envName));
  const stderr = replaceSecret(capture.stderr, dsn, envName);
  const startDiagnostic = capture.startFailed ? 'psql failed to start' : '';
  const diagnostics = receiptText(stderr || startDiagnostic);
  const completed = !capture.timedOut && !capture.startFailed && capture.exit === 0;
  return {
    ...baseReceipt('db', display, ctx.timeoutSeconds, startedAt), command,
    state: capture.timedOut ? 'timeout' : completed ? 'completed' : 'command-error',
    proofEligible: completed,
    endedAt: new Date().toISOString(),
    ...(capture.exit === null ? {} : { exit: capture.exit }),
    ...(capture.signal ? { signal: capture.signal } : {}),
    output: output.text,
    outputTruncated: output.truncated || capture.stdoutTruncated,
    ...(diagnostics.text ? { diagnostics: diagnostics.text } : {}),
    diagnosticsTruncated: diagnostics.truncated || capture.stderrTruncated,
  };
}

export async function runRun(args: string[], ctx: StepContext): Promise<StepReceipt> {
  const startedAt = new Date().toISOString();
  const parsed = parseStepArgs('run', args);
  if (!parsed.ok) return parseFailure('run', args, ctx, startedAt, parsed.problem);
  const { argv, expectExit } = parsed.parsed as ParsedRun;
  const display = `run ${argv.join(' ')}` + (expectExit === 0 ? '' : ` --expect-exit ${expectExit}`);
  const command = { argv, cwd: ctx.repoRoot };
  const capture = await execCapture(argv, {
    cwd: ctx.repoRoot,
    timeoutMs: Math.ceil(ctx.timeoutSeconds * 1000),
  });
  // The child inherits the environment (approved argv, no adversaries — user
  // decision), but the KNOWN secret values must never land in a receipt:
  // an approved `run` that prints its environment would otherwise receipt
  // the auth value and the DSN verbatim.
  const scrub = (text: string): string => {
    let out = text;
    for (const envName of [ctx.authValueEnv, ctx.dbUrlEnv]) {
      const secret = envName ? process.env[envName] : undefined;
      if (envName && secret) out = replaceSecret(out, secret, envName);
    }
    return out;
  };
  const output = receiptText(scrub(capture.stdout));
  const diagnostics = receiptText(scrub(capture.stderr || capture.startFailed || ''));
  const completed = !capture.timedOut && !capture.startFailed && capture.exit === expectExit;
  return {
    ...baseReceipt('run', display, ctx.timeoutSeconds, startedAt), command,
    state: capture.timedOut ? 'timeout' : completed ? 'completed' : 'command-error',
    proofEligible: completed,
    endedAt: new Date().toISOString(),
    ...(capture.exit === null ? {} : { exit: capture.exit }),
    ...(capture.signal ? { signal: capture.signal } : {}),
    output: output.text,
    outputTruncated: output.truncated || capture.stdoutTruncated,
    ...(diagnostics.text ? { diagnostics: diagnostics.text } : {}),
    diagnosticsTruncated: diagnostics.truncated || capture.stderrTruncated,
  };
}

interface WaitProbe {
  matched: boolean;
  output: string;
  diagnostics: string;
  status?: number;
  outputTruncated: boolean;
  diagnosticsTruncated: boolean;
}

async function urlProbe(parsed: ParsedWait, ctx: StepContext, remainingMs: number): Promise<WaitProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.ceil(remainingMs)));
  try {
    const url = new URL(parsed.url!, ctx.baseUrl.endsWith('/') ? ctx.baseUrl : `${ctx.baseUrl}/`).toString();
    // Same origin lock and redirect posture as runHttp: a probe that wandered
    // off to another host reporting 2xx would be a false "ready".
    if (new URL(url).origin !== new URL(ctx.baseUrl).origin) {
      return {
        matched: false,
        output: '',
        diagnostics: `wait --url resolves off the contract origin: ${url}`,
        outputTruncated: false,
        diagnosticsTruncated: false,
      };
    }
    const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: controller.signal });
    const body = await response.text();
    const output = receiptText(body);
    const matched = response.ok && (parsed.contains === undefined || body.includes(parsed.contains));
    return {
      matched,
      output: output.text,
      diagnostics: matched ? '' : body,
      status: response.status,
      outputTruncated: output.truncated,
      diagnosticsTruncated: false,
    };
  } catch {
    return {
      matched: false, output: '', diagnostics: controller.signal.aborted ? 'probe timed out' : 'request failed',
      outputTruncated: false, diagnosticsTruncated: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function sqlProbe(parsed: ParsedWait, ctx: StepContext, remainingMs: number): Promise<WaitProbe> {
  const receipt = await runDb([parsed.sql!], { ...ctx, timeoutSeconds: remainingMs / 1000 });
  const nonEmpty = receipt.output.trim().length > 0;
  return {
    matched: receipt.state === 'completed' && nonEmpty &&
      (parsed.contains === undefined || receipt.output.includes(parsed.contains)),
    output: receipt.output,
    diagnostics: receipt.diagnostics ?? '',
    outputTruncated: receipt.outputTruncated,
    diagnosticsTruncated: receipt.diagnosticsTruncated,
  };
}

export async function runWait(args: string[], ctx: StepContext): Promise<StepReceipt> {
  const startedAt = new Date().toISOString();
  const parsedResult = parseStepArgs('wait', args);
  if (!parsedResult.ok) return parseFailure('wait', args, ctx, startedAt, parsedResult.problem);
  const parsed = parsedResult.parsed as ParsedWait;
  const timeoutSeconds = Math.min(parsed.timeoutSeconds, ctx.timeoutSeconds);
  const display = `wait ${args.join(' ')}`;
  const deadline = Date.now() + Math.ceil(timeoutSeconds * 1000);
  let last: WaitProbe = {
    matched: false, output: '', diagnostics: 'no probe completed',
    outputTruncated: false, diagnosticsTruncated: false,
  };

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    last = parsed.url
      ? await urlProbe(parsed, ctx, remaining)
      : await sqlProbe(parsed, ctx, remaining);
    if (last.matched) {
      const output = receiptText(last.output);
      const diagnostics = receiptText(last.diagnostics);
      return {
        ...baseReceipt('wait', display, timeoutSeconds, startedAt),
        state: 'completed', proofEligible: false, endedAt: new Date().toISOString(),
        ...(last.status === undefined ? {} : { status: last.status }),
        output: output.text, outputTruncated: output.truncated || last.outputTruncated,
        ...(diagnostics.text ? { diagnostics: diagnostics.text } : {}),
        diagnosticsTruncated: diagnostics.truncated || last.diagnosticsTruncated,
      };
    }
    const afterProbe = deadline - Date.now();
    if (afterProbe <= 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(2000, afterProbe)));
  }

  const diagnosticSource = last.diagnostics || last.output || 'condition was not met';
  const diagnostics = receiptText(diagnosticSource);
  return {
    ...baseReceipt('wait', display, timeoutSeconds, startedAt),
    state: 'timeout', proofEligible: false, endedAt: new Date().toISOString(),
    ...(last.status === undefined ? {} : { status: last.status }),
    output: '', outputTruncated: false,
    diagnostics: diagnostics.text,
    diagnosticsTruncated: diagnostics.truncated || last.diagnosticsTruncated || last.outputTruncated,
  };
}
