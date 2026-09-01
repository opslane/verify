import { describe, expect, it } from 'vitest';
import {
  applyReceiptedProofs,
  applyTaint,
  classify,
  headline,
  renderReport,
  summarise,
  type CriterionResult,
  type Precheck,
} from '../src/lib/verdict.js';
import { validateCriteria, type Criterion } from '../src/lib/criteria.js';
import { renderHtml } from '../src/lib/html.js';

const criterion = (over: Partial<Criterion> = {}): Criterion => ({
  id: 'AC1',
  title: 'an event lands in the digest',
  plain: 'A marked event appears in the digest.',
  doIt: 'POST a marked event',
  expectIt: 'digest contains the marker',
  source: { kind: 'plan', ref: 'R1' },
  intent: 'changes',
  baseline: 'fail',
  witness: 'success',
  dependsOn: ['api', 'sink'],
  proof: { kind: 'marker-in-data', detail: 'marker in the digest message' },
  ...over,
});

describe('terminal classification', () => {
  const verdict = (
    result: CriterionResult,
    substantiated: boolean,
    tainted = false,
  ) => classify([result], { [result.id]: { substantiated, tainted } })[0].displayVerdict;

  it('implements the truth table top to bottom', () => {
    expect(verdict({ id: 'AC1', outcome: 'pass', proofSeen: true, observed: 'ok' }, true, true)).toBe('blocked');
    expect(verdict({ id: 'AC1', outcome: 'could-not-run', observed: 'permission denied' }, false)).toBe('blocked');
    expect(verdict({ id: 'AC1', outcome: 'could-not-run', observed: '  ' }, false)).toBe('not-proven');
    expect(verdict({ id: 'AC1', outcome: 'pass', proofSeen: true, observed: 'ok' }, true)).toBe('proven');
    expect(verdict({ id: 'AC1', outcome: 'pass', proofSeen: false, observed: 'ok' }, true)).toBe('not-proven');
    expect(verdict({ id: 'AC1', outcome: 'pass', proofSeen: true, observed: 'ok' }, false)).toBe('not-proven');
    expect(verdict({ id: 'AC1', outcome: 'fail', proofSeen: false, observed: 'wrong' }, true)).toBe('failed');
    expect(verdict({ id: 'AC1', outcome: 'fail', proofSeen: true, observed: 'wrong' }, true)).toBe('failed');
    expect(verdict({ id: 'AC1', outcome: 'fail', observed: 'wrong' }, false)).toBe('not-proven');
  });

  it('drives headline, counts, and text from displayVerdict', () => {
    const results = classify([
      { id: 'AC1', outcome: 'pass', proofSeen: true, observed: 'ok' },
      { id: 'AC2', outcome: 'fail', proofSeen: true, observed: 'wrong' },
      { id: 'AC3', outcome: 'could-not-run', observed: 'sink down' },
      { id: 'AC4', outcome: 'pass', proofSeen: true, observed: 'claimed' },
    ], {
      AC1: { substantiated: true }, AC2: { substantiated: true },
      AC3: { substantiated: false }, AC4: { substantiated: false },
    });
    const summary = summarise(results, { filesWithoutCriterion: 0 });
    // Behaviour/Ran count raw outcomes (independent axes); proven/notProven
    // are the verdict buckets.
    expect(summary).toMatchObject({ proven: 1, notProven: 1, behaviour: { passed: 2, failed: 1 }, ran: { total: 4, couldNotRun: 1 } });
    expect(headline(summary)).toBe("1 of 4 proven. 1 couldn't run. 1 failed. 1 not proven.");
    expect(renderReport(results, { filesWithoutCriterion: 0 }, [])).toContain('AC4  ~  not proven — reported pass, no evidence');
  });

  it('PASS appears only when every classified result is proven', () => {
    const results = classify([
      { id: 'AC1', outcome: 'pass', proofSeen: true, observed: 'ok' },
      { id: 'AC2', outcome: 'pass', proofSeen: true, observed: 'ok' },
    ], { AC1: { substantiated: true }, AC2: { substantiated: true } });
    expect(headline(summarise(results, { filesWithoutCriterion: 0 }))).toBe('PASS — 2 of 2 proven.');
    expect(headline(summarise(results, { filesWithoutCriterion: 0 }), { violation: true })).toMatch(/^CANNOT TRUST THIS RUN/);
  });
});

describe('receipted proof', () => {
  it('overrides the judge in both directions and labels every source', () => {
    const results: CriterionResult[] = [
      { id: 'AC1', outcome: 'pass', proofSeen: false, observed: 'judge was stingy' },
      { id: 'AC2', outcome: 'pass', proofSeen: true, observed: 'judge was generous' },
      { id: 'AC3', outcome: 'pass', proofSeen: true, observed: 'hand driven' },
    ];
    const applied = applyReceiptedProofs(results, { AC1: { seen: true }, AC2: { seen: false } });
    expect(applied.results.map((result) => result.proofSeen)).toEqual([true, false, true]);
    expect(applied.sources).toEqual({ AC1: 'receipted', AC2: 'receipted', AC3: 'judged' });
    const classified = classify(applied.results, {
      AC1: { substantiated: true }, AC2: { substantiated: true }, AC3: { substantiated: true },
    });
    expect(renderReport(classified, { filesWithoutCriterion: 0 }, [], { sources: applied.sources })).toContain('[machine-checked]');
  });

  it('lets taint make the final override', () => {
    const receipted = applyReceiptedProofs(
      [{ id: 'AC1', outcome: 'pass', proofSeen: false, observed: 'judge result' }],
      { AC1: { seen: true } },
    );
    const final = applyTaint(receipted.results, { parts: { api: 'down' }, tainted: {}, unchecked: [] }, [{ id: 'AC1', dependsOn: ['api'] }]);
    expect(final[0]).toMatchObject({ outcome: 'could-not-run', proofSeen: false });
  });
});

describe('mechanical taint', () => {
  const precheck: Precheck = { parts: { api: 'ok', sink: 'down' }, tainted: { AC2: 'sink' }, unchecked: [] };

  it('recomputes taint from parts + dependsOn', () => {
    const results = applyTaint(
      [{ id: 'AC1', outcome: 'pass', proofSeen: true, observed: 'claims it worked' }],
      { ...precheck, tainted: {} },
      [{ id: 'AC1', dependsOn: ['sink'] }],
    );
    expect(results[0]).toMatchObject({ outcome: 'could-not-run', proofSeen: false });
    expect(results[0].observed).toContain('sink');
  });

  it('honors the precheck tainted map even when the derived lookup finds nothing', () => {
    // Same belt-and-braces rule as the drive guard: derived parts x dependsOn
    // is the authority, the tainted map is the fallback — never dropped.
    const original: CriterionResult[] = [
      { id: 'AC1', outcome: 'pass', proofSeen: true, observed: 'worked' },
    ];
    const tainted = applyTaint(
      original,
      { parts: { api: 'ok' }, tainted: { AC1: 'api' }, unchecked: [] },
      [{ id: 'AC1', dependsOn: ['api'] }],
    );
    expect(tainted[0].outcome).toBe('could-not-run');
  });
});

describe('criteria schema', () => {
  it('requires dependencies and proof while keeping plain optional', () => {
    const bare = { ...criterion() } as Record<string, unknown>;
    delete bare.dependsOn;
    delete bare.proof;
    expect(validateCriteria([bare]).join('\n')).toMatch(/dependsOn[\s\S]*proof/);
    expect(validateCriteria([criterion({ plain: undefined })])).toEqual([]);
  });
});

describe('html report', () => {
  const criteria = [
    criterion(),
    criterion({ id: 'AC2', plain: 'A guard <b>holds</b>.', intent: 'preserves' }),
  ];
  const raw: CriterionResult[] = [
    { id: 'AC1', outcome: 'pass', proofSeen: true, observed: 'marker verify-r1 seen' },
    { id: 'AC2', outcome: 'pass', observed: 'no proof captured' },
  ];
  const results = classify(raw, { AC1: { substantiated: true }, AC2: { substantiated: true } });
  const input = {
    runId: 'r1',
    runTag: 'verify-r1',
    criteria,
    results,
    filesWithoutCriterion: 0,
    precheck: { parts: { api: 'ok' as const, sink: 'unknown' as const }, tainted: {}, unchecked: ['sink'] },
    violation: false,
    evidence: {
      AC1: {
        files: [{
          name: 'shot <1>.png', relativePath: 'shots/shot 1.png', href: 'shots/shot%201.png',
          bytes: 12, kind: 'image' as const, source: 'named' as const, alsoCitedBy: ['AC2'],
        }],
        markers: [], substantiated: true,
      },
      AC2: { files: [], markers: [], substantiated: true },
    },
    notChecked: [{ what: 'terminal recording', why: 'asciinema missing' }],
    sources: { AC1: 'receipted' as const, AC2: 'judged' as const },
  };

  it('escapes claims, highlights the run tag, and keeps evidence relative', () => {
    const html = renderHtml(input);
    expect(html).toContain('A guard &lt;b&gt;holds&lt;/b&gt;.');
    expect(html).not.toContain('<b>holds</b>');
    expect(html).toContain('src="shots/shot%201.png"');
    expect(html).toContain('also cited by AC2');
    expect(html).toContain('<mark>verify-r1</mark>');
  });

  it('renders the classified verdict and reader-language proof source', () => {
    const html = renderHtml(input);
    expect(html).toContain('class="card not-proven"');
    expect(html).toContain('proof of run was not observed');
    expect(html).toContain('machine-checked');
    expect(html).toContain('agent-reported');
  });

  it('calls out a receipted failure whose check definitely ran', () => {
    const failed = classify([
      { id: 'AC1', outcome: 'fail', proofSeen: true, observed: 'wrong value' },
    ], { AC1: { substantiated: true } });
    const html = renderHtml({
      ...input,
      criteria: [criterion()], results: failed,
      evidence: { AC1: { files: [], markers: [], substantiated: true } },
      sources: { AC1: 'receipted' },
    });
    expect(html).toContain('check ran: machine-checked');
    expect(html).toContain('class="card failed"');
  });

  it('labels a judged failure with proof honestly, never as machine-checked', () => {
    const failed = classify([
      { id: 'AC1', outcome: 'fail', proofSeen: true, observed: 'wrong value' },
    ], { AC1: { substantiated: true } });
    const html = renderHtml({
      ...input,
      criteria: [criterion()], results: failed,
      evidence: { AC1: { files: [], markers: [], substantiated: true } },
      sources: { AC1: 'judged' },
    });
    expect(html).toContain('check ran: agent-reported');
    expect(html).not.toContain('check ran: machine-checked');
  });

  it('escapes evidence filenames and renders video evidence', () => {
    const html = renderHtml({
      ...input,
      evidence: {
        ...input.evidence,
        AC2: {
          files: [{
            name: 'clip<script>.webm', relativePath: 'clip.webm', href: 'clip.webm',
            bytes: 9, kind: 'video' as const, source: 'named' as const, alsoCitedBy: [],
          }],
          markers: [], substantiated: true,
        },
      },
    });
    expect(html).toContain('clip&lt;script&gt;.webm');
    expect(html).not.toContain('clip<script>');
    expect(html).toContain('<video controls src="clip.webm">');
  });

  it('lists unchecked parts and carries codify markers', () => {
    const html = renderHtml(input);
    expect(html).toContain('sink: no probe available');
    expect(html).toContain('asciinema missing');
    expect(html).toContain('codify-block-begin');
  });

  it('renders approved step labels and honest receipt transcripts without a PTY', () => {
    const driven = criterion({
      drive: [
        { verb: 'run', args: ['approved-label'] },
        { verb: 'wait', args: ['--url', '/ready', '--timeout', '2'] },
      ],
    });
    const receipt = {
      verb: 'run' as const, display: 'receipt display', state: 'completed' as const,
      proofEligible: true, startedAt: '2026-09-01T00:00:00.000Z', endedAt: '2026-09-01T00:00:00.300Z',
      command: { argv: ['node', 'check.js'], cwd: '/repo' }, timeoutSeconds: 2,
      output: 'row verify-r1', diagnostics: 'one warning', outputTruncated: true, diagnosticsTruncated: true,
    };
    const drivenResult = classify([
      { id: 'AC1', outcome: 'pass', proofSeen: true, observed: 'ok' },
    ], { AC1: { substantiated: true } });
    const html = renderHtml({
      ...input,
      criteria: [driven], results: drivenResult,
      evidence: { AC1: {
        files: [], markers: [], substantiated: true,
        attempt: {
          folder: 'drive-1-1', qualifies: true,
          manifest: {
            ac: 'AC1', attempt: 'drive-1-1', finalized: true,
            startedAt: receipt.startedAt, endedAt: receipt.endedAt, completed: 1, proof: null,
            steps: [
              { index: 1, verb: 'run', state: 'completed' },
              { index: 2, verb: 'wait', state: 'not-attempted' },
            ],
          },
          receipts: { 1: receipt, 3: receipt },
        },
      } },
    });
    expect(html).toContain('run approved-label');
    expect(html).toContain('not-attempted — no receipt for step 2');
    expect(html).toContain('unlabeled extra step 3');
    expect(html).toContain('recorded invocation');
    expect(html).toContain('captured output');
    expect(html).toContain('diagnostics');
    expect(html).toContain('node check.js');
    expect(html).toContain('row <mark>verify-r1</mark>');
    expect(html.match(/truncated at capture limit/g)).toHaveLength(4);
  });
});
