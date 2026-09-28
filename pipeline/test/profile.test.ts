import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkProfile } from '../src/lib/profile.js';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const skill = join(pkgRoot, '..', 'skills', 'verify-setup', 'SKILL.md');

// Every cited file exists and is long enough.
const anyFile = () => 10_000;

function skillExample(): Record<string, any> {
  const text = readFileSync(skill, 'utf8');
  const match = /```json app-profile\n([\s\S]*?)\n```/.exec(text);
  if (!match) throw new Error('no app-profile example in verify-setup SKILL.md');
  return JSON.parse(match[1]);
}

function profile(): Record<string, any> {
  return structuredClone(skillExample());
}

describe('checkProfile', () => {
  it('accepts the example the verify-setup skill documents', () => {
    const { errors, counts } = checkProfile(skillExample(), anyFile);
    expect(errors).toEqual([]);
    expect(counts).toMatchObject({ services: 1, actors: 1, entities: 1, transitions: 2, external: 1, config: 1 });
  });

  it('rejects a kind outside the allowed values', () => {
    const p = profile();
    p.actors[0].kind = 'cron';
    expect(checkProfile(p, anyFile).errors).toContain(
      'actors[0].kind: "cron" is not one of scheduler, poller, reaper, sweeper, consumer, boot_task, migration',
    );
  });

  it('rejects missing and unexpected keys, so profiles stay one shape', () => {
    const p = profile();
    delete p.external[0].stub_how;
    p.external[0].guarded = true;
    const { errors } = checkProfile(p, anyFile);
    expect(errors).toContain('external[0]: missing "stub_how"');
    expect(errors).toContain('external[0]: unexpected key "guarded"');
  });

  it('rejects a source that does not point at a real line', () => {
    const p = profile();
    p.services[0].source = 'compose.yaml';
    p.config[0].source = '.env.example:99';
    p.actors[0].source = 'gone.ts:1';
    const lines = (path: string) => (path === 'gone.ts' ? null : 20);
    const { errors } = checkProfile(p, lines);
    expect(errors).toContain('services[0].source: "compose.yaml" is not "path:line"');
    expect(errors).toContain('config[0].source: .env.example has 20 lines, not 99');
    expect(errors).toContain('actors[0].source: gone.ts does not exist');
  });

  it('checks the end of a line range, not only its start', () => {
    const p = profile();
    p.services[0].source = 'compose.yaml:3-40';
    expect(checkProfile(p, () => 20).errors).toContain('services[0].source: compose.yaml has 20 lines, not 40');
  });

  it('accepts an edge answered by the user and requires at least one hop', () => {
    const p = profile();
    expect(checkProfile(p, anyFile).errors).toEqual([]);
    p.edge.hops = [];
    expect(checkProfile(p, anyFile).errors).toContain(
      'edge.hops: expected at least one hop ("none" or "unknown" if so)',
    );
  });

  it('counts unknowns, which are allowed', () => {
    const p = profile();
    p.external[0].stubbable = 'unknown';
    p.entities[0].transitions[0].by = 'unknown';
    p.edge.hops = ['unknown'];
    const { errors, counts } = checkProfile(p, anyFile);
    expect(errors).toEqual([]);
    expect(counts.unknowns).toBe(3);
  });

  it('rejects a non-positive interval', () => {
    const p = profile();
    p.actors[0].interval_s = 0;
    expect(checkProfile(p, anyFile).errors).toContain('actors[0].interval_s: expected a positive number or null');
  });
});

describe('profile-check verb', () => {
  const cli = join(pkgRoot, 'src', 'cli.ts');

  function repoWith(p: unknown): string {
    const repo = mkdtempSync(join(tmpdir(), 'verify-profile-'));
    mkdirSync(join(repo, '.verify'));
    for (const file of ['compose.yaml', 'worker/src/index.ts', 'worker/src/db.ts', 'api/handler/jobs.go',
      'migrations/001_jobs.sql', 'worker/src/llm.ts', '.env.example']) {
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      writeFileSync(join(repo, file), 'x\n'.repeat(2000));
    }
    writeFileSync(join(repo, '.verify', 'profile.json'), JSON.stringify(p));
    return repo;
  }

  function run(repo: string): { status: number; out: Record<string, any> } {
    try {
      const out = execFileSync('npx', ['--no-install', 'tsx', cli, 'profile-check', '--repo', repo], {
        cwd: pkgRoot, encoding: 'utf8',
      });
      return { status: 0, out: JSON.parse(out) };
    } catch (err: any) {
      return { status: err.status, out: JSON.parse(err.stdout) };
    }
  }

  it('passes a valid profile against the real files in the repo', () => {
    const { status, out } = run(repoWith(profile()));
    expect(status).toBe(0);
    expect(out.ok).toBe(true);
    expect(out.counts.actors).toBe(1);
  });

  it('fails when a cited path escapes the repo', () => {
    const p = profile();
    p.services[0].source = '../../etc/passwd:1';
    const { status, out } = run(repoWith(p));
    expect(status).toBe(1);
    expect(out.errors).toContain('services[0].source: ../../etc/passwd does not exist');
  });
});
