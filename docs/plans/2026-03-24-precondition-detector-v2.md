# Precondition Detector v2 — Setup-Writer Activation from Plan URLs

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate the 31 `missing_data` failures (37% of all pipeline failures) by detecting data prerequisites from planned URLs and promoting pure-UI groups to setup groups.

**Architecture:** A deterministic `detectPreconditions()` function runs after plan validation. It matches each PlannedAC's URL against `appIndex.routes`, extracts entity references, and checks them against `seed_ids`. When entities are referenced but don't exist in seed data (or seed_ids is empty), it generates a condition string. The orchestrator merges these into `groupConditions`, triggering the existing setup-writer. If setup-writer fails on a promoted group, browse agents run anyway (no regression).

**Tech Stack:** TypeScript, vitest, existing pipeline infrastructure

---

## Context

### Validated by data (2026-03-23)

Spike A against documenso DB:
- Simple/medium conditions: **2/2 success** (setup-writer creates entities correctly)
- Hard FK chains (Envelope table): **0/2 success** (schema awareness gap — separate fix)

Upstream enforcement approach was attempted and **verified to fix 0/31 cases** — the planner already uses correct `example_urls`, but those entities don't exist in the DB. The problem is data creation, not URL correction.

### What the detector catches (verified against eval data)

| Category | PRs | How detected |
|----------|-----|-------------|
| Entity-at-URL (documents/:id, :orgUrl, :token) | 2626, 2636, 2635, 2604, 2584 | URL has parameterized entity ID, `seed_ids` empty |
| Empty list page (documents list, templates list) | 2628, 2605, 2590, 2581, 2608 | URL matches list route, entity model has no `seed_ids` |

### What it won't fix

- Hard FK chain entities (Envelope table with 24+ NOT NULL FKs) — setup-writer fails, browse agents get 404s as before
- Cases requiring semantic preconditions ("document with nameless recipient") — needs AC generator enhancement

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
    expect(result).not.toBeNull();
    expect(result!.params.get("teamUrl")).toBe("abc123");
    expect(result!.params.get("id")).toBe("42");
  });

  it("returns empty params for a static route", () => {
    const result = matchRoute("/settings", "/settings");
    expect(result).not.toBeNull();
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

**Step 2: Run tests — expect FAIL (module not found)**

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

**Step 6: Run existing tests — expect PASS (no regression)**

Run: `cd pipeline && npx vitest run test/plan-validator.test.ts`

**Step 7: Commit**

```bash
git add pipeline/src/lib/route-match.ts pipeline/test/route-match.test.ts pipeline/src/stages/plan-validator.ts
git commit -m "refactor: extract routeToRegex to shared lib/route-match.ts"
```

---

### Task 2: Write failing tests for `detectPreconditions`

**Files:**
- Create: `pipeline/test/precondition-detector.test.ts`

**Step 1: Write the tests**

```typescript
import { describe, it, expect } from "vitest";
import { detectPreconditions } from "../src/stages/precondition-detector.js";
import type { PlannerOutput, AppIndex, ACGeneratorOutput } from "../src/lib/types.js";

const mockAppIndex: AppIndex = {
  indexed_at: "2026-03-23T00:00:00Z",
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
  seed_ids: {},  // empty — like real documenso
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
  it("detects entity-at-URL when seed_ids is empty", () => {
    const plan = makePlan({ id: "ac1", group: "group-a-0", url: "/t/personal_abc/documents/1/edit" });
    const groups = makeGroups({ id: "group-a-0", condition: null });
    const result = detectPreconditions(plan, mockAppIndex, groups);
    expect(result.preconditions.has("group-a-0")).toBe(true);
    expect(result.preconditions.get("group-a-0")).toMatch(/document/i);
  });

  it("detects org reference with unknown slug", () => {
    const plan = makePlan({ id: "ac1", group: "group-a-0", url: "/o/verifyorg/settings/members" });
    const groups = makeGroups({ id: "group-a-0", condition: null });
    const result = detectPreconditions(plan, mockAppIndex, groups);
    expect(result.preconditions.has("group-a-0")).toBe(true);
    expect(result.preconditions.get("group-a-0")).toMatch(/organisation|organization|org/i);
  });

  it("detects embed token reference", () => {
    const plan = makePlan({ id: "ac1", group: "group-a-0", url: "/embed/v0/direct/direct_tok_001" });
    const groups = makeGroups({ id: "group-a-0", condition: null });
    const result = detectPreconditions(plan, mockAppIndex, groups);
    expect(result.preconditions.has("group-a-0")).toBe(true);
  });

  it("detects empty-list pages when entity model has no seeds", () => {
    const plan = makePlan({ id: "ac1", group: "group-a-0", url: "/t/personal_abc/templates" });
    const groups = makeGroups({ id: "group-a-0", condition: null });
    const result = detectPreconditions(plan, mockAppIndex, groups);
    expect(result.preconditions.has("group-a-0")).toBe(true);
    expect(result.preconditions.get("group-a-0")).toMatch(/template/i);
  });

  it("detects documents list page needing seed data", () => {
    const plan = makePlan({ id: "ac1", group: "group-a-0", url: "/t/personal_abc/documents" });
    const groups = makeGroups({ id: "group-a-0", condition: null });
    const result = detectPreconditions(plan, mockAppIndex, groups);
    expect(result.preconditions.has("group-a-0")).toBe(true);
    expect(result.preconditions.get("group-a-0")).toMatch(/document/i);
  });

  it("skips groups that already have explicit conditions", () => {
    const plan = makePlan({ id: "ac1", group: "group-a-0", url: "/t/personal_abc/documents/1/edit" });
    const groups = makeGroups({ id: "group-a-0", condition: "user has admin role" });
    const result = detectPreconditions(plan, mockAppIndex, groups);
    expect(result.preconditions.has("group-a-0")).toBe(false);
  });

  it("skips static routes with no entity params", () => {
    const plan = makePlan({ id: "ac1", group: "group-a-0", url: "/settings" });
    const groups = makeGroups({ id: "group-a-0", condition: null });
    const result = detectPreconditions(plan, mockAppIndex, groups);
    expect(result.preconditions.has("group-a-0")).toBe(false);
  });

  it("skips team-only routes (settings, webhooks) — team slug assumed seeded", () => {
    const plan = makePlan({ id: "ac1", group: "group-a-0", url: "/t/personal_abc/settings" });
    const groups = makeGroups({ id: "group-a-0", condition: null });
    const result = detectPreconditions(plan, mockAppIndex, groups);
    expect(result.preconditions.has("group-a-0")).toBe(false);
  });

  it("returns empty when appIndex is null", () => {
    const plan = makePlan({ id: "ac1", group: "group-a-0", url: "/t/abc/documents/1/edit" });
    const groups = makeGroups({ id: "group-a-0", condition: null });
    const result = detectPreconditions(plan, null, groups);
    expect(result.preconditions.size).toBe(0);
  });

  it("handles URL with query string", () => {
    const plan = makePlan({ id: "ac1", group: "group-a-0", url: "/o/verifyorg/settings/members?tab=invites" });
    const groups = makeGroups({ id: "group-a-0", condition: null });
    const result = detectPreconditions(plan, mockAppIndex, groups);
    expect(result.preconditions.has("group-a-0")).toBe(true);
  });

  it("handles URL matching no route", () => {
    const plan = makePlan({ id: "ac1", group: "group-a-0", url: "/unknown/page" });
    const groups = makeGroups({ id: "group-a-0", condition: null });
    const result = detectPreconditions(plan, mockAppIndex, groups);
    expect(result.preconditions.has("group-a-0")).toBe(false);
  });

  it("does not duplicate conditions for same group with same entity", () => {
    const plan: PlannerOutput = {
      criteria: [
        { id: "ac1", group: "group-x", description: "t", url: "/t/abc/documents/1/edit",
          steps: ["Nav"], screenshot_at: [], timeout_seconds: 90 },
        { id: "ac2", group: "group-x", description: "t", url: "/t/abc/documents/1/edit",
          steps: ["Nav"], screenshot_at: [], timeout_seconds: 90 },
      ],
    };
    const groups: ACGeneratorOutput = {
      groups: [{ id: "group-x", condition: null, acs: [
        { id: "ac1", description: "t" }, { id: "ac2", description: "t" },
      ] }],
      skipped: [],
    };
    const result = detectPreconditions(plan, mockAppIndex, groups);
    expect(result.preconditions.has("group-x")).toBe(true);
    // Condition should not be duplicated
    const condition = result.preconditions.get("group-x")!;
    expect(condition.split(";").length).toBeLessThanOrEqual(2);
  });

  it("populates details array for logging", () => {
    const plan = makePlan({ id: "ac1", group: "group-a-0", url: "/t/abc/documents/1/edit" });
    const groups = makeGroups({ id: "group-a-0", condition: null });
    const result = detectPreconditions(plan, mockAppIndex, groups);
    expect(result.details.length).toBeGreaterThan(0);
    expect(result.details[0].source).toBe("url_entity");
    expect(result.details[0].acId).toBe("ac1");
  });

  it("does not flag entity when seed_ids has entries for that model", () => {
    const indexWithSeeds: AppIndex = {
      ...mockAppIndex,
      seed_ids: { Envelope: ["doc-1", "doc-2"] },
    };
    const plan = makePlan({ id: "ac1", group: "group-a-0", url: "/t/abc/documents/doc-1/edit" });
    const groups = makeGroups({ id: "group-a-0", condition: null });
    const result = detectPreconditions(plan, indexWithSeeds, groups);
    // doc-1 IS in seed_ids, so no precondition needed
    expect(result.preconditions.has("group-a-0")).toBe(false);
  });

  it("flags entity when seed_ids exists but ID is not in it", () => {
    const indexWithSeeds: AppIndex = {
      ...mockAppIndex,
      seed_ids: { Envelope: ["doc-1"] },
    };
    const plan = makePlan({ id: "ac1", group: "group-a-0", url: "/t/abc/documents/99/edit" });
    const groups = makeGroups({ id: "group-a-0", condition: null });
    const result = detectPreconditions(plan, indexWithSeeds, groups);
    expect(result.preconditions.has("group-a-0")).toBe(true);
  });

  it("does not flag list page when seed_ids has entries for that model", () => {
    const indexWithSeeds: AppIndex = {
      ...mockAppIndex,
      seed_ids: { Template: ["tmpl-1"] },
    };
    const plan = makePlan({ id: "ac1", group: "group-a-0", url: "/t/abc/templates" });
    const groups = makeGroups({ id: "group-a-0", condition: null });
    const result = detectPreconditions(plan, indexWithSeeds, groups);
    expect(result.preconditions.has("group-a-0")).toBe(false);
  });
});
```

**Step 2: Run tests — expect FAIL**

Run: `cd pipeline && npx vitest run test/precondition-detector.test.ts`

**Step 3: Commit**

```bash
git add pipeline/test/precondition-detector.test.ts
git commit -m "test(precondition): add failing tests for precondition detector"
```

---

### Task 3: Add `InferredPrecondition` and `PreconditionResult` types

**Files:**
- Modify: `pipeline/src/lib/types.ts` (after line 68, after `PlanValidationResult`)

**Step 1: Add types**

```typescript
// ── Precondition Detector ──────────────────────────────────────────────────────

export interface InferredPrecondition {
  groupId: string;
  acId: string;
  condition: string;
  source: "url_entity" | "empty_list";
}

export interface PreconditionResult {
  preconditions: Map<string, string>;       // groupId → merged condition string
  details: InferredPrecondition[];          // individual detections for logging
}
```

**Step 2: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`

**Step 3: Commit**

```bash
git add pipeline/src/lib/types.ts
git commit -m "feat(types): add InferredPrecondition and PreconditionResult types"
```

---

### Task 4: Implement `detectPreconditions`

**Files:**
- Create: `pipeline/src/stages/precondition-detector.ts`

**Step 1: Implement**

```typescript
import type {
  PlannerOutput, AppIndex, ACGeneratorOutput,
  PreconditionResult, InferredPrecondition,
} from "../lib/types.js";
import { matchRoute } from "../lib/route-match.js";

/** Path segments that indicate an org entity (not a team). */
const ORG_SEGMENTS = ["o", "org", "organisation", "organization"];

/**
 * Fuzzy-match a URL path segment to a data_model key.
 * "documents" → "Envelope" (if Envelope exists in data_model)
 * "templates" → "Template"
 * Falls back to checking if any model name contains the singularized segment.
 */
function segmentToModel(segment: string, dataModel: AppIndex["data_model"]): string | null {
  const models = Object.keys(dataModel);
  const lower = segment.toLowerCase();

  // Direct match (e.g., "webhooks" → "Webhook")
  const singular = lower.endsWith("s") ? lower.slice(0, -1) : lower;
  for (const model of models) {
    if (model.toLowerCase() === singular) return model;
  }

  // Known aliases — keep minimal, extend only when eval data shows gaps
  const aliases: Record<string, string> = { document: "Envelope", documents: "Envelope" };
  if (aliases[lower] && dataModel[aliases[lower]]) return aliases[lower];

  return null;
}

/**
 * Detect data prerequisites from planned URLs.
 * Scans each PlannedAC's URL against appIndex routes. When a URL references
 * an entity that doesn't exist in seed data, generates a condition string
 * for the setup-writer.
 */
export function detectPreconditions(
  plan: PlannerOutput,
  appIndex: AppIndex | null,
  acGroups: ACGeneratorOutput,
): PreconditionResult {
  const empty: PreconditionResult = { preconditions: new Map(), details: [] };
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
  const groupConditionParts = new Map<string, Set<string>>();

  for (const ac of plan.criteria) {
    if (existingConditions.get(ac.group)) continue;

    // Match URL against routes
    for (const route of routeKeys) {
      const matched = matchRoute(route, ac.url);
      if (!matched) continue;

      const { params, segments } = matched;

      // No params → static route, nothing to check
      if (params.size === 0) break;

      // Check each parameterized segment
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (!seg.startsWith(":")) continue;

        const paramName = seg.slice(1);
        const paramValue = params.get(paramName);
        if (!paramValue) continue;

        const prevSeg = i > 0 ? segments[i - 1] : "";

        // Skip team slug params — teams are created during setup
        if (prevSeg === "t" || prevSeg === "team") continue;

        // Org references
        if (ORG_SEGMENTS.includes(prevSeg.toLowerCase())) {
          if (!allSeedIds.has(paramValue)) {
            const condition = `An organisation with slug '${paramValue}' must exist with at least one member`;
            addCondition(groupConditionParts, ac.group, condition);
            details.push({ groupId: ac.group, acId: ac.id, condition, source: "url_entity" });
          }
          continue;
        }

        // Entity references — infer model from preceding path segment
        const model = segmentToModel(prevSeg, appIndex.data_model);
        if (model) {
          const modelSeeds = appIndex.seed_ids[model] ?? [];
          if (!modelSeeds.includes(paramValue) && !allSeedIds.has(paramValue)) {
            const label = prevSeg.endsWith("s") ? prevSeg.slice(0, -1) : prevSeg;
            const condition = `A ${label} must exist for the logged-in user's team`;
            addCondition(groupConditionParts, ac.group, condition);
            details.push({ groupId: ac.group, acId: ac.id, condition, source: "url_entity" });
          }
        } else if (!allSeedIds.has(paramValue)) {
          // Generic entity reference — param not in seeds, model unknown
          const condition = `Entity '${paramValue}' referenced in URL must exist`;
          addCondition(groupConditionParts, ac.group, condition);
          details.push({ groupId: ac.group, acId: ac.id, condition, source: "url_entity" });
        }
      }

      // List pages: route ends with a static segment that maps to a model
      const lastSeg = segments[segments.length - 1];
      if (!lastSeg.startsWith(":")) {
        const model = segmentToModel(lastSeg, appIndex.data_model);
        if (model) {
          const modelSeeds = appIndex.seed_ids[model] ?? [];
          if (modelSeeds.length === 0) {
            const label = lastSeg.endsWith("s") ? lastSeg.slice(0, -1) : lastSeg;
            const condition = `At least one ${label} must exist for the logged-in user's team`;
            addCondition(groupConditionParts, ac.group, condition);
            details.push({ groupId: ac.group, acId: ac.id, condition, source: "empty_list" });
          }
        }
      }

      break; // first matching route wins
    }
  }

  const preconditions = new Map<string, string>();
  for (const [groupId, parts] of groupConditionParts) {
    preconditions.set(groupId, [...parts].join("; "));
  }

  return { preconditions, details };
}

function addCondition(map: Map<string, Set<string>>, groupId: string, condition: string): void {
  if (!map.has(groupId)) map.set(groupId, new Set());
  map.get(groupId)!.add(condition);
}
```

**Step 2: Run precondition tests — expect PASS**

Run: `cd pipeline && npx vitest run test/precondition-detector.test.ts`

**Step 3: Run full suite — expect PASS**

Run: `cd pipeline && npx vitest run`

**Step 4: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`

**Step 5: Commit**

```bash
git add pipeline/src/stages/precondition-detector.ts
git commit -m "feat(precondition): add deterministic precondition detector from plan URLs"
```

---

### Task 5: Wire into orchestrator

**Files:**
- Modify: `pipeline/src/orchestrator.ts`

**Step 1: Add import at top of file**

```typescript
import { detectPreconditions } from "./stages/precondition-detector.js";
```

**Step 2: Add precondition merge after groupConditions (after line 185)**

Find:
```typescript
  // Find which groups need setup
  const groupConditions = new Map<string, string | null>();
  for (const group of acs.groups) {
    groupConditions.set(group.id, group.condition);
  }
```

Add immediately after:
```typescript
  // Detect implicit preconditions from plan URLs
  const { preconditions, details: preconditionDetails } = detectPreconditions(plan, appIndex, acs);
  if (preconditions.size > 0) {
    callbacks.onLog(`  Inferred ${preconditions.size} preconditions from plan URLs:`);
    for (const [groupId, condition] of preconditions) {
      callbacks.onLog(`    ${groupId}: ${condition}`);
      if (!groupConditions.get(groupId)) {
        groupConditions.set(groupId, condition);
      }
    }
  }
```

**Step 3: Add graceful failure for promoted groups**

In the `executeGroup` function, find the setup failure block (around line 257-268 — the block that pushes `setup_failed` verdicts). Wrap it so promoted groups (inferred condition) fall through to browse agents instead of aborting:

Find:
```typescript
      if (!setupSuccess) {
```

After the existing `setup_failed` verdict push, add a check: if the condition came from preconditions (not from the AC generator), skip the early return and let browse agents run:

```typescript
      if (!setupSuccess) {
        const isInferred = preconditions.has(groupId);
        if (isInferred) {
          callbacks.onLog(`  Setup failed for inferred precondition ${groupId} — running browse agents anyway`);
        } else {
          // existing setup_failed verdict push + return
```

Close the else block after the existing `return` statement.

**Step 4: Run tests**

Run: `cd pipeline && npx vitest run`

**Step 5: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`

**Step 6: Commit**

```bash
git add pipeline/src/orchestrator.ts
git commit -m "feat(orchestrator): merge inferred preconditions, graceful failure for promoted groups"
```

---

### Task 6: Add timeline logging

**Files:**
- Modify: `pipeline/src/orchestrator.ts`

**Step 1: Log precondition details to timeline**

After the precondition merge block from Task 5, add:

```typescript
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

**Step 2: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`

**Step 3: Commit**

```bash
git add pipeline/src/orchestrator.ts
git commit -m "feat(orchestrator): log precondition detections to timeline"
```

---

### Task 7: Run eval to validate

**Step 1: Run a single PR**

Pick PR 2605 (template description overflow — simple case, Spike A showed setup-writer succeeds):

```bash
cd pipeline && npx tsx src/cli.ts run \
  --spec /path/to/documenso/.verify/specs/pr-2605.md \
  --verify-dir /Users/abhishekray/Projects/opslane/evals/documenso/.verify
```

**Step 2: Check timeline for precondition detections**

```bash
grep precondition_inferred /Users/abhishekray/Projects/opslane/evals/documenso/.verify/runs/*/logs/timeline.jsonl
```

Expected: `precondition_inferred` event for the templates URL.

**Step 3: Check verdicts**

If setup-writer creates a template, the browse agent should see it on the page. Verdict should change from `error` to `pass`, `fail`, or `spec_unclear`.

**Step 4: Run medium case**

Pick PR 2636 (org members — medium complexity, Spike A succeeded):

**Step 5: If both pass, run full eval set for the 10 missing_data PRs**

---

## Coverage

```
CODE PATH COVERAGE
===========================
[+] pipeline/src/lib/route-match.ts
    ├── [★★★] routeToRegex — static, single-param, multi-param, special chars
    ├── [★★★] matchRoute — match, no-match, params, segments, query string
    └── [★★★] matchRoute returns null

[+] pipeline/src/stages/precondition-detector.ts
    ├── [★★★] entity-at-URL with empty seed_ids
    ├── [★★★] org slug reference
    ├── [★★★] embed token reference
    ├── [★★★] empty list page (templates, documents)
    ├── [★★★] skip explicit conditions
    ├── [★★★] skip static routes
    ├── [★★★] skip team-only routes
    ├── [★★★] null appIndex → empty
    ├── [★★★] URL with query string
    ├── [★★★] URL matching no route
    ├── [★★★] dedup within same group
    ├── [★★★] details array populated
    ├── [★★★] seed_ids has ID → no precondition
    ├── [★★★] seed_ids exists but ID missing → precondition
    └── [★★★] list page with seeds → no precondition

─────────────────────────────────
COVERAGE: 18/18 paths tested (100%)
GAPS: 0
─────────────────────────────────
```
