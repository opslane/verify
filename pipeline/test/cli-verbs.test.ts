import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(pkgRoot, 'src', 'cli.ts');

function runCli(args: string[]): string {
  return execFileSync('npx', ['--no-install', 'tsx', cli, ...args], {
    cwd: pkgRoot,
    encoding: 'utf8',
  });
}


describe('criteria', () => {
  it('renders criteria.md from a json file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-cli-'));
    const input = join(dir, 'in.json');
    writeFileSync(
      input,
      JSON.stringify({
        criteria: [
          {
            id: 'AC1',
            title: 'search_assets returns rows',
            doIt: 'POST tools/call',
            expectIt: 'HTTP 200',
            source: { kind: 'plan', ref: 'plan line 12' },
            existing: { kind: 'none' },
          },
        ],
        uncoveredFiles: ['src/log.ts'],
      }),
    );

    const output = runCli(['criteria', '--criteria', input]);
    expect(output).toContain('AC1  search_assets returns rows');
    expect(output).toContain('No criterion covers: src/log.ts');
  });
});

describe('report', () => {
  it('renders report.md from a json file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-cli-'));
    const input = join(dir, 'in.json');
    writeFileSync(
      input,
      JSON.stringify({
        results: [{ id: 'AC1', outcome: 'pass', observed: '50 rows' }],
        coverage: { filesWithoutCriterion: 1 },
        notChecked: [{ what: '/healthz', why: 'pod-internal' }],
      }),
    );

    const output = runCli(['report', '--results', input]);
    expect(output).toContain('AC1  ✔  50 rows');
    expect(output).toContain('Behaviour  1 passed, 0 failed');
    expect(output).toContain('/healthz');
  });
});

describe('changed-files', () => {
  function tempRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'verify-repo-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'v@example.com');
    git('config', 'user.name', 'v');
    writeFileSync(join(dir, 'seed.ts'), 'export const a = 1;\n');
    git('add', '.');
    git('commit', '-qm', 'seed');
    writeFileSync(join(dir, 'feature.ts'), 'export const b = 2;\n');
    writeFileSync(join(dir, 'feature.test.ts'), 'it("x", () => {});\n');
    return dir;
  }

  function claimsFile(claims: Record<string, string[]>): string {
    const dir = mkdtempSync(join(tmpdir(), 'verify-claims-'));
    const file = join(dir, 'claims.json');
    writeFileSync(file, JSON.stringify(claims));
    return file;
  }

  it('includes untracked work and drops test files', () => {
    const dir = tempRepo();
    const output = JSON.parse(runCli(['changed-files', '--repo', dir, '--base', 'HEAD']));
    expect(output.changed).toContain('feature.ts');
    expect(output.changed).not.toContain('feature.test.ts');
    expect(output.changed).not.toContain('seed.ts');
  });

  it('computes the coverage axis from a claims file', () => {
    const dir = tempRepo();
    const claims = claimsFile({ AC1: ['feature.ts'] });
    const output = JSON.parse(
      runCli(['changed-files', '--repo', dir, '--base', 'HEAD', '--claims', claims]),
    );
    expect(output.uncovered).toEqual([]);
    expect(output.filesWithoutCriterion).toBe(0);
  });

  it('reports a file no criterion claims', () => {
    const dir = tempRepo();
    writeFileSync(join(dir, 'orphan.ts'), 'export const c = 3;\n');
    const claims = claimsFile({ AC1: ['feature.ts'] });
    const output = JSON.parse(
      runCli(['changed-files', '--repo', dir, '--base', 'HEAD', '--claims', claims]),
    );
    expect(output.uncovered).toContain('orphan.ts');
    expect(output.filesWithoutCriterion).toBe(1);
  });
});

