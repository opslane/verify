import { describe, it, expect } from 'vitest';
import { formatVerifyComment, formatStartupFailureComment, formatNoSpecComment, VERIFY_MARKER } from './comment.js';

describe('comment formatter', () => {
  it('formats a full verify report', () => {
    const comment = formatVerifyComment({
      specPath: 'docs/plans/2026-03-12-feature.md',
      port: 3000,
      results: [
        { id: 'AC1', description: 'Page loads', result: 'pass' },
        { id: 'AC2', description: 'Form submits', result: 'fail', expected: 'Success toast', observed: 'Page crashed' },
        { id: 'AC3', description: 'Admin tab', result: 'skipped', reason: 'Setup failed' },
      ],
    });

    expect(comment).toContain(VERIFY_MARKER);
    expect(comment).toContain('AC1');
    expect(comment).toContain('Pass');
    expect(comment).toContain('Fail');
    expect(comment).toContain('Skipped');
    expect(comment).toContain('Page crashed');
  });

  it('formats startup failure comment', () => {
    const comment = formatStartupFailureComment({
      port: 3000,
      error: 'Timed out',
      serverLog: 'Error: EADDRINUSE',
    });

    expect(comment).toContain(VERIFY_MARKER);
    expect(comment).toContain('failed to start');
    expect(comment).toContain('EADDRINUSE');
  });

  it('formats no-spec comment', () => {
    const comment = formatNoSpecComment();
    expect(comment).toContain(VERIFY_MARKER);
    expect(comment).toContain('No spec found');
  });

  it('includes marker for comment update detection', () => {
    const comment = formatVerifyComment({
      specPath: 'test.md',
      port: 3000,
      results: [{ id: 'AC1', description: 'test', result: 'pass' }],
    });
    expect(comment).toContain(VERIFY_MARKER);
  });
});
