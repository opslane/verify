import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Criterion, DriveStep } from './criteria.js';
import { parseStepArgs, type DriveVerb, type ParsedHttp } from './step-args.js';
import {
  runDb,
  runHttp,
  runRun,
  runWait,
  type StepContext,
  type StepReceipt,
  type StepState,
} from './steps.js';

export type ProofResult = 'present' | 'absent' | 'inconclusive';

export interface AttemptManifest {
  ac: string;
  attempt: string;
  startedAt: string;
  endedAt: string;
  steps: { index: number; verb: DriveVerb; state: StepState }[];
  completed: number;
  proof: { step?: number; expect: 'present' | 'absent'; result: ProofResult; seen: boolean } | null;
  finalized: true;
}

export interface DriveOptions {
  runDir: string;
  marker: string;
  ctx: Omit<StepContext, 'timeoutSeconds'>;
  draft?: boolean;
  onlyStep?: number;
  dryRun?: boolean;
}

interface PreparedStep {
  index: number;
  verb: DriveVerb;
  args: string[];
  timeoutSeconds: number;
}

const RUNNERS: Record<DriveVerb, (args: string[], ctx: StepContext) => Promise<StepReceipt>> = {
  http: runHttp,
  db: runDb,
  wait: runWait,
  run: runRun,
};

function containedPath(repoRoot: string, file: string): string {
  const canonicalRoot = realpathSync(repoRoot);
  const canonicalFile = realpathSync(resolve(canonicalRoot, file));
  const fromRoot = relative(canonicalRoot, canonicalFile);
  if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`@file is outside repo root: ${file}`);
  }
  return canonicalFile;
}

function substitute(value: string, marker: string): string {
  return value.replaceAll('{{marker}}', marker);
}

function prepareStep(step: DriveStep, index: number, marker: string, repoRoot: string): PreparedStep {
  const loaded = [...step.args];
  if (step.verb === 'http') {
    for (let i = 0; i < loaded.length - 1; i += 1) {
      if (loaded[i] === '--json' && loaded[i + 1].startsWith('@')) {
        loaded[i + 1] = readFileSync(containedPath(repoRoot, loaded[i + 1].slice(1)), 'utf8');
      }
    }
  }
  const args = loaded.map((arg) => substitute(arg, marker));
  if (step.verb === 'http') {
    const parsed = parseStepArgs('http', args);
    if (parsed.ok) {
      const body = (parsed.parsed as ParsedHttp).json;
      if (body !== undefined) JSON.parse(body);
    }
  }
  return { index, verb: step.verb, args, timeoutSeconds: step.timeoutSeconds ?? 60 };
}

function createAttempt(parent: string): { name: string; dir: string } {
  mkdirSync(parent, { recursive: true });
  let milliseconds = Date.now();
  while (true) {
    const name = `drive-${milliseconds}-${process.pid}`;
    const dir = join(parent, name);
    try {
      mkdirSync(dir);
      return { name, dir };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      milliseconds += 1;
    }
  }
}

function mechanicalProof(
  criterion: Criterion,
  receipts: Map<number, StepReceipt>,
  marker: string,
): AttemptManifest['proof'] {
  if (criterion.proof.kind !== 'marker-in-data' || criterion.proof.step === undefined) return null;
  const step = criterion.proof.step;
  const expect = criterion.proof.expect ?? 'present';
  const receipt = receipts.get(step);
  let result: ProofResult = 'inconclusive';
  if (receipt?.proofEligible && receipt.state === 'completed') {
    if (receipt.output.includes(marker)) result = 'present';
    else if (!receipt.outputTruncated) result = 'absent';
  }
  return { step, expect, result, seen: result === expect };
}

export async function driveCriterion(
  criterion: Criterion,
  opts: DriveOptions,
): Promise<AttemptManifest | { dryRun: { verb: string; args: string[]; timeoutSeconds: number }[] }> {
  if (!/^verify-[a-z0-9-]+$/.test(opts.marker)) throw new Error(`invalid marker ${JSON.stringify(opts.marker)}`);
  if (!criterion.drive) throw new Error('no plan — drive it by hand');
  if (opts.onlyStep !== undefined && (!Number.isInteger(opts.onlyStep) || opts.onlyStep < 1 || opts.onlyStep > criterion.drive.length)) {
    throw new Error(`step ${opts.onlyStep} is outside the drive plan`);
  }

  const allSteps = criterion.drive.map((step, index) => prepareStep(step, index + 1, opts.marker, opts.ctx.repoRoot));
  const selected = opts.onlyStep === undefined ? allSteps : [allSteps[opts.onlyStep - 1]];
  if (opts.dryRun) {
    return { dryRun: selected.map(({ verb, args, timeoutSeconds }) => ({ verb, args, timeoutSeconds })) };
  }

  const startedAt = new Date().toISOString();
  const evidence = join(opts.runDir, 'evidence', criterion.id);
  const attemptParent = opts.draft ? join(evidence, 'drafts') : evidence;
  const attempt = createAttempt(attemptParent);
  const states: AttemptManifest['steps'] = [];
  const receipts = new Map<number, StepReceipt>();
  let stopped = false;

  const planForState = opts.onlyStep === undefined ? allSteps : selected;
  for (const step of planForState) {
    if (stopped) {
      states.push({ index: step.index, verb: step.verb, state: 'not-attempted' });
      continue;
    }
    try {
      const receipt = await RUNNERS[step.verb](step.args, { ...opts.ctx, timeoutSeconds: step.timeoutSeconds });
      receipts.set(step.index, receipt);
      writeFileSync(join(attempt.dir, `step-${step.index}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
      states.push({ index: step.index, verb: step.verb, state: receipt.state });
      if (receipt.state !== 'completed') stopped = true;
    } catch {
      states.push({ index: step.index, verb: step.verb, state: 'command-error' });
      stopped = true;
    }
  }

  const proof = mechanicalProof(criterion, receipts, opts.marker);
  const manifest: AttemptManifest = {
    ac: criterion.id,
    attempt: attempt.name,
    startedAt,
    endedAt: new Date().toISOString(),
    steps: states,
    completed: states.filter((step) => step.state === 'completed').length,
    proof,
    finalized: true,
  };

  if (!opts.draft) {
    const temp = join(attempt.dir, `attempt.json.tmp-${process.pid}`);
    writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(temp, join(attempt.dir, 'attempt.json'));
  }
  return manifest;
}

export function latestFinalizedProof(
  runDir: string,
  ac: string,
): { result: ProofResult; expect: 'present' | 'absent'; seen: boolean } | undefined {
  const evidence = join(runDir, 'evidence', ac);
  if (!existsSync(evidence)) return undefined;
  const candidates: { folder: string; startedAt: string; proof: NonNullable<AttemptManifest['proof']> }[] = [];
  for (const folder of readdirSync(evidence)) {
    if (!folder.startsWith('drive-')) continue;
    try {
      const value = JSON.parse(readFileSync(join(evidence, folder, 'attempt.json'), 'utf8')) as Partial<AttemptManifest>;
      if (value.finalized !== true || value.proof === null || typeof value.proof !== 'object') continue;
      if (typeof value.startedAt !== 'string') continue;
      const proof = value.proof as NonNullable<AttemptManifest['proof']>;
      if (!['present', 'absent', 'inconclusive'].includes(proof.result)) continue;
      if (!['present', 'absent'].includes(proof.expect)) continue;
      // seen is recomputed, never trusted: a hand-edited or buggy manifest
      // claiming {result: inconclusive, seen: true} must not count.
      candidates.push({ folder, startedAt: value.startedAt,
        proof: { ...proof, seen: proof.result === proof.expect } });
    } catch {
      // A crashed or malformed attempt is deliberately invisible.
    }
  }
  candidates.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.folder.localeCompare(b.folder));
  const latest = candidates.at(-1)?.proof;
  return latest ? { result: latest.result, expect: latest.expect, seen: latest.seen } : undefined;
}
