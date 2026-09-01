import { describe, expect, it } from 'vitest';
import { parseStepArgs } from '../src/lib/step-args.js';

describe('parseStepArgs', () => {
  it('accepts an http request with optional body and status', () => {
    expect(parseStepArgs('http', ['POST', '/events', '--json', '{"ok":true}', '--expect-status', '201']))
      .toEqual({
        ok: true,
        parsed: { method: 'POST', path: '/events', json: '{"ok":true}', expectStatus: 201 },
      });
  });

  it.each([
    [['GET', '/', '--expect-status', 'abc'], 'integer'],
    [['POST', '/', '--json'], 'value'],
    [['GET', '/', '--wat'], 'unknown'],
  ])('rejects invalid http arguments %#', (args, problem) => {
    const result = parseStepArgs('http', args);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain(problem);
  });

  it('rejects db statement separators and metacommands', () => {
    for (const sql of ['select 1; select 2', '\\dt']) {
      const result = parseStepArgs('db', [sql]);
      expect(result.ok).toBe(false);
    }
  });

  it.each([
    [['--sql', 'select 1', '--url', '/health', '--timeout', '5'], 'exactly one'],
    [['--timeout', '5'], 'exactly one'],
    [['--url', '/health'], '--timeout'],
  ])('rejects invalid wait arguments %#', (args, problem) => {
    const result = parseStepArgs('wait', args);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain(problem);
  });

  it('accepts one wait source and a positive timeout', () => {
    expect(parseStepArgs('wait', ['--url', '/health', '--contains', 'ok', '--timeout', '3']))
      .toEqual({ ok: true, parsed: { url: '/health', contains: 'ok', timeoutSeconds: 3 } });
  });

  it('rejects an invalid run expected exit and empty argv', () => {
    expect(parseStepArgs('run', ['node', '--expect-exit', '-1'])).toMatchObject({ ok: false });
    expect(parseStepArgs('run', [])).toMatchObject({ ok: false });
  });

  it('parses run argv and strips a trailing expected exit declaration', () => {
    expect(parseStepArgs('run', ['node', '-e', 'process.exit(2)', '--expect-exit', '2']))
      .toEqual({ ok: true, parsed: { argv: ['node', '-e', 'process.exit(2)'], expectExit: 2 } });
  });
});
