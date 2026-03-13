import { describe, it, expect } from 'vitest';
import { buildInstallCommands, buildReadinessProbe } from './infra-services.js';

describe('infra-services', () => {
  it('returns empty commands for empty list', () => {
    expect(buildInstallCommands([])).toEqual([]);
  });

  it('returns install + start commands for minio', () => {
    const cmds = buildInstallCommands(['minio']);
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds.some(c => c.includes('minio'))).toBe(true);
  });

  it('returns install + start commands for mailhog', () => {
    const cmds = buildInstallCommands(['mailhog']);
    expect(cmds.length).toBeGreaterThan(0);
  });

  it('ignores postgres and redis (baked into template)', () => {
    const cmds = buildInstallCommands(['postgres', 'redis']);
    expect(cmds).toEqual([]);
  });

  it('builds readiness probe for minio', () => {
    const probe = buildReadinessProbe('minio');
    expect(probe.command).toContain('curl');
    expect(probe.port).toBe(9000);
  });

  it('builds readiness probe for mailhog', () => {
    const probe = buildReadinessProbe('mailhog');
    expect(probe.port).toBe(8025);
  });
});
