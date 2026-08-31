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


function criterion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'AC1',
    title: 'search_assets returns rows for a working credential',
    doIt: 'POST tools/call search_assets with a live token',
    // A bare status code proves the transport worked, not that the tool did. The skill
    // asks for the side effect, so the fixture models one.
    expectIt: 'HTTP 200 whose result carries at least one asset row',
    source: { kind: 'plan', ref: 'plan line 12' },
    intent: 'changes',
    baseline: 'fail',
    witness: 'success',
    dependsOn: ['api'],
    proof: { kind: 'marker-in-data', detail: 'the marker in the created row' },
    ...overrides,
  };
}

function writeInput(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'verify-cli-'));
  const input = join(dir, 'in.json');
  writeFileSync(input, JSON.stringify(body));
  return input;
}

describe('criteria', () => {
  it('renders criteria.md from a json file', () => {
    const input = writeInput({
      criteria: [criterion()],
      uncoveredFiles: ['src/log.ts'],
    });

    const output = runCli(['criteria', '--criteria', input]);
    expect(output).toContain('| AC | From | Intent | Base | Shows | Behaviour | How it is driven | Expect |');
    expect(output).toMatch(/^\| AC1 \| plan line 12 \| changes \| fail \| success \|/m);
    expect(output).toContain('No criterion covers: src/log.ts');
    expect(output).toContain('What these criteria prove');
  });

  // The engine cannot judge whether a declaration is truthful, but it can refuse to
  // render one that is missing. Otherwise the rule lives only in prose the model may skip.
  it('exits non-zero when a criterion omits its declarations', () => {
    const { intent, ...undeclared } = criterion();
    const input = writeInput({ criteria: [undeclared] });

    expect(() => runCli(['criteria', '--criteria', input])).toThrow(/intent/);
  });

  // Still rendered, not rejected: the artifact exists for a human to correct, and a
  // free pass is something they need to see rather than something to hide behind an
  // exit code. Missing declarations are different, because there is nothing to show.
  it('renders a free pass loudly instead of suppressing the artifact', () => {
    const input = writeInput({ criteria: [criterion({ baseline: 'pass' })] });
    const output = runCli(['criteria', '--criteria', input]);
    expect(output).toContain('FREE PASS');
    expect(output).toContain('Do not approve as they stand.');
  });
});

describe('report', () => {
  function writeReportInputs(dir: string) {
    const results = join(dir, 'in.json');
    writeFileSync(
      results,
      JSON.stringify({
        results: [{ id: 'AC1', outcome: 'pass', proofSeen: true, observed: '50 rows' }],
        coverage: { filesWithoutCriterion: 1 },
        notChecked: [{ what: '/healthz', why: 'pod-internal' }],
      }),
    );
    const criteriaPath = join(dir, 'criteria.json');
    writeFileSync(
      criteriaPath,
      JSON.stringify({ criteria: [criterion(), criterion({ id: 'AC2', title: 'second' })] }),
    );
    return { results, criteriaPath };
  }

  it('renders report.md, reconciled against the criteria', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-cli-'));
    const { results, criteriaPath } = writeReportInputs(dir);
    const precheck = join(dir, 'precheck.json');
    writeFileSync(precheck, JSON.stringify({ parts: { api: 'ok' }, tainted: {}, unchecked: [] }));

    const output = runCli(['report', '--results', results, '--criteria', criteriaPath, '--precheck', precheck]);
    expect(output).toContain('AC1  ✔  50 rows');
    // AC2 had no result: it can never disappear from the count.
    expect(output).toContain('AC2  ~  could not run, no result was recorded for this criterion');
    expect(output).toContain('1 of 2 proven');
    expect(output).toContain('/healthz');
  });

  it('fails closed when criteria have dependencies but no precheck exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-cli-'));
    const { results, criteriaPath } = writeReportInputs(dir);
    expect(() => runCli(['report', '--results', results, '--criteria', criteriaPath])).toThrow();
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

