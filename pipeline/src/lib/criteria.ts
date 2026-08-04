/** Where a criterion came from. Printed so the reader knows what was invented. */
export type Source =
  | { kind: 'plan'; ref: string }
  | { kind: 'inferred'; from: string }
  | { kind: 'invented'; note: string };

export interface Criterion {
  id: string;
  title: string;
  doIt: string;
  expectIt: string;
  source: Source;
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

export function renderCriteria(criteria: Criterion[], uncoveredFiles: string[]): string {
  const header = [
    '| AC | From | Behaviour | How it is driven | Expect |',
    '|----|------|-----------|------------------|--------|',
  ];

  const rows = criteria.map((criterion) =>
    [
      '',
      criterion.id,
      sourceLabel(criterion.source),
      cell(criterion.title),
      cell(criterion.doIt),
      cell(criterion.expectIt),
      '',
    ].join(' | ').replace(/^ \| /, '| ').replace(/ \| $/, ' |'),
  );

  const sections = [[...header, ...rows].join('\n')];

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
