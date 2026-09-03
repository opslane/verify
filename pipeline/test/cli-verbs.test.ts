import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

function driveRepo(options: { git?: boolean; tainted?: boolean; runId?: string } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'verify-drive-cli-'));
  const runId = options.runId ?? 'r1';
  const verifyDir = join(repo, '.verify');
  const runDir = join(verifyDir, 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(verifyDir, 'current-run'), 'r1\n');
  writeFileSync(join(verifyDir, 'run-env.json'), JSON.stringify({ run_id: 'r1', marker: 'verify-m1' }));
  writeFileSync(join(verifyDir, 'setup.json'), JSON.stringify({
    mode: 'none', base_url: 'http://localhost:3000',
    auth: { header: '', value_env: '' }, observe: {},
  }));
  writeFileSync(join(runDir, 'criteria.json'), JSON.stringify({ criteria: [criterion({
    drive: [{ verb: 'run', args: ['node', '-e', "console.log('row {{marker}}')"] }],
    proof: { kind: 'marker-in-data', detail: 'marker in stdout', step: 1, expect: 'present' },
  })] }));
  writeFileSync(join(runDir, 'precheck.json'), JSON.stringify({
    parts: { api: 'ok' }, tainted: options.tainted ? { AC1: 'api' } : {}, unchecked: [],
  }));
  if (options.git !== false) {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'v@example.com');
    git('config', 'user.name', 'v');
    writeFileSync(join(repo, 'README.md'), 'fixture\n');
    git('add', 'README.md');
    git('commit', '-qm', 'fixture');
  }
  return { repo, runDir };
}


function criterion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'AC1',
    title: 'search_assets returns rows for a working credential',
    doIt: 'POST tools/call search_assets with a live token',
    // A bare status code proves the transport worked, not that the tool did. The skill
    // asks for the side effect, so the fixture models one.
    expectIt: 'HTTP 200 whose result carries at least one asset row',
    source: { kind: 'plan', ref: 'plan line 12', quote: 'search_assets works with an OAuth token' },
    why: 'the token path is the new code; a bare 200 would not show it reached the tool',
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
    expect(output).toContain('| AC | From | Cited | Why | Intent | Base | Shows | Behaviour | Plain claim | How it is driven | Expect |');
    expect(output).toMatch(/^\| AC1 \| plan line 12 \| search_assets works with an OAuth token \| the token path [^|]+ \| changes \| fail \| success \|/m);
    expect(output).toContain('No criterion covers: src/log.ts');
    expect(output).toContain('No spec was supplied');
  });

  it('looks each quote up in --spec and lists the ones it cannot find', () => {
    const input = writeInput({ criteria: [criterion(), criterion({ id: 'AC2', source: { kind: 'plan', ref: 'R2', quote: 'not in there' } })] });
    const spec = join(dirname(input), 'spec.md');
    writeFileSync(spec, '# Plan\n\nsearch_assets works\n  with an OAuth token.\n');
    const output = runCli(['criteria', '--criteria', input, '--spec', spec]);
    expect(output).toContain('NOT IN THE SPEC');
    expect(output).toContain('- AC2: "not in there"');
    expect(output).not.toContain('- AC1:');
    expect(output).not.toContain('No spec was supplied');
    expect(() => runCli(['criteria', '--criteria', input, '--spec', join(dirname(input), 'nope.md')])).toThrow(/does not exist/);
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
    // Legacy mode (no --run-dir) keeps the pre-drive line shape: no claim
    // prefix, "could not run" wording — only the banner is new.
    expect(output).toContain('AC1  ✔  50 rows');
    // AC2 had no result: it can never disappear from the count.
    expect(output).toContain('AC2  ~  could not run, no result was recorded for this criterion');
    expect(output).toContain('1 of 2 proven');
    expect(output).toContain('/healthz');
    expect(output).toContain('evidence not verified (legacy mode)');
  });

  it('fails closed when criteria have dependencies but no precheck exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-cli-'));
    const { results, criteriaPath } = writeReportInputs(dir);
    expect(() => runCli(['report', '--results', results, '--criteria', criteriaPath])).toThrow();
  });

  // The upgrade case: a run approved before citations existed still reports.
  it('reports a run approved before citations, and still refuses to draft one', () => {
    const repo = mkdtempSync(join(tmpdir(), 'verify-older-run-'));
    const runDir = join(repo, '.verify', 'runs', 'r1');
    mkdirSync(runDir, { recursive: true });
    const older = criterion({ source: { kind: 'plan', ref: 'design: no billing routes' }, proof: { kind: 'live-read', detail: 'fresh route table' } });
    delete (older as { why?: string }).why;
    writeFileSync(join(runDir, 'criteria.json'), JSON.stringify({ criteria: [older] }));
    writeFileSync(join(runDir, 'precheck.json'), JSON.stringify({ parts: { api: 'ok' }, tainted: {}, unchecked: [] }));
    writeFileSync(join(runDir, 'evidence.png'), 'pixels');
    const results = join(runDir, 'results.json');
    writeFileSync(results, JSON.stringify({
      results: [{ id: 'AC1', outcome: 'pass', proofSeen: true, observed: 'no billing routes', evidence: ['evidence.png'] }],
      coverage: { filesWithoutCriterion: 0 }, notChecked: [],
    }));
    expect(runCli(['report', '--repo-root', repo, '--run-dir', runDir, '--results', results]))
      .toContain('PASS — 1 of 1 proven.');
    const html = readFileSync(runCli(['html', '--repo-root', repo, '--run-dir', runDir, '--results', results]).trim(), 'utf8');
    expect(html).toContain('quote not recorded');
    expect(html).toContain('Why this check: not recorded');
    // Drafting is still gated: the same criterion cannot be approved anew.
    expect(() => runCli(['criteria', '--criteria', writeInput({ criteria: [older] })]))
      .toThrow(/has no why[\s\S]*source\.quote/);
  });

  it('gates a hand-driven pass on validated named evidence in run-dir mode', () => {
    const repo = mkdtempSync(join(tmpdir(), 'verify-report-v2-'));
    const runDir = join(repo, '.verify', 'runs', 'r1');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'criteria.json'), JSON.stringify({ criteria: [criterion({
      plain: 'A working credential returns asset rows.',
      proof: { kind: 'live-read', detail: 'fresh asset row' },
    })] }));
    writeFileSync(join(runDir, 'precheck.json'), JSON.stringify({ parts: { api: 'ok' }, tainted: {}, unchecked: [] }));
    const results = join(runDir, 'results.json');
    const body = (evidence: string[]) => JSON.stringify({
      results: [{ id: 'AC1', outcome: 'pass', proofSeen: true, observed: 'one row', evidence }],
      coverage: { filesWithoutCriterion: 0 }, notChecked: [],
    });
    writeFileSync(results, body([]));
    expect(runCli(['report', '--repo-root', repo, '--run-dir', runDir, '--results', results]))
      .toContain('not proven — reported pass, no evidence');

    writeFileSync(results, body(['missing.png']));
    expect(runCli(['report', '--repo-root', repo, '--run-dir', runDir, '--results', results]))
      .toContain('missing/rejected: missing.png');

    writeFileSync(join(runDir, 'asset row.png'), 'pixels');
    writeFileSync(results, body(['asset row.png']));
    const output = runCli(['report', '--repo-root', repo, '--run-dir', runDir, '--results', results]);
    expect(output).toContain('PASS — 1 of 1 proven.');
    expect(output).toContain('A working credential returns asset rows.');
    expect(output).toContain('evidence: asset row.png');
    const htmlPath = runCli(['html', '--repo-root', repo, '--run-dir', runDir, '--results', results]).trim();
    expect(readFileSync(htmlPath, 'utf8')).toContain('src="asset%20row.png"');
  });
});

describe('drive', () => {
  it('executes the approved plan from pipeline cwd and records the repository commit', () => {
    const { repo, runDir } = driveRepo();
    const manifest = JSON.parse(runCli(['drive', 'AC1', '--repo-root', repo, '--run-dir', runDir]));
    expect(manifest).toMatchObject({ finalized: true, ac: 'AC1', proof: { result: 'present', seen: true } });
    expect(readFileSync(join(runDir, 'manifest.json'), 'utf8')).toMatch(/"commit":\s*"[0-9a-f]+"/);
  });

  it('uses an unknown commit fallback outside git', () => {
    const { repo, runDir } = driveRepo({ git: false });
    runCli(['drive', 'AC1', '--repo-root', repo, '--run-dir', runDir]);
    expect(JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')).commit).toBe('unknown');
  });

  it('refuses to drive a criterion tainted by precheck', () => {
    const { repo, runDir } = driveRepo({ tainted: true });
    expect(() => runCli(['drive', 'AC1', '--repo-root', repo, '--run-dir', runDir])).toThrow(/taint/i);
  });

  it('binds the requested run directory to the current run', () => {
    const { repo, runDir } = driveRepo({ runId: 'r2' });
    expect(() => runCli(['drive', 'AC1', '--repo-root', repo, '--run-dir', runDir])).toThrow(/r1[\s\S]*r2|r2[\s\S]*r1/);
  });

  it('does not let a judge rescue missing receipted proof', () => {
    const { repo, runDir } = driveRepo();
    const results = join(runDir, 'results.json');
    writeFileSync(results, JSON.stringify({
      results: [{ id: 'AC1', outcome: 'pass', proofSeen: true, observed: 'judge claimed proof' }],
      coverage: { filesWithoutCriterion: 0 }, notChecked: [],
    }));
    const output = runCli(['report', '--repo-root', repo, '--run-dir', runDir, '--results', results]);
    expect(output).toContain('not proven');
    expect(output).toContain('[machine-checked]');
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
