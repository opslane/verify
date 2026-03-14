# Sandbox V2: Dev Mode + Docker Compose

**Date:** 2026-03-14
**Status:** Design

## Problem

The current sandbox approach pre-builds the customer's app at E2B template creation time (e.g., `pnpm build --filter=@formbricks/web...`). This means:

1. **The running app is always master's code**, not the PR's code. New pages, changed components, and modified API routes from the PR are invisible to the browser agent.
2. **Schema mismatches**: The compiled server code expects master's DB schema, but `prisma db push` with the PR's schema creates a mismatch that crashes the app.
3. **Complex template maintenance**: Standalone mode requires copying static/public files, managing `.env` at build time, and debugging production-only issues (standalone routing, missing traces, etc.).

We discovered all of these issues debugging formbricks end-to-end.

## Design

### Core Principle

**Templates are environments, not app builds.** The template provides OS, tools, and infrastructure. The pipeline builds/runs the actual PR code at runtime.

### Two Key Changes

#### 1. Dev Mode Instead of Production Build

Run `pnpm dev` / `npm run dev` instead of building a standalone production bundle.

**Why:**
- Tests the actual PR source code — no stale build artifacts
- Eliminates build step (saves 3-8 min and all standalone complexity)
- Schema push with PR schema is correct (dev server reads the same schema)
- How developers test locally — proven to work

**Trade-off:** Dev mode compiles pages on-demand (first page load takes 5-15s). The browser agent waits for pages anyway, so this is transparent. Dev mode behavior may differ slightly from production, but for AC verification ("does the UI work?") it's equivalent.

**Not in scope:** Production build support. Can add `build_command` later if needed.

#### 2. Docker Compose for Infrastructure

Instead of manually installing Postgres, Redis, MinIO, etc., run the customer's existing `docker-compose.dev.yml`.

**Why:**
- Most apps already have a docker-compose.dev.yml (formbricks does)
- Eliminates `detected_infra`, custom install scripts, readiness probes
- Customers don't need to tell us what services they need — it's already in their compose file
- E2B supports Docker inside sandboxes (tested and confirmed)

**Fallback:** If an app has no compose file, it must either use SQLite/in-memory storage or the user provides a compose file. We don't auto-detect infrastructure.

**Pattern:** Compose handles infra (DB, cache, storage), app runs natively for dev mode:
```
docker compose -f docker-compose.dev.yml up -d --wait  # infra (waits for healthchecks)
pnpm dev                                                # app (native, reads PR source)
```

### Template Architecture

#### Base Template (`opslane-verify-v2`)
- Ubuntu 22.04, Node 22, pnpm/yarn/bun
- Docker + Docker Compose (pre-installed)
- Playwright + Chromium
- Entrypoint: start Docker daemon, `sleep infinity`

No Postgres, Redis, or other services baked in — Docker Compose handles all of that.

#### Per-App Templates (optional, e.g., `opslane-formbricks`)
- Same base (OS, Node, Docker, Playwright)
- Clone repo + `pnpm install` (deps only, no build)
- Entrypoint: start Docker daemon, `sleep infinity`

**When to create:** When `npm install` takes >2 minutes. Otherwise use base template.
**When to rebuild:** When lockfile changes significantly (~monthly).

### Pipeline Flow

```
1. Checkout PR branch
2. Write .env (decrypted from DB)
3. docker compose up -d --wait (start infra, wait for all healthchecks)
   - If compose file has no healthchecks, fall back to 15s delay + retry on step 5
4. Install deps (always — idempotent, fast no-op if unchanged)
5. Schema push (always — idempotent, fast no-op if unchanged)
6. Seed DB (if seed_command configured)
7. Start dev server (pnpm dev / npm run dev)
8. Health check (poll until HTTP 2xx, 120s timeout)
9. Parse spec → acceptance criteria
10. Launch browser, pre-authenticate
11. Run browser agent per AC
12. Post PR comment with results
13. Destroy sandbox
```

All steps run every time. No conditionals. Idempotent by design.

**Expected timing:**
- Custom template: ~5-8 min (deps cached, compose pulls cached images)
- Base template: ~8-12 min (add 2-4 min for full install)
- Cold start penalty: first run pulls Docker images (~200MB for Postgres + Redis), add 1-3 min

### Resource Requirements

E2B sandbox must be sized for Docker daemon + compose services + Node dev server:
- **Minimum:** 8 GB RAM, 4 CPUs
- **Why:** Docker daemon ~200MB, Postgres ~100MB, Redis ~50MB, Node dev server ~500MB-2GB (monorepos), Playwright ~500MB. Plus headroom for compilation.
- Undersized VMs will OOM during `pnpm dev` compilation or when Playwright launches Chromium alongside running services.

### Repo Config (Simplified)

| Field | Required | Default | Example |
|---|---|---|---|
| `dev_command` | yes | `npm run dev` | `pnpm --filter @formbricks/web dev` |
| `port` | yes | `3000` | `3000` |
| `compose_file` | no | null | `docker-compose.dev.yml` |
| `install_command` | no | `npm install` | `pnpm install` |
| `schema_command` | no | null | `npx prisma db push --schema=... --accept-data-loss` |
| `seed_command` | no | null | `ALLOW_SEED=true pnpm --filter @formbricks/database db:seed` |
| `health_path` | no | `/` | `/auth/login` |
| `env_vars` | no | null | encrypted key-value pairs |
| `test_email` | no | null | encrypted |
| `test_password` | no | null | encrypted |
| `login_script` | no | null | Playwright login snippet |
| `sandbox_template` | no | null | `opslane-formbricks` |

**Removed:**
- `startup_command` → renamed to `dev_command` (clearer intent)
- `pre_start_script` → replaced by explicit `schema_command` + `seed_command` (less footgun-prone)
- `detected_infra` → replaced by `compose_file` (customer's existing compose file)
- `browser_auth_state` → not used (login_script handles fresh auth each run)

### Future (Not In Scope)

- **Multi-service support**: `services` array for apps with separate frontend/backend
- **LLM auto-detection**: Detect dev_command, port, schema_command from repo contents
- **docker-compose.yml ingestion**: Auto-detect compose file path
- **Production build option**: `build_command` field for customers who need it
- **Config-as-code**: `opslane.verify.yml` in repo root

## Validation

- Docker inside E2B sandbox: **tested and working** (Postgres + Redis via compose, accessible from host)
- Dev mode startup: **tested locally** (formbricks `pnpm dev` with PR checkout works correctly)
- Login script + cookie injection: **tested and working** (formbricks auth flow)
