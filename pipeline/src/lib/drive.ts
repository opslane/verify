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

export interface FinalizedAttempt {
  folder: string;
  manifest: AttemptManifest;
  receipts: Record<number, StepReceipt>;
  /** A finalized attempt with at least one terminal step substantiates a drive. */
  qualifies: boolean;
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
  // Proof comes from THE newest finalized attempt — the same attempt that
  // substantiates. Walking back to an older attempt's proof would let proof
  // and substantiation describe different executions.
  const proof = latestFinalizedAttempt(runDir, ac)?.manifest.proof;
  if (!proof || !['present', 'absent', 'inconclusive'].includes(proof.result) ||
      !['present', 'absent'].includes(proof.expect)) return undefined;
  return { result: proof.result, expect: proof.expect, seen: proof.result === proof.expect };
}

function validState(value: unknown): value is StepState {
  return ['completed', 'command-error', 'timeout', 'not-attempted'].includes(value as string);
}

/** Newest engine-finalized attempt, including its neutral per-step receipts. */
export const TERMINAL_STEP_STATES: readonly StepState[] = ['completed', 'command-error', 'timeout'];

export function latestFinalizedAttempt(runDir: string, ac: string): FinalizedAttempt | undefined {
  return allFinalizedAttempts(runDir, ac).at(-1);
}

/** Every finalized attempt, sorted oldest to newest. */
function allFinalizedAttempts(runDir: string, ac: string): FinalizedAttempt[] {
  const evidence = join(runDir, 'evidence', ac);
  if (!existsSync(evidence)) return [];
  const candidates: FinalizedAttempt[] = [];
  let folders: string[];
  try {
    folders = readdirSync(evidence);
  } catch {
    return [];
  }
  for (const folder of folders) {
    if (!folder.startsWith('drive-')) continue;
    try {
      const dir = join(evidence, folder);
      const value = JSON.parse(readFileSync(join(dir, 'attempt.json'), 'utf8')) as Partial<AttemptManifest>;
      if (value.finalized !== true || value.ac !== ac || typeof value.startedAt !== 'string' ||
          typeof value.endedAt !== 'string' || !Array.isArray(value.steps)) continue;
      if (!value.steps.every((step) =>
        typeof step === 'object' && step !== null && Number.isInteger(step.index) &&
        typeof step.verb === 'string' && validState(step.state))) continue;

      const receipts: Record<number, StepReceipt> = {};
      for (const name of readdirSync(dir)) {
        const match = /^step-(0|[1-9]\d*)\.json$/.exec(name);
        if (!match) continue;
        try {
          const receipt = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Partial<StepReceipt>;
          if (typeof receipt.verb !== 'string' || typeof receipt.display !== 'string' ||
              !validState(receipt.state) || typeof receipt.startedAt !== 'string' ||
              typeof receipt.endedAt !== 'string' || typeof receipt.output !== 'string') continue;
          // Optional fields reach the renderer; a malformed one must render as
          // a missing receipt, never crash the report.
          if (receipt.diagnostics !== undefined && typeof receipt.diagnostics !== 'string') continue;
          if (receipt.status !== undefined && typeof receipt.status !== 'number') continue;
          if (receipt.exit !== undefined && typeof receipt.exit !== 'number') continue;
          if (receipt.command !== undefined && (typeof receipt.command !== 'object' || receipt.command === null ||
              !Array.isArray(receipt.command.argv) || !receipt.command.argv.every((a) => typeof a === 'string') ||
              typeof receipt.command.cwd !== 'string')) continue;
          if (receipt.request !== undefined && (typeof receipt.request !== 'object' || receipt.request === null ||
              typeof receipt.request.url !== 'string' || typeof receipt.request.method !== 'string')) continue;
          receipts[Number(match[1])] = receipt as StepReceipt;
        } catch {
          // A malformed individual receipt remains visibly absent from the trail.
        }
      }
      const manifest = value as AttemptManifest;
      candidates.push({
        folder,
        manifest,
        receipts,
        qualifies: manifest.steps.some((step) => TERMINAL_STEP_STATES.includes(step.state)),
      });
    } catch {
      // A crashed or malformed attempt is deliberately invisible.
    }
  }
  candidates.sort((a, b) =>
    a.manifest.startedAt.localeCompare(b.manifest.startedAt) || a.folder.localeCompare(b.folder));
  return candidates;
}
