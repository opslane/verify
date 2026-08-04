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

function renderSource(source: Source): string {
  switch (source.kind) {
    case 'plan':
      return source.ref;
    case 'inferred':
      return `INFERRED from diff, ${source.from}`;
    case 'invented':
      return `INVENTED. ${source.note}`;
  }
}

export function renderCriteria(criteria: Criterion[], uncoveredFiles: string[]): string {
  const blocks = criteria.map((criterion) =>
    [
      `${criterion.id}  ${criterion.title}`,
      `     Do        ${criterion.doIt}`,
      `     Expect    ${criterion.expectIt}`,
      `     From      ${renderSource(criterion.source)}`,
    ].join('\n'),
  );
  const body = blocks.join('\n\n');
  if (uncoveredFiles.length === 0) return body + '\n';
  return `${body}\n\nNo criterion covers: ${uncoveredFiles.join(', ')}\n`;
}
