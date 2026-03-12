# verify/server

Cloud service that reviews GitHub PRs using Claude in an E2B sandbox.

## How it works

1. GitHub PR opened/updated → Svix (webhook buffer) → this server
2. Server responds 202, triggers a Trigger.dev background task
3. Task: fetches PR diff, spins up E2B sandbox, clones repo, runs `claude -p`
4. Posts code review as a PR comment

## Required GitHub App permissions

- `pull_requests: write` — post/edit review comments
- `contents: read` — fetch PR diff

## Setup

1. Copy `.env.example` to `.env` and fill in all values
2. Install: `npm install`
3. Dev: `npm run dev` (Hono server) + `npm run trigger:dev` (Trigger.dev worker)

## Environment variables

See `.env.example` for all required vars.

## Deployment

- **Hono server** → Railway (use `Dockerfile`, set env vars in Railway dashboard)
- **Trigger.dev tasks** → `npm run trigger:deploy`

## Local testing with ngrok

```bash
ngrok http 3000
# Set SVIX_SKIP_VERIFICATION=true in .env
# Point GitHub App webhook to: https://<ngrok-url>/webhooks/github
```
