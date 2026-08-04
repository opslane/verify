export type Outcome = 'pass' | 'fail' | 'could-not-run';

export interface CriterionResult {
  id: string;
  outcome: Outcome;
  /** What was seen. Never a claim, always an observation. */
  observed: string;
}

export interface NotChecked {
  what: string;
  why: string;
}

export interface Coverage {
  filesWithoutCriterion: number;
}

export interface RunSummary {
  behaviour: { passed: number; failed: number };
  ran: { total: number; couldNotRun: number };
  covered: { criteria: number; filesWithoutCriterion: number };
}

const MARK: Record<Outcome, string> = {
  pass: '✔',
  fail: '✘',
  'could-not-run': '~',
};

export function summarise(results: CriterionResult[], coverage: Coverage): RunSummary {
  return {
    behaviour: {
      passed: results.filter((result) => result.outcome === 'pass').length,
      failed: results.filter((result) => result.outcome === 'fail').length,
    },
    ran: {
      total: results.length,
      couldNotRun: results.filter((result) => result.outcome === 'could-not-run').length,
    },
    covered: {
      criteria: results.length,
      filesWithoutCriterion: coverage.filesWithoutCriterion,
    },
  };
}

export function renderReport(
  results: CriterionResult[],
  coverage: Coverage,
  notChecked: NotChecked[],
): string {
  const summary = summarise(results, coverage);

  const resultLines = results.map((result) => {
    const observed =
      result.outcome === 'could-not-run'
        ? `could not run, ${result.observed}`
        : result.observed;
    return `${result.id}  ${MARK[result.outcome]}  ${observed}`;
  });

  const axes = [
    `Behaviour  ${summary.behaviour.passed} passed, ${summary.behaviour.failed} failed`,
    `Ran        ${summary.ran.total} criteria, ${summary.ran.couldNotRun} could not run`,
    `Covered    ${summary.covered.criteria} criteria, ${summary.covered.filesWithoutCriterion} changed files have none`,
  ];

  const width = Math.max(0, ...notChecked.map((entry) => entry.what.length));
  const notCheckedLines = notChecked.length
    ? notChecked.map((entry) => `  ${entry.what.padEnd(width)}  ${entry.why}`)
    : ['  (nothing)'];

  return [
    resultLines.join('\n'),
    '',
    axes.join('\n'),
    '',
    'Not checked',
    notCheckedLines.join('\n'),
    '',
  ].join('\n');
}
