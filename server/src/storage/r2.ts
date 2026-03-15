import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// R2 is optional — screenshots degrade gracefully when not configured.
// This intentionally does NOT fail-fast at module load (unlike core env vars)
// because R2 is supplementary infrastructure, not required for the pipeline to function.
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME ?? 'opslane-verify-evidence';

/** Presigned URL expiry — 7 days (max useful lifetime for a PR comment) */
const PRESIGN_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (_client) return _client;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error('R2 credentials not configured');
  }
  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
  return _client;
}

/** Sanitize path component — alphanumeric, hyphens, single dots only */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.{2,}/g, '_');
}

export function buildScreenshotKey(owner: string, repo: string, prNumber: number, acId: string): string {
  return `verify/${sanitize(owner)}/${sanitize(repo)}/${prNumber}/ac-${sanitize(acId)}.png`;
}

export function isR2Configured(): boolean {
  return !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);
}

/**
 * Upload a screenshot to R2 and return a presigned URL (7-day expiry).
 * Returns undefined if R2 is not configured (graceful degradation).
 */
export async function uploadScreenshot(
  owner: string,
  repo: string,
  prNumber: number,
  acId: string,
  imageBuffer: Buffer,
): Promise<string | undefined> {
  if (!isR2Configured()) {
    return undefined;
  }

  const key = buildScreenshotKey(owner, repo, prNumber, acId);
  const client = getClient();

  await client.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: imageBuffer,
    ContentType: 'image/png',
  }));

  // Generate presigned GET URL so PR comments can embed the screenshot
  const url = await getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }),
    { expiresIn: PRESIGN_EXPIRY_SECONDS },
  );

  return url;
}
