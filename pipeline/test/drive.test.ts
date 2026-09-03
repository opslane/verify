import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Criterion } from '../src/lib/criteria.js';
import type { StepReceipt } from '../src/lib/steps.js';

const mockState = vi.hoisted(() => ({ calls: [] as string[][], queue: [] as StepReceipt[] }));
vi.mock('../src/lib/steps.js', async (orig) => {
  const real = await orig() as object;
  const record = (verb: string) => async (args: string[]) => {
    mockState.calls.push([verb, ...args]);
    return mockState.queue.shift() ?? okReceipt(`${verb} out verify-m1`, verb as StepReceipt['verb']);
  };
  return { ...real, runHttp: record('http'), runDb: record('db'), runWait: record('wait'), runRun: record('run') };
});

import { driveCriterion, latestFinalizedAttempt, latestFinalizedProof } from '../src/lib/drive.js';

function okReceipt(output: string, verb: StepReceipt['verb'] = 'run'): StepReceipt {
  return {
    verb,
    display: `${verb} fixture`,
    state: 'completed',
    proofEligible: verb !== 'wait',
    startedAt: '2026-09-01T00:00:00.000Z',
    endedAt: '2026-09-01T00:00:01.000Z',
    timeoutSeconds: 60,
    output,
    outputTruncated: false,
    diagnosticsTruncated: false,
  };
}

function criterion(overrides: Partial<Criterion> = {}): Criterion {
  return {
    id: 'AC1',
    title: 'marked data is observable',
    doIt: 'create and read marked data',
    expectIt: 'the marked row is returned',
    source: { kind: 'plan', ref: 'R1', quote: 'marked data is observable' },
    why: 'the marker is how a reader knows the check ran',
    intent: 'changes',
    baseline: 'fail',
    witness: 'success',
    dependsOn: ['api', 'db'],
    drive: [
      { verb: 'http', args: ['POST', '/events', '--json', '{"marker":"{{marker}}"}'] },
      { verb: 'wait', args: ['--url', '/ready/{{marker}}', '--timeout', '5'] },
      { verb: 'db', args: ["select '{{marker}}'"] },
    ],
    proof: { kind: 'marker-in-data', detail: 'marker row', step: 3 },
    ...overrides,
  };
}

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'verify-drive-repo-'));
  const runDir = join(repoRoot, '.verify', 'runs', 'r1');
  mkdirSync(runDir, { recursive: true });
  return {
    repoRoot,
    runDir,
    opts: { runDir, marker: 'verify-m1', ctx: { baseUrl: 'http://localhost', repoRoot } },
  };
}

beforeEach(() => {
  mockState.calls = [];
  mockState.queue = [];
});
afterEach(() => vi.restoreAllMocks());

describe('driveCriterion', () => {
  it('substitutes the marker, loads json files first, and finalizes proof receipts', async () => {
    const f = fixture();
    writeFileSync(join(f.repoRoot, 'event.json'), '{"marker":"{{marker}}", "spacing": true}\n');
    const driven = criterion({
      drive: [
        { verb: 'http', args: ['POST', '/events', '--json', '@event.json'] },
        ...criterion().drive!.slice(1),
      ],
    });
    const result = await driveCriterion(driven, f.opts);
    expect('dryRun' in result).toBe(false);
    if ('dryRun' in result) throw new Error('expected an attempt');
    expect(mockState.calls[0][4]).toBe('{"marker":"verify-m1", "spacing": true}\n');
    expect(mockState.calls.flat().join(' ')).not.toContain('{{marker}}');
    expect(result).toMatchObject({ finalized: true, completed: 3, proof: { result: 'present', seen: true } });
    const attemptDir = join(f.runDir, 'evidence', 'AC1', result.attempt);
    expect(readdirSync(attemptDir).sort()).toEqual(['attempt.json', 'step-1.json', 'step-2.json', 'step-3.json']);
    expect(latestFinalizedProof(f.runDir, 'AC1')).toEqual({ result: 'present', expect: 'present', seen: true });
  });

  it('stops after a timeout and makes an unattempted proof inconclusive', async () => {
    const f = fixture();
    mockState.queue = [okReceipt('first'), { ...okReceipt('', 'wait'), state: 'timeout' }];
    const result = await driveCriterion(criterion(), f.opts);
    if ('dryRun' in result) throw new Error('expected an attempt');
    expect(result.steps).toEqual([
      { index: 1, verb: 'http', state: 'completed' },
      { index: 2, verb: 'wait', state: 'timeout' },
      { index: 3, verb: 'db', state: 'not-attempted' },
    ]);
    expect(result.proof).toMatchObject({ result: 'inconclusive', seen: false });
    expect(readdirSync(join(f.runDir, 'evidence', 'AC1', result.attempt))).not.toContain('step-3.json');
    expect(latestFinalizedProof(f.runDir, 'AC1')?.seen).toBe(false);
  });

  it('proves an eligible, complete, untruncated absence', async () => {
    const f = fixture();
    mockState.queue = [okReceipt('ordinary row')];
    const result = await driveCriterion(criterion({
      drive: [{ verb: 'db', args: ['select marker'] }],
      proof: { kind: 'marker-in-data', detail: 'no marker row', step: 1, expect: 'absent' },
    }), f.opts);
    if ('dryRun' in result) throw new Error('expected an attempt');
    expect(result.proof).toMatchObject({ result: 'absent', seen: true });
  });

  it.each([
    [{ outputTruncated: true }, 'truncated output'],
    [{ proofEligible: false, diagnostics: 'echo verify-m1' }, 'ineligible refusal output'],
  ])('makes absent proof inconclusive for %s', async (receiptPatch) => {
    const f = fixture();
    mockState.queue = [{ ...okReceipt(''), ...receiptPatch }];
    const result = await driveCriterion(criterion({
      drive: [{ verb: 'http', args: ['GET', '/'] }],
      proof: { kind: 'marker-in-data', detail: 'no marker', step: 1, expect: 'absent' },
    }), f.opts);
    if ('dryRun' in result) throw new Error('expected an attempt');
    expect(result.proof).toMatchObject({ result: 'inconclusive', seen: false });
  });

  it('leaves live-read proof to the judge', async () => {
    const f = fixture();
    const result = await driveCriterion(criterion({ proof: { kind: 'live-read', detail: 'fresh timestamp' } }), f.opts);
    if ('dryRun' in result) throw new Error('expected an attempt');
    expect(result.proof).toBeNull();
    expect(latestFinalizedProof(f.runDir, 'AC1')).toBeUndefined();
  });

  it('keeps draft receipts separate and writes no manifest', async () => {
    const f = fixture();
    const result = await driveCriterion(criterion(), { ...f.opts, draft: true, onlyStep: 1 });
    if ('dryRun' in result) throw new Error('expected an attempt');
    const drafts = join(f.runDir, 'evidence', 'AC1', 'drafts');
    expect(readdirSync(drafts)).toHaveLength(1);
    expect(readdirSync(join(drafts, readdirSync(drafts)[0]))).toEqual(['step-1.json']);
    expect(latestFinalizedProof(f.runDir, 'AC1')).toBeUndefined();
  });

  it('dry-runs substituted steps without executing', async () => {
    const f = fixture();
    const result = await driveCriterion(criterion(), { ...f.opts, dryRun: true });
    expect(result).toEqual({ dryRun: [
      { verb: 'http', args: ['POST', '/events', '--json', '{"marker":"verify-m1"}'], timeoutSeconds: 60 },
      { verb: 'wait', args: ['--url', '/ready/verify-m1', '--timeout', '5'], timeoutSeconds: 60 },
      { verb: 'db', args: ["select 'verify-m1'"], timeoutSeconds: 60 },
    ] });
    expect(mockState.calls).toEqual([]);
  });

  it('rejects unsafe markers and file escapes, including prefix siblings and symlinks', async () => {
    const f = fixture();
    await expect(driveCriterion(criterion(), { ...f.opts, marker: 'verify m1; rm' })).rejects.toThrow('marker');

    const outside = join(dirname(f.repoRoot), 'outside.json');
    writeFileSync(outside, '{}');
    const fileCriterion = (path: string) => criterion({
      drive: [{ verb: 'http', args: ['POST', '/', '--json', `@${path}`] }],
      proof: { kind: 'marker-in-data', detail: 'marker', step: 1 },
    });
    await expect(driveCriterion(fileCriterion('../outside.json'), { ...f.opts, dryRun: true })).rejects.toThrow('outside repo root');

    const sibling = `${f.repoRoot}-other`;
    mkdirSync(sibling);
    writeFileSync(join(sibling, 'body.json'), '{}');
    await expect(driveCriterion(fileCriterion(`../${sibling.split('/').at(-1)}/body.json`), { ...f.opts, dryRun: true }))
      .rejects.toThrow('outside repo root');

    const link = join(f.repoRoot, 'linked.json');
    symlinkSync(outside, link);
    await expect(driveCriterion(fileCriterion('linked.json'), { ...f.opts, dryRun: true })).rejects.toThrow('outside repo root');
  });

  it('refuses a criterion without a plan', async () => {
    const f = fixture();
    await expect(driveCriterion(criterion({ drive: undefined }), f.opts)).rejects.toThrow('no plan — drive it by hand');
  });
});

describe('latestFinalizedProof', () => {
  it('skips malformed and unfinalized manifests and chooses newest startedAt', () => {
    const f = fixture();
    const evidence = join(f.runDir, 'evidence', 'AC1');
    const writeAttempt = (name: string, body: string) => {
      const dir = join(evidence, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'attempt.json'), body);
    };
    writeAttempt('drive-999-1', '{bad json');
    writeAttempt('drive-998-1', JSON.stringify({ finalized: false }));
    writeAttempt('drive-900-1', JSON.stringify({
      finalized: true, ac: 'AC1', attempt: 'drive-900-1', startedAt: '2026-09-01T00:00:02.000Z',
      endedAt: '2026-09-01T00:00:03.000Z', steps: [{ index: 1, verb: 'run', state: 'completed' }], completed: 1,
      proof: { result: 'present', expect: 'present', seen: true },
    }));
    writeAttempt('drive-9999-1', JSON.stringify({
      finalized: true, ac: 'AC1', attempt: 'drive-9999-1', startedAt: '2026-09-01T00:00:01.000Z',
      endedAt: '2026-09-01T00:00:02.000Z', steps: [{ index: 1, verb: 'run', state: 'completed' }], completed: 1,
      proof: { result: 'absent', expect: 'present', seen: false },
    }));
    expect(latestFinalizedProof(f.runDir, 'AC1')).toEqual({ result: 'present', expect: 'present', seen: true });
  });

  it('recomputes seen from result vs expect instead of trusting the manifest', () => {
    const f = fixture();
    const dir = join(f.runDir, 'evidence', 'AC1', 'drive-1000-1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'attempt.json'), JSON.stringify({
      finalized: true, ac: 'AC1', attempt: 'drive-1000-1', startedAt: '2026-09-01T00:00:03.000Z',
      endedAt: '2026-09-01T00:00:04.000Z', steps: [{ index: 1, verb: 'run', state: 'completed' }], completed: 1,
      proof: { result: 'inconclusive', expect: 'present', seen: true },
    }));
    expect(latestFinalizedProof(f.runDir, 'AC1')?.seen).toBe(false);
  });

  it('computes qualifies=false from a real all-not-attempted manifest', () => {
    const f = fixture();
    const dir = join(f.runDir, 'evidence', 'AC9', 'drive-1-1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'attempt.json'), JSON.stringify({
      finalized: true, ac: 'AC9', attempt: 'drive-1-1', startedAt: '2026-09-01T00:00:00.000Z',
      endedAt: '2026-09-01T00:00:01.000Z', steps: [{ index: 1, verb: 'run', state: 'not-attempted' }],
      completed: 0, proof: null,
    }));
    expect(latestFinalizedAttempt(f.runDir, 'AC9')?.qualifies).toBe(false);
  });

  it('takes proof ONLY from the newest finalized attempt — no cross-attempt fallback', () => {
    const f = fixture();
    const write = (folder: string, startedAt: string, proof: unknown) => {
      const dir = join(f.runDir, 'evidence', 'AC8', folder);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'attempt.json'), JSON.stringify({
        finalized: true, ac: 'AC8', attempt: folder, startedAt,
        endedAt: startedAt, steps: [{ index: 1, verb: 'run', state: 'completed' }], completed: 1, proof,
      }));
    };
    write('drive-1-1', '2026-09-01T00:00:01.000Z', { result: 'present', expect: 'present', seen: true });
    write('drive-2-1', '2026-09-01T00:00:02.000Z', null);
    // The newest attempt has no usable proof; an older attempt's proof must
    // not describe a different execution than the one that substantiates.
    expect(latestFinalizedProof(f.runDir, 'AC8')).toBeUndefined();
  });
});
