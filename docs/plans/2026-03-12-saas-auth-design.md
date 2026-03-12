# SaaS Auth — Design

**Date:** 2026-03-12
**Status:** Design complete, ready for implementation

## Overview

Add GitHub OAuth sign-up to the verify code reviewer so teams can self-serve install
the GitHub App. No dashboard for v1 — the product is purely the GitHub App. Users sign
in with GitHub, get redirected to install the App, and PR reviews start working.

## Architecture

```
Landing page (static HTML served by Hono)
  → "Sign in with GitHub" button
    → GET /auth/github  (generate state, redirect to GitHub OAuth)
      → GitHub OAuth consent screen
        → GET /auth/callback  (verify state, exchange code, upsert org+user, set JWT cookie)
          → redirect to GitHub App install URL
            → GitHub App installed
              → webhooks fire, PR reviews work
```

The existing webhook handler (`POST /webhooks/github`) is unchanged. Auth routes are
new prefixes on the same Hono server. Session is a JWT in an httpOnly cookie — no
refresh tokens for v1. JWT expiry: **90 days** (no re-login flow needed for v1).

**Note:** GitHub OAuth App (handles sign-in) and GitHub App (handles PR webhooks) are
two separate GitHub entities, both configured in your GitHub org settings.

## OAuth Flow Detail

### CSRF protection (state param)

`/auth/github`:
1. Generate a random `state` token
2. Store it in a short-lived httpOnly cookie (`oauth_state`, 10 min TTL)
3. Redirect to GitHub with `&state=<value>` appended to the OAuth URL

`/auth/callback`:
1. Compare `state` query param against `oauth_state` cookie — reject with 400 if mismatch
2. Clear the `oauth_state` cookie
3. Exchange `code` for access token, fetch user info, upsert org + user, set JWT

### Scopes

Request `read:user user:email` — sufficient to read GitHub user identity and email.
Do not request `read:org` — not needed for v1.

### Org model

Each GitHub user is their own org (1:1). On first sign-in:
- Create `org` with `github_org_login = user.github_login`
- Create `user` linked to that org

This keeps sign-up frictionless. If a team needs shared access later, that's a v2 problem.

## Routes

```
GET  /                  serve static landing page (HTML)
GET  /auth/github       generate state cookie, redirect to GitHub OAuth
GET  /auth/callback     verify state, exchange code, upsert org+user, set JWT, redirect to App install
POST /webhooks/github   existing PR review handler (unchanged)
```

## Installation → Org Linkage

When the GitHub App `installation.created` webhook fires, GitHub does not include a
platform session. To link the installation to an org, use `sender.login` from the
webhook payload to look up the `users` row, then get its `org_id`.

```
webhook payload: { installation: { id, account: { login } }, sender: { login } }
  → look up users WHERE github_login = sender.login
  → upsert github_installations (org_id = user.org_id, installation_id, github_account_login)
```

If `sender.login` has no matching user (installed by someone who hasn't signed up yet),
store the installation without an `org_id` and reconcile on first sign-in. Add
`org_id` as nullable to support this.

## Data Model

New Postgres database on Railway. Migrations: numbered SQL files in `server/db/migrations/`,
run at server startup via a `migrate.ts` script using `postgres.js`.

```sql
-- 001_foundation.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE orgs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_org_login TEXT NOT NULL UNIQUE,  -- equals the owner user's github_login (1:1 for v1)
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id),
  github_id TEXT NOT NULL UNIQUE,         -- GitHub's numeric user ID (stable across renames)
  github_login TEXT NOT NULL,             -- e.g. "jsmith"
  email TEXT,                             -- may be null if user hides email on GitHub
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE github_installations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES orgs(id),        -- nullable: may arrive before user signs up
  installation_id BIGINT NOT NULL UNIQUE,
  github_account_login TEXT NOT NULL,     -- org or user the app is installed on
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_github_login ON users(github_login);
```

**DB library:** `postgres.js` (`postgres` npm package) — minimal, no ORM, raw SQL.

## Environment Variables

New:

| Var | Description |
|-----|-------------|
| `GITHUB_OAUTH_CLIENT_ID` | OAuth App client ID |
| `GITHUB_OAUTH_CLIENT_SECRET` | OAuth App client secret |
| `GITHUB_APP_INSTALL_URL` | e.g. `https://github.com/apps/your-app/installations/new` |
| `DATABASE_URL` | Railway Postgres connection string |
| `JWT_SECRET` | Random secret for signing session cookies |

Existing (unchanged):

| Var | Description |
|-----|-------------|
| `GITHUB_APP_ID` | GitHub App numeric ID |
| `GITHUB_APP_PRIVATE_KEY` | Base64-encoded PEM private key |
| `SVIX_WEBHOOK_SECRET` | Svix signing secret |
| `E2B_API_KEY` | E2B sandbox API key |
| `PORT` | HTTP port (Railway sets automatically) |
