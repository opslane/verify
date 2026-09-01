import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Criterion } from '../src/lib/criteria.js';
import type { FinalizedAttempt } from '../src/lib/drive.js';
import { EVIDENCE_EXCERPT_LIMIT, resolveEvidence } from '../src/lib/evidence.js';

function criterion(id: string, driven = false): Criterion {
  return {
    id, title: `${id} title`, doIt: 'do it', expectIt: 'see it',
    source: { kind: 'plan', ref: id }, intent: 'changes', baseline: 'fail', witness: 'success',
    dependsOn: ['api'], proof: { kind: 'live-read', detail: 'fresh value' },
    ...(driven ? { drive: [{ verb: 'run', args: ['node', '-v'] }] } : {}),
  };
}

function attempt(state: 'completed' | 'command-error' | 'timeout' | 'not-attempted'): FinalizedAttempt {
  return {
    folder: 'drive-1-1',
    manifest: {
      ac: 'AC1', attempt: 'drive-1-1', finalized: true,
      startedAt: '2026-09-01T00:00:00.000Z', endedAt: '2026-09-01T00:00:01.000Z',
      steps: [{ index: 1, verb: 'run', state }], completed: state === 'completed' ? 1 : 0, proof: null,
    },
    receipts: {},
    qualifies: state !== 'not-attempted',
  };
}

function runDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'verify-evidence-'));
  mkdirSync(join(dir, 'evidence', 'AC1', 'drive-1-1'), { recursive: true });
  mkdirSync(join(dir, 'evidence', 'AC1', 'drafts'), { recursive: true });
  return dir;
}

describe('named evidence resolution', () => {
  it('accepts nonempty files anywhere in the run and reports each rejected item', () => {
    const dir = runDir();
    writeFileSync(join(dir, 'shot.PNG'), 'pixels');
    writeFileSync(join(dir, 'empty.log'), '');
    writeFileSync(join(dir, 'report.md'), 'old report');
    writeFileSync(join(dir, 'evidence', 'AC1', 'drive-1-1', 'step-1.json'), '{}');
    const evidence = resolveEvidence(dir, [criterion('AC1')], [{
      id: 'AC1', outcome: 'pass', proofSeen: true, observed: 'seen',
      evidence: ['shot.PNG', 'missing.log', 'empty.log', 'report.md', 'evidence/AC1/drive-1-1/step-1.json'],
    }], {}, {});
    expect(evidence.AC1.files).toMatchObject([{ name: 'shot.PNG', kind: 'image' }]);
    expect(evidence.AC1.substantiated).toBe(true);
    expect(evidence.AC1.markers.map((item) => item.message).join('\n')).toMatch(/missing\.log[\s\S]*empty[\s\S]*own evidence[\s\S]*engine-reserved/);
  });

  it('substantiates a FAIL from an all-errors trail but never a PASS', () => {
    const dir = runDir();
    const errors = attempt('command-error');
    const failCase = resolveEvidence(dir, [criterion('AC1', true)], [{
      id: 'AC1', outcome: 'fail', observed: 'step exploded',
    }], { AC1: errors }, {}).AC1;
    expect(failCase.substantiated).toBe(true);
    const passCase = resolveEvidence(dir, [criterion('AC1', true)], [{
      id: 'AC1', outcome: 'pass', proofSeen: true, observed: 'claims it worked',
    }], { AC1: errors }, {}).AC1;
    expect(passCase.substantiated).toBe(false);
  });

  it('escapes control characters in submitted evidence names', () => {
    const dir = runDir();
    const evil = 'x\u001b[31mFAKE\nAC9  ok';
    const out = resolveEvidence(dir, [criterion('AC1')], [{
      id: 'AC1', outcome: 'pass', observed: 'seen',
      evidence: [evil, 42 as unknown as string],
    }], {}, {}).AC1;
    const text = out.markers.map((m) => m.message).join('|');
    expect(text).not.toMatch(/\u001b/);
    expect(text).not.toContain('\n');
    expect(text).toContain('\\u001b');
  });

  it('rejects draft receipt folders and uppercase self-outputs', () => {
    const dir = runDir();
    writeFileSync(join(dir, 'evidence', 'AC1', 'drafts', 'step-1.json'), '{"draft":true}');
    writeFileSync(join(dir, 'Report.MD'), 'old report');
    const result = resolveEvidence(dir, [criterion('AC1')], [{
      id: 'AC1', outcome: 'pass', proofSeen: true, observed: 'seen',
      evidence: ['evidence/AC1/drafts/step-1.json', 'Report.MD'],
    }], {}, {}).AC1;
    expect(result.files).toEqual([]);
    expect(result.substantiated).toBe(false);
    expect(result.markers.map((m) => m.message).join('\n')).toMatch(/engine-reserved[\s\S]*own evidence/);
  });

  it('rejects absolute paths, escapes, directories, and symlinks including parent symlinks', () => {
    const dir = runDir();
    const outside = mkdtempSync(join(tmpdir(), 'verify-outside-'));
    writeFileSync(join(outside, 'outside.log'), 'secret');
    mkdirSync(join(dir, 'folder'));
    symlinkSync(join(outside, 'outside.log'), join(dir, 'linked.log'));
    symlinkSync(outside, join(dir, 'linked-dir'));
    const result = resolveEvidence(dir, [criterion('AC1')], [{
      id: 'AC1', outcome: 'pass', observed: 'seen',
      evidence: [join(outside, 'outside.log'), '../outside.log', 'folder', 'linked.log', 'linked-dir/outside.log'],
    }], {}, {}).AC1;
    expect(result.files).toEqual([]);
    expect(result.markers).toHaveLength(5);
    expect(result.markers.map((item) => item.message).join('\n')).toMatch(/absolute paths[\s\S]*outside the run[\s\S]*not a regular file[\s\S]*symlinks/);
  });

  it('uses canonical identity to call out reuse on every criterion', () => {
    const dir = runDir();
    writeFileSync(join(dir, 'observe.log'), 'one observation');
    const evidence = resolveEvidence(dir, [criterion('AC1'), criterion('AC2')], [
      { id: 'AC1', outcome: 'pass', proofSeen: true, observed: 'one', evidence: ['./observe.log'] },
      { id: 'AC2', outcome: 'pass', proofSeen: true, observed: 'two', evidence: ['observe.log'] },
    ], {}, {});
    expect(evidence.AC1.files[0].alsoCitedBy).toEqual(['AC2']);
    expect(evidence.AC2.files[0].alsoCitedBy).toEqual(['AC1']);
  });

  it('caps lossy text excerpts, URL-encodes links, and still substantiates unknown binary types', () => {
    const dir = runDir();
    const name = 'raw output.bin';
    writeFileSync(join(dir, name), Buffer.alloc(EVIDENCE_EXCERPT_LIMIT + 10, 0xff));
    const file = resolveEvidence(dir, [criterion('AC1')], [{
      id: 'AC1', outcome: 'fail', observed: 'wrong', evidence: [name],
    }], {}, {}).AC1.files[0];
    expect(file.kind).toBe('excerpt');
    expect(file.href).toBe('raw%20output.bin');
    expect(Buffer.byteLength(file.excerpt ?? '')).toBeGreaterThan(0);
  });
});

describe('substantiation by mode', () => {
  it('does not let a named file rescue a driven criterion', () => {
    const dir = runDir();
    writeFileSync(join(dir, 'shot.png'), 'pixels');
    const evidence = resolveEvidence(dir, [criterion('AC1', true)], [{
      id: 'AC1', outcome: 'pass', proofSeen: true, observed: 'seen', evidence: ['shot.png'],
    }], {}, {});
    expect(evidence.AC1.files).toHaveLength(1);
    expect(evidence.AC1.substantiated).toBe(false);
  });

  it.each(['completed', 'command-error', 'timeout'] as const)('%s attempts substantiate', (state) => {
    const dir = runDir();
    const trail = attempt(state);
    expect(resolveEvidence(dir, [criterion('AC1', true)], [{
      id: 'AC1', outcome: 'fail', observed: state,
    }], { AC1: trail }, {}).AC1.substantiated).toBe(true);
  });

  it('a finalized attempt with no terminal step does not substantiate', () => {
    const dir = runDir();
    expect(resolveEvidence(dir, [criterion('AC1', true)], [{
      id: 'AC1', outcome: 'pass', proofSeen: true, observed: 'claimed',
    }], { AC1: attempt('not-attempted') }, {}).AC1.substantiated).toBe(false);
  });

  it('auto-attaches an existing taint precheck log without using it to substantiate', () => {
    const dir = runDir();
    mkdirSync(join(dir, 'prechecks'));
    writeFileSync(join(dir, 'prechecks', 'api.log'), 'connection refused');
    const evidence = resolveEvidence(dir, [criterion('AC1')], [{
      id: 'AC1', outcome: 'could-not-run', observed: 'api down',
    }], {}, { AC1: 'api' }).AC1;
    expect(evidence.files).toMatchObject([{ name: 'prechecks/api.log', source: 'precheck' }]);
    expect(evidence.substantiated).toBe(false);
  });
});
