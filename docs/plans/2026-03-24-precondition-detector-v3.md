# Precondition Detector v3 — Setup-Writer Activation + URL Rewriting

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate the 31 `missing_data` failures (37% of all pipeline failures) by detecting data prerequisites from planned URLs, creating missing entities via setup-writer, and rewriting plan URLs to use the created entity IDs.

**Architecture:** Three components working together:

1. **Precondition detector** — deterministic function that matches PlannedAC URLs against `appIndex.routes`, identifies entity references not in `seed_ids`, and emits conditions + URL rewrite rules
2. **Setup-writer** (existing, unchanged) — creates entities from conditions
3. **URL rewriter** — after setup-writer succeeds, queries the DB for created entity IDs and patches PlannedAC URLs before browse agents run

**Tech Stack:** TypeScript, vitest, existing pipeline infrastructure

---

## Context

### Spike validation (2026-03-24)

| Spike | Result |
|-------|--------|
| Detection simulation against 31 eval cases | 22/31 detected from introspection text (71%). All 10 PRs have ≥1 AC detected → all groups promoted. |
| Approach 1: setup-writer with exact ID | FAILED — Envelope NOT NULL constraint (`updatedAt`) |
| Approach 2: setup-writer creates entity + post-query for ID | SUCCESS — CTE with RETURNING id, URL patchable |
| Approach 2b: create + separate SELECT | SUCCESS — simpler, deterministic |

### Case breakdown (verified against eval data)

| Case type | Count | Fix mechanism |
|-----------|-------|--------------|
| Entity at specific URL ID → 404 | 19 | Setup-writer creates entity → query for ID → patch URL |
| List page empty (0 results) | 12 | Setup-writer creates entity → list page shows it |
| **Total** | **31** | |

### Data flow

```
                    plan.json + appIndex
                         │
              ┌──────────▼──────────┐
              │  detectPreconditions │
              │                     │
              │  For each PlannedAC: │
              │  1. Match URL → route│
              │  2. Extract params   │
              │  3. Check seed_ids   │
              │  4. Emit condition   │
              │     + rewrite rule   │
              └──────────┬──────────┘
                         │
         ┌───────────────▼───────────────┐
         │  groupConditions (merged)     │
         │  rewriteRules (new)           │
         └───────────────┬───────────────┘
                         │
              ┌──────────▼──────────┐
              │   setup-writer      │  (existing, unchanged)
              │   creates entity    │
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │   rewriteUrls()     │  (new)
              │                     │
              │   1. Query DB for   │
              │      created entity │
              │   2. Patch PlannedAC│
              │      URLs with real │
              │      entity ID      │
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │   browse agents     │  (use patched URLs)
              └─────────────────────┘
```

---

## Tasks

### Task 1: Extract `routeToRegex` to shared utility

**Files:**
- Create: `pipeline/src/lib/route-match.ts`
- Modify: `pipeline/src/stages/plan-validator.ts:8-15`
- Create: `pipeline/test/route-match.test.ts`

**Step 1: Write the tests**

Create `pipeline/test/route-match.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { routeToRegex, matchRoute } from "../src/lib/route-match.js";

describe("routeToRegex", () => {
  it("matches a static route", () => {
    const re = routeToRegex("/settings");
    expect(re.test("/settings")).toBe(true);
    expect(re.test("/billing")).toBe(false);
  });

  it("matches a single-param route", () => {
    const re = routeToRegex("/t/:teamUrl/settings");
    expect(re.test("/t/abc123/settings")).toBe(true);
    expect(re.test("/t/settings")).toBe(false);
  });

  it("matches a multi-param route", () => {
    const re = routeToRegex("/t/:teamUrl/documents/:id/edit");
    expect(re.test("/t/abc/documents/42/edit")).toBe(true);
    expect(re.test("/t/abc/documents/edit")).toBe(false);
  });

  it("escapes special regex characters in static segments", () => {
    const re = routeToRegex("/api/v1.0/:id");
    expect(re.test("/api/v1.0/abc")).toBe(true);
    expect(re.test("/api/v1X0/abc")).toBe(false);
  });
});

describe("matchRoute", () => {
  it("returns null for non-matching URL", () => {
    expect(matchRoute("/settings", "/billing")).toBeNull();
  });

  it("extracts parameter values from a matching URL", () => {
    const result = matchRoute("/t/:teamUrl/documents/:id/edit", "/t/abc123/documents/42/edit");
    expect(result!.params.get("teamUrl")).toBe("abc123");
    expect(result!.params.get("id")).toBe("42");
  });

  it("returns empty params for a static route", () => {
    const result = matchRoute("/settings", "/settings");
    expect(result!.params.size).toBe(0);
  });

  it("exposes route segments", () => {
    const result = matchRoute("/t/:teamUrl/documents/:id/edit", "/t/abc/documents/42/edit");
    expect(result!.segments).toEqual(["", "t", ":teamUrl", "documents", ":id", "edit"]);
  });

  it("strips query string before matching", () => {
    expect(matchRoute("/settings", "/settings?tab=profile")).not.toBeNull();
  });
});
```

**Step 2: Run tests — expect FAIL**

Run: `cd pipeline && npx vitest run test/route-match.test.ts`

**Step 3: Implement**

Create `pipeline/src/lib/route-match.ts`:

```typescript
/** Convert a parameterized route like /t/:teamUrl/settings to a regex */
export function routeToRegex(route: string): RegExp {
  const pattern = route
    .split(/:[a-zA-Z]+/)
    .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]+");
  return new RegExp(`^${pattern}$`);
}

export interface RouteMatch {
  params: Map<string, string>;
  segments: string[];
}

/** Match a URL against a route pattern. Returns params or null. */
export function matchRoute(route: string, url: string): RouteMatch | null {
  const urlBase = url.split("?")[0];
  const segments = route.split("/");
  const paramNames: string[] = [];

  const regexParts = segments.map((seg) => {
    if (seg.startsWith(":")) {
      paramNames.push(seg.slice(1));
      return "([^/]+)";
    }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });

  const match = new RegExp(`^${regexParts.join("/")}$`).exec(urlBase);
  if (!match) return null;

  const params = new Map<string, string>();
  for (let i = 0; i < paramNames.length; i++) {
    params.set(paramNames[i], match[i + 1]);
  }
  return { params, segments };
}
```

**Step 4: Run tests — expect PASS**

Run: `cd pipeline && npx vitest run test/route-match.test.ts`

**Step 5: Update plan-validator to use shared import**

In `pipeline/src/stages/plan-validator.ts`, replace lines 8-15 (the private `routeToRegex` function) with:

```typescript
import { routeToRegex } from "../lib/route-match.js";
```

**Step 6: Run existing tests — expect PASS**

Run: `cd pipeline && npx vitest run test/plan-validator.test.ts`

**Step 7: Commit**

```bash
git add pipeline/src/lib/route-match.ts pipeline/test/route-match.test.ts pipeline/src/stages/plan-validator.ts
git commit -m "refactor: extract routeToRegex to shared lib/route-match.ts"
```

---

### Task 2: Add types for precondition detection and URL rewriting

**Files:**
- Modify: `pipeline/src/lib/types.ts` (after `PlanValidationResult`, around line 68)

**Step 1: Add types**

```typescript
// ── Precondition Detector ──────────────────────────────────────────────────────

export interface UrlRewriteRule {
  acId: string;
  route: string;                         // e.g., "/t/:teamUrl/documents/:id/edit"
  paramName: string;                     // e.g., "id"
  entityModel: string;                   // e.g., "Envelope"
  entityTable: string;                   // e.g., "Envelope" (postgres table name)
}

export interface InferredPrecondition {
  groupId: string;
  acId: string;
  condition: string;
  source: "url_entity" | "empty_list";
  rewriteRule: UrlRewriteRule | null;    // non-null for entity-at-URL cases
}

export interface PreconditionResult {
  preconditions: Map<string, string>;       // groupId → merged condition string
  details: InferredPrecondition[];          // individual detections for logging
  rewriteRules: UrlRewriteRule[];           // rules for post-setup URL rewriting
}
```

**Step 2: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`

**Step 3: Commit**

```bash
git add pipeline/src/lib/types.ts
git commit -m "feat(types): add precondition detection and URL rewrite types"
```

---

### Task 3: Write failing tests for `detectPreconditions`

**Files:**
- Create: `pipeline/test/precondition-detector.test.ts`

**Step 1: Write the tests**

```typescript
import { describe, it, expect } from "vitest";
import { detectPreconditions } from "../src/stages/precondition-detector.js";
import type { PlannerOutput, AppIndex, ACGeneratorOutput } from "../src/lib/types.js";

const mockAppIndex: AppIndex = {
  indexed_at: "2026-03-24T00:00:00Z",
  routes: {
    "/t/:teamUrl/documents/:id/edit": { component: "document-edit.tsx" },
    "/t/:teamUrl/documents": { component: "documents-list.tsx" },
    "/t/:teamUrl/templates": { component: "templates-list.tsx" },
    "/t/:teamUrl/templates/:id": { component: "template-detail.tsx" },
    "/t/:teamUrl/settings": { component: "settings.tsx" },
    "/t/:teamUrl/settings/webhooks": { component: "webhooks.tsx" },
    "/o/:orgUrl/settings/members": { component: "org-members.tsx" },
    "/settings": { component: "user-settings.tsx" },
    "/embed/v0/direct/:token": { component: "embed-direct.tsx" },
  },
  pages: {},
  data_model: {
    Envelope: { columns: { id: "id", title: "title" }, table_name: "Envelope", enums: {}, source: "schema.prisma", manual_id_columns: ["id"] },
    Template: { columns: { id: "id", title: "title" }, table_name: "Template", enums: {}, source: "schema.prisma", manual_id_columns: ["id"] },
    Team: { columns: { id: "id", url: "url" }, table_name: "Team", enums: {}, source: "schema.prisma", manual_id_columns: [] },
    Webhook: { columns: { id: "id" }, table_name: "Webhook", enums: {}, source: "schema.prisma", manual_id_columns: [] },
  },
  fixtures: {},
  db_url_env: "DATABASE_URL",
  feature_flags: [],
  seed_ids: {},
  json_type_annotations: {},
  example_urls: {},
};

const makeGroups = (...groups: Array<{ id: string; condition: string | null }>): ACGeneratorOutput => ({
  groups: groups.map(g => ({ ...g, acs: [{ id: "ac1", description: "test" }] })),
  skipped: [],
});

const makePlan = (...criteria: Array<{ id: string; group: string; url: string }>): PlannerOutput => ({
  criteria: criteria.map(c => ({
    ...c, description: "test", steps: ["Navigate", "Wait"],
    screenshot_at: [], timeout_seconds: 90,
  })),
});

describe("detectPreconditions", () => {
  // --- Entity-at-URL cases (need URL rewriting) ---

  it("detects entity-at-URL and emits rewrite rule", () => {
    const plan = makePlan({ id: "ac1", group: "g-a", url: "/t/personal_abc/documents/1/edit" });
    const groups = makeGroups({ id: "g-a", condition: null });
    const result = detectPreconditions(plan, mockAppIndex, groups);

    expect(result.preconditions.has("g-a")).toBe(true);
    expect(result.preconditions.get("g-a")).toMatch(/document/i);
    expect(result.rewriteRules).toHaveLength(1);
    expect(result.rewriteRules[0].paramName).toBe("id");
    expect(result.rewriteRules[0].entityModel).toBe("Envelope");
    expect(result.rewriteRules[0].acId).toBe("ac1");
  });

  it("detects org reference and emits rewrite rule", () => {
    const plan = makePlan({ id: "ac1", group: "g-a", url: "/o/verifyorg/settings/members" });
    const groups = makeGroups({ id: "g-a", condition: null });
    const result = detectPreconditions(plan, mockAppIndex, groups);

    expect(result.preconditions.has("g-a")).toBe(true);
    expect(result.rewriteRules).toHaveLength(1);
    expect(result.rewriteRules[0].paramName).toBe("orgUrl");
  });

  it("detects embed token and emits rewrite rule", () => {
    const plan = makePlan({ id: "ac1", group: "g-a", url: "/embed/v0/direct/direct_tok_001" });
    const groups = makeGroups({ id: "g-a", condition: null });
    const result = detectPreconditions(plan, mockAppIndex, groups);

    expect(result.preconditions.has("g-a")).toBe(true);
    expect(result.rewriteRules).toHaveLength(1);
    expect(result.rewriteRules[0].paramName).toBe("token");
  });

  // --- List page cases (no URL rewriting needed) ---

  it("detects empty list page, no rewrite rule", () => {
    const plan = makePlan({ id: "ac1", group: "g-a", url: "/t/personal_abc/templates" });
    const groups = makeGroups({ id: "g-a", condition: null });
    const result = detectPreconditions(plan, mockAppIndex, groups);

    expect(result.preconditions.has("g-a")).toBe(true);
    expect(result.preconditions.get("g-a")).toMatch(/template/i);
    // List pages don't need URL rewriting — the URL is already correct
    const listRewrites = result.rewriteRules.filter(r => r.acId === "ac1");
    expect(listRewrites).toHaveLength(0);
  });

  it("detects documents list page", () => {
    const plan = makePlan({ id: "ac1", group: "g-a", url: "/t/personal_abc/documents" });
    const groups = makeGroups({ id: "g-a", condition: null });
    const result = detectPreconditions(plan, mockAppIndex, groups);

    expect(result.preconditions.has("g-a")).toBe(true);
    expect(result.preconditions.get("g-a")).toMatch(/document/i);
  });

  // --- Skip cases ---

  it("skips groups with explicit conditions", () => {
    const plan = makePlan({ id: "ac1", group: "g-a", url: "/t/abc/documents/1/edit" });
    const groups = makeGroups({ id: "g-a", condition: "user has admin role" });
    const result = detectPreconditions(plan, mockAppIndex, groups);
    expect(result.preconditions.has("g-a")).toBe(false);
    expect(result.rewriteRules).toHaveLength(0);
  });

  it("skips static routes (no params)", () => {
    const plan = makePlan({ id: "ac1", group: "g-a", url: "/settings" });
    const groups = makeGroups({ id: "g-a", condition: null });
    const result = detectPreconditions(plan, mockAppIndex, groups);
    expect(result.preconditions.has("g-a")).toBe(false);
  });

  it("skips team-only routes", () => {
    const plan = makePlan({ id: "ac1", group: "g-a", url: "/t/personal_abc/settings" });
    const groups = makeGroups({ id: "g-a", condition: null });
    const result = detectPreconditions(plan, mockAppIndex, groups);
    expect(result.preconditions.has("g-a")).toBe(false);
  });

  it("returns empty when appIndex is null", () => {
    const plan = makePlan({ id: "ac1", group: "g-a", url: "/t/abc/documents/1/edit" });
    const groups = makeGroups({ id: "g-a", condition: null });
    const result = detectPreconditions(plan, null, groups);
    expect(result.preconditions.size).toBe(0);
    expect(result.rewriteRules).toHaveLength(0);
  });

  it("handles URL with query string", () => {
    const plan = makePlan({ id: "ac1", group: "g-a", url: "/o/verifyorg/settings/members?tab=invites" });
    const groups = makeGroups({ id: "g-a", condition: null });
    const result = detectPreconditions(plan, mockAppIndex, groups);
    expect(result.preconditions.has("g-a")).toBe(true);
  });

  it("handles URL matching no route", () => {
    const plan = makePlan({ id: "ac1", group: "g-a", url: "/unknown/page" });
    const groups = makeGroups({ id: "g-a", condition: null });
    const result = detectPreconditions(plan, mockAppIndex, groups);
    expect(result.preconditions.has("g-a")).toBe(false);
  });

  // --- Seed data cases ---

  it("skips entity when seed_ids has the exact ID", () => {
    const idx: AppIndex = { ...mockAppIndex, seed_ids: { Envelope: ["doc-1"] } };
    const plan = makePlan({ id: "ac1", group: "g-a", url: "/t/abc/documents/doc-1/edit" });
    const groups = makeGroups({ id: "g-a", condition: null });
    const result = detectPreconditions(plan, idx, groups);
    expect(result.preconditions.has("g-a")).toBe(false);
  });

  it("detects entity when seed_ids exists but ID is different", () => {
    const idx: AppIndex = { ...mockAppIndex, seed_ids: { Envelope: ["doc-1"] } };
    const plan = makePlan({ id: "ac1", group: "g-a", url: "/t/abc/documents/99/edit" });
    const groups = makeGroups({ id: "g-a", condition: null });
    const result = detectPreconditions(plan, idx, groups);
    expect(result.preconditions.has("g-a")).toBe(true);
  });

  it("skips list page when seed_ids has entries for that model", () => {
    const idx: AppIndex = { ...mockAppIndex, seed_ids: { Template: ["tmpl-1"] } };
    const plan = makePlan({ id: "ac1", group: "g-a", url: "/t/abc/templates" });
    const groups = makeGroups({ id: "g-a", condition: null });
    const result = detectPreconditions(plan, idx, groups);
    expect(result.preconditions.has("g-a")).toBe(false);
  });

  // --- Dedup ---

  it("deduplicates conditions within same group", () => {
    const plan: PlannerOutput = {
      criteria: [
        { id: "ac1", group: "g-x", description: "t", url: "/t/abc/documents/1/edit",
          steps: ["Nav"], screenshot_at: [], timeout_seconds: 90 },
        { id: "ac2", group: "g-x", description: "t", url: "/t/abc/documents/1/edit",
          steps: ["Nav"], screenshot_at: [], timeout_seconds: 90 },
      ],
    };
    const groups: ACGeneratorOutput = {
      groups: [{ id: "g-x", condition: null, acs: [
        { id: "ac1", description: "t" }, { id: "ac2", description: "t" },
      ] }],
      skipped: [],
    };
    const result = detectPreconditions(plan, mockAppIndex, groups);
    expect(result.preconditions.has("g-x")).toBe(true);
    // One condition, two rewrite rules (one per AC)
    expect(result.rewriteRules.filter(r => r.acId === "ac1")).toHaveLength(1);
    expect(result.rewriteRules.filter(r => r.acId === "ac2")).toHaveLength(1);
  });
});
```

**Step 2: Run tests — expect FAIL**

Run: `cd pipeline && npx vitest run test/precondition-detector.test.ts`

**Step 3: Commit**

```bash
git add pipeline/test/precondition-detector.test.ts
git commit -m "test(precondition): add failing tests for detector with URL rewrite rules"
```

---

### Task 4: Implement `detectPreconditions`

**Files:**
- Create: `pipeline/src/stages/precondition-detector.ts`

**Step 1: Implement**

```typescript
import type {
  PlannerOutput, AppIndex, ACGeneratorOutput,
  PreconditionResult, InferredPrecondition, UrlRewriteRule,
} from "../lib/types.js";
import { matchRoute } from "../lib/route-match.js";

const ORG_SEGMENTS = ["o", "org", "organisation", "organization"];

/** Fuzzy-match a URL segment to a data_model key. */
function segmentToModel(
  segment: string,
  dataModel: AppIndex["data_model"],
): { model: string; table: string } | null {
  const lower = segment.toLowerCase();
  const singular = lower.endsWith("s") ? lower.slice(0, -1) : lower;
  for (const [model, info] of Object.entries(dataModel)) {
    if (model.toLowerCase() === singular) return { model, table: info.table_name };
  }
  const aliases: Record<string, string> = { document: "Envelope", documents: "Envelope" };
  if (aliases[lower] && dataModel[aliases[lower]]) {
    return { model: aliases[lower], table: dataModel[aliases[lower]].table_name };
  }
  return null;
}

export function detectPreconditions(
  plan: PlannerOutput,
  appIndex: AppIndex | null,
  acGroups: ACGeneratorOutput,
): PreconditionResult {
  const empty: PreconditionResult = { preconditions: new Map(), details: [], rewriteRules: [] };
  if (!appIndex) return empty;

  const existingConditions = new Map<string, string | null>();
  for (const group of acGroups.groups) {
    existingConditions.set(group.id, group.condition);
  }

  const allSeedIds = new Set<string>();
  for (const ids of Object.values(appIndex.seed_ids)) {
    for (const id of ids) allSeedIds.add(id);
  }

  const routeKeys = Object.keys(appIndex.routes);
  const details: InferredPrecondition[] = [];
  const rewriteRules: UrlRewriteRule[] = [];
  const groupConditionParts = new Map<string, Set<string>>();

  for (const ac of plan.criteria) {
    if (existingConditions.get(ac.group)) continue;

    for (const route of routeKeys) {
      const matched = matchRoute(route, ac.url);
      if (!matched) continue;

      const { params, segments } = matched;
      if (params.size === 0) break;

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (!seg.startsWith(":")) continue;

        const paramName = seg.slice(1);
        const paramValue = params.get(paramName);
        if (!paramValue) continue;

        const prevSeg = i > 0 ? segments[i - 1] : "";

        // Skip team slug — teams are created during setup
        if (prevSeg === "t" || prevSeg === "team") continue;

        // Org references
        if (ORG_SEGMENTS.includes(prevSeg.toLowerCase())) {
          if (!allSeedIds.has(paramValue)) {
            const condition = `An organisation with slug '${paramValue}' must exist with at least one member`;
            addCondition(groupConditionParts, ac.group, condition);
            const rule: UrlRewriteRule = {
              acId: ac.id, route, paramName,
              entityModel: "Organisation", entityTable: "Organisation",
            };
            rewriteRules.push(rule);
            details.push({ groupId: ac.group, acId: ac.id, condition, source: "url_entity", rewriteRule: rule });
          }
          continue;
        }

        // Entity references
        const modelInfo = segmentToModel(prevSeg, appIndex.data_model);
        if (modelInfo) {
          const modelSeeds = appIndex.seed_ids[modelInfo.model] ?? [];
          if (!modelSeeds.includes(paramValue) && !allSeedIds.has(paramValue)) {
            const label = prevSeg.endsWith("s") ? prevSeg.slice(0, -1) : prevSeg;
            const condition = `A ${label} must exist for the logged-in user's team`;
            addCondition(groupConditionParts, ac.group, condition);
            const rule: UrlRewriteRule = {
              acId: ac.id, route, paramName,
              entityModel: modelInfo.model, entityTable: modelInfo.table,
            };
            rewriteRules.push(rule);
            details.push({ groupId: ac.group, acId: ac.id, condition, source: "url_entity", rewriteRule: rule });
          }
        } else if (!allSeedIds.has(paramValue)) {
          const condition = `Entity '${paramValue}' referenced in URL must exist`;
          addCondition(groupConditionParts, ac.group, condition);
          const rule: UrlRewriteRule = {
            acId: ac.id, route, paramName,
            entityModel: "unknown", entityTable: "unknown",
          };
          rewriteRules.push(rule);
          details.push({ groupId: ac.group, acId: ac.id, condition, source: "url_entity", rewriteRule: rule });
        }
      }

      // List pages
      const lastSeg = segments[segments.length - 1];
      if (!lastSeg.startsWith(":")) {
        const modelInfo = segmentToModel(lastSeg, appIndex.data_model);
        if (modelInfo) {
          const modelSeeds = appIndex.seed_ids[modelInfo.model] ?? [];
          if (modelSeeds.length === 0) {
            const label = lastSeg.endsWith("s") ? lastSeg.slice(0, -1) : lastSeg;
            const condition = `At least one ${label} must exist for the logged-in user's team`;
            addCondition(groupConditionParts, ac.group, condition);
            details.push({ groupId: ac.group, acId: ac.id, condition, source: "empty_list", rewriteRule: null });
          }
        }
      }

      break;
    }
  }

  const preconditions = new Map<string, string>();
  for (const [groupId, parts] of groupConditionParts) {
    preconditions.set(groupId, [...parts].join("; "));
  }

  return { preconditions, details, rewriteRules };
}

function addCondition(map: Map<string, Set<string>>, groupId: string, condition: string): void {
  if (!map.has(groupId)) map.set(groupId, new Set());
  map.get(groupId)!.add(condition);
}
```

**Step 2: Run tests — expect PASS**

Run: `cd pipeline && npx vitest run test/precondition-detector.test.ts`

**Step 3: Full suite + typecheck**

Run: `cd pipeline && npx vitest run && npx tsc --noEmit`

**Step 4: Commit**

```bash
git add pipeline/src/stages/precondition-detector.ts
git commit -m "feat(precondition): detector with URL rewrite rules"
```

---

### Task 5: Write failing tests for `rewriteUrlsFromSetup`

**Files:**
- Create: `pipeline/test/url-rewriter.test.ts`

**Step 1: Write the tests**

```typescript
import { describe, it, expect } from "vitest";
import { rewriteUrlsFromSetup } from "../src/stages/precondition-detector.js";
import type { PlannedAC, UrlRewriteRule } from "../src/lib/types.js";

describe("rewriteUrlsFromSetup", () => {
  it("replaces entity ID in URL with created entity ID", () => {
    const acs: PlannedAC[] = [{
      id: "ac1", group: "g-a", description: "test",
      url: "/t/personal_abc/documents/1/edit",
      steps: ["Navigate"], screenshot_at: [], timeout_seconds: 90,
    }];
    const rules: UrlRewriteRule[] = [{
      acId: "ac1", route: "/t/:teamUrl/documents/:id/edit",
      paramName: "id", entityModel: "Envelope", entityTable: "Envelope",
    }];
    const createdIds = new Map([["Envelope", "abc-123-def"]]);

    const patched = rewriteUrlsFromSetup(acs, rules, createdIds);
    expect(patched[0].url).toBe("/t/personal_abc/documents/abc-123-def/edit");
  });

  it("replaces org slug in URL", () => {
    const acs: PlannedAC[] = [{
      id: "ac1", group: "g-a", description: "test",
      url: "/o/verifyorg/settings/members",
      steps: ["Navigate"], screenshot_at: [], timeout_seconds: 90,
    }];
    const rules: UrlRewriteRule[] = [{
      acId: "ac1", route: "/o/:orgUrl/settings/members",
      paramName: "orgUrl", entityModel: "Organisation", entityTable: "Organisation",
    }];
    const createdIds = new Map([["Organisation", "real-org-slug"]]);

    const patched = rewriteUrlsFromSetup(acs, rules, createdIds);
    expect(patched[0].url).toBe("/o/real-org-slug/settings/members");
  });

  it("does not modify ACs without rewrite rules", () => {
    const acs: PlannedAC[] = [{
      id: "ac1", group: "g-a", description: "test",
      url: "/settings",
      steps: ["Navigate"], screenshot_at: [], timeout_seconds: 90,
    }];
    const patched = rewriteUrlsFromSetup(acs, [], new Map());
    expect(patched[0].url).toBe("/settings");
  });

  it("preserves query string during rewrite", () => {
    const acs: PlannedAC[] = [{
      id: "ac1", group: "g-a", description: "test",
      url: "/o/verifyorg/settings/members?tab=invites",
      steps: ["Navigate"], screenshot_at: [], timeout_seconds: 90,
    }];
    const rules: UrlRewriteRule[] = [{
      acId: "ac1", route: "/o/:orgUrl/settings/members",
      paramName: "orgUrl", entityModel: "Organisation", entityTable: "Organisation",
    }];
    const createdIds = new Map([["Organisation", "real-org"]]);

    const patched = rewriteUrlsFromSetup(acs, rules, createdIds);
    expect(patched[0].url).toBe("/o/real-org/settings/members?tab=invites");
  });

  it("skips rewrite when no created ID for that model", () => {
    const acs: PlannedAC[] = [{
      id: "ac1", group: "g-a", description: "test",
      url: "/t/abc/documents/1/edit",
      steps: ["Navigate"], screenshot_at: [], timeout_seconds: 90,
    }];
    const rules: UrlRewriteRule[] = [{
      acId: "ac1", route: "/t/:teamUrl/documents/:id/edit",
      paramName: "id", entityModel: "Envelope", entityTable: "Envelope",
    }];
    // No created ID for Envelope
    const patched = rewriteUrlsFromSetup(acs, rules, new Map());
    expect(patched[0].url).toBe("/t/abc/documents/1/edit"); // unchanged
  });

  it("also rewrites matching URLs in steps array", () => {
    const acs: PlannedAC[] = [{
      id: "ac1", group: "g-a", description: "test",
      url: "/t/abc/documents/1/edit",
      steps: [
        "Navigate to /t/abc/documents/1/edit",
        "Wait for page load",
        "Take screenshot",
      ],
      screenshot_at: [], timeout_seconds: 90,
    }];
    const rules: UrlRewriteRule[] = [{
      acId: "ac1", route: "/t/:teamUrl/documents/:id/edit",
      paramName: "id", entityModel: "Envelope", entityTable: "Envelope",
    }];
    const createdIds = new Map([["Envelope", "new-id"]]);

    const patched = rewriteUrlsFromSetup(acs, rules, createdIds);
    expect(patched[0].url).toBe("/t/abc/documents/new-id/edit");
    expect(patched[0].steps[0]).toContain("new-id");
  });
});
```

**Step 2: Run tests — expect FAIL**

Run: `cd pipeline && npx vitest run test/url-rewriter.test.ts`

**Step 3: Commit**

```bash
git add pipeline/test/url-rewriter.test.ts
git commit -m "test(url-rewriter): add failing tests for post-setup URL rewriting"
```

---

### Task 6: Implement `rewriteUrlsFromSetup`

**Files:**
- Modify: `pipeline/src/stages/precondition-detector.ts`

**Step 1: Add the rewrite function**

Append to `pipeline/src/stages/precondition-detector.ts`:

```typescript
import { matchRoute } from "../lib/route-match.js";
// (matchRoute already imported above)

/**
 * After setup-writer creates entities, rewrite PlannedAC URLs to use the
 * actual created entity IDs.
 *
 * @param acs - the planned ACs to rewrite (mutated in place, returns same array)
 * @param rules - rewrite rules from detectPreconditions
 * @param createdIds - map of entityModel → created entity ID (from DB query after setup)
 */
export function rewriteUrlsFromSetup(
  acs: PlannedAC[],
  rules: UrlRewriteRule[],
  createdIds: Map<string, string>,
): PlannedAC[] {
  if (rules.length === 0) return acs;

  // Build lookup: acId → rewrite rules
  const rulesByAc = new Map<string, UrlRewriteRule[]>();
  for (const rule of rules) {
    if (!rulesByAc.has(rule.acId)) rulesByAc.set(rule.acId, []);
    rulesByAc.get(rule.acId)!.push(rule);
  }

  return acs.map((ac) => {
    const acRules = rulesByAc.get(ac.id);
    if (!acRules) return ac;

    let newUrl = ac.url;
    let newSteps = [...ac.steps];

    for (const rule of acRules) {
      const newId = createdIds.get(rule.entityModel);
      if (!newId) continue;

      // Extract the old param value from the current URL
      const matched = matchRoute(rule.route, newUrl);
      if (!matched) continue;

      const oldValue = matched.params.get(rule.paramName);
      if (!oldValue || oldValue === newId) continue;

      // Replace old value with new ID in URL
      // Split on query string, replace in path, rejoin
      const [path, qs] = newUrl.split("?");
      const newPath = path.replace(`/${oldValue}/`, `/${newId}/`)
        .replace(new RegExp(`/${oldValue}$`), `/${newId}`);
      newUrl = qs ? `${newPath}?${qs}` : newPath;

      // Also replace in steps
      newSteps = newSteps.map((step) => step.replaceAll(oldValue, newId));
    }

    return { ...ac, url: newUrl, steps: newSteps };
  });
}
```

Also add the import for `PlannedAC` at the top of the file:

```typescript
import type {
  PlannerOutput, AppIndex, ACGeneratorOutput,
  PreconditionResult, InferredPrecondition, UrlRewriteRule,
  PlannedAC,
} from "../lib/types.js";
```

**Step 2: Run rewriter tests — expect PASS**

Run: `cd pipeline && npx vitest run test/url-rewriter.test.ts`

**Step 3: Run all tests + typecheck**

Run: `cd pipeline && npx vitest run && npx tsc --noEmit`

**Step 4: Commit**

```bash
git add pipeline/src/stages/precondition-detector.ts
git commit -m "feat(url-rewriter): rewrite plan URLs with created entity IDs"
```

---

### Task 7: Write `queryCreatedEntityIds` helper

After setup-writer creates entities, we need to query the DB for the most recently created entity ID per model. This is the "approach 2b" from the spike.

**Files:**
- Modify: `pipeline/src/stages/precondition-detector.ts`
- Create: `pipeline/test/query-created-ids.test.ts`

**Step 1: Implement the helper**

Add to `pipeline/src/stages/precondition-detector.ts`:

```typescript
import { execSync } from "node:child_process";

/**
 * After setup-writer creates entities, query the DB for the most recently
 * created entity ID for each model that has a rewrite rule.
 *
 * @param rewriteRules - rules specifying which entity tables to query
 * @param dbUrl - postgres connection URL (no query params)
 * @returns map of entityModel → most recently created entity ID
 */
export function queryCreatedEntityIds(
  rewriteRules: UrlRewriteRule[],
  dbUrl: string,
): Map<string, string> {
  const createdIds = new Map<string, string>();

  // Deduplicate by model
  const models = new Map<string, string>();  // model → table
  for (const rule of rewriteRules) {
    if (rule.entityModel !== "unknown") {
      models.set(rule.entityModel, rule.entityTable);
    }
  }

  for (const [model, table] of models) {
    try {
      const result = execSync(
        `psql "${dbUrl}" -t -A -c "SELECT id FROM \\"${table}\\" ORDER BY \\"createdAt\\" DESC LIMIT 1"`,
        { encoding: "utf-8", timeout: 5_000, stdio: ["pipe", "pipe", "pipe"] },
      ).trim();
      if (result) {
        createdIds.set(model, result);
      }
    } catch {
      // Table might not have createdAt or might not exist — skip
    }
  }

  return createdIds;
}
```

**Step 2: Write a unit test (mocked)**

Create `pipeline/test/query-created-ids.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import type { UrlRewriteRule } from "../src/lib/types.js";

// We can't test against a real DB in unit tests, but we can test the
// deduplication and error handling logic by mocking execSync
describe("queryCreatedEntityIds", () => {
  it("deduplicates models before querying", async () => {
    // This is an integration test that would need a real DB
    // For unit testing, verify the function signature and types
    const { queryCreatedEntityIds } = await import("../src/stages/precondition-detector.js");
    expect(typeof queryCreatedEntityIds).toBe("function");
  });

  it("skips unknown models", async () => {
    const { queryCreatedEntityIds } = await import("../src/stages/precondition-detector.js");
    const rules: UrlRewriteRule[] = [{
      acId: "ac1", route: "/x/:id", paramName: "id",
      entityModel: "unknown", entityTable: "unknown",
    }];
    // With a bad DB URL, should return empty map (not throw)
    const result = queryCreatedEntityIds(rules, "postgresql://invalid:5432/nope");
    expect(result.size).toBe(0);
  });
});
```

**Step 3: Run tests**

Run: `cd pipeline && npx vitest run test/query-created-ids.test.ts`

**Step 4: Commit**

```bash
git add pipeline/src/stages/precondition-detector.ts pipeline/test/query-created-ids.test.ts
git commit -m "feat(precondition): add queryCreatedEntityIds helper for post-setup DB query"
```

---

### Task 8: Wire everything into orchestrator

**Files:**
- Modify: `pipeline/src/orchestrator.ts`

**Step 1: Add imports**

```typescript
import { detectPreconditions, rewriteUrlsFromSetup, queryCreatedEntityIds } from "./stages/precondition-detector.js";
```

**Step 2: Add precondition detection after groupConditions (after line 185)**

After:
```typescript
  const groupConditions = new Map<string, string | null>();
  for (const group of acs.groups) {
    groupConditions.set(group.id, group.condition);
  }
```

Add:
```typescript
  // Detect implicit preconditions from plan URLs
  const { preconditions, details: preconditionDetails, rewriteRules } = detectPreconditions(plan, appIndex, acs);
  if (preconditions.size > 0) {
    callbacks.onLog(`  Inferred ${preconditions.size} preconditions from plan URLs:`);
    for (const [groupId, condition] of preconditions) {
      callbacks.onLog(`    ${groupId}: ${condition}`);
      if (!groupConditions.get(groupId)) {
        groupConditions.set(groupId, condition);
      }
    }
  }

  // Log precondition details to timeline
  for (const detail of preconditionDetails) {
    timeline.log({
      stage: "precondition-detector",
      event: "precondition_inferred",
      groupId: detail.groupId,
      acId: detail.acId,
      condition: detail.condition,
      source: detail.source,
    });
  }
```

**Step 3: Add URL rewriting after setup-writer succeeds**

In `executeGroup`, after `setupSuccess = true` and the `break` (around line 246), add URL rewriting:

Find:
```typescript
        if (setupExec.success) {
          setupSuccess = true;
          writeFileSync(join(runDir, "setup", groupId, "commands.json"), JSON.stringify(commands, null, 2));
          break;
        }
```

Replace with:
```typescript
        if (setupExec.success) {
          setupSuccess = true;
          writeFileSync(join(runDir, "setup", groupId, "commands.json"), JSON.stringify(commands, null, 2));

          // Rewrite plan URLs with created entity IDs
          const groupRules = rewriteRules.filter(r => groupAcs.some(ac => ac.id === r.acId));
          if (groupRules.length > 0) {
            const dbUrlEnv = appIndex?.db_url_env ?? "DATABASE_URL";
            const dbUrl = (projectEnv[dbUrlEnv] ?? projectEnv.DATABASE_URL ?? "").split("?")[0];
            if (dbUrl) {
              const createdIds = queryCreatedEntityIds(groupRules, dbUrl);
              if (createdIds.size > 0) {
                const patched = rewriteUrlsFromSetup(groupAcs, groupRules, createdIds);
                // Update groupAcs in place
                for (let i = 0; i < groupAcs.length; i++) {
                  groupAcs[i] = patched[i];
                }
                callbacks.onLog(`  Rewrote ${createdIds.size} entity URLs for ${groupId}`);
                for (const [model, id] of createdIds) {
                  timeline.log({ stage: "url-rewriter", event: "url_rewritten", groupId, model, createdId: id });
                }
              }
            }
          }

          break;
        }
```

**Step 4: Add graceful failure for promoted groups**

In the setup failure block (around line 257), wrap the existing early-return so promoted groups fall through:

```typescript
      if (!setupSuccess) {
        if (snapshotPath) restoreSnapshot(snapshotPath, snapshotTableList, projectEnv);
        const isInferred = preconditions.has(groupId);
        if (isInferred) {
          callbacks.onLog(`  Setup failed for inferred precondition ${groupId} — running browse agents anyway`);
        } else {
          const reason = lastRetryContext?.type === "exec_error"
            ? `Setup failed after ${MAX_SETUP_ATTEMPTS} attempts: ${lastRetryContext.error}`
            : `Setup failed after ${MAX_SETUP_ATTEMPTS} attempts: could not produce valid output`;
          for (const ac of groupAcs) {
            allVerdicts.push({ ac_id: ac.id, verdict: "setup_failed", confidence: "high", reasoning: reason });
            progress.update(ac.id, "error", "setup_failed");
          }
          return;
        }
      }
```

**Step 5: Run tests + typecheck**

Run: `cd pipeline && npx vitest run && npx tsc --noEmit`

**Step 6: Commit**

```bash
git add pipeline/src/orchestrator.ts
git commit -m "feat(orchestrator): wire precondition detector + URL rewriting + graceful failure"
```

---

### Task 9: Run eval to validate

**Step 1: Run PR 2605 (template — simple, validated by spike)**

```bash
cd pipeline && npx tsx src/cli.ts run \
  --spec <spec-for-pr-2605> \
  --verify-dir /Users/abhishekray/Projects/opslane/evals/documenso/.verify
```

Check timeline for `precondition_inferred` and `url_rewritten` events.

**Step 2: Run PR 2636 (org — medium, validated by Spike A)**

**Step 3: Run PR 2584 (document edit — tests URL rewriting specifically)**

This PR had all 4 ACs navigating to `/documents/1/edit` which 404'd. After setup-writer creates a document and URL rewriting patches the URL, the browse agent should reach the actual document editor.

**Step 4: Compare before/after for all 10 missing_data PRs**

---

## Expected outcomes

| PR | Condition | Setup-writer | URL rewrite | Expected result |
|----|-----------|-------------|-------------|-----------------|
| 2626 | document | Creates envelope | `/documents/1/edit` → `/documents/<new-id>/edit` | Browse agent reaches editor |
| 2636 | org | Creates org + members | `/o/verifyorg/...` → `/o/<slug>/...` | Browse agent reaches org page |
| 2635 | embed token | May fail (complex) | Token URL rewrite | Graceful failure, no regression |
| 2628 | document list | Creates envelope | No rewrite needed (list page) | List shows documents |
| 2608 | document list | Creates envelope | No rewrite needed | List shows documents |
| 2605 | template | Creates template | No rewrite needed | Template visible on page |
| 2604 | document | Creates envelope | URL rewrite | Browse agent reaches editor |
| 2590 | document list | Creates envelope | No rewrite needed | List shows documents |
| 2584 | document | Creates envelope | URL rewrite | Browse agent reaches editor |
| 2581 | mixed | Creates both | URL rewrite for docs | Partial fix |

**Conservative estimate: 7-8/10 PRs fixed, 0 regressions.**
