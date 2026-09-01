export type DriveVerb = 'http' | 'db' | 'wait' | 'run';

export interface ParsedHttp {
  method: string;
  path: string;
  json?: string;
  expectStatus?: number;
}

export interface ParsedDb { sql: string }

export interface ParsedWait {
  sql?: string;
  url?: string;
  contains?: string;
  timeoutSeconds: number;
}

export interface ParsedRun { argv: string[]; expectExit: number }

export type ParsedStep = ParsedHttp | ParsedDb | ParsedWait | ParsedRun;
export type StepArgsResult = { ok: true; parsed: ParsedStep } | { ok: false; problem: string };

function integer(value: string | undefined, label: string): number | string {
  if (value === undefined) return `${label} needs a value`;
  if (!/^-?\d+$/.test(value)) return `${label} must be an integer`;
  return Number(value);
}

function parseHttp(args: string[]): StepArgsResult {
  if (!args[0] || !args[1]) return { ok: false, problem: 'http needs METHOD and path' };
  const parsed: ParsedHttp = { method: args[0], path: args[1] };
  const seen = new Set<string>();
  for (let i = 2; i < args.length; i += 2) {
    const flag = args[i];
    if (flag !== '--json' && flag !== '--expect-status') {
      return { ok: false, problem: `http has unknown flag ${JSON.stringify(flag)}` };
    }
    if (seen.has(flag)) return { ok: false, problem: `http repeats ${flag}` };
    seen.add(flag);
    const value = args[i + 1];
    if (value === undefined) return { ok: false, problem: `${flag} needs a value` };
    if (flag === '--json') parsed.json = value;
    else {
      const status = integer(value, '--expect-status');
      if (typeof status === 'string') return { ok: false, problem: status };
      if (status < 100 || status > 599) {
        return { ok: false, problem: '--expect-status must be an integer from 100 to 599' };
      }
      parsed.expectStatus = status;
    }
  }
  return { ok: true, parsed };
}

function parseDb(args: string[]): StepArgsResult {
  if (args.length !== 1 || !args[0]) return { ok: false, problem: 'db needs exactly one SQL argument' };
  if (/[\\;]/.test(args[0])) {
    return { ok: false, problem: 'db SQL cannot contain backslash metacommands or statement separators (;)' };
  }
  return { ok: true, parsed: { sql: args[0] } };
}

function parseWait(args: string[]): StepArgsResult {
  const values: Partial<Record<'--sql' | '--url' | '--contains' | '--timeout', string>> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i] as keyof typeof values;
    if (!['--sql', '--url', '--contains', '--timeout'].includes(flag)) {
      return { ok: false, problem: `wait has unknown flag ${JSON.stringify(flag)}` };
    }
    if (Object.hasOwn(values, flag)) return { ok: false, problem: `wait repeats ${flag}` };
    const value = args[i + 1];
    if (value === undefined) return { ok: false, problem: `${flag} needs a value` };
    values[flag] = value;
  }
  if (Number(values['--sql'] !== undefined) + Number(values['--url'] !== undefined) !== 1) {
    return { ok: false, problem: 'wait needs exactly one of --sql or --url' };
  }
  const timeout = integer(values['--timeout'], '--timeout');
  if (typeof timeout === 'string') return { ok: false, problem: timeout };
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return { ok: false, problem: '--timeout must be finite and positive' };
  }
  return {
    ok: true,
    parsed: {
      ...(values['--sql'] !== undefined ? { sql: values['--sql'] } : {}),
      ...(values['--url'] !== undefined ? { url: values['--url'] } : {}),
      ...(values['--contains'] !== undefined ? { contains: values['--contains'] } : {}),
      timeoutSeconds: timeout,
    },
  };
}

function parseRun(args: string[]): StepArgsResult {
  if (args.length === 0 || args[0] === '') return { ok: false, problem: 'run needs a non-empty argv' };
  let argv = args;
  let expectExit = 0;
  const flagAt = args.indexOf('--expect-exit');
  if (flagAt !== -1) {
    if (flagAt !== args.length - 2) {
      return { ok: false, problem: '--expect-exit N must be the final two run arguments' };
    }
    const exit = integer(args[flagAt + 1], '--expect-exit');
    if (typeof exit === 'string') return { ok: false, problem: exit };
    if (exit < 0) return { ok: false, problem: '--expect-exit must be an integer >= 0' };
    expectExit = exit;
    argv = args.slice(0, flagAt);
    if (argv.length === 0 || argv[0] === '') return { ok: false, problem: 'run needs a non-empty argv' };
  }
  return { ok: true, parsed: { argv, expectExit } };
}

export function parseStepArgs(verb: DriveVerb, args: string[]): StepArgsResult {
  switch (verb) {
    case 'http': return parseHttp(args);
    case 'db': return parseDb(args);
    case 'wait': return parseWait(args);
    case 'run': return parseRun(args);
  }
}
