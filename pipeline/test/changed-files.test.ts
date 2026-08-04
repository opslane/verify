import { describe, expect, it } from 'vitest';
import { parseDiffNames, uncoveredFiles } from '../src/lib/changed-files.js';

describe('parseDiffNames', () => {
  it('parses git diff --name-only output', () => {
    expect(parseDiffNames('mcp/src/assets.ts\nmcp/src/log.ts\n')).toEqual([
      'mcp/src/assets.ts',
      'mcp/src/log.ts',
    ]);
  });

  it('drops blank lines', () => {
    expect(parseDiffNames('a.ts\n\n\nb.ts\n')).toEqual(['a.ts', 'b.ts']);
  });

  // Name-only matching missed helpers living inside a test directory, while the
  // skill claimed every test file was excluded.
  it('drops files inside test directories, not just test-named files', () => {
    expect(parseDiffNames([
      'src/app.ts',
      'tests/helper.ts',
      '__tests__/fixtures.ts',
      'src/__mocks__/client.ts',
      'spec/support/env.rb',
      'test/setup.ts',
    ].join('\n'))).toEqual(['src/app.ts']);
  });

  it('does not mistake a source directory for a test directory', () => {
    expect(parseDiffNames(['src/latest/index.ts', 'contest/rules.ts'].join('\n')))
      .toEqual(['src/latest/index.ts', 'contest/rules.ts']);
  });

  it('drops test files, which are not behaviour under test', () => {
    expect(
      parseDiffNames(
        'a.ts\na.test.ts\nb_test.go\ntest_c.py\nspec/widget_spec.rb\nsrc/WidgetTest.java\n',
      ),
    ).toEqual(['a.ts']);
  });
});

describe('uncoveredFiles', () => {
  it('returns changed files no criterion claims', () => {
    const changed = ['mcp/src/assets.ts', 'mcp/src/telemetry.ts', 'mcp/src/log.ts'];
    const claimed = { AC1: ['mcp/src/assets.ts'] };
    expect(uncoveredFiles(changed, claimed)).toEqual(['mcp/src/telemetry.ts', 'mcp/src/log.ts']);
  });

  it('returns empty when everything is claimed', () => {
    expect(uncoveredFiles(['a.ts'], { AC1: ['a.ts'] })).toEqual([]);
  });
});
