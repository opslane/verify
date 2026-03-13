# Remote Verify Pipeline — v2 Backlog

Items deferred from the v1 design (`2026-03-12-remote-verify-pipeline-design.md`). These are features we've designed or discussed but chose not to build in the initial release.

## Auto-Detection via Claude

**What:** During repo setup, clone the repo into an E2B sandbox and run Claude headless with a detection prompt. Claude analyzes `package.json`, `docker-compose*.yml`, `Makefile`, `README`, `.env.example`, `Dockerfile`, `Procfile`, and setup scripts, then outputs a JSON config that pre-fills the setup form.

**Why deferred:** Adds an E2B sandbox lifecycle + Claude call to the one-time setup flow. Most developers know their startup command and port. The empty form is good enough for v1.

**Design notes:**
- Detection prompt should output: framework, packageManager, installCommand, startupCommand, port, preStartScript, infraServices, healthPath, notes
- Handles monorepos naturally (Claude reads turbo/workspace config)
- Can infer pre-start scripts from `.env.example` comments and migration files
- Cost: one Claude call per repo setup (~30 seconds)
- Could alternatively fetch key files via GitHub API instead of cloning into a sandbox (faster, cheaper)

## Screenshot Evidence in PR Comments

**What:** Include screenshots from browser agents as visual evidence of pass/fail results in the PR comment.

**Why deferred:** Base64-encoded screenshots in GitHub comments hit the ~65KB API limit with 2-3 screenshots. Needs external storage.

**Design notes:**
- Upload screenshots to S3/R2 bucket, link in the PR comment as `![screenshot](https://...)`
- Collapsed `<details>` blocks keep the comment scannable
- Compress/resize to ~50KB per screenshot
- Consider only including screenshots for failed ACs (success doesn't need visual proof)
- Need to handle image expiry/retention policy

## Linear/Jira Ticket Fetching

**What:** When spec discovery finds a Linear or Jira link in the PR body, fetch the ticket content and use it as the spec for AC verification.

**Why deferred:** Requires OAuth integration with Linear/Jira, plus parsing different ticket formats.

**Design notes:**
- Detect patterns: `LIN-123`, `PROJ-123`, or full URLs (`linear.app/...`, `*.atlassian.net/...`)
- Need user to connect their Linear/Jira account in the dashboard (OAuth flow)
- Store access tokens encrypted (same AES-256-GCM pattern as env vars)
- Ticket content may not have clear ACs — Claude would need to extract them

## Config-as-Code (`opslane.verify.yml`)

**What:** Allow repos to include an `opslane.verify.yml` file that overrides dashboard config. Pipeline reads both, with the file taking precedence.

**Why deferred:** Dashboard config is sufficient for v1. Config-as-code is a power-user feature.

**Design notes:**
- Non-sensitive config only (startup command, port, health path, infra services, pre-start script)
- Secrets always come from the dashboard (never in a repo file)
- File in repo takes precedence over dashboard values (except secrets)
- Changes to the file in a PR should take effect for that PR's verification run
- Schema validation with clear error messages on malformed config

## Per-Environment Configs

**What:** Different configs for different environments (dev, staging, production).

**Why deferred:** v1 only runs against a sandbox-hosted dev environment.

## Video Recording

**What:** Record browser sessions as video (webm) for debugging failed ACs.

**Why deferred:** Adds storage requirements and Playwright config complexity. Text evidence is sufficient for v1.

**Design notes:**
- Playwright supports `recordVideo: { dir: '/tmp/videos' }`
- Same S3/R2 upload pattern as screenshots
- Potentially more useful than screenshots for complex multi-step interactions

## Trace File Storage

**What:** Store Playwright trace files for failed runs, allowing `npx playwright show-trace` debugging.

**Why deferred:** Same storage requirements as video/screenshots.

## Re-run with Custom Spec

**What:** Allow `/verify <spec-url>` or `/verify <inline-spec>` comments to run verification against a spec that isn't in the PR.

**Why deferred:** v1 always uses what's in the PR (plan file or PR body). Custom specs add complexity around spec provenance and caching.

## Encryption Key Rotation

**What:** Support rotating the `ENCRYPTION_KEY` without downtime — re-encrypt all stored secrets with the new key.

**Why deferred:** Single key is fine for v1. Rotation can be a manual process (decrypt all with old key, re-encrypt with new key, update env var).

**Design notes:**
- Store key version alongside ciphertext: `v1:iv:ciphertext:authTag`
- On decrypt, check version and use corresponding key
- Migration script: read all encrypted values, decrypt with old key, encrypt with new key, update rows
