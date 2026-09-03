import { describe, expect, it } from 'vitest';
import { freePasses, quotesNotInSpec, renderCriteria, validateCriteria, type Criterion } from '../src/lib/criteria.js';

const base: Criterion = {
  id: 'AC1',
  title: 'the drain loop clears a batch without waiting for the next poll',
  doIt: 'insert 10 jobs, start the worker, time to completion',
  expectIt: 'under 5s; the old poller needed 45s or more',
  source: { kind: 'plan', ref: 'R1', quote: 'the worker drains a full batch as soon as it is polled' },
  why: 'a batch left waiting for the next poll is the slowness the change exists to remove',
  intent: 'changes',
  baseline: 'fail',
  witness: 'success',
  dependsOn: ['api'],
  proof: { kind: 'marker-in-data', detail: 'the marker in the created row' },
};

// What a markdown reader counts is unescaped pipes. Splitting on every '|' counts the
// escaped ones too, so it cannot tell a corrupted row from an intact one.
const columnCount = (row: string) => (row.match(/(^|[^\\])\|/g) ?? []).length;

describe('renderCriteria', () => {
  it('renders a table so criteria can be scanned, not read', () => {
    const out = renderCriteria([base], []);
    expect(out).toContain('| AC | From | Cited | Why | Intent | Base | Shows | Behaviour | Plain claim | How it is driven | Expect |');
    expect(out).toMatch(/^\| AC1 \| R1 \| the worker drains a full batch as soon as it is polled \| a batch left waiting [^|]+ \| changes \| fail \| success \|/m);
  });

  // A requirement id alone is a pointer the reader has to chase. The words the
  // criterion was read from, and the reason it exists, sit next to it instead.
  it('cites the spec verbatim and says why the check exists, per row', () => {
    const out = renderCriteria(
      [
        base,
        { ...base, id: 'AC2', source: { kind: 'inferred', from: 'the diff deleted /confluence/*; user said it must 404' }, why: 'a deleted route the plan never mentioned' },
        { ...base, id: 'AC3', source: { kind: 'invented', note: 'plan names no field; I picked purchase_date' }, why: 'persistence is the whole feature' },
      ],
      [],
    );
    const rows = out.split('\n').filter((line) => /^\| AC\d/.test(line));
    expect(rows[0]).toContain('| the worker drains a full batch as soon as it is polled | a batch left waiting for the next poll is the slowness the change exists to remove |');
    expect(rows[1]).toContain('| INFERRED | the diff deleted /confluence/*; user said it must 404 | a deleted route the plan never mentioned |');
    expect(rows[2]).toContain('| INVENTED | plan names no field; I picked purchase_date | persistence is the whole feature |');
  });

  // The requirement a criterion tests has to be visible at a glance. Buried in a
  // From line under a block, nobody checks the mapping.
  it('puts the requirement in its own column', () => {
    const out = renderCriteria(
      [
        { ...base, source: { kind: 'plan', ref: 'R1', quote: 'one' } },
        { ...base, id: 'AC2', source: { kind: 'plan', ref: 'R2', quote: 'two' } },
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
    // 11 columns means 12 delimiters, one either side of each cell.
    expect(columnCount(row)).toBe(12);
  });

  // The id and the source label are cells like any other. Both used to go through
  // unescaped, so a pipe in either one split the row and shifted every column after it.
  it('escapes a pipe in the id and the source label', () => {
    const out = renderCriteria(
      [{ ...base, id: 'AC|1', source: { kind: 'plan', ref: 'R|1', quote: 'a | b' }, why: 'c | d' }],
      [],
    );
    const row = out.split('\n').find((line) => line.includes('AC\\|1'))!;
    expect(row).toContain('R\\|1');
    expect(row).toContain('a \\| b | c \\| d');
    expect(columnCount(row)).toBe(12);
  });

  // A quote is copied from a spec file, so it wraps wherever the spec wrapped. A raw
  // newline would end the table row mid-cell and the rest would render as prose.
  it('keeps a wrapped quote and why on one table row', () => {
    const out = renderCriteria(
      [{ ...base, source: { kind: 'plan', ref: 'R1', quote: 'the worker drains\n  a full batch' }, why: 'line one\r\nline two' }],
      [],
    );
    const rows = out.split('\n').filter((line) => /^\| AC1 /.test(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('| the worker drains a full batch | line one line two |');
    expect(columnCount(rows[0])).toBe(12);
  });

  // A quote copied from an indented or tab-formatted spec is still that spec's words.
  // Showing its tabs as \u0009 would make the reader's by-eye comparison fail.
  it('folds tabs, indentation and a bare CR in a quote to single spaces', () => {
    const out = renderCriteria(
      [{ ...base, source: { kind: 'plan', ref: 'R1', quote: '- retry\tafter\r  one hour' } }],
      [],
    );
    expect(out).toContain('| - retry after one hour |');
    expect(out).not.toContain('\\u0009');
    expect(out).not.toContain('\\u000d');
  });

  // The reader checks the quote against the spec by eye. A bidi override could make
  // two different strings look the same, so controls are shown as escapes.
  it('makes a bidi override in a citation visible instead of honouring it', () => {
    const out = renderCriteria(
      [{ ...base, source: { kind: 'plan', ref: 'R1', quote: 'accept \u202etoken' }, why: 'w\u0007' }],
      [],
    );
    expect(out).toContain('| accept \\u202etoken | w\\u0007 |');
    expect(out).not.toContain('\u202e');
  });

  it('lists changed files that no criterion covers', () => {
    const out = renderCriteria([base], ['src/telemetry.ts', 'src/log.ts']);
    expect(out).toContain('No criterion covers: src/telemetry.ts, src/log.ts');
  });

  it('omits the uncovered line when every file is covered', () => {
    expect(renderCriteria([base], [])).not.toContain('No criterion covers');
  });
});

// A quote the spec does not contain looks exactly like one it does. Only a lookup
// tells them apart, and the artifact has to say when no lookup happened.
describe('quotes against the spec', () => {
  const spec = [
    '## Draining',
    'The worker drains a full batch',
    '   as soon as it is polled, rather than one job per tick.',
    'Permanent failures are never retried.',
  ].join('\n');

  it('finds a quote across the spec\'s own wrapping, case and indentation', () => {
    expect(quotesNotInSpec([base], spec)).toEqual([]);
    expect(quotesNotInSpec([{ ...base, source: { kind: 'plan', ref: 'R2', quote: 'permanent failures are never retried.' } }], spec)).toEqual([]);
  });

  it('names a quote the spec does not contain, loudly, and leaves other kinds alone', () => {
    const paraphrase: Criterion = { ...base, id: 'AC2', source: { kind: 'plan', ref: 'R1', quote: 'batches drain immediately' } };
    const invented: Criterion = { ...base, id: 'AC3', source: { kind: 'invented', note: 'not in the spec at all' } };
    expect(quotesNotInSpec([base, paraphrase, invented], spec).map((c) => c.id)).toEqual(['AC2']);
    const out = renderCriteria([base, paraphrase, invented], [], { spec });
    expect(out).toContain('NOT IN THE SPEC');
    expect(out).toContain('- AC2: "batches drain immediately"');
    expect(out).toContain('Do not approve as they stand.');
    expect(out).not.toContain('- AC1:');
  });

  it('cannot look up a quote the run never recorded', () => {
    const older = { ...base, source: { kind: 'plan', ref: 'R1' } } as Criterion;
    expect(quotesNotInSpec([older], spec)).toEqual([]);
    expect(renderCriteria([older], [], { spec })).not.toContain('NOT IN THE SPEC');
  });

  it('says nothing about missing quotes when every quote is found', () => {
    expect(renderCriteria([base], [], { spec })).not.toContain('NOT IN THE SPEC');
  });

  it('says the quotes were not checked when no spec was supplied', () => {
    expect(renderCriteria([base], [])).toContain('No spec was supplied, so the quotes were not looked up');
    expect(renderCriteria([base], [], { spec })).not.toContain('No spec was supplied');
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

  it('renders and validates an approved plain-language claim', () => {
    const claim = 'A queued batch clears without waiting for another poll.';
    expect(renderCriteria([{ ...base, plain: claim }], [])).toContain(`| ${claim} |`);
    expect(validateCriteria([{ ...base, plain: '   ' }])).toEqual([
      'AC1 plain must be a non-empty string when present',
    ]);
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

  // A criterion with no citation is one the reader cannot check against the spec, and
  // one with no reason is one nobody can tell is worth keeping. Both are rejected
  // rather than rendered with an empty cell.
  it('rejects a criterion that does not say why it exists', () => {
    const { why, ...withoutWhy } = base;
    expect(validateCriteria([withoutWhy])).toEqual(['AC1 has no why']);
    expect(validateCriteria([{ ...base, why: '  ' }])).toEqual(['AC1 has no why']);
  });

  // The skill says a why that repeats the title goes back. The engine can catch the
  // word-for-word case; anything subtler is the reviewer's.
  it('rejects a why that is the title or the plain claim restated', () => {
    expect(validateCriteria([{ ...base, why: base.title }])).toEqual([
      'AC1 why restates the title — say what bug this check would catch',
    ]);
    expect(validateCriteria([{ ...base, plain: 'A batch clears at once.', why: 'a batch clears at once' }])).toEqual([
      'AC1 why restates the title — say what bug this check would catch',
    ]);
    expect(validateCriteria([{ ...base, why: 'a batch left waiting is the bug' }])).toEqual([]);
  });

  // The drafting gate is strict; an already-approved snapshot is only read. Without
  // the split, upgrading kills every run that was approved before citations existed.
  it('tolerates a run approved before citations, without loosening the drafting gate', () => {
    const older = { ...base, source: { kind: 'plan', ref: 'design: no billing routes' } };
    delete (older as { why?: string }).why;
    expect(validateCriteria([older])).toEqual([
      'AC1 has no why',
      'AC1 source.quote must be the verbatim spec text the criterion was read from',
    ]);
    expect(validateCriteria([older], { provenance: 'optional' })).toEqual([]);
    // Everything else is still enforced on an older snapshot.
    expect(validateCriteria([{ ...older, intent: 'probably' }], { provenance: 'optional' }).join('\n'))
      .toContain('AC1 has intent="probably"');
    expect(validateCriteria([{ ...older, source: { kind: 'plan', quote: 'x' } }], { provenance: 'optional' }))
      .toEqual(['AC1 source.ref must say where in the spec the quote is']);
  });

  it('shows the gap in the table rather than a blank cell', () => {
    const older = { ...base, source: { kind: 'plan', ref: 'design: no billing routes' } };
    delete (older as { why?: string }).why;
    const row = renderCriteria([older], []).split('\n').find((line) => /^\| AC1 /.test(line))!;
    expect(row).toContain('| design: no billing routes | (not recorded) | (not recorded) |');
    expect(columnCount(row)).toBe(12);
  });

  it('rejects a plan source without a verbatim quote', () => {
    expect(validateCriteria([{ ...base, source: { kind: 'plan', ref: 'R1' } }])).toEqual([
      'AC1 source.quote must be the verbatim spec text the criterion was read from',
    ]);
    expect(validateCriteria([{ ...base, source: { kind: 'plan', quote: 'x' } }])).toEqual([
      'AC1 source.ref must say where in the spec the quote is',
    ]);
  });

  it('treats a whitespace-only citation as missing', () => {
    expect(validateCriteria([{ ...base, source: { kind: 'plan', ref: 'R1', quote: '   ' } }])).toEqual([
      'AC1 source.quote must be the verbatim spec text the criterion was read from',
    ]);
    expect(validateCriteria([{ ...base, source: { kind: 'plan', ref: ' ', quote: 'x' } }])).toEqual([
      'AC1 source.ref must say where in the spec the quote is',
    ]);
    expect(validateCriteria([{ ...base, source: { kind: 'inferred', from: '\n' } }])).toEqual([
      'AC1 source.from must name the diff observation and the answer the user gave',
    ]);
  });

  it('rejects a malformed source instead of rendering an empty From cell', () => {
    expect(validateCriteria([{ ...base, source: { kind: 'diff', from: 'x' } }])).toEqual([
      'AC1 has source.kind="diff", expected one of plan, inferred, invented',
    ]);
    expect(validateCriteria([{ ...base, source: { kind: 'inferred' } }])).toEqual([
      'AC1 source.from must name the diff observation and the answer the user gave',
    ]);
    expect(validateCriteria([{ ...base, source: { kind: 'invented', note: '' } }])).toEqual([
      'AC1 source.note must say what assumption was made',
    ]);
    const { source, ...withoutSource } = base;
    expect(validateCriteria([withoutSource])).toEqual(['AC1 has no source']);
    // The old bare-ref shape a model may still emit, and an object with no kind at all.
    expect(validateCriteria([{ ...base, source: 'R1' }])).toEqual(['AC1 has no source']);
    expect(validateCriteria([{ ...base, source: {} }])).toEqual([
      'AC1 has source.kind=undefined, expected one of plan, inferred, invented',
    ]);
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

  it('accepts a driven marker proof pointing at an eligible step', () => {
    const driven: Criterion = {
      ...base,
      drive: [
        { verb: 'wait', args: ['--url', '/ready', '--timeout', '5'] },
        { verb: 'http', args: ['POST', '/events', '--expect-status', '201'] },
      ],
      proof: { ...base.proof, step: 2, expect: 'present' },
    };
    expect(validateCriteria([driven])).toEqual([]);
  });

  it('rejects proof steps that cannot supply eligible proof', () => {
    const withStep = (drive: Criterion['drive']) => ({
      ...base,
      drive,
      proof: { ...base.proof, step: 1 },
    });
    expect(validateCriteria([withStep([{ verb: 'wait', args: ['--url', '/ready', '--timeout', '5'] }])]).join('\n'))
      .toContain('cannot be a proof step');
    expect(validateCriteria([withStep([{ verb: 'http', args: ['GET', '/', '--expect-status', '401'] }])]).join('\n'))
      .toContain('cannot be a proof step');
    expect(validateCriteria([withStep([{ verb: 'http', args: ['GET', '/', '--expect-status', '201'] }])]))
      .toEqual([]);
  });

  it('enforces the driven marker proof matrix', () => {
    expect(validateCriteria([{ ...base, drive: [{ verb: 'db', args: ['select 1'] }] }]).join('\n'))
      .toContain('proof.step is required');
    expect(validateCriteria([{ ...base, proof: { ...base.proof, step: 1 } }]).join('\n'))
      .toContain('only permitted');
    expect(validateCriteria([{
      ...base,
      drive: [{ verb: 'run', args: ['node', '-v'] }],
      proof: { kind: 'live-read', detail: 'fresh timestamp', expect: 'present' },
    }]).join('\n')).toContain('only permitted');
  });

  it('rejects malformed plan elements without throwing', () => {
    expect(validateCriteria([{ ...base, drive: [null] }]).join('\n')).toContain('drive[0] is not an object');
    expect(validateCriteria([{
      ...base,
      drive: [{ verb: 'run', args: ['node'], timeoutSeconds: Infinity }],
      proof: { ...base.proof, step: 1 },
    }]).join('\n')).toContain('timeoutSeconds');
  });

  it('renders approved drive steps verbatim with the proof rule', () => {
    const out = renderCriteria([{
      ...base,
      drive: [
        { verb: 'http', args: ['POST', '/events', '--json', '{"marker":"{{marker}}"}'] },
        { verb: 'db', args: ['select marker from events'], timeoutSeconds: 12 },
      ],
      proof: { ...base.proof, step: 2, expect: 'absent' },
    }], []);
    expect(out).toContain('Drive plans (what will actually run)');
    expect(out).toContain('http POST /events --json {"marker":"{{marker}}"}');
    expect(out).toContain('db select marker from events (timeout: 12s)');
    expect(out).toContain('proof: step 2 output must NOT contain the marker');
  });
});
