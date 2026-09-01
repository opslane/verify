import { describe, expect, it } from 'vitest';
import { classify, headline, renderReport, summarise, validateResults, type CriterionResult } from '../src/lib/verdict.js';

const results: CriterionResult[] = [
  { id: 'AC1', outcome: 'pass', proofSeen: true, observed: '50 rows (was HTTP 500)' },
  { id: 'AC2', outcome: 'pass', proofSeen: true, observed: 'HTTP 401 before dispatch' },
  { id: 'AC3', outcome: 'could-not-run', observed: 'staging rejected the create' },
];
const classified = classify(results, Object.fromEntries(results.map((result) => [
  result.id, { substantiated: true },
])));

describe('summarise', () => {
  it('keeps behaviour and execution apart', () => {
    const summary = summarise(classified, { filesWithoutCriterion: 2 });
    expect(summary.behaviour).toEqual({ passed: 2, failed: 0 });
    expect(summary.ran).toEqual({ total: 3, couldNotRun: 1 });
    expect(summary.covered).toEqual({ criteria: 3, filesWithoutCriterion: 2 });
  });

  it('does not count a could-not-run as a failure', () => {
    const blocked = classify(
      [{ id: 'AC1', outcome: 'could-not-run', observed: 'db down' }],
      { AC1: { substantiated: false } },
    );
    const summary = summarise(
      blocked,
      { filesWithoutCriterion: 0 },
    );
    expect(summary.behaviour.failed).toBe(0);
    expect(summary.ran.couldNotRun).toBe(1);
  });
});

describe('renderReport', () => {
  it('renders per-criterion lines with the right marks', () => {
    const output = renderReport(classified, { filesWithoutCriterion: 2 }, []);
    expect(output).toContain('AC1  ✔  50 rows (was HTTP 500)');
    expect(output).toContain('AC3  ~  blocked, staging rejected the create');
  });

  it('renders the axes apart from each other', () => {
    const output = renderReport(classified, { filesWithoutCriterion: 2 }, []);
    expect(output).toContain('Behaviour  2 passed, 0 failed');
    expect(output).toContain('Ran        3 criteria, 1 could not run');
    expect(output).toContain('Covered    3 criteria, 2 changed files have none');
  });

  it('always renders Not checked, even when empty', () => {
    const output = renderReport(classified, { filesWithoutCriterion: 0 }, []);
    expect(output).toContain('Not checked');
    expect(output).toContain('  (nothing)');
  });

  it('lists explicit not-checked entries', () => {
    const output = renderReport(classified, { filesWithoutCriterion: 0 }, [
      { what: '/healthz', why: 'pod-internal, not routed publicly' },
    ]);
    expect(output).toContain('/healthz');
    expect(output).toContain('pod-internal, not routed publicly');
  });
});

describe('validateResults', () => {
  it('rejects a typo outcome instead of letting classify misbucket it', () => {
    const problems = validateResults({ results: [{ id: 'AC1', outcome: 'Pass', observed: 'ok' }] });
    expect(problems.join('\n')).toContain('outcome must be pass|fail|could-not-run');
  });

  it('accepts a well-formed results file', () => {
    expect(validateResults({ results: [{ id: 'AC1', outcome: 'pass', observed: 'ok' }] })).toEqual([]);
  });
});

describe('headline buckets', () => {
  it('never double-counts a demoted criterion across segments', () => {
    // An unevidenced fail is not-proven ONLY — it must not also count as failed.
    const one = classify([{ id: 'AC1', outcome: 'fail', observed: 'wrong' }], { AC1: { substantiated: false } });
    expect(headline(summarise(one, { filesWithoutCriterion: 0 }))).toBe('0 of 1 proven. 1 not proven.');
    // A blank-reason could-not-run is not-proven ONLY.
    const two = classify([{ id: 'AC1', outcome: 'could-not-run', observed: '' }], { AC1: { substantiated: false } });
    expect(headline(summarise(two, { filesWithoutCriterion: 0 }))).toBe('0 of 1 proven. 1 not proven.');
  });
});
