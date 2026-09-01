// classify-run.ts — the ONE classification pipeline both report and html
// consume. The two verbs used to duplicate these ~20 lines; a change applied
// to one but not the other would make the outputs disagree, which is the
// exact failure the classifier exists to prevent.
import type { Criterion } from './criteria.js';
import { latestFinalizedAttempt, latestFinalizedProof, type FinalizedAttempt } from './drive.js';
import { resolveEvidence, type CriterionEvidence } from './evidence.js';
import {
  applyReceiptedProofs,
  applyTaint,
  classify,
  reconcile,
  taintPartFor,
  type ClassifiedCriterionResult,
  type CriterionResult,
  type Precheck,
  type ProofSource,
} from './verdict.js';

export interface ClassifiedRun {
  classified: ClassifiedCriterionResult[];
  evidence: Record<string, CriterionEvidence>;
  sources: Record<string, ProofSource>;
  attempts: Record<string, FinalizedAttempt | undefined>;
  taintedBy: Record<string, string | undefined>;
}

/** reconcile → receipted proofs → resolve evidence → taint → classify, bound
 * to one run directory. */
export function classifyRun(
  runDir: string,
  criteria: Criterion[],
  rawResults: CriterionResult[],
  precheck: Precheck | undefined,
): ClassifiedRun {
  let results = reconcile(criteria, rawResults, precheck);
  const entries: Record<string, { seen: boolean }> = {};
  const attempts: Record<string, FinalizedAttempt | undefined> = {};
  for (const criterion of criteria) {
    if (criterion.drive) attempts[criterion.id] = latestFinalizedAttempt(runDir, criterion.id);
    if (criterion.drive && criterion.proof?.kind === 'marker-in-data') {
      entries[criterion.id] = { seen: latestFinalizedProof(runDir, criterion.id)?.seen ?? false };
    }
  }
  const receipted = applyReceiptedProofs(results, entries);
  results = receipted.results;
  const taintedBy: Record<string, string | undefined> = {};
  if (precheck) {
    for (const criterion of criteria) taintedBy[criterion.id] = taintPartFor(criterion.id, precheck, criteria);
  }
  const evidence = resolveEvidence(runDir, criteria, results, attempts, taintedBy);
  if (precheck) results = applyTaint(results, precheck, criteria);
  const classified = classify(results, Object.fromEntries(results.map((result) => [result.id, {
    substantiated: evidence[result.id]?.substantiated === true,
    tainted: taintedBy[result.id] !== undefined,
  }])));
  return { classified, evidence, sources: receipted.sources, attempts, taintedBy };
}
