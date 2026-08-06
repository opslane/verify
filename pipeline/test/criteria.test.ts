import { describe, expect, it } from 'vitest';
import { freePasses, renderCriteria, validateCriteria, type Criterion } from '../src/lib/criteria.js';

const base: Criterion = {
  id: 'AC1',
  title: 'the drain loop clears a batch without waiting for the next poll',
  doIt: 'insert 10 jobs, start the worker, time to completion',
  expectIt: 'under 5s; the old poller needed 45s or more',
  source: { kind: 'plan', ref: 'R1' },
  intent: 'changes',
  baseline: 'fail',
  witness: 'success',
};

describe('renderCriteria', () => {
  it('renders a table so criteria can be scanned, not read', () => {
    const out = renderCriteria([base], []);
    expect(out).toContain('| AC | From | Intent | Base | Shows | Behaviour | How it is driven | Expect |');
    expect(out).toMatch(/^\| AC1 \| R1 \| changes \| fail \| success \|/m);
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

  // What a markdown reader counts is unescaped pipes. Splitting on every '|' counts the
  // escaped ones too, so it cannot tell a corrupted row from an intact one.
  const columnCount = (row: string) => (row.match(/(^|[^\\])\|/g) ?? []).length;

  // A pipe inside a cell would split the column and silently corrupt the table.
  it('escapes a pipe in any cell', () => {
    const out = renderCriteria([{ ...base, doIt: 'run `a | b` and read stdout' }], []);
    expect(out).toContain('a \\| b');
    const row = out.split('\n').find((line) => /^\| AC1 /.test(line))!;
    // 8 columns means 9 delimiters, one either side of each cell.
    expect(columnCount(row)).toBe(9);
  });

  // The id and the source label are cells like any other. Both used to go through
  // unescaped, so a pipe in either one split the row and shifted every column after it.
  it('escapes a pipe in the id and the source label', () => {
    const out = renderCriteria(
      [{ ...base, id: 'AC|1', source: { kind: 'plan', ref: 'R|1' } }],
      [],
    );
    const row = out.split('\n').find((line) => line.includes('AC\\|1'))!;
    expect(row).toContain('R\\|1');
    expect(columnCount(row)).toBe(9);
  });

  it('lists changed files that no criterion covers', () => {
    const out = renderCriteria([base], ['src/telemetry.ts', 'src/log.ts']);
    expect(out).toContain('No criterion covers: src/telemetry.ts, src/log.ts');
  });

  it('omits the uncovered line when every file is covered', () => {
    expect(renderCriteria([base], [])).not.toContain('No criterion covers');
  });
});

// The failure this whole shape exists for: a criterion declared as testing the change
// that the base commit would also have passed. It proved nothing, and the run comes back
// green regardless, so the approval artifact has to say so loudly.
describe('free passes', () => {
  const freePass: Criterion = { ...base, id: 'AC2', intent: 'changes', baseline: 'pass' };

  it('finds a changes criterion the base commit already passes', () => {
    expect(freePasses([base, freePass]).map((c) => c.id)).toEqual(['AC2']);
  });

  it('does not flag a preserves criterion for passing on base', () => {
    const guard: Criterion = { ...base, id: 'AC3', intent: 'preserves', baseline: 'pass' };
    expect(freePasses([guard])).toEqual([]);
  });

  it('names them in the artifact and refuses to let them read as approved', () => {
    const out = renderCriteria([freePass], []);
    expect(out).toContain('FREE PASS');
    expect(out).toContain('AC2');
    expect(out).toContain('Do not approve as they stand.');
  });

  it('says nothing about free passes when there are none', () => {
    expect(renderCriteria([base], [])).not.toContain('FREE PASS');
  });

  it('surfaces an unknown baseline as something to confirm', () => {
    const out = renderCriteria([{ ...base, baseline: 'unknown' }], []);
    expect(out).toContain('Unknown against the base commit');
    expect(out).toContain('AC1');
  });
});

// A set where every criterion checks something is refused is satisfied by an
// implementation that refuses everything. The grid makes that visible as an empty cell.
describe('the intent x witness grid', () => {
  it('counts the four boxes', () => {
    const out = renderCriteria(
      [
        base,
        { ...base, id: 'AC2', intent: 'changes', witness: 'refusal' },
        { ...base, id: 'AC3', intent: 'preserves', baseline: 'pass', witness: 'refusal' },
      ],
      [],
    );
    expect(out).toContain('What these criteria prove');
    expect(out).toMatch(/success\s+0\s+1/);
    expect(out).toMatch(/refusal\s+1\s+1/);
  });

  it('calls out a set where nothing shows the new behaviour working', () => {
    const out = renderCriteria(
      [{ ...base, witness: 'refusal' }, { ...base, id: 'AC2', witness: 'refusal' }],
      [],
    );
    expect(out).toContain('No criterion shows the new behaviour working');
    expect(out).toContain('refuses');
  });

  it('stays quiet when at least one criterion shows the change working', () => {
    expect(renderCriteria([base], [])).not.toContain('No criterion shows');
  });
});

// TypeScript types do nothing for JSON parsed at runtime, so a criterion missing its
// declarations would render as a blank cell and silently undercount the grid.
describe('validateCriteria', () => {
  it('accepts a fully declared criterion', () => {
    expect(validateCriteria([base])).toEqual([]);
  });

  it('rejects a missing declaration rather than rendering a blank cell', () => {
    const { intent, ...withoutIntent } = base;
    const problems = validateCriteria([withoutIntent]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('AC1 has intent=undefined');
    expect(problems[0]).toContain('changes, preserves');
  });

  it('rejects a value outside the enum', () => {
    const problems = validateCriteria([{ ...base, baseline: 'probably' }]);
    expect(problems[0]).toContain('AC1 has baseline="probably"');
  });

  it('rejects a repeated id, which would double-count the grid', () => {
    expect(validateCriteria([base, base])).toEqual(['criteria[1] repeats id AC1']);
  });

  it('rejects an empty expectation', () => {
    expect(validateCriteria([{ ...base, expectIt: '' }])).toEqual(['AC1 has no expectIt']);
  });

  it('rejects input that is not an array', () => {
    expect(validateCriteria({ AC1: base })).toEqual(['criteria must be an array']);
  });
});
