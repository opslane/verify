# Deterministic Route Resolver — Implementation Plan (v2)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the flaky LLM-based route resolver (3/65 routes, Haiku) with a deterministic resolver that maps parameterized routes to concrete URLs via DB queries (56/65 routes, 1.6s, no LLM).

**Architecture:** A new `resolveExampleUrls` function in `pipeline/src/lib/route-resolver.ts` takes the route list, data model schema, a psql connection string, and auth user context. It resolves `:paramName` segments by matching them to DB columns using naming conventions, then queries the DB for real values scoped to the test user's team. Called from `index-app` in cli.ts, replacing the current Haiku LLM call.

**Tech Stack:** TypeScript, psql via `execSync`, vitest

**Spike evidence:** Spike 7a resolved 56/65 routes (86%) in 1.6s. The 9 unresolved routes all have empty tables (ephemeral tokens). Current LLM approach: 3/65 (5%).

**Review fixes incorporated (v1 → v2):**
- `psqlQuery` uses `execSync` (not `execFileSync` with broken string splitting) — matches `dumpSeedData` pattern
- Dead cache removed from `resolveExampleUrls`
- Task 2 uses `psqlQuery` helper from route-resolver.ts instead of inline `execSync`
- `dbUrlEnv`/`cleanDbUrl` hoisted — computed once, not twice
- `folderId` restores folder type awareness from spike
- Task 3 merged into Task 2

---

## Task 1: Create `resolveExampleUrls` function with tests

**Files:**
- Create: `pipeline/src/lib/route-resolver.ts`
- Create: `pipeline/test/route-resolver.test.ts`

**Step 1: Write the failing tests**

Create `pipeline/test/route-resolver.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveParam, resolveExampleUrls, psqlQuery } from "../src/lib/route-resolver.js";

// Mock execSync to avoid real DB calls in unit tests
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execSync: vi.fn() };
});

import { execSync } from "node:child_process";
const mockExec = vi.mocked(execSync);

describe("psqlQuery", () => {
  beforeEach(() => { mockExec.mockReset(); });

  it("returns trimmed result on success", () => {
    mockExec.mockReturnValueOnce("org_xyz\n");
    const result = psqlQuery("psql connstr", "SELECT 1");
    expect(result).toBe("org_xyz");
  });

  it("returns empty string on failure", () => {
    mockExec.mockImplementationOnce(() => { throw new Error("connection refused"); });
    const result = psqlQuery("psql connstr", "SELECT 1");
    expect(result).toBe("");
  });
});

describe("resolveParam", () => {
  beforeEach(() => { mockExec.mockReset(); });

  it("resolves teamUrl from provided context", () => {
    const result = resolveParam("teamUrl", "/t/:teamUrl/settings", "psql connstr", {
      userId: "9", teamId: "7", teamUrl: "personal_abc",
    }, {});
    expect(result).toBe("personal_abc");
  });

  it("resolves orgUrl via DB query", () => {
    mockExec.mockReturnValueOnce("org_xyz\n");
    const result = resolveParam("orgUrl", "/o/:orgUrl/settings", "psql connstr", {
      userId: "9", teamId: "7", teamUrl: "personal_abc",
    }, {});
    expect(result).toBe("org_xyz");
  });

  it("resolves id from parent path segment context", () => {
    mockExec.mockReturnValueOnce("42\n");
    const result = resolveParam("id", "/t/:teamUrl/documents/:id", "psql connstr", {
      userId: "9", teamId: "7", teamUrl: "personal_abc",
    }, { Envelope: { table_name: "Envelope", columns: { id: "id", teamId: "teamId" }, enums: {}, source: "", manual_id_columns: [] } });
    expect(result).toBe("42");
  });

  it("returns null when DB query returns empty", () => {
    mockExec.mockReturnValueOnce("\n");
    const result = resolveParam("orgUrl", "/o/:orgUrl/settings", "psql connstr", {
      userId: "9", teamId: "7", teamUrl: "personal_abc",
    }, {});
    expect(result).toBeNull();
  });
});

describe("resolveExampleUrls", () => {
  beforeEach(() => { mockExec.mockReset(); });

  it("resolves routes with known params", () => {
    const routes = { "/t/:teamUrl/settings": { component: "Settings" } };
    const result = resolveExampleUrls(
      routes, {}, "psql connstr",
      { userId: "9", teamId: "7", teamUrl: "personal_abc" },
    );
    expect(result["/t/:teamUrl/settings"]).toBe("/t/personal_abc/settings");
  });

  it("skips routes where params cannot be resolved", () => {
    mockExec.mockReturnValue("\n");
    const routes = { "/share/:slug": { component: "Share" } };
    const result = resolveExampleUrls(
      routes, {}, "psql connstr",
      { userId: "9", teamId: "7", teamUrl: "personal_abc" },
    );
    expect(result["/share/:slug"]).toBeUndefined();
  });

  it("returns empty object when no parameterized routes", () => {
    const routes = { "/settings": { component: "Settings" }, "/dashboard": { component: "Dashboard" } };
    const result = resolveExampleUrls(
      routes, {}, "psql connstr",
      { userId: "9", teamId: "7", teamUrl: "personal_abc" },
    );
    expect(result).toEqual({});
  });

  it("resolves multi-param routes only when all params resolve", () => {
    // teamUrl resolves from context, id resolves from DB
    mockExec.mockReturnValueOnce("42\n");
    const routes = { "/t/:teamUrl/documents/:id/edit": { component: "Edit" } };
    const result = resolveExampleUrls(
      routes,
      { Envelope: { table_name: "Envelope", columns: { id: "id", teamId: "teamId" }, enums: {}, source: "", manual_id_columns: [] } },
      "psql connstr",
      { userId: "9", teamId: "7", teamUrl: "personal_abc" },
    );
    expect(result["/t/:teamUrl/documents/:id/edit"]).toBe("/t/personal_abc/documents/42/edit");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd pipeline && npx vitest run test/route-resolver.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `pipeline/src/lib/route-resolver.ts`:

```typescript
// pipeline/src/lib/route-resolver.ts — Deterministic route param resolver
import { execSync } from "node:child_process";
import type { AppIndex } from "./types.js";

export interface RouteResolverContext {
  userId: string;
  teamId: string;
  teamUrl: string;
}

/**
 * Query the DB via psql. Returns trimmed result or empty string on failure.
 * Uses execSync with shell (matches dumpSeedData pattern in index-app.ts).
 */
export function psqlQuery(psqlCmd: string, query: string): string {
  try {
    return (execSync(
      `${psqlCmd} -t -A -c ${JSON.stringify(query)}`,
      { timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ) as string).trim();
  } catch {
    return "";
  }
}

/** Get the path segment immediately before a :param */
function parentSegment(route: string, paramName: string): string | null {
  const parts = route.split("/");
  const idx = parts.indexOf(`:${paramName}`);
  if (idx <= 0) return null;
  const prev = parts[idx - 1];
  return prev.startsWith(":") ? null : prev;
}

/**
 * Resolve a single :paramName to a concrete value.
 * Uses naming conventions + DB queries scoped to the auth user's team.
 */
export function resolveParam(
  paramName: string,
  route: string,
  psqlCmd: string,
  ctx: RouteResolverContext,
  dataModel: AppIndex["data_model"],
): string | null {
  // ── Known params from context ──
  if (paramName === "teamUrl") return ctx.teamUrl;

  if (paramName === "orgUrl") {
    const val = psqlQuery(psqlCmd,
      `SELECT o.url FROM "Organisation" o JOIN "OrganisationMember" om ON om."organisationId" = o.id WHERE om."userId" = ${ctx.userId} LIMIT 1`);
    return val || null;
  }

  // ── :id — context-dependent ──
  if (paramName === "id") return resolveId(route, psqlCmd, ctx);

  // ── :token — context-dependent ──
  if (paramName === "token") return resolveToken(route, psqlCmd, ctx);

  // ── :folderId — folder type depends on route context ──
  if (paramName === "folderId") {
    const folderType = route.includes("/templates/") ? "TEMPLATE" : "DOCUMENT";
    const val = psqlQuery(psqlCmd, `SELECT id FROM "Folder" WHERE "teamId" = ${ctx.teamId} AND type = '${folderType}' LIMIT 1`);
    if (val) return val;
    // Fallback: any folder for this team
    return psqlQuery(psqlCmd, `SELECT id FROM "Folder" WHERE "teamId" = ${ctx.teamId} LIMIT 1`) || null;
  }

  // ── :slug ──
  if (paramName === "slug") {
    return psqlQuery(psqlCmd,
      `SELECT dsl.slug FROM "DocumentShareLink" dsl JOIN "Envelope" e ON e.id = dsl."envelopeId" WHERE e."teamId" = ${ctx.teamId} LIMIT 1`) || null;
  }

  // ── :url (public profile /p/:url) ──
  if (paramName === "url" && route.startsWith("/p/")) {
    return psqlQuery(psqlCmd,
      `SELECT t.url FROM "Team" t JOIN "TeamProfile" tp ON tp."teamId" = t.id WHERE tp.enabled = true LIMIT 1`) || ctx.teamUrl;
  }

  // ── Generic fallback: search schema for matching column ──
  for (const [_modelName, info] of Object.entries(dataModel)) {
    if (paramName in info.columns) {
      const val = psqlQuery(psqlCmd, `SELECT "${info.columns[paramName]}" FROM "${info.table_name}" LIMIT 1`);
      if (val) return val;
    }
  }

  return null;
}

function resolveId(route: string, psqlCmd: string, ctx: RouteResolverContext): string | null {
  const parent = parentSegment(route, "id");
  const segments = route.split("/").filter(p => p && !p.startsWith(":")).join("/");

  // Map parent path segments to tables + scoping
  const segmentToTable: Record<string, { table: string; scope: string }> = {
    documents:               { table: "Envelope", scope: `"teamId" = ${ctx.teamId} AND type = 'DOCUMENT'` },
    templates:               { table: "Envelope", scope: `"teamId" = ${ctx.teamId} AND type = 'TEMPLATE'` },
    webhooks:                { table: "Webhook", scope: `"teamId" = ${ctx.teamId}` },
    "email-domains":         { table: "EmailDomain", scope: `1=1` },
    groups:                  { table: "OrganisationGroup", scope: `1=1` },
    users:                   { table: "User", scope: `1=1` },
    organisations:           { table: "Organisation", scope: `1=1` },
    "organisation-insights": { table: "Organisation", scope: `1=1` },
    "unsealed-documents":    { table: "Envelope", scope: `1=1` },
  };

  // Try parent segment first
  if (parent && segmentToTable[parent]) {
    const { table, scope } = segmentToTable[parent];
    const val = psqlQuery(psqlCmd, `SELECT id FROM "${table}" WHERE ${scope} LIMIT 1`);
    if (val) return val;
  }

  // Try context-based matching (for nested routes like /admin/documents/:id)
  for (const [seg, { table, scope }] of Object.entries(segmentToTable)) {
    if (segments.includes(seg)) {
      const val = psqlQuery(psqlCmd, `SELECT id FROM "${table}" WHERE ${scope} LIMIT 1`);
      if (val) return val;
    }
  }

  // Embed routes
  if (segments.includes("authoring/document") || segments.includes("authoring/envelope")) {
    const val = psqlQuery(psqlCmd, `SELECT id FROM "Envelope" WHERE "teamId" = ${ctx.teamId} LIMIT 1`);
    if (val) return val;
  }
  if (segments.includes("authoring/template")) {
    const val = psqlQuery(psqlCmd, `SELECT id FROM "Envelope" WHERE "teamId" = ${ctx.teamId} AND type = 'TEMPLATE' LIMIT 1`);
    if (val) return val;
  }

  // Ultimate fallback: any envelope for the team
  return psqlQuery(psqlCmd, `SELECT id FROM "Envelope" WHERE "teamId" = ${ctx.teamId} LIMIT 1`) || null;
}

function resolveToken(route: string, psqlCmd: string, ctx: RouteResolverContext): string | null {
  // /d/:token or /sign/:token — recipient token
  if (route.startsWith("/d/") || route.startsWith("/sign/") || route.includes("/sign/")) {
    return psqlQuery(psqlCmd,
      `SELECT r.token FROM "Recipient" r JOIN "Envelope" e ON e.id = r."envelopeId" WHERE e."teamId" = ${ctx.teamId} LIMIT 1`) || null;
  }

  // /embed/v0/direct/:token
  if (route.includes("direct")) {
    return psqlQuery(psqlCmd,
      `SELECT tdl.token FROM "TemplateDirectLink" tdl JOIN "Envelope" e ON e.id = tdl."envelopeId" WHERE e."teamId" = ${ctx.teamId} LIMIT 1`) || null;
  }

  // /reset-password/:token
  if (route.includes("reset-password")) {
    return psqlQuery(psqlCmd, `SELECT token FROM "PasswordResetToken" WHERE "userId" = ${ctx.userId} LIMIT 1`) || null;
  }

  // /organisation/invite/:token or /organisation/decline/:token
  if (route.includes("organisation/invite") || route.includes("organisation/decline")) {
    return psqlQuery(psqlCmd,
      `SELECT omi.token FROM "OrganisationMemberInvite" omi JOIN "Organisation" o ON o.id = omi."organisationId" JOIN "OrganisationMember" om ON om."organisationId" = o.id WHERE om."userId" = ${ctx.userId} LIMIT 1`) || null;
  }

  // /verify-email/:token
  if (route.includes("verify-email") && !route.includes("team")) {
    return psqlQuery(psqlCmd, `SELECT token FROM "VerificationToken" WHERE "userId" = ${ctx.userId} LIMIT 1`) || null;
  }

  // /team/verify-email/:token
  if (route.includes("team/verify-email")) {
    return psqlQuery(psqlCmd, `SELECT token FROM "TeamEmailVerification" WHERE "teamId" = ${ctx.teamId} LIMIT 1`) || null;
  }

  return null;
}

/**
 * Resolve all parameterized routes to concrete example URLs.
 * Returns a map of route pattern → concrete URL for successfully resolved routes.
 */
export function resolveExampleUrls(
  routes: AppIndex["routes"],
  dataModel: AppIndex["data_model"],
  psqlCmd: string,
  ctx: RouteResolverContext,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const route of Object.keys(routes)) {
    const params = route.match(/:([a-zA-Z]+)/g)?.map(p => p.slice(1));
    if (!params || params.length === 0) continue;

    let resolved = route;
    let allResolved = true;

    for (const param of params) {
      const value = resolveParam(param, route, psqlCmd, ctx, dataModel);
      if (value) {
        resolved = resolved.replace(`:${param}`, value);
      } else {
        allResolved = false;
        break;
      }
    }

    if (allResolved) {
      result[route] = resolved;
    }
  }

  return result;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd pipeline && npx vitest run test/route-resolver.test.ts`
Expected: PASS

**Step 5: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: PASS

**Step 6: Commit**

```bash
git add pipeline/src/lib/route-resolver.ts pipeline/test/route-resolver.test.ts
git commit -m "feat(route-resolver): deterministic param resolver with DB queries"
```

---

## Task 2: Wire into `index-app`, replacing the LLM resolver, and verify

**Files:**
- Modify: `pipeline/src/cli.ts:204-247` (replace LLM resolver with deterministic one)
- Modify: `pipeline/src/cli.ts` (imports)

**Step 1: Update imports**

At the top of `pipeline/src/cli.ts`, add the import for the new resolver:

```typescript
import { resolveExampleUrls, psqlQuery } from "./lib/route-resolver.js";
import type { RouteResolverContext } from "./lib/route-resolver.js";
```

**Step 2: Replace the LLM resolver block**

In `pipeline/src/cli.ts`, replace lines 204-247 (the entire Step 3.5 block) with:

```typescript
  // Step 3.5: Route resolver — map parameterized routes to concrete URLs deterministically
  const paramRoutes = Object.keys(appIndex.routes).filter(r => r.includes(":"));
  if (paramRoutes.length > 0) {
    console.log(`  Resolving ${paramRoutes.length} parameterized routes...`);

    // Build psql connection string (reuse projectEnvForDump already computed above)
    const dbUrlEnv = appIndex.db_url_env ?? "DATABASE_URL";
    const dbUrl = (projectEnvForDump[dbUrlEnv] ?? projectEnvForDump.DATABASE_URL ?? "") as string;
    const cleanDbUrl = dbUrl.split("?")[0];
    const psqlCmd = cleanDbUrl ? `psql "${cleanDbUrl}"` : "";

    // Resolve auth user context for scoping
    let resolverCtx: RouteResolverContext | null = null;
    if (psqlCmd) {
      const config = loadConfig(join(projectDir, ".verify"));
      if (config.auth?.email) {
        // Postgres single-quote escaping for email
        const escapedEmail = config.auth.email.replace(/'/g, "''");
        const userId = psqlQuery(psqlCmd, `SELECT id FROM "User" WHERE email = '${escapedEmail}' LIMIT 1`);

        if (userId) {
          const teamRow = psqlQuery(psqlCmd,
            `SELECT t.id || '|' || t.url FROM "Team" t JOIN "Organisation" o ON o.id = t."organisationId" JOIN "OrganisationMember" om ON om."organisationId" = o.id WHERE om."userId" = ${userId} AND t.url LIKE 'personal_%' LIMIT 1`);

          if (teamRow) {
            const [teamId, teamUrl] = teamRow.split("|");
            resolverCtx = { userId, teamId, teamUrl };
          }
        }
      }
    }

    if (resolverCtx) {
      const exampleUrls = resolveExampleUrls(appIndex.routes, appIndex.data_model, psqlCmd, resolverCtx);
      appIndex.example_urls = exampleUrls;
      console.log(`  Resolved ${Object.keys(exampleUrls).length}/${paramRoutes.length} example URLs (deterministic)`);
    } else {
      console.log("  Warning: could not resolve auth user context — skipping route resolution");
    }
  }
```

Note: This uses `psqlQuery` from `route-resolver.ts` for the user/team lookup — no inline `execSync` calls, no duplicated logic. The `dbUrlEnv` and `cleanDbUrl` are computed once at the top.

**Step 3: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: PASS

**Step 4: Run all tests**

Run: `cd pipeline && npx vitest run`
Expected: PASS — all tests pass

**Step 5: Integration test against Documenso**

Run the `index-app` command against Documenso to verify the resolver works end-to-end:

```bash
cd pipeline && npx tsx src/cli.ts index-app \
  --project-dir /Users/abhishekray/Projects/opslane/evals/documenso \
  --output /tmp/test-app-index.json
```

Then check coverage:

```bash
python3 -c "
import json
d = json.load(open('/tmp/test-app-index.json'))
eu = d.get('example_urls', {})
routes = d.get('routes', {})
param = [r for r in routes if ':' in r]
print(f'example_urls: {len(eu)}/{len(param)} parameterized routes resolved')
print(f'Coverage: {len(eu)/len(param)*100:.0f}%')
"
```

Expected: 50+ routes resolved (86%+ coverage), up from 3.

**Step 6: Commit**

```bash
git add pipeline/src/cli.ts
git commit -m "feat(index-app): replace LLM route resolver with deterministic resolver"
```

---

## Summary of changes

| File | Change |
|------|--------|
| `pipeline/src/lib/route-resolver.ts` | New module: `psqlQuery`, `resolveParam`, `resolveExampleUrls` — deterministic route resolver using `execSync` |
| `pipeline/test/route-resolver.test.ts` | Unit tests: psqlQuery, resolveParam (teamUrl, orgUrl, id, null), resolveExampleUrls (known params, unresolvable, empty, multi-param) |
| `pipeline/src/cli.ts` | Replace LLM resolver block with deterministic resolver; use `psqlQuery` for user context resolution |

**Total: ~180 lines of production code (route-resolver.ts), ~80 lines of tests.**

**What's removed:** The Haiku LLM call, 16KB seed data truncation, route-resolver.txt prompt template dependency (file kept but unused).

**What's fixed from v1:** `execSync` instead of broken `execFileSync`, dead cache removed, `psqlQuery` reused in cli.ts, `dbUrlEnv`/`cleanDbUrl` computed once, `folderId` type awareness restored.
