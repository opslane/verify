# Evidence Capture + Judge Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Capture screenshots per AC, persist to Cloudflare R2, run an Opus judge to independently verify verdicts, and embed screenshots + judge reasoning in the PR comment.

**Architecture:** After each AC's agent run, take a viewport screenshot via CDP in the sandbox, download it via E2B's `sandbox.downloadUrl()`, upload to R2 for a permanent URL. After all ACs complete, send screenshots + agent verdicts to an Opus judge call. Judge can override agent verdicts. Final results with screenshots and judge reasoning posted as PR comment.

**Tech Stack:** TypeScript, E2B SDK (`sandbox.downloadUrl`), `@aws-sdk/client-s3` (R2), Anthropic SDK (Opus vision)

**Design doc:** `docs/plans/2026-03-14-cloud-pipeline-parity.md`

---

## Prerequisites (manual)

1. **Create R2 bucket** `opslane-verify-evidence` in Cloudflare dashboard
2. **Enable public access** or configure a custom domain for the bucket
3. **Create R2 API token** with read/write access to the bucket
4. **Add env vars to `server/.env`:**
   ```
   R2_ACCOUNT_ID=<your-account-id>
   R2_ACCESS_KEY_ID=<token-access-key>
   R2_SECRET_ACCESS_KEY=<token-secret>
   R2_BUCKET_NAME=opslane-verify-evidence
   R2_PUBLIC_URL=https://pub-xxx.r2.dev
   ```
5. **Install dependency:** `cd server && npm install @aws-sdk/client-s3`

---

## Task 1: R2 Upload Helper

**Files:**
- Create: `server/src/storage/r2.ts`
- Create: `server/src/storage/r2.test.ts`

**Step 1: Write tests**

```typescript
// server/src/storage/r2.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({}),
  })),
  PutObjectCommand: vi.fn().mockImplementation((params) => params),
}));

import { buildScreenshotKey, getPublicUrl } from './r2.js';

describe('r2 storage', () => {
  it('builds screenshot key from PR context', () => {
    const key = buildScreenshotKey('org', 'repo', 42, 'AC-1');
    expect(key).toBe('verify/org/repo/42/ac-AC-1.png');
  });

  it('builds public URL from key', () => {
    const url = getPublicUrl('verify/org/repo/42/ac-AC-1.png');
    expect(url).toMatch(/\/verify\/org\/repo\/42\/ac-AC-1\.png$/);
  });

  it('sanitizes key components', () => {
    const key = buildScreenshotKey('org/../hack', 'repo', 42, 'AC-1');
    expect(key).not.toContain('..');
  });

  it('returns undefined when R2 is not configured', async () => {
    const { uploadScreenshot } = await import('./r2.js');
    const result = await uploadScreenshot('org', 'repo', 42, 'AC-1', Buffer.from('fake-png'));
    // In test env, R2 env vars are not set — should return undefined
    expect(result).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && node --env-file=.env ./node_modules/.bin/vitest run src/storage/r2.test.ts`
Expected: FAIL — module not found.

**Step 3: Write implementation**

```typescript
// server/src/storage/r2.ts
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// R2 is optional — screenshots degrade gracefully when not configured.
// This intentionally does NOT fail-fast at module load (unlike core env vars)
// because R2 is supplementary infrastructure, not required for the pipeline to function.
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME ?? 'opslane-verify-evidence';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL ?? '';

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

/** Sanitize path component — alphanumeric, hyphens, dots only */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function buildScreenshotKey(owner: string, repo: string, prNumber: number, acId: string): string {
  return `verify/${sanitize(owner)}/${sanitize(repo)}/${prNumber}/ac-${sanitize(acId)}.png`;
}

export function getPublicUrl(key: string): string {
  return `${R2_PUBLIC_URL}/${key}`;
}

/**
 * Upload a screenshot to R2 and return the public URL.
 * Returns undefined if R2 is not configured (graceful degradation).
 */
export async function uploadScreenshot(
  owner: string,
  repo: string,
  prNumber: number,
  acId: string,
  imageBuffer: Buffer,
): Promise<string | undefined> {
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
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

  return getPublicUrl(key);
}
```

**Step 4: Run tests**

Run: `cd server && node --env-file=.env ./node_modules/.bin/vitest run src/storage/r2.test.ts`
Expected: ALL PASS

**Step 5: Verify compilation + commit**

Run: `cd server && npx tsc --noEmit`

```bash
git add server/src/storage/r2.ts server/src/storage/r2.test.ts
git commit -m "feat: add R2 upload helper for screenshot persistence"
```

---

## Task 2: Screenshot Capture + E2B Download in Pipeline

**Files:**
- Modify: `server/src/sandbox/types.ts:30-36`
- Modify: `server/src/sandbox/e2b-provider.ts`
- Modify: `server/src/verify/pipeline.ts`

**Step 1: Add `downloadUrl` to `SandboxProvider` interface**

In `server/src/sandbox/types.ts`, add to the interface:

```typescript
  downloadUrl(sandboxId: string, path: string): Promise<string>;
```

**Step 2: Implement in `E2BSandboxProvider`**

In `server/src/sandbox/e2b-provider.ts`, add after `readFile`:

```typescript
  async downloadUrl(sandboxId: string, path: string): Promise<string> {
    if (!path.startsWith('/') || path.includes('..')) {
      throw new Error(`downloadUrl path must be absolute without traversal: ${path}`);
    }
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) throw new Error(`Sandbox ${sandboxId} not found`);
    // downloadUrl is on the Sandbox class, not sandbox.files
    return sandbox.downloadUrl(path, { useSignatureExpiration: 300 });
  }
```

**Step 3: Add screenshot capture + R2 upload to pipeline**

In `server/src/verify/pipeline.ts`, add imports at the top:

```typescript
import { uploadScreenshot } from '../storage/r2.js';
import type { SandboxProvider } from '../sandbox/types.js';
```

Add the capture helper function (after the imports, before `runVerifyPipeline`):

```typescript
const SANDBOX_ENV = 'NODE_PATH=/home/user/.local/node_modules:/usr/local/lib/node_modules:/usr/lib/node_modules PLAYWRIGHT_BROWSERS_PATH=/ms-playwright';

/**
 * Take a viewport screenshot of the current browser state,
 * download from sandbox, upload to R2 for a permanent URL.
 */
async function captureAndPersistScreenshot(
  provider: SandboxProvider,
  sandboxId: string,
  owner: string,
  repo: string,
  prNumber: number,
  acId: string,
  log: (step: string, msg: string) => void,
): Promise<{ screenshotUrl?: string; screenshotBuffer?: Buffer }> {
  const screenshotPath = `/home/user/evidence-ac-${acId}.png`;

  try {
    // Take viewport screenshot via CDP (no fullPage — keeps file size manageable)
    const screenshotScript = `const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0]?.pages()[0];
  if (page) {
    await page.screenshot({ path: '${screenshotPath}' });
    console.log(JSON.stringify({ ok: true }));
  } else {
    console.log(JSON.stringify({ ok: false, error: 'No page found' }));
  }
  process.exit(0);
})();`;

    await provider.uploadFiles(sandboxId, [{ path: '/home/user/capture-screenshot.cjs', content: screenshotScript }]);
    await drain(provider.runCommand(sandboxId,
      `${SANDBOX_ENV} node /home/user/capture-screenshot.cjs`,
      { rawOutput: true, timeoutMs: 15_000 },
    ));

    // Download via E2B signed URL (fetch server-side before sandbox is destroyed)
    const tempUrl = await provider.downloadUrl(sandboxId, screenshotPath);
    const response = await fetch(tempUrl);
    if (!response.ok) {
      log('screenshot', `Download failed: ${response.status}`);
      return {};
    }
    const screenshotBuffer = Buffer.from(await response.arrayBuffer());

    // Upload to R2 for permanent URL
    const screenshotUrl = await uploadScreenshot(owner, repo, prNumber, acId, screenshotBuffer);
    if (screenshotUrl) {
      log('screenshot', `Uploaded: ${screenshotUrl}`);
    }

    return { screenshotUrl, screenshotBuffer };
  } catch (err) {
    log('screenshot', `Failed: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}
```

**Step 4: Wire into the AC loop**

Replace the `for (const ac of criteria)` loop body to add screenshot capture after each agent run. After the `runBrowserAgent` call and before `results.push`, add:

```typescript
      // Capture screenshot after agent finishes
      const { screenshotUrl, screenshotBuffer } = await captureAndPersistScreenshot(
        provider, sandbox.id, owner, repo, prNumber, ac.id, log,
      );
      if (screenshotBuffer) screenshotBuffers.set(ac.id, screenshotBuffer);
```

And add `screenshotUrl` to the `results.push` object. Also add `const screenshotBuffers: Map<string, Buffer> = new Map();` before the loop.

**Step 5: Verify compilation**

Run: `cd server && npx tsc --noEmit`
Expected: Error — `screenshotUrl` not in `AcResult`. Will be fixed in Task 4.

**Step 6: Commit**

```bash
git add server/src/sandbox/types.ts server/src/sandbox/e2b-provider.ts server/src/verify/pipeline.ts
git commit -m "feat: capture screenshots per AC, download from sandbox, upload to R2"
```

---

## Task 3: Judge Module

**Files:**
- Create: `server/src/verify/judge.ts`
- Create: `server/src/verify/judge.test.ts`

**Step 1: Write tests**

```typescript
// server/src/verify/judge.test.ts
import { describe, it, expect } from 'vitest';
import { parseJudgeResponse } from './judge.js';

describe('parseJudgeResponse', () => {
  it('parses valid judge JSON', () => {
    const input = JSON.stringify({
      criteria: [
        { ac_id: 'AC-1', status: 'pass', reasoning: 'Heading matches', evidence: 'screenshot shows correct heading' },
        { ac_id: 'AC-2', status: 'fail', reasoning: 'Button label wrong', evidence: 'screenshot shows old label' },
      ],
    });
    const result = parseJudgeResponse(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ ac_id: 'AC-1', status: 'pass', reasoning: 'Heading matches', evidence: 'screenshot shows correct heading' });
    expect(result[1].status).toBe('fail');
  });

  it('handles code-fenced JSON', () => {
    const input = '```json\n{"criteria":[{"ac_id":"AC-1","status":"pass","reasoning":"ok","evidence":"ok"}]}\n```';
    const result = parseJudgeResponse(input);
    expect(result).toHaveLength(1);
  });

  it('returns empty array for malformed JSON', () => {
    expect(parseJudgeResponse('not json')).toEqual([]);
  });

  it('filters out entries with missing fields', () => {
    const input = JSON.stringify({
      criteria: [
        { ac_id: 'AC-1', status: 'pass', reasoning: 'ok' },
        { status: 'fail' },
      ],
    });
    const result = parseJudgeResponse(input);
    expect(result).toHaveLength(1);
  });

  it('normalizes invalid status to error', () => {
    const input = JSON.stringify({
      criteria: [{ ac_id: 'AC-1', status: 'maybe', reasoning: 'unsure' }],
    });
    const result = parseJudgeResponse(input);
    expect(result[0].status).toBe('error');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && node --env-file=.env ./node_modules/.bin/vitest run src/verify/judge.test.ts`
Expected: FAIL.

**Step 3: Write implementation**

```typescript
// server/src/verify/judge.ts
import Anthropic from '@anthropic-ai/sdk';

export interface JudgeVerdict {
  ac_id: string;
  status: 'pass' | 'fail' | 'error';
  reasoning: string;
  evidence?: string;
}

export interface AcEvidence {
  id: string;
  description: string;
  agentVerdict: string;
  agentReasoning: string;
  screenshotBase64?: string;
}

const JUDGE_PROMPT = `You are a quality judge reviewing frontend verification results.
For each acceptance criterion, review the screenshot and agent log, then return a verdict.

Rules:
1. Use the SCREENSHOT as primary evidence. Agent verdict is context, not truth.
2. pass = criterion clearly met in the screenshot
3. fail = criterion clearly not met
4. error = agent crashed or hit login redirect — cannot judge
5. Be strict: if you cannot clearly confirm the criterion, mark as fail.
6. If a screenshot shows a login page, mark as error: "Auth redirect"

Return ONLY valid JSON:
{
  "criteria": [
    { "ac_id": "AC-1", "status": "pass|fail|error", "reasoning": "one sentence", "evidence": "what you see in screenshot" }
  ]
}`;

/**
 * Run the judge: send screenshots + agent verdicts to Opus for independent verification.
 */
export async function runJudge(
  evidence: AcEvidence[],
  log: (msg: string) => void,
): Promise<JudgeVerdict[]> {
  if (evidence.length === 0) return [];

  const client = new Anthropic();
  const contentBlocks: Anthropic.ContentBlockParam[] = [
    { type: 'text', text: JUDGE_PROMPT },
  ];

  for (const ac of evidence) {
    contentBlocks.push({
      type: 'text',
      text: `\n--- ${ac.id}: ${ac.description} ---\nAgent verdict: ${ac.agentVerdict}\nAgent reasoning: ${ac.agentReasoning}`,
    });

    if (ac.screenshotBase64) {
      contentBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: ac.screenshotBase64 },
      });
    } else {
      contentBlocks.push({
        type: 'text',
        text: '(No screenshot available for this AC)',
      });
    }
  }

  log(`Calling Opus judge with ${evidence.length} ACs, ${evidence.filter(e => e.screenshotBase64).length} screenshots`);

  const response = await client.messages.create({
    model: 'claude-opus-4-20250514',
    max_tokens: 4096,
    messages: [{ role: 'user', content: contentBlocks }],
  });

  const text = response.content.find((c) => c.type === 'text')?.text ?? '{}';
  log(`Judge response: ${text.slice(0, 300)}`);
  return parseJudgeResponse(text);
}

/** Parse the judge's JSON response into validated verdicts. Exported for testing. */
export function parseJudgeResponse(text: string): JudgeVerdict[] {
  const cleaned = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();

  try {
    const parsed = JSON.parse(cleaned) as { criteria?: unknown[] };
    if (!Array.isArray(parsed.criteria)) return [];

    return parsed.criteria
      .filter((item): item is { ac_id: string; status: string; reasoning: string; evidence?: string } =>
        typeof item === 'object' && item !== null &&
        'ac_id' in item && typeof (item as Record<string, unknown>).ac_id === 'string' &&
        'status' in item && typeof (item as Record<string, unknown>).status === 'string' &&
        'reasoning' in item && typeof (item as Record<string, unknown>).reasoning === 'string'
      )
      .map((item) => ({
        ac_id: item.ac_id,
        status: (['pass', 'fail', 'error'].includes(item.status) ? item.status : 'error') as 'pass' | 'fail' | 'error',
        reasoning: item.reasoning,
        evidence: typeof item.evidence === 'string' ? item.evidence : undefined,
      }));
  } catch {
    return [];
  }
}
```

**Step 4: Run tests**

Run: `cd server && node --env-file=.env ./node_modules/.bin/vitest run src/verify/judge.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add server/src/verify/judge.ts server/src/verify/judge.test.ts
git commit -m "feat: add judge module — Opus vision reviews screenshots per AC"
```

---

## Task 4: Update Comment Formatter + Wire Judge into Pipeline

**Files:**
- Modify: `server/src/verify/comment.ts`
- Modify: `server/src/verify/pipeline.ts`

**Step 1: Update `AcResult` and `formatVerifyComment` in `comment.ts`**

Add `screenshotUrl`, `judgeReasoning`, `judgeOverride` to `AcResult`. Update `formatVerifyComment` to use `<details>` tags with embedded screenshots and judge reasoning. Keep the `specPath` and `port` in the header.

**Step 2: Wire judge into pipeline**

In `pipeline.ts`, after the AC loop and before building the comment, add:

```typescript
    // Run judge — independent verdict verification
    import { runJudge } from './judge.js';

    log('judge', 'Running Opus judge');
    const judgeEvidence = results
      .filter((r) => r.result !== 'skipped' && screenshotBuffers.has(r.id))
      .map((r) => ({
        id: r.id,
        description: r.description,
        agentVerdict: r.result,
        agentReasoning: r.observed ?? r.reason ?? 'none',
        screenshotBase64: screenshotBuffers.get(r.id)?.toString('base64'),
      }));

    if (judgeEvidence.length > 0) {
      const judgeVerdicts = await runJudge(judgeEvidence, (msg) => log('judge', msg));

      for (const jv of judgeVerdicts) {
        const result = results.find((r) => r.id === jv.ac_id);
        if (!result) continue;

        result.judgeReasoning = jv.reasoning;
        if (result.result !== jv.status && result.result !== 'skipped') {
          log('judge', `Override: ${jv.ac_id} agent=${result.result} → judge=${jv.status} (${jv.reasoning})`);
          result.result = jv.status === 'error' ? 'skipped' : jv.status;
          result.judgeOverride = true;
          if (jv.status === 'error') result.reason = jv.reasoning;
        }
      }
    }
```

Note: use static import `import { runJudge } from './judge.js';` at the top of the file (not dynamic import — `Anthropic` is already imported).

**Step 3: Recompute `passed` count after judge overrides**

Move the `const passed = ...` line to after the judge block.

**Step 4: Verify compilation + run all tests**

Run: `cd server && npx tsc --noEmit && node --env-file=.env ./node_modules/.bin/vitest run`
Expected: ALL PASS.

**Step 5: Commit**

```bash
git add server/src/verify/pipeline.ts server/src/verify/comment.ts
git commit -m "feat: wire screenshots + Opus judge into verify pipeline"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | R2 upload helper | `storage/r2.ts`, `storage/r2.test.ts` |
| 2 | Screenshot capture + E2B download + pipeline wiring | `sandbox/types.ts`, `sandbox/e2b-provider.ts`, `verify/pipeline.ts` |
| 3 | Judge module (Opus + vision) | `verify/judge.ts`, `verify/judge.test.ts` |
| 4 | Comment formatter + wire judge | `verify/comment.ts`, `verify/pipeline.ts` |

**After all tasks:** Set up R2 env vars, restart dev server, trigger `/verify` on formbricks PR. Expected: PR comment includes screenshots per AC, judge reasoning, and judge can override agent verdicts.

## Review Fixes Incorporated

- Fixed `sandbox.downloadUrl()` API (not `sandbox.files.downloadUrl`)
- Dropped `sharp` — not needed, viewport screenshots are small enough
- Removed `fullPage: true` — viewport screenshots keep file size manageable
- Merged downloadUrl task into screenshot task (was 8 lines, not a separate task)
- Dropped "final verification" non-task
- Static import for judge module (Anthropic already imported)
- S3Client singleton (lazy, not recreated per upload)
- Kept specPath + port in comment header
- Added test for R2 graceful degradation
- Added comment explaining R2 convention deviation
