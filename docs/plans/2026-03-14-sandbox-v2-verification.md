# Sandbox V2: Verification Plan

**Goal:** Prove the sandbox v2 design works end-to-end — Docker Compose replaces baked-in Postgres/Redis inside E2B sandboxes.

**Already proven:** Docker daemon + Docker Compose run inside E2B sandboxes (manually tested).

**What remains unproven:**
1. Updated E2B template (Docker in, Postgres/Redis out) builds and boots
2. `docker compose up -d --wait` starts services that are reachable from the host namespace
3. `setupSandbox()` works end-to-end with compose instead of baked-in infra
4. Resource sizing (8GB/4CPU) handles the full stack without OOM
5. Cold start timing is acceptable (Docker image pulls add latency)

**Design doc reference:** `docs/plans/2026-03-14-sandbox-v2-design.md`

---

## Acceptance Criteria

### AC-1: Updated E2B template builds and boots with Docker (no baked-in services)

The template Dockerfile installs Docker + Docker Compose but NOT Postgres, Redis, or any application services. The entrypoint starts the Docker daemon and nothing else. On sandbox boot, `docker info` succeeds and `which psql` / `which redis-cli` return "not found".

**Why:** The design principle is "templates are environments, not app builds." The current template violates this by baking in Postgres + Redis. Customers who need MySQL or MongoDB can't use it. Docker Compose makes infra declarative and customer-controlled.

---

### AC-2: Docker Compose starts Postgres + Redis from a compose file and services are reachable

Given a `docker-compose.dev.yml` with Postgres 16 and Redis 7 (with healthchecks), `docker compose up -d --wait` completes and both services are reachable:
- `pg_isready -h localhost -U app` exits 0
- `redis-cli ping` returns PONG

**Why:** This is the core mechanism replacing `infra-services.ts`. The `--wait` flag blocks until healthchecks pass, eliminating the custom readiness probe loop that infra-services.ts implemented.

---

### AC-3: setupSandbox() works end-to-end with compose + dev mode

The full `setupSandbox()` flow completes successfully with a real E2B sandbox:
1. `.env` file is written with decrypted secrets
2. `docker compose -f <compose_file> up -d --wait` starts infra
3. `npm install` installs deps
4. `schema_command` applies database schema
5. `seed_command` seeds test data
6. `dev_command` starts the dev server
7. Health check returns HTTP 2xx

Uses a real (simple) test app, not mocks. `setupSandbox()` returns `{ success: true }`.

**Why:** This proves the actual code we wrote works against real infrastructure. Unit tests with mocked providers don't catch issues like PTY output parsing, Docker networking, or timing-dependent health checks.

---

### AC-4: Resource sizing handles the full stack without OOM

With the sandbox sized at 8GB RAM / 4 CPUs (per design doc), the following all run simultaneously without OOM:
- Docker daemon (~200MB)
- Postgres container (~100MB)
- Redis container (~50MB)
- Node.js dev server (~500MB-2GB)
- Playwright Chromium (~500MB)

Verify: `dmesg | grep -i oom` returns empty, `free -m` shows >1GB available.

**Why:** The current template is 4GB/2CPU. Docker adds ~300MB overhead vs bare-metal Postgres/Redis. Dev server compilation (especially monorepos) is memory-hungry. Under-sizing causes silent OOM kills that are hard to debug.

---

### AC-5: Cold start timing is acceptable

Measure the time from sandbox creation to app healthy, broken down by phase:
- Docker daemon start: target <5s
- `docker compose up --wait` (image pull + start): target <60s first run, <10s cached
- `npm install`: target <120s (deps cached in custom template) or <300s (base template)
- Schema push: target <30s
- Dev server ready (first compile): target <30s

Total: target <5 min (custom template) or <8 min (base template).

**Why:** The design doc promises 5-8 min for custom templates, 8-12 min for base. We need to measure actual timing to validate these estimates. If Docker image pulls add 5+ minutes, we may need to pre-pull common images in the template.

---

## Execution Plan

### Phase 1: Update Template + Prove It Boots (AC-1)

**Step 1:** Update `server/e2b-templates/verify/Dockerfile`:
- Remove: `postgresql-common`, `postgresql-16`, `postgresql-client-16`, `redis-server`, pg_hba.conf config
- Add: Docker CE + Docker Compose plugin (via Docker's official apt repo)
- Add: `psql` client only (for schema commands — customers may use it in `schema_command`)
- Keep: Node 22, pnpm/yarn/bun, Playwright + Chromium

**Step 2:** Update `server/e2b-templates/verify/entrypoint.sh`:
```bash
#!/bin/bash
set -e
# Start Docker daemon
dockerd > /var/log/dockerd.log 2>&1 &
# Wait for Docker to be ready
until docker info > /dev/null 2>&1; do sleep 0.5; done
# Keep container alive
sleep infinity
```

**Step 3:** Update `server/e2b-templates/verify/e2b.toml`:
```toml
memory_mb = 8_192
cpu_count = 4
dockerfile = "Dockerfile"
template_name = "opslane-verify-v2"
```

**Step 4:** Build + deploy template:
```bash
cd server/e2b-templates/verify && e2b template build
```

**Step 5:** Write `server/src/verify/test-docker-sandbox.ts`:
```typescript
// Creates sandbox, runs `docker info`, asserts success
// Runs `which psql` — asserts not found (or found if we keep psql client)
// Runs `which redis-cli` — asserts not found
// Destroys sandbox
```

Run: `node --env-file=.env --import tsx/esm src/verify/test-docker-sandbox.ts`

**Milestone gate:** Template builds. `docker info` succeeds. No baked-in services.

---

### Phase 2: Prove Compose Starts Services (AC-2)

**Step 1:** Extend test script to upload a `docker-compose.dev.yml`:
```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 2s
      timeout: 5s
      retries: 10
  redis:
    image: redis:7
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 5s
      retries: 10
```

**Step 2:** Run `docker compose -f docker-compose.dev.yml up -d --wait`, time it.

**Step 3:** Assert:
- `pg_isready -h localhost -U app` exits 0
- `docker exec <redis-container> redis-cli ping` returns PONG
  (Note: `redis-cli` won't be on the host — must exec into the container or install it)

**Step 4:** Run `docker compose down`, destroy sandbox.

**Milestone gate:** Both services reachable. Record pull + start time.

---

### Phase 3: Prove setupSandbox() End-to-End (AC-3 + AC-4 + AC-5)

**Step 1:** Create a minimal test app repo (or use a public one) with:
- `package.json` with a `dev` script that starts an HTTP server
- `docker-compose.dev.yml` with Postgres
- A Prisma schema (or raw SQL schema command)
- A simple Express/Hono server that connects to Postgres and returns 200

**Step 2:** Write `server/src/verify/test-setup-sandbox.ts` that:
1. Creates a sandbox with the updated template
2. Clones the test app
3. Constructs a `RepoConfig`:
   ```typescript
   {
     dev_command: 'npm run dev',
     port: 3000,
     compose_file: 'docker-compose.dev.yml',
     schema_command: 'npx prisma db push --accept-data-loss',
     install_command: 'npm install',
     health_path: '/',
     // ... other fields null
   }
   ```
4. Calls `setupSandbox(provider, sandboxId, config, log)`
5. Asserts `{ success: true }`
6. Runs `free -m` and `dmesg | grep -i oom` to verify resource headroom
7. Logs timing for each phase
8. Destroys sandbox

**Step 3:** Record actual timing breakdown and compare to design doc estimates.

**Milestone gate:** `setupSandbox()` returns `{ success: true }`. No OOM. Timing within design doc targets.

---

## Timing Measurement

Each phase should log timestamps so we can measure:

```
[00:00] Sandbox created
[00:02] Docker daemon ready
[00:03] docker compose up started
[00:45] docker compose services ready (first run — image pull)
[00:48] npm install started
[02:30] npm install complete
[02:32] schema push complete
[02:33] dev server started
[02:48] health check passed (first compile)
[02:48] TOTAL: 2m 48s
```

---

## What We're NOT Testing

- **Formbricks specifically** — follow-up after foundation is proven
- **Per-app custom templates** — base template first
- **Login script execution** — `login_script` field scaffolded, not wired
- **Production build mode** — out of scope per design doc
- **Browser agent + AC verification** — that's the existing pipeline, unchanged
