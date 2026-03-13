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
import { parseAcceptanceCriteriaJson } from './pipeline.js';

describe('parseAcceptanceCriteriaJson', () => {
  it('parses valid JSON array', () => {
    const input = '[{"id":"AC-1","description":"Login page loads"},{"id":"AC-2","description":"User can submit form"}]';
    const result = parseAcceptanceCriteriaJson(input);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('AC-1');
    expect(result[1].description).toBe('User can submit form');
  });

  it('extracts JSON from markdown code fences', () => {
    const input = '```json\n[{"id":"AC-1","description":"Page renders"}]\n```';
    const result = parseAcceptanceCriteriaJson(input);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('AC-1');
  });

  it('returns empty array for non-JSON response', () => {
    expect(parseAcceptanceCriteriaJson('No criteria found.')).toEqual([]);
  });

  it('filters out items with missing fields', () => {
    const input = '[{"id":"AC-1","description":"Valid"},{"id":"AC-2"},{"description":"No ID"}]';
    const result = parseAcceptanceCriteriaJson(input);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('AC-1');
  });

  it('returns empty array for malformed JSON', () => {
    expect(parseAcceptanceCriteriaJson('[{broken')).toEqual([]);
  });
});

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
