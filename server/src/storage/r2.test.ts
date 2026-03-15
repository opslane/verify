import { describe, it, expect, vi } from 'vitest';

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({}),
  })),
  PutObjectCommand: vi.fn().mockImplementation((params) => params),
  GetObjectCommand: vi.fn().mockImplementation((params) => params),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://signed-url.example.com/test'),
}));

import { buildScreenshotKey } from './r2.js';

describe('r2 storage', () => {
  it('builds screenshot key from PR context', () => {
    const key = buildScreenshotKey('org', 'repo', 42, 'AC-1');
    expect(key).toBe('verify/org/repo/42/ac-AC-1.png');
  });

  it('sanitizes key components', () => {
    const key = buildScreenshotKey('org/../hack', 'repo', 42, 'AC-1');
    expect(key).not.toContain('..');
  });

  it('sanitizes special characters', () => {
    const key = buildScreenshotKey('my org', 'my repo!', 1, 'AC 2');
    expect(key).toBe('verify/my_org/my_repo_/1/ac-AC_2.png');
  });

  it('uploads and returns presigned URL when R2 is configured', async () => {
    // When running with .env loaded, R2 is configured — the mock S3 client handles the upload
    const { uploadScreenshot, isR2Configured } = await import('./r2.js');
    if (!isR2Configured()) {
      // Skip if env vars not set (CI)
      return;
    }
    const result = await uploadScreenshot('org', 'repo', 42, 'AC-1', Buffer.from('fake-png'));
    expect(result).toBe('https://signed-url.example.com/test');
  });
});
