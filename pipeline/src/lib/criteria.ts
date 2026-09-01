import { parseStepArgs, type DriveVerb, type ParsedHttp } from './step-args.js';

/** Where a criterion came from. Printed so the reader knows what was invented. */
export type Source =
  | { kind: 'plan'; ref: string }
  | { kind: 'inferred'; from: string }
  | { kind: 'invented'; note: string };

/** What the criterion is for. Kept separate from what the base commit does with it. */
export type Intent = 'changes' | 'preserves';

/**
 * What the base commit is expected to do with this criterion. `not-applicable` is for
 * criteria the base cannot answer at all, like a rolling-upgrade check that needs both
 * versions running, or a flag the base binary refuses to start with.
 */
export type Baseline = 'fail' | 'pass' | 'not-applicable' | 'unknown';

/** Does this criterion show something working, or something correctly turned away? */
export type Witness = 'success' | 'refusal';

/** The parts of the system a criterion drives or observes. Pre-checks probe each one. */
export type Part = 'api' | 'db' | 'worker' | 'browser' | 'sink' | 'storage';

/**
 * How a reader will know the check actually ran. The marker proves the action
 * happened, not that data was created: refusals carry the marker in the
 * rejected request, read-only checks prove freshness instead.
 */
export type Proof =
  | { kind: 'marker-in-data'; detail: string; step?: number; expect?: 'present' | 'absent' }
  | { kind: 'marked-request-rejected'; detail: string; step?: never; expect?: never }
  | { kind: 'live-read'; detail: string; step?: never; expect?: never };

export interface DriveStep {
  verb: DriveVerb;
  args: string[];
  timeoutSeconds?: number;
}

export const INTENTS: readonly Intent[] = ['changes', 'preserves'];
export const BASELINES: readonly Baseline[] = ['fail', 'pass', 'not-applicable', 'unknown'];
export const WITNESSES: readonly Witness[] = ['success', 'refusal'];
export const PARTS: readonly Part[] = ['api', 'db', 'worker', 'browser', 'sink', 'storage'];
export const PROOF_KINDS = ['marker-in-data', 'marked-request-rejected', 'live-read'] as const;

export interface Criterion {
  id: string;
  title: string;
  /** Approved reader-facing claim. Falls back to title for older runs. */
  plain?: string;
  doIt: string;
  expectIt: string;
  source: Source;
  intent: Intent;
  baseline: Baseline;
  witness: Witness;
  /** Which parts the pre-check stage must prove alive before this is judged. */
  dependsOn: Part[];
  /** What artifact will show this check actually ran. */
  proof: Proof;
  /** Ordered, user-approved steps the drive command executes verbatim. */
  drive?: DriveStep[];
}

/**
 * A criterion meant to prove the change did something, that the base commit would also
 * have passed. It tested nothing. This is the one classification error the engine can
 * catch without judging whether the declarations are truthful.
 */
export function freePasses(criteria: Criterion[]): Criterion[] {
  return criteria.filter((c) => c.intent === 'changes' && c.baseline === 'pass');
}

/**
 * The declarations are the whole point of the approval artifact, so a criterion that
 * omits one is rejected rather than rendered with a blank cell. Returns human-readable
 * problems; empty means valid.
 */
export function validateCriteria(criteria: unknown): string[] {
  if (!Array.isArray(criteria)) return ['criteria must be an array'];

  const problems: string[] = [];
  const seen = new Set<string>();

  criteria.forEach((criterion, index) => {
    const at = `criteria[${index}]`;
    if (typeof criterion !== 'object' || criterion === null) {
      problems.push(`${at} is not an object`);
      return;
    }

    const c = criterion as Record<string, unknown>;
    const id = typeof c.id === 'string' ? c.id : undefined;
    if (!id) problems.push(`${at} has no id`);
    else if (seen.has(id)) problems.push(`${at} repeats id ${id}`);
    else seen.add(id);

    const label = id ?? at;
    for (const field of ['title', 'doIt', 'expectIt'] as const) {
      if (typeof c[field] !== 'string' || c[field] === '') {
        problems.push(`${label} has no ${field}`);
      }
    }
    if (c.plain !== undefined && (typeof c.plain !== 'string' || c.plain.trim() === '')) {
      problems.push(`${label} plain must be a non-empty string when present`);
    }

    const enums = [
      ['intent', INTENTS],
      ['baseline', BASELINES],
      ['witness', WITNESSES],
    ] as const;

    for (const [field, allowed] of enums) {
      if (!allowed.includes(c[field] as never)) {
        problems.push(
          `${label} has ${field}=${JSON.stringify(c[field])}, expected one of ${allowed.join(', ')}`,
        );
      }
    }

    const deps = c.dependsOn;
    if (!Array.isArray(deps) || deps.length === 0) {
      problems.push(`${label} has no dependsOn — every criterion names the parts it relies on`);
    } else {
      for (const part of deps) {
        if (!PARTS.includes(part as never)) {
          problems.push(`${label} depends on ${JSON.stringify(part)}, expected one of ${PARTS.join(', ')}`);
        }
      }
    }

    const proof = c.proof as Record<string, unknown> | undefined;
    if (
      typeof proof !== 'object' || proof === null ||
      !PROOF_KINDS.includes(proof.kind as never) ||
      typeof proof.detail !== 'string' || proof.detail === ''
    ) {
      problems.push(
        `${label} has no usable proof — a criterion you cannot prove ran is defective ` +
        `(kind: ${PROOF_KINDS.join(' | ')}, plus a non-empty detail)`,
      );
    }

    const drive = c.drive;
    const parsedSteps: ({ verb: DriveVerb; parsed: ReturnType<typeof parseStepArgs> } | undefined)[] = [];
    if (drive !== undefined) {
      if (!Array.isArray(drive)) {
        problems.push(`${label} drive must be an array`);
      } else {
        drive.forEach((rawStep, stepIndex) => {
          const stepAt = `${label} drive[${stepIndex}]`;
          if (typeof rawStep !== 'object' || rawStep === null) {
            problems.push(`${stepAt} is not an object`);
            parsedSteps.push(undefined);
            return;
          }
          const step = rawStep as Record<string, unknown>;
          if (!['http', 'db', 'wait', 'run'].includes(step.verb as string)) {
            problems.push(`${stepAt} has unknown verb ${JSON.stringify(step.verb)}`);
            parsedSteps.push(undefined);
            return;
          }
          if (!Array.isArray(step.args) || !step.args.every((arg) => typeof arg === 'string')) {
            problems.push(`${stepAt} args must be an array of strings`);
            parsedSteps.push(undefined);
            return;
          }
          const verb = step.verb as DriveVerb;
          const parsed = parseStepArgs(verb, step.args);
          parsedSteps.push({ verb, parsed });
          if (!parsed.ok) problems.push(`${stepAt}: ${parsed.problem}`);
          if (
            step.timeoutSeconds !== undefined &&
            (typeof step.timeoutSeconds !== 'number' || !Number.isFinite(step.timeoutSeconds) ||
              step.timeoutSeconds <= 0 || step.timeoutSeconds > 3600)
          ) {
            problems.push(`${stepAt} timeoutSeconds must be finite, positive, and no more than 3600`);
          }
        });
      }
    }

    if (proof && typeof proof === 'object') {
      const hasStep = Object.hasOwn(proof, 'step');
      const hasExpect = Object.hasOwn(proof, 'expect');
      const drivenMarker = Array.isArray(drive) && proof.kind === 'marker-in-data';
      if ((hasStep || hasExpect) && !drivenMarker) {
        problems.push(`${label} proof.step and proof.expect are only permitted on a driven marker-in-data proof`);
      }
      if (drivenMarker) {
        if (!hasStep) {
          problems.push(`${label} proof.step is required on a driven marker-in-data proof`);
        } else if (!Number.isInteger(proof.step) || (proof.step as number) < 1 || (proof.step as number) > drive.length) {
          problems.push(`${label} proof.step must be an integer within the drive plan`);
        } else {
          const selected = parsedSteps[(proof.step as number) - 1];
          let proofCapable = selected?.verb === 'db' || selected?.verb === 'run';
          if (selected?.verb === 'http' && selected.parsed.ok) {
            const status = (selected.parsed.parsed as ParsedHttp).expectStatus;
            proofCapable = status === undefined || (status >= 200 && status < 300);
          }
          if (!proofCapable) problems.push(`${label} proof.step ${proof.step} cannot be a proof step`);
        }
        if (hasExpect && proof.expect !== 'present' && proof.expect !== 'absent') {
          problems.push(`${label} proof.expect must be present or absent`);
        }
      }
    }
  });

  return problems;
}

/**
 * The short label for the From column. For a plan criterion this is the
 * requirement id itself (`R1`, `AC7`, `Stage 1 item 2`) so the mapping from
 * criterion to requirement is scannable without reading prose.
 */
function sourceLabel(source: Source): string {
  switch (source.kind) {
    case 'plan':
      return source.ref;
    case 'inferred':
      return 'INFERRED';
    case 'invented':
      return 'INVENTED';
  }
}

/** A pipe inside a cell would split the column and silently corrupt the table. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/**
 * The intent x witness grid. An empty `changes`/`success` cell is the most common way a
 * criteria set passes while proving nothing: every criterion checks that something is
 * refused, so an implementation that refuses everything satisfies all of them.
 */
function renderGrid(criteria: Criterion[]): string {
  const count = (intent: Intent, witness: Witness) =>
    criteria.filter((c) => c.intent === intent && c.witness === witness).length;

  const lines = [
    'What these criteria prove',
    '',
    '            preserves  changes',
    `  success   ${String(count('preserves', 'success')).padStart(9)}  ${String(count('changes', 'success')).padStart(7)}`,
    `  refusal   ${String(count('preserves', 'refusal')).padStart(9)}  ${String(count('changes', 'refusal')).padStart(7)}`,
  ];

  if (count('changes', 'success') === 0) {
    lines.push(
      '',
      'No criterion shows the new behaviour working. An implementation that refuses',
      'everything would pass this set.',
    );
  }

  return lines.join('\n');
}

export function renderCriteria(criteria: Criterion[], uncoveredFiles: string[]): string {
  const header = [
    '| AC | From | Intent | Base | Shows | Behaviour | Plain claim | How it is driven | Expect |',
    '|----|------|--------|------|-------|-----------|-------------|------------------|--------|',
  ];

  const rows = criteria.map((criterion) =>
    [
      '',
      cell(criterion.id),
      cell(sourceLabel(criterion.source)),
      cell(criterion.intent),
      cell(criterion.baseline),
      cell(criterion.witness),
      cell(criterion.title),
      cell(criterion.plain ?? criterion.title),
      cell(criterion.doIt),
      cell(criterion.expectIt),
      '',
    ].join(' | ').replace(/^ \| /, '| ').replace(/ \| $/, ' |'),
  );

  const sections = [[...header, ...rows].join('\n')];

  // A criterion meant to prove the change did something, that the base would also have
  // passed, tested nothing. Loud, because the run will otherwise come back green.
  const free = freePasses(criteria);
  if (free.length > 0) {
    sections.push(
      [
        'FREE PASS. These are declared as testing the change, and the base commit passes them too:',
        ...free.map((c) => `- ${c.id}: ${c.title}`),
        'Rewrite them or mark them as preserves. Do not approve as they stand.',
      ].join('\n'),
    );
  }

  const unknown = criteria.filter((c) => c.baseline === 'unknown');
  if (unknown.length > 0) {
    sections.push(
      [
        'Unknown against the base commit. Confirm before approving:',
        ...unknown.map((c) => `- ${c.id}: ${c.title}`),
      ].join('\n'),
    );
  }

  sections.push(renderGrid(criteria));

  // Anything not straight from the plan gets explained underneath. The table
  // says WHICH criteria were invented; this says what the assumption was, which
  // is the part the reader has to be able to correct.
  const notes = criteria
    .filter((criterion) => criterion.source.kind !== 'plan')
    .map((criterion) => {
      const source = criterion.source;
      return source.kind === 'invented'
        ? `- ${criterion.id} is INVENTED. ${source.note}`
        : `- ${criterion.id} is INFERRED from the diff: ${(source as { from: string }).from}`;
    });

  if (notes.length > 0) {
    sections.push(['Where these came from', ...notes].join('\n'));
  }

  // Parts and proofs are what half two's pre-checks and the judge enforce, so
  // the reader approves them alongside the behaviours.
  const reliance = criteria.map(
    (c) => `- ${c.id} relies on: ${c.dependsOn.join(', ')} — proof it ran: ${c.proof.kind} (${c.proof.detail})`,
  );
  sections.push(['Before judging, these parts get one pipeline check each', ...reliance].join('\n'));

  const driven = criteria.filter((criterion) => criterion.drive !== undefined);
  if (driven.length > 0) {
    const plans = driven.flatMap((criterion) => {
      const lines = [`${criterion.id}:`];
      for (const [index, step] of (criterion.drive ?? []).entries()) {
        const timeout = step.timeoutSeconds === undefined ? '' : ` (timeout: ${step.timeoutSeconds}s)`;
        lines.push(`  ${index + 1}. ${step.verb} ${step.args.join(' ')}${timeout}`);
      }
      if (criterion.proof.kind === 'marker-in-data' && criterion.proof.step !== undefined) {
        const direction = (criterion.proof.expect ?? 'present') === 'absent' ? 'must NOT contain' : 'must contain';
        lines.push(`  proof: step ${criterion.proof.step} output ${direction} the marker`);
      } else {
        lines.push('  proof: judged');
      }
      return lines;
    });
    sections.push(['Drive plans (what will actually run)', ...plans].join('\n'));
  }

  if (uncoveredFiles.length > 0) {
    sections.push(`No criterion covers: ${uncoveredFiles.join(', ')}`);
  }

  return sections.join('\n\n') + '\n';
}
