import { describe, expect, it } from 'vitest';
import { renderCriteria, type Criterion } from '../src/lib/criteria.js';

const base: Criterion = {
  id: 'AC1',
  title: 'search_assets returns rows, not a 500',
  doIt: 'POST tools/call search_assets, no filters',
  expectIt: 'HTTP 200, more than 0 rows',
  source: { kind: 'plan', ref: 'plan line 12' },
};

describe('renderCriteria', () => {
  it('renders a plan-sourced criterion', () => {
    const out = renderCriteria([base], []);
    expect(out).toContain('AC1  search_assets returns rows, not a 500');
    expect(out).toContain('Do        POST tools/call search_assets, no filters');
    expect(out).toContain('Expect    HTTP 200, more than 0 rows');
    expect(out).toContain('From      plan line 12');
  });

  it('marks an invented criterion loudly', () => {
    const out = renderCriteria([{
      ...base,
      source: {
        kind: 'invented',
        note: 'Plan says "field values persist," never says which field. I picked purchase_date.',
      },
    }], []);
    expect(out).toContain('From      INVENTED.');
    expect(out).toContain('I picked purchase_date.');
  });

  it('lists changed files that no criterion covers', () => {
    const out = renderCriteria([base], ['mcp/src/telemetry.ts', 'mcp/src/log.ts']);
    expect(out).toContain('No criterion covers: mcp/src/telemetry.ts, mcp/src/log.ts');
  });

  it('omits the uncovered line when every file is covered', () => {
    expect(renderCriteria([base], [])).not.toContain('No criterion covers');
  });
});
