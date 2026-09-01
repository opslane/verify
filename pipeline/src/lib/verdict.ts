import type { Criterion } from './criteria.js';
import type { CriterionEvidence } from './evidence.js';

export type Outcome = 'pass' | 'fail' | 'could-not-run';
export type DisplayVerdict = 'proven' | 'failed' | 'not-proven' | 'blocked';

export interface CriterionResult {
  id: string;
  outcome: Outcome;
  /** What was seen. Never a claim, always an observation. */
  observed: string;
  /** Whether the declared proof-of-run was observed. Absent means false. */
  proofSeen?: boolean;
  /** Run-relative files explicitly named by the result author. */
  evidence?: string[];
}

export interface ClassifiedCriterionResult extends CriterionResult {
  /** Computed once at the terminal classification stage. */
  displayVerdict: DisplayVerdict;
  /** Computed by opening named evidence or a finalized drive attempt. */
  substantiated: boolean;
}

/** The pipeline-check output (precheck.sh). Taint is enforced here, mechanically. */
export interface Precheck {
  parts: Record<string, 'ok' | 'down' | 'unknown'>;
  tainted: Record<string, string>;
  unchecked: string[];
}

export type ProofSource = 'receipted' | 'judged';
export interface ReceiptedProofEntry { seen: boolean }

export function applyReceiptedProofs(
  results: CriterionResult[],
  entries: Record<string, ReceiptedProofEntry>,
): { results: CriterionResult[]; sources: Record<string, ProofSource> } {
  const sources: Record<string, ProofSource> = {};
  return {
    results: results.map((result) => {
      const entry = entries[result.id];
      sources[result.id] = entry === undefined ? 'judged' : 'receipted';
      return entry === undefined ? result : { ...result, proofSeen: entry.seen };
    }),
    sources,
  };
}

const OUTCOMES = new Set(['pass', 'fail', 'could-not-run']);

/** results.json is author-written; a typo'd outcome must fail loudly, never
 * fall through classify's else branch into a wrong verdict. */
export function validateResults(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { results?: unknown }).results)) {
    return ['results.json must contain a results array'];
  }
  const problems: string[] = [];
  (value as { results: unknown[] }).results.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) { problems.push(`results[${index}] must be an object`); return; }
    const result = entry as Partial<CriterionResult>;
    if (typeof result.id !== 'string' || result.id === '') problems.push(`results[${index}] needs a string id`);
    if (!OUTCOMES.has(result.outcome as string)) {
      problems.push(`results[${index}] outcome must be pass|fail|could-not-run, got ${JSON.stringify(result.outcome)}`);
    }
    if (typeof result.observed !== 'string') problems.push(`results[${index}] needs a string observed`);
    if (result.proofSeen !== undefined && typeof result.proofSeen !== 'boolean') {
      problems.push(`results[${index}] proofSeen must be a boolean`);
    }
  });
  return problems;
}

export function taintPartFor(
  id: string,
  precheck: Precheck,
  criteria?: { id: string; dependsOn?: string[] }[],
): string | undefined {
  if (criteria !== undefined) {
    const criterion = criteria.find((item) => item.id === id);
    // The derived lookup is the authority, but the precheck's own tainted map
    // stays as the fallback — same belt-and-braces derivation the drive guard
    // uses; dropping it here made the two disagree.
    return criterion?.dependsOn?.find((part) => precheck.parts[part] === 'down')
      ?? precheck.tainted?.[id];
  }
  // Compatibility for direct/legacy callers that have no approved dependency
  // declarations to recompute from.
  return precheck.tainted?.[id];
}

/** Mechanical taint is the final mutation before classification. */
export function applyTaint(
  results: CriterionResult[],
  precheck: Precheck,
  criteria?: { id: string; dependsOn?: string[] }[],
): CriterionResult[] {
  return results.map((result) => {
    const part = taintPartFor(result.id, precheck, criteria);
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
 * One result per approved criterion, in criteria order. Unknown and duplicate
 * ids never inflate a report.
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
      evidence: [],
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

/**
 * The sole bucket decision. Rules are ordered exactly as the report-v2 truth
 * table; renderers and summaries consume only `displayVerdict` afterwards.
 */
export function classify(
  results: CriterionResult[],
  facts: Record<string, { substantiated: boolean; tainted?: boolean }>,
): ClassifiedCriterionResult[] {
  return results.map((result) => {
    const substantiated = facts[result.id]?.substantiated === true;
    const tainted = facts[result.id]?.tainted === true;
    let displayVerdict: DisplayVerdict;
    if (tainted) displayVerdict = 'blocked';
    else if (result.outcome === 'could-not-run') {
      displayVerdict = (result.observed ?? '').trim() === '' ? 'not-proven' : 'blocked';
    } else if (result.outcome === 'pass') {
      displayVerdict = substantiated && result.proofSeen === true ? 'proven' : 'not-proven';
    } else {
      displayVerdict = substantiated ? 'failed' : 'not-proven';
    }
    return { ...result, substantiated, displayVerdict };
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
  proven: number;
  notProven: number;
  failedVerdict: number;
  blocked: number;
}

const MARK: Record<DisplayVerdict, string> = {
  proven: '✔',
  failed: '✘',
  'not-proven': '~',
  blocked: '~',
};

export function summarise(results: ClassifiedCriterionResult[], coverage: Coverage): RunSummary {
  const count = (verdict: DisplayVerdict) => results.filter((r) => r.displayVerdict === verdict).length;
  return {
    // Behaviour and Ran stay raw-outcome axes (independent of the verdict
    // buckets), as the README's four-axis contract documents.
    behaviour: {
      passed: results.filter((r) => r.outcome === 'pass').length,
      failed: results.filter((r) => r.outcome === 'fail').length,
    },
    ran: {
      total: results.length,
      couldNotRun: results.filter((r) => r.outcome === 'could-not-run').length,
    },
    covered: { criteria: results.length, filesWithoutCriterion: coverage.filesWithoutCriterion },
    proven: count('proven'),
    notProven: count('not-proven'),
    failedVerdict: count('failed'),
    blocked: count('blocked'),
  };
}

export function headline(summary: RunSummary, opts: { violation?: boolean } = {}): string {
  // The headline consumes ONLY verdict buckets so its segments partition
  // ran.total — mixing in the raw axes double-counted demoted criteria.
  let line = `${summary.proven} of ${summary.ran.total} proven.`;
  if (summary.blocked > 0) line += ` ${summary.blocked} couldn't run.`;
  if (summary.failedVerdict > 0) line += ` ${summary.failedVerdict} failed.`;
  if (summary.notProven > 0) line += ` ${summary.notProven} not proven.`;
  if (opts.violation) return `CANNOT TRUST THIS RUN — verify modified the working tree. ${line}`;
  if (summary.proven === summary.ran.total && summary.ran.total > 0) return `PASS — ${line}`;
  return line;
}

export interface ReportOptions {
  criteria?: Pick<Criterion, 'id' | 'title' | 'plain'>[];
  evidence?: Record<string, CriterionEvidence>;
  sources?: Record<string, ProofSource>;
  legacyEvidence?: boolean;
  violation?: boolean;
}

export function notProvenReason(result: ClassifiedCriterionResult): string {
  if (result.outcome === 'could-not-run') return 'reported blocked, no reason';
  if (!result.substantiated) return `reported ${result.outcome}, no evidence`;
  return 'the check may not have actually run';
}

export function sourceLabel(source: ProofSource): string {
  return source === 'receipted' ? 'machine-checked' : 'agent-reported';
}

/** Terminal output is a forgery surface too: strip C0/C1 controls, line and
 * bidi overrides from every author-written string a report line embeds. */
export function sanitizeLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (ch) =>
    ch === '\n' ? ' ' : `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function evidenceSummary(evidence: CriterionEvidence | undefined): string {
  if (!evidence) return '';
  const items = [
    ...evidence.files.map((file) => file.name),
    ...evidence.markers.map((marker) => marker.message),
  ];
  if (evidence.attempt) {
    items.push(evidence.attempt.qualifies
      ? `receipt trail (${evidence.attempt.manifest.steps.length} steps)`
      : 'no qualifying receipt trail (no step reached a terminal state)');
  }
  return items.length > 0 ? ` — evidence: ${items.join(', ')}` : '';
}

export function renderReport(
  results: ClassifiedCriterionResult[],
  coverage: Coverage,
  notChecked: NotChecked[],
  options: ReportOptions = {},
): string {
  const summary = summarise(results, coverage);
  const line = headline(summary, { violation: options.violation });
  const criteria = new Map((options.criteria ?? []).map((criterion) => [criterion.id, criterion]));
  const resultLines = results.map((result) => {
    const source = options.sources?.[result.id];
    const sourceTag = source ? ` [${sourceLabel(source)}]` : '';
    const claim = criteria.get(result.id);
    const claimLabel = claim ? ` ${claim.plain ?? claim.title} —` : '';
    let detail: string;
    if (result.displayVerdict === 'not-proven') detail = `not proven — ${notProvenReason(result)}; ${result.observed}`;
    else if (result.displayVerdict === 'blocked') {
      detail = `${options.legacyEvidence ? 'could not run' : 'blocked'}, ${result.observed}`;
    }
    else detail = result.observed;
    return sanitizeLine(`${result.id}  ${MARK[result.displayVerdict]} ${claimLabel} ${detail}${sourceTag}` +
      evidenceSummary(options.evidence?.[result.id]));
  });

  const axes = [
    `Proven     ${summary.proven} of ${summary.ran.total}`,
    `Behaviour  ${summary.behaviour.passed} passed, ${summary.behaviour.failed} failed`,
    `Ran        ${summary.ran.total} criteria, ${summary.ran.couldNotRun} could not run`,
    `Covered    ${summary.covered.criteria} criteria, ${summary.covered.filesWithoutCriterion} changed files have none`,
  ];
  const width = Math.max(0, ...notChecked.map((entry) => entry.what.length));
  const notCheckedLines = notChecked.length
    ? notChecked.map((entry) => `  ${entry.what.padEnd(width)}  ${entry.why}`)
    : ['  (nothing)'];

  return [
    line,
    ...(options.legacyEvidence ? ['evidence not verified (legacy mode)'] : []),
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
