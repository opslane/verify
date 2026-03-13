import { describe, it, expect } from 'vitest';
import { discoverSpec } from './spec-discovery.js';

describe('discoverSpec', () => {
  it('returns plan file when PR changes include docs/plans/*.md', () => {
    const result = discoverSpec({
      changedFiles: [
        { filename: 'src/index.ts', status: 'modified' },
        { filename: 'docs/plans/2026-03-12-feature.md', status: 'added' },
      ],
      prBody: '',
    });

    expect(result.type).toBe('plan-file');
    if (result.type === 'plan-file') {
      expect(result.specPath).toBe('docs/plans/2026-03-12-feature.md');
    }
  });

  it('prefers added plan files over modified ones', () => {
    const result = discoverSpec({
      changedFiles: [
        { filename: 'docs/plans/old-plan.md', status: 'modified' },
        { filename: 'docs/plans/new-plan.md', status: 'added' },
      ],
      prBody: '',
    });

    if (result.type === 'plan-file') {
      expect(result.specPath).toBe('docs/plans/new-plan.md');
    }
  });

  it('falls back to PR body when no plan file found', () => {
    const result = discoverSpec({
      changedFiles: [{ filename: 'src/index.ts', status: 'modified' }],
      prBody: '## Acceptance Criteria\n- [ ] User can log in\n- [ ] Dashboard loads',
    });

    expect(result.type).toBe('pr-body');
    if (result.type === 'pr-body') {
      expect(result.specContent).toContain('User can log in');
    }
  });

  it('returns no-spec when nothing found', () => {
    const result = discoverSpec({
      changedFiles: [{ filename: 'src/index.ts', status: 'modified' }],
      prBody: 'Fixed a typo.',
    });

    expect(result.type).toBe('no-spec');
  });
});
