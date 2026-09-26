import { describe, expect, it } from 'vitest';
import { parseEnvFile } from '../src/lib/env-file.js';

describe('parseEnvFile', () => {
  it('reads KEY=VALUE lines the way env.sh does', () => {
    expect(parseEnvFile([
      '# comment',
      'APP_PORT=4000',
      'DATABASE_URL="postgres://u:p@localhost/db?sslmode=disable"',
      'EQUALS=a=b',
      'HALF="open',
      'export SKIPPED=1',
      '1DIGIT=x',
      'NO_EQUALS',
      'PATH=/evil',
      'DYLD_INSERT_LIBRARIES=x',
      '',
      'LAST=wins',
      'LAST=really',
    ].join('\n'))).toEqual({
      APP_PORT: '4000',
      DATABASE_URL: 'postgres://u:p@localhost/db?sslmode=disable',
      EQUALS: 'a=b',
      HALF: '"open',
      LAST: 'really',
    });
  });

  it('keeps a final line with no trailing newline', () => {
    expect(parseEnvFile('A=1\nB=2')).toEqual({ A: '1', B: '2' });
  });
});
