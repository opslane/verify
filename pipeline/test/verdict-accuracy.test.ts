// The verdict-accuracy rules: proof gates the headline, taint is mechanical,
// checks that did not run never disappear, and the HTML page tells the same
// story as the text report.
import { describe, expect, it } from 'vitest';
import {
  applyReceiptedProofs,
  applyTaint,
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

describe('proof-of-run', () => {
  it('a pass without its proof is not proven and blocks PASS', () => {
    const results: CriterionResult[] = [
      { id: 'AC1', outcome: 'pass', proofSeen: true, observed: 'marker seen' },
      { id: 'AC2', outcome: 'pass', observed: 'looked fine' }, // no proof
    ];
    const summary = summarise(results, { filesWithoutCriterion: 0 });
    expect(summary.proven).toBe(1);
    expect(summary.notProven).toBe(1);
    expect(headline(summary)).toBe('1 of 2 proven. 1 not proven.');
    expect(renderReport(results, { filesWithoutCriterion: 0 }, [])).toContain(
      'AC2  ~  not proven — the check may not have actually run',
    );
  });

  it('PASS appears only when every criterion is proven', () => {
    const results: CriterionResult[] = [
      { id: 'AC1', outcome: 'pass', proofSeen: true, observed: 'ok' },
      { id: 'AC2', outcome: 'pass', proofSeen: true, observed: 'ok' },
    ];
    const summary = summarise(results, { filesWithoutCriterion: 0 });
    expect(headline(summary)).toBe('PASS — 2 of 2 proven.');
  });

  it('could-not-run never disappears from the headline', () => {
    const results: CriterionResult[] = [
      { id: 'AC1', outcome: 'pass', proofSeen: true, observed: 'ok' },
      { id: 'AC2', outcome: 'could-not-run', observed: 'sink down' },
    ];
    const summary = summarise(results, { filesWithoutCriterion: 0 });
    expect(headline(summary)).toBe("1 of 2 proven. 1 couldn't run.");
  });

  it('a violation poisons the headline even when all proven', () => {
    const results: CriterionResult[] = [
      { id: 'AC1', outcome: 'pass', proofSeen: true, observed: 'ok' },
    ];
    const summary = summarise(results, { filesWithoutCriterion: 0 });
    expect(headline(summary, { violation: true })).toMatch(/^CANNOT TRUST THIS RUN/);
    expect(headline(summary, { violation: true })).not.toMatch(/^PASS/);
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
    expect(renderReport(applied.results, { filesWithoutCriterion: 0 }, [], applied.sources)).toContain('[receipted]');
  });

  it('lets taint make the final override', () => {
    const results = [{ id: 'AC1', outcome: 'pass' as const, proofSeen: false, observed: 'judge result' }];
    const receipted = applyReceiptedProofs(results, { AC1: { seen: true } });
    const final = applyTaint(
      receipted.results,
      { parts: { api: 'down' }, tainted: {}, unchecked: [] },
      [{ id: 'AC1', dependsOn: ['api'] }],
    );
    expect(final[0]).toMatchObject({ outcome: 'could-not-run', proofSeen: false });
  });

  it('does not alter ids absent from the supplied receipt entries', () => {
    const results = [{ id: 'AC1', outcome: 'pass' as const, proofSeen: true, observed: 'judged' }];
    expect(applyReceiptedProofs(results, {}).results).toEqual(results);
  });
});

describe('mechanical taint', () => {
  const precheck: Precheck = {
    parts: { api: 'ok', sink: 'down' },
    tainted: { AC2: 'sink' },
    unchecked: [],
  };

  it('overrides even a judged pass for a tainted criterion', () => {
    const results: CriterionResult[] = [
      { id: 'AC1', outcome: 'pass', proofSeen: true, observed: 'ok' },
      { id: 'AC2', outcome: 'pass', proofSeen: true, observed: 'claims it worked' },
    ];
    const tainted = applyTaint(results, precheck);
    expect(tainted[1].outcome).toBe('could-not-run');
    expect(tainted[1].proofSeen).toBe(false);
    expect(tainted[1].observed).toContain('sink');
    expect(tainted[0]).toEqual(results[0]);
  });

  it('recomputes taint from parts + dependsOn — a tampered tainted map cannot bypass it', () => {
    const results: CriterionResult[] = [
      { id: 'AC1', outcome: 'pass', proofSeen: true, observed: 'claims it worked' },
    ];
    const scrubbed: Precheck = { parts: { sink: 'down' }, tainted: {}, unchecked: [] };
    const criteria = [{ id: 'AC1', dependsOn: ['sink'] }];
    const tainted = applyTaint(results, scrubbed, criteria);
    expect(tainted[0].outcome).toBe('could-not-run');
  });
});

describe('criteria schema', () => {
  it('rejects a criterion without dependsOn or proof', () => {
    const bare = { ...criterion() } as Record<string, unknown>;
    delete bare.dependsOn;
    delete bare.proof;
    const problems = validateCriteria([bare]);
    expect(problems.join('\n')).toContain('dependsOn');
    expect(problems.join('\n')).toContain('proof');
  });

  it('rejects an unknown part', () => {
    const problems = validateCriteria([criterion({ dependsOn: ['mainframe' as never] })]);
    expect(problems.join('\n')).toContain('mainframe');
  });

  it('accepts a complete criterion', () => {
    expect(validateCriteria([criterion()])).toEqual([]);
  });
});

describe('html report', () => {
  const input = {
    runId: 'r1',
    criteria: [criterion(), criterion({ id: 'AC2', title: 'guard <b>holds</b>', intent: 'preserves' as const })],
    results: [
      { id: 'AC1', outcome: 'pass' as const, proofSeen: true, observed: 'marker seen' },
      { id: 'AC2', outcome: 'pass' as const, observed: 'no proof captured' },
    ],
    filesWithoutCriterion: 0,
    precheck: { parts: { api: 'ok' as const, sink: 'unknown' as const }, tainted: {}, unchecked: ['sink'] },
    violation: false,
    assets: { AC1: { images: ['evidence/AC1/screenshot-1.png'], videos: ['evidence/AC1/session.webm'] } },
    notChecked: [{ what: 'terminal recording', why: 'asciinema missing' }],
    sources: { AC1: 'receipted' as const, AC2: 'judged' as const },
  };

  it('escapes model-controlled text and keeps evidence relative', () => {
    const html = renderHtml(input);
    expect(html).toContain('&lt;b&gt;holds&lt;/b&gt;');
    expect(html).not.toContain('<b>holds</b>');
    expect(html).toContain('src="evidence/AC1/screenshot-1.png"');
    expect(html).toContain('<video controls src="evidence/AC1/session.webm">');
    expect(html).not.toContain('data:image');
  });

  it('renders a proofless pass as not proven, never a green card', () => {
    const html = renderHtml(input);
    expect(html).toContain('class="card not-proven"');
    expect(html).toContain('not proven — the check may not have actually run');
    expect(html).toContain('proof: receipted');
    expect(html).toContain('proof: judged');
  });

  it('headline says PASS only when proven, and violation poisons the page', () => {
    expect(renderHtml(input)).not.toContain('<h1>PASS');
    const clean = {
      ...input,
      results: input.results.map((r) => ({ ...r, proofSeen: true })),
    };
    expect(renderHtml(clean)).toContain('PASS — 2 of 2 proven.');
    expect(renderHtml({ ...clean, violation: true })).toContain('CANNOT TRUST THIS RUN');
  });

  it('lists unchecked parts and the not-checked section, and carries codify markers', () => {
    const html = renderHtml(input);
    expect(html).toContain('sink: no probe available');
    expect(html).toContain('asciinema missing');
    expect(html).toContain('codify-block-begin');
  });
});
