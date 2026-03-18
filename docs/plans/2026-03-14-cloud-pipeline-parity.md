# Cloud Pipeline Parity with Local Pipeline

**Date:** 2026-03-14
**Status:** Design (reviewed, revised)

## Problem

The cloud verify pipeline is missing critical stages that the local pipeline has. The agent self-reports pass/fail with no independent verification, no screenshots are captured for human review, and execution is less reliable because the agent improvises navigation instead of following planned steps.

## Design — 2 Phases + Backlog

### Phase 1: Evidence Capture + Judge

**Goal:** Capture screenshots per AC, persist to R2, pass to an Opus judge for independent verdict verification, embed in PR comment.

#### Screenshot Capture

After `runBrowserAgent()` returns for each AC, the pipeline takes a final screenshot by running a Playwright script in the sandbox that connects via CDP and captures the current page state. Screenshots are saved to `/home/user/evidence/ac-{id}.png`.

#### Screenshot Persistence (Cloudflare R2)

E2B download URLs die when the sandbox is destroyed — they cannot be used in PR comments. Instead:

1. After each screenshot, read it from the sandbox as bytes (fetch the E2B `downloadUrl` server-side before sandbox destruction, or use a sandbox command to base64-encode and capture the output — but NOT via PTY which corrupts binary data)
2. Upload to Cloudflare R2 bucket (S3-compatible API)
3. Get permanent public URL: `https://{r2-public-domain}/verify/{owner}/{repo}/{prNumber}/ac-{id}.png`
4. Embed in PR comment

**R2 setup:**
- One bucket: `opslane-verify-evidence`
- Public read access (or signed URLs with long expiry)
- Lifecycle rule: delete objects after 90 days
- Env vars: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL`

**Implementation:** Use `@aws-sdk/client-s3` (R2 is S3-compatible) to upload. One helper function:

```typescript
async function uploadScreenshot(
  key: string,      // e.g. "verify/org/repo/42/ac-AC-1.png"
  imageBuffer: Buffer,
): Promise<string>   // returns public URL
```

#### Reading Screenshots from Sandbox

Two approaches to get image bytes out of the sandbox:

a) **E2B `downloadUrl` + server-side fetch** — call `sandbox.files.downloadUrl(path)`, fetch the URL from Node.js before sandbox is destroyed. Simple, but depends on E2B SDK supporting this.

b) **Sandbox command: `base64 -w0 file.png`** — run in sandbox, capture output. BUT: the PTY transport will mangle this (line splitting, ANSI stripping). Don't use this.

c) **Add `readFileAsBuffer` to E2B provider** — check if E2B SDK has a binary read method. If the SDK supports it, this is cleanest.

Use (a) as the primary approach. The flow:
```
1. Take screenshot in sandbox → /home/user/evidence/ac-{id}.png
2. Get download URL: sandbox.files.downloadUrl(path) → temp URL
3. Fetch bytes: fetch(tempUrl) → Buffer
4. Upload to R2: putObject(key, buffer) → permanent URL
5. (repeat for all ACs)
6. Destroy sandbox
```

#### Screenshot Resize for Judge

Full-page PNGs are 500KB-2MB. Sending 5 of these to Claude as base64 images costs significant tokens. The local pipeline resizes to 300px width before sending to the judge.

In the sandbox, after capturing each screenshot:
```bash
# Resize to 600px width (balance between readability and token cost)
convert /home/user/evidence/ac-{id}.png -resize 600x /home/user/evidence/ac-{id}-thumb.png
```

Or resize server-side using `sharp` after downloading. Send the thumbnail to the judge, upload the full-size to R2 for the PR comment.

If neither `convert` (ImageMagick) nor `sharp` is available, send full-size and accept the token cost for now.

#### Judge

A single Claude API call after all ACs have run. Reviews screenshots + agent self-reported verdicts. Can override agent verdicts (catch false passes).

**Model:** Opus. The judge is the quality gate — false passes are the most dangerous failure mode. The local pipeline uses Opus for the same reason.

**Input:** Claude messages API with vision — screenshots as base64 image content blocks:

```typescript
const messages = [{
  role: 'user',
  content: [
    { type: 'text', text: judgeSystemPrompt },
    // Per AC:
    { type: 'text', text: `--- AC-1: ${description} ---\nAgent verdict: ${verdict}\nAgent reasoning: ${observed}` },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: thumbnailBase64 } },
    // ... repeat
  ],
}];
```

**Judge prompt** (adapted from local `judge.txt`):

```
You are a quality judge reviewing frontend verification results.
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
    { "ac_id": "AC-1", "status": "pass|fail|error", "reasoning": "one sentence", "evidence": "screenshot description" }
  ]
}
```

**Verdict override:** Judge's verdict replaces agent's self-reported verdict. PR comment shows overrides:
```
AC-1: ✅ Pass (judge confirmed)
AC-2: ❌ Fail (agent said pass, judge overrode: "Screenshot shows old heading text")
```

#### PR Comment Format

Update `comment.ts` to embed screenshots and show judge reasoning:

```markdown
## Acceptance Criteria Verification

<details>
<summary>AC-1: Navigate to /auth/login and verify heading — ✅ Pass</summary>

> Judge: Heading clearly shows "Sign in to your account" as expected.

![AC-1](https://r2-url/verify/org/repo/42/ac-AC-1.png)
</details>

<details>
<summary>AC-2: Verify form fields are present — ❌ Fail</summary>

> Agent said: pass
> Judge override: Screenshot shows login page but email field placeholder has changed.

![AC-2](https://r2-url/verify/org/repo/42/ac-AC-2.png)
</details>
```

#### Files Changed

- Create: `server/src/storage/r2.ts` — R2 upload helper
- Create: `server/src/verify/judge.ts` — judge prompt + API call + response parser
- Create: `server/src/verify/judge.test.ts` — unit tests for judge response parsing
- Modify: `server/src/verify/pipeline.ts` — screenshot capture, R2 upload, judge call, use judge verdicts
- Modify: `server/src/verify/comment.ts` — embed screenshots, show judge reasoning, `AcResult` gets `screenshotUrl` + `judgeReasoning` + `judgeOverride`
- Modify: `server/src/sandbox/e2b-provider.ts` — add `downloadUrl()` method
- Modify: `server/src/sandbox/types.ts` — add `downloadUrl` to interface

---

### Phase 2: Pre-Written Steps from Planner

**Goal:** The planner outputs concrete Playwright steps per AC. The agent follows them instead of improvising.

#### Planner Changes

Update `parseAcceptanceCriteria` to produce a richer schema:

```typescript
interface AcceptanceCriterion {
  id: string;
  description: string;
  testable: boolean;
  url: string;
  steps: string[];           // concrete Playwright actions
  screenshot_at: string[];   // named checkpoint labels
}
```

The planner prompt gets the local `planner.txt` rules:
- Rule 1: Read the diff first, test the delta
- Steps must be concrete Playwright actions
- Prefer selectors: `data-testid` > `aria-label` > `role` > text > class
- Screenshot labels are snake_case descriptions
- No brittle pixel measurements

#### Agent Changes

The agent prompt changes from "here's a goal, figure it out" to "here are the steps, execute them in order" — matching the local `agent.txt` template:

```
ACCEPTANCE CRITERION: {description}
START URL: {baseUrl}{url}

STEPS:
1. {step}
2. {step}

SCREENSHOT CHECKPOINTS: {screenshot_at labels}
Save screenshots to: /home/user/evidence/ac-{id}/screenshot-{label}.png
```

#### Named Screenshots

Multiple screenshots per AC at named checkpoints. All sent to judge. The most relevant one (or last) shown in PR comment; all available via R2 links.

#### Files Changed

- Modify: `server/src/verify/pipeline.ts` — updated AC schema, pass steps to agent
- Modify: `server/src/verify/browser-agent.ts` — consume steps + screenshot checkpoints in prompt

---

### Deferred (Backlog)

#### Video Recording
Requires rewriting `browser-agent.ts` from CDP-persistent-browser to per-AC Playwright contexts. This is a large architectural change — needs its own design doc. GitHub can't inline `<video>` in comments anyway, so value is limited to download links.

#### Per-AC Retry
Premature without judge data showing flakiness rate. Implement after Phase 1 proves the judge catches failures, and we have data showing what percentage of failures are flaky vs genuine.

---

## Implementation Order

| Phase | Effort | Dependencies |
|-------|--------|-------------|
| P1: Evidence + Judge | Medium-Large (5-6 tasks) | R2 bucket setup |
| P2: Pre-written steps | Medium (3-4 tasks) | None (but benefits from P1) |

## Model Usage

| Stage | Model | Reason |
|-------|-------|--------|
| Planner | Sonnet | Sufficient with diff context |
| Agent | Sonnet | Execution, not evaluation |
| Judge | Opus | Quality gate — false passes are most dangerous |

## New Infrastructure

- **Cloudflare R2 bucket** (`opslane-verify-evidence`)
- **New env vars:** `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL`
- **New dependency:** `@aws-sdk/client-s3` (for R2 uploads)
