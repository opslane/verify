import { describe, expect, it } from 'vitest';
import { renderReport, summarise, type CriterionResult } from '../src/lib/verdict.js';

const results: CriterionResult[] = [
  { id: 'AC1', outcome: 'pass', proofSeen: true, observed: '50 rows (was HTTP 500)' },
  { id: 'AC2', outcome: 'pass', proofSeen: true, observed: 'HTTP 401 before dispatch' },
  { id: 'AC3', outcome: 'could-not-run', observed: 'staging rejected the create' },
];

describe('summarise', () => {
  it('keeps behaviour and execution apart', () => {
    const summary = summarise(results, { filesWithoutCriterion: 2 });
    expect(summary.behaviour).toEqual({ passed: 2, failed: 0 });
    expect(summary.ran).toEqual({ total: 3, couldNotRun: 1 });
    expect(summary.covered).toEqual({ criteria: 3, filesWithoutCriterion: 2 });
  });

  it('does not count a could-not-run as a failure', () => {
    const summary = summarise(
      [{ id: 'AC1', outcome: 'could-not-run', observed: 'db down' }],
      { filesWithoutCriterion: 0 },
    );
    expect(summary.behaviour.failed).toBe(0);
    expect(summary.ran.couldNotRun).toBe(1);
  });
});

describe('renderReport', () => {
  it('renders per-criterion lines with the right marks', () => {
    const output = renderReport(results, { filesWithoutCriterion: 2 }, []);
    expect(output).toContain('AC1  ✔  50 rows (was HTTP 500)');
    expect(output).toContain('AC3  ~  could not run, staging rejected the create');
  });

  it('renders the axes apart from each other', () => {
    const output = renderReport(results, { filesWithoutCriterion: 2 }, []);
    expect(output).toContain('Behaviour  2 passed, 0 failed');
    expect(output).toContain('Ran        3 criteria, 1 could not run');
    expect(output).toContain('Covered    3 criteria, 2 changed files have none');
  });

  it('always renders Not checked, even when empty', () => {
    const output = renderReport(results, { filesWithoutCriterion: 0 }, []);
    expect(output).toContain('Not checked');
    expect(output).toContain('  (nothing)');
  });

  it('lists explicit not-checked entries', () => {
    const output = renderReport(results, { filesWithoutCriterion: 0 }, [
      { what: '/healthz', why: 'pod-internal, not routed publicly' },
    ]);
    expect(output).toContain('/healthz');
    expect(output).toContain('pod-internal, not routed publicly');
  });
});
