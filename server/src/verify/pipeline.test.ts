import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => ({
  findRepoConfig: vi.fn(),
  sql: {},
}));

vi.mock('../crypto.js', () => ({
  decrypt: vi.fn((v: string) => v),
}));

vi.mock('../github/app-service.js', () => ({
  GitHubAppService: vi.fn().mockImplementation(() => ({
    getTokenForRepo: vi.fn().mockResolvedValue({ token: 'test-token', expiresAt: '', installationId: 1 }),
  })),
}));

vi.mock('../github/pr.js', () => ({
  fetchPullRequest: vi.fn().mockResolvedValue({
    title: 'Test PR',
    body: '',
    headBranch: 'feature',
    baseBranch: 'main',
    headSha: 'abc123',
    diff: 'diff content',
    cloneUrl: 'https://github.com/org/repo.git',
  }),
}));

import { findRepoConfig } from '../db.js';

describe('verify pipeline', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns no-config result when no repo config exists', async () => {
    (findRepoConfig as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { runVerifyPipeline } = await import('./pipeline.js');
    const result = await runVerifyPipeline(
      { owner: 'org', repo: 'app', prNumber: 1 },
      { log: () => {} },
    );

    expect(result.mode).toBe('no-config');
  });
});
