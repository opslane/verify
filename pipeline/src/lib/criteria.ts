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

export const INTENTS: readonly Intent[] = ['changes', 'preserves'];
export const BASELINES: readonly Baseline[] = ['fail', 'pass', 'not-applicable', 'unknown'];
export const WITNESSES: readonly Witness[] = ['success', 'refusal'];

export interface Criterion {
  id: string;
  title: string;
  doIt: string;
  expectIt: string;
  source: Source;
  intent: Intent;
  baseline: Baseline;
  witness: Witness;
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
    '| AC | From | Intent | Base | Shows | Behaviour | How it is driven | Expect |',
    '|----|------|--------|------|-------|-----------|------------------|--------|',
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

  if (uncoveredFiles.length > 0) {
    sections.push(`No criterion covers: ${uncoveredFiles.join(', ')}`);
  }

  return sections.join('\n\n') + '\n';
}
