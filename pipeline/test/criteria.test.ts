import { describe, expect, it } from 'vitest';
import { renderCriteria, type Criterion } from '../src/lib/criteria.js';

const base: Criterion = {
  id: 'AC1',
  title: 'the drain loop clears a batch without waiting for the next poll',
  doIt: 'insert 10 jobs, start the worker, time to completion',
  expectIt: 'under 5s; the old poller needed 45s or more',
  source: { kind: 'plan', ref: 'R1' },
};

describe('renderCriteria', () => {
  it('renders a table so criteria can be scanned, not read', () => {
    const out = renderCriteria([base], []);
    expect(out).toContain('| AC | From | Behaviour | How it is driven | Expect |');
    expect(out).toMatch(/^\| AC1 \| R1 \|/m);
  });

  // The requirement a criterion tests has to be visible at a glance. Buried in a
  // From line under a block, nobody checks the mapping.
  it('puts the requirement in its own column', () => {
    const out = renderCriteria(
      [
        { ...base, source: { kind: 'plan', ref: 'R1' } },
        { ...base, id: 'AC2', source: { kind: 'plan', ref: 'R2' } },
      ],
      [],
    );
    const rows = out.split('\n').filter((line) => /^\| AC\d/.test(line));
    expect(rows[0]).toContain('| R1 |');
    expect(rows[1]).toContain('| R2 |');
  });

  it('marks an invented criterion in the table and explains it below', () => {
    const out = renderCriteria(
      [
        {
          ...base,
          id: 'AC3',
          source: {
            kind: 'invented',
            note: 'The plan says "field values persist" but never says which field. I picked purchase_date.',
          },
        },
      ],
      [],
    );
    expect(out).toMatch(/^\| AC3 \| INVENTED \|/m);
    expect(out).toContain('AC3 is INVENTED');
    expect(out).toContain('I picked purchase_date.');
  });

  it('marks an inferred criterion the same way', () => {
    const out = renderCriteria(
      [
        {
          ...base,
          id: 'AC4',
          source: { kind: 'inferred', from: 'routes/oauth/discovery.py changed' },
        },
      ],
      [],
    );
    expect(out).toMatch(/^\| AC4 \| INFERRED \|/m);
    expect(out).toContain('routes/oauth/discovery.py changed');
  });

  it('adds no notes section when every criterion came from the plan', () => {
    const out = renderCriteria([base], []);
    expect(out).not.toContain('INVENTED');
    expect(out).not.toContain('Where these came from');
  });

  // A pipe inside a cell would split the column and silently corrupt the table.
  it('escapes a pipe in any cell', () => {
    const out = renderCriteria([{ ...base, doIt: 'run `a | b` and read stdout' }], []);
    expect(out).toContain('a \\| b');
    const row = out.split('\n').find((line) => /^\| AC1 /.test(line))!;
    // 5 columns => 6 pipes => 7 fields, plus the trailing empty after the last pipe.
    expect(row.split('|')).toHaveLength(8);
  });

  it('lists changed files that no criterion covers', () => {
    const out = renderCriteria([base], ['src/telemetry.ts', 'src/log.ts']);
    expect(out).toContain('No criterion covers: src/telemetry.ts, src/log.ts');
  });

  it('omits the uncovered line when every file is covered', () => {
    expect(renderCriteria([base], [])).not.toContain('No criterion covers');
  });
});
