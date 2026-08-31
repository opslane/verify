export type Outcome = 'pass' | 'fail' | 'could-not-run';

export interface CriterionResult {
  id: string;
  outcome: Outcome;
  /** What was seen. Never a claim, always an observation. */
  observed: string;
  /**
   * Whether the criterion's declared proof-of-run was actually observed in the
   * evidence. A pass without its proof does not count as proven: it renders
   * "not proven" and blocks the PASS headline. Absent means false — proof is
   * never assumed.
   */
  proofSeen?: boolean;
}

/** The pipeline-check output (precheck.sh). Taint is enforced here, mechanically. */
export interface Precheck {
  parts: Record<string, 'ok' | 'down' | 'unknown'>;
  tainted: Record<string, string>;
  unchecked: string[];
}

/**
 * A criterion whose dependent part failed its pipeline check is could-not-run
 * regardless of what the judge or driver reported — a broken pipe must never
 * become a verdict in either direction. Taint is recomputed here from the
 * parts map and each criterion's own dependsOn: the derived `tainted` map in
 * precheck.json is a convenience, never the authority.
 */
export function applyTaint(
  results: CriterionResult[],
  precheck: Precheck,
  criteria?: { id: string; dependsOn?: string[] }[],
): CriterionResult[] {
  const deps = new Map((criteria ?? []).map((c) => [c.id, c.dependsOn ?? []]));
  const downFor = (id: string): string | undefined => {
    const declared = deps.get(id);
    if (declared) {
      const down = declared.find((part) => precheck.parts[part] === 'down');
      if (down) return down;
    }
    return precheck.tainted[id];
  };
  return results.map((result) => {
    const part = downFor(result.id);
    if (!part) return result;
    return {
      ...result,
      outcome: 'could-not-run',
      proofSeen: false,
      observed: `dependent part ${part} failed its pipeline check`,
    };
  });
}

/**
 * One result per approved criterion, in criteria order. A criterion the
 * results forgot becomes could-not-run; duplicate or unknown result ids can
 * never inflate the count. Fails on criteria relying on an unprobed part get
 * the environmental note appended.
 */
export function reconcile(
  criteria: { id: string; dependsOn?: string[] }[],
  results: CriterionResult[],
  precheck?: Precheck,
): CriterionResult[] {
  const byId = new Map<string, CriterionResult>();
  for (const result of results) {
    if (!byId.has(result.id)) byId.set(result.id, result);
  }
  const unchecked = new Set(precheck?.unchecked ?? []);
  return criteria.map((criterion) => {
    const found = byId.get(criterion.id) ?? {
      id: criterion.id,
      outcome: 'could-not-run' as const,
      proofSeen: false,
      observed: 'no result was recorded for this criterion',
    };
    if (found.outcome === 'fail') {
      const suspect = (criterion.dependsOn ?? []).find((part) => unchecked.has(part));
      if (suspect && !found.observed.includes('may be environmental')) {
        return {
          ...found,
          observed: `${found.observed} — the failure may be environmental: ${suspect} was never health-checked`,
        };
      }
    }
    return found;
  });
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
  /** pass AND proof seen. The only thing the headline may call proven. */
  proven: number;
  /** pass whose declared proof was not observed — it does not count. */
  notProven: number;
}

const MARK: Record<Outcome, string> = {
  pass: '✔',
  fail: '✘',
  'could-not-run': '~',
};

export function summarise(results: CriterionResult[], coverage: Coverage): RunSummary {
  const proven = results.filter((r) => r.outcome === 'pass' && r.proofSeen === true).length;
  const passed = results.filter((r) => r.outcome === 'pass').length;
  return {
    behaviour: {
      passed,
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
    proven,
    notProven: passed - proven,
  };
}

/**
 * The one-line verdict. Checks that did not run never disappear from the
 * count, and PASS appears only when every criterion is proven. A clean-repo
 * violation poisons the whole line: verdicts about a mutated tree are not
 * verdicts about your code.
 */
export function headline(summary: RunSummary, opts: { violation?: boolean } = {}): string {
  let line = `${summary.proven} of ${summary.ran.total} proven.`;
  if (summary.ran.couldNotRun > 0) line += ` ${summary.ran.couldNotRun} couldn't run.`;
  if (summary.behaviour.failed > 0) line += ` ${summary.behaviour.failed} failed.`;
  if (summary.notProven > 0) line += ` ${summary.notProven} not proven.`;
  if (opts.violation) {
    return `CANNOT TRUST THIS RUN — verify modified the working tree. ${line}`;
  }
  if (summary.proven === summary.ran.total && summary.ran.total > 0) {
    return `PASS — ${line}`;
  }
  return line;
}

export function renderReport(
  results: CriterionResult[],
  coverage: Coverage,
  notChecked: NotChecked[],
): string {
  const summary = summarise(results, coverage);

  const resultLines = results.map((result) => {
    if (result.outcome === 'pass' && result.proofSeen !== true) {
      return `${result.id}  ~  not proven — the check may not have actually run; ${result.observed}`;
    }
    const observed =
      result.outcome === 'could-not-run'
        ? `could not run, ${result.observed}`
        : result.observed;
    return `${result.id}  ${MARK[result.outcome]}  ${observed}`;
  });

  const axes = [
    `Proven     ${summary.proven} of ${summary.ran.total} (pass with its declared proof observed)`,
    `Behaviour  ${summary.behaviour.passed} passed, ${summary.behaviour.failed} failed`,
    `Ran        ${summary.ran.total} criteria, ${summary.ran.couldNotRun} could not run`,
    `Covered    ${summary.covered.criteria} criteria, ${summary.covered.filesWithoutCriterion} changed files have none`,
  ];

  const width = Math.max(0, ...notChecked.map((entry) => entry.what.length));
  const notCheckedLines = notChecked.length
    ? notChecked.map((entry) => `  ${entry.what.padEnd(width)}  ${entry.why}`)
    : ['  (nothing)'];

  return [
    headline(summary),
    '',
    resultLines.join('\n'),
    '',
    axes.join('\n'),
    '',
    'Not checked',
    notCheckedLines.join('\n'),
    '',
  ].join('\n');
}
