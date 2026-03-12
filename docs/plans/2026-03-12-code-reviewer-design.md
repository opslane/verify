# Code Reviewer — Design

**Date:** 2026-03-12
**Status:** Design finalized, ready for implementation

## Overview

A GitHub PR code reviewer that runs as a cloud service in the `verify` repo.
When a PR is opened or updated, a GitHub App webhook fires, a Trigger.dev background
job spins up an E2B sandbox, clones the repo, runs the Claude CLI to review the full
codebase in context, and posts the result back as a PR comment.

## Repo structure

New `server/` directory added alongside existing `scripts/`:

```
verify/
  scripts/          ← existing Bash CLI pipeline (unchanged)
  server/
    src/
      index.ts              ← Hono HTTP server entry (webhook receiver + health check)
      routes/
        webhooks.ts         ← POST /webhooks/github (Svix-forwarded), responds 202 immediately
      github/
        app-service.ts      ← GitHubAppService (copied from opslane-v2)
        pr.ts               ← fetch PR metadata, post PR comment
      sandbox/
        e2b-provider.ts     ← E2BSandboxProvider (copied from opslane-v2)
      review/
        runner.ts           ← Trigger.dev task: clone → claude -p → post comment
        prompt.ts           ← builds the review prompt from PR metadata + diff summary
      dedup/
        set.ts              ← in-memory Set keyed on delivery ID to prevent duplicate runs
    package.json
    tsconfig.json
    Dockerfile
  server/.env.example       ← placeholder values only, committed to repo
```

## Request flow

```
GitHub PR event (opened / synchronize)
  → Svix (buffers, retries on server downtime)
    → POST /webhooks/github on Railway
      → verify Svix signature (SVIX_SKIP_VERIFICATION=true for local dev)
        → check in-memory dedup set (delivery ID)
          → respond 202 immediately
            → trigger Trigger.dev background task
              → fetch PR metadata + diff summary via GitHub API (installation token)
                → spin up E2B sandbox (try/finally guarantees teardown)
                  → clone repo + checkout PR branch
                    → run: claude -p "<review prompt>" --dangerouslySkipPermissions
                      (hard timeout: 180s)
                      → capture stdout
                        → POST comment to PR via GitHub API
                          → kill sandbox (always, even on failure)
```

## Claude prompt

The review prompt includes:
- PR title, description, base branch, and head SHA
- Unified diff (truncated to ~50KB if larger — post "diff too large" comment instead)
- Instruction to review for: correctness, security, architecture, simplicity, test coverage, maintainability
- Instruction to output plain markdown with severity-tagged findings (Blocker / Should Fix / Consider)

See `skills/code-review-scale` for the full rubric that informs the prompt.

## Environment variables

All secrets from environment — never hardcoded:

| Var | Description |
|-----|-------------|
| `GITHUB_APP_ID` | GitHub App numeric ID |
| `GITHUB_APP_PRIVATE_KEY` | Base64-encoded PEM private key |
| `GITHUB_WEBHOOK_SECRET` | Raw GitHub HMAC secret (for direct verification if Svix is bypassed) |
| `SVIX_WEBHOOK_SECRET` | Svix signing secret to verify forwarded events |
| `E2B_API_KEY` | E2B sandbox API key |
| `TRIGGER_SECRET_KEY` | Trigger.dev project secret |
| `PORT` | HTTP port (Railway sets automatically) |

Local dev only:

| Var | Description |
|-----|-------------|
| `SVIX_SKIP_VERIFICATION` | `true` to bypass Svix sig check — guarded: only allowed when `NODE_ENV !== 'production'` |

## Key decisions

- **Svix** for incoming webhook reliability (buffers + retries if Railway server is down)
- **Trigger.dev** for async background job execution — webhook handler returns 202 immediately
- **E2B sandbox** — full repo clone + Claude CLI with whole codebase context
- **`try/finally`** around sandbox lifecycle — always torn down, even on failure
- **180s hard timeout** on `claude -p` invocation inside sandbox
- **In-memory dedup Set** keyed on Svix delivery ID — prevents duplicate reviews on retry
- **50KB diff cap** — if exceeded, post a "diff too large" comment instead of reviewing
- **Single PR comment** — plain markdown, posted by the GitHub App bot. On `synchronize`, edit the existing bot comment in-place (find by bot login + marker) rather than adding a new one
- **`GET /health`** endpoint for Railway health checks
- **Open source safe** — `.env.example` with placeholders only, `.env` gitignored, no secrets in code or comments
- **GitHub App permissions required**: `pull_requests: read+write`, `contents: read`

## What triggers a review

GitHub App webhook events: `pull_request.opened` and `pull_request.synchronize`

All other events return `200 { accepted: false }`.

## Deployment

- **Platform:** Railway
- **Background jobs:** Trigger.dev (cloud)
- **Runtime:** Node.js
- **Docker:** `server/Dockerfile` for Railway deploy
