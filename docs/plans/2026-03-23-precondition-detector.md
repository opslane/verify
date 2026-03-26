# Precondition Detector — Hybrid Setup-Writer Activation

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate the 31 `missing_data` failures (largest failure category at 37% of all failures) by detecting data prerequisites from planned URLs and promoting pure-UI groups to setup groups when data must exist.

**Architecture:** A new deterministic `detectPreconditions()` function runs after plan validation. It scans each PlannedAC's URL against app.json route patterns to identify entity references (documents, templates, orgs). When entities are referenced but don't exist in seed data, it generates a condition string and the orchestrator merges these inferred conditions into `groupConditions`. The existing setup-writer then runs for these promoted groups with no changes needed.

**Tech Stack:** TypeScript, vitest, existing pipeline infrastructure (app-index, plan-validator, orchestrator)

---

## Context

### Spike results (2026-03-23)

| Spike | Result |
|-------|--------|
| C: Heuristic regex on failure text | 31/31 cases caught (100%) |
| B: LLM prerequisite extraction | 6/6 correct (parsing bug masked results) |
| A: Setup-writer capability | Not yet run (needs documenso checkout) |

### Root cause breakdown

Most `missing_data` failures share the same pattern: the AC generator correctly marks a group as `condition: null` (pure UI — no *mutation* needed), but the browse agent navigates to a URL referencing an entity that doesn't exist in the seed database. The setup-writer is never invoked because the group has no condition.

### Categories of missing data

| Category | % of cases | Example | Detection method |
|----------|-----------|---------|-----------------|
| Entity at URL doesn't exist | ~60% | `/documents/1/edit` → 404 | URL pattern matching against routes |
| Hardcoded ID that doesn't exist | ~25% | `direct_tok_001` | URL segment not in seed_ids |
| Empty list page | ~15% | Templates page shows "We're all empty" | Route implies list of entity type |

---

## Design

### Where it lives

New file: `pipeline/src/stages/precondition-detector.ts`

Called from: `pipeline/src/orchestrator.ts` — after plan validation, before group splitting.

### Data flow

```
plan-validator ──→ detectPreconditions(plan, appIndex) ──→ Map<groupId, condition>
                                                              │
orchestrator ← merge into groupConditions ────────────────────┘
```

### How it works

1. For each `PlannedAC`, extract the URL and match it against `appIndex.routes`
2. If the URL matches a parameterized route (e.g., `/t/:teamUrl/documents/:id/edit`), extract the parameter segments
3. Map parameter names to data model entities using a simple heuristic table (`:id` after `/documents/` → `Envelope` model)
4. Check if the entity ID in the URL exists in `appIndex.seed_ids`
5. If not, and the group has `condition: null`, generate a condition string describing what data must exist
6. For list pages (routes with no entity ID like `/t/:teamUrl/templates`), check if any seed data exists for that entity type
7. Return a `Map<groupId, string>` of inferred conditions

### What it does NOT do

- Does not replace the AC generator's explicit conditions — those still take precedence
- Does not use an LLM — purely deterministic
- Does not modify the plan — only adds conditions to groups
- Does not handle complex semantic prerequisites (e.g., "document with nameless recipient") — that's a future enhancement via the AC generator prompt

---

## Tasks

### Task 1: Add `PreconditionResult` type

**Files:**
- Modify: `pipeline/src/lib/types.ts`

**Step 1: Add the type definition**

Add after the `PlanValidationResult` type (around line 68):

```typescript
export interface InferredPrecondition {
  groupId: string;
  acId: string;
  condition: string;
  source: "url_entity" | "empty_list" | "missing_seed";
}

export interface PreconditionResult {
  preconditions: Map<string, string>;       // groupId → merged condition string
  details: InferredPrecondition[];          // individual detections for logging
}
```

**Step 2: Commit**

```bash
git add pipeline/src/lib/types.ts
git commit -m "feat(types): add InferredPrecondition and PreconditionResult types"
```

---

### Task 2: Write failing tests for `detectPreconditions`

**Files:**
- Create: `pipeline/test/precondition-detector.test.ts`
- Create: `pipeline/test/fixtures/plan-needs-preconditions.json`

**Step 1: Create the test fixture**

`pipeline/test/fixtures/plan-needs-preconditions.json` — a plan with URLs referencing entities that don't exist in seed data:

```json
{
  "criteria": [
    {
      "id": "ac1",
      "group": "group-a-0",
      "description": "Document edit page loads",
      "url": "/t/personal_abc123/documents/99/edit",
      "steps": ["Navigate to URL", "Wait for page load", "Take screenshot"],
      "screenshot_at": ["after_load"],
      "timeout_seconds": 90
    },
    {
      "id": "ac2",
      "group": "group-b-0",
      "description": "Templates list shows items",
      "url": "/t/personal_abc123/templates",
      "steps": ["Navigate to URL", "Wait for page load", "Check template rows"],
      "screenshot_at": ["after_load"],
      "timeout_seconds": 90
    },
    {
      "id": "ac3",
      "group": "group-c-0",
      "description": "Settings page renders",
      "url": "/settings",
      "steps": ["Navigate to URL", "Wait for page load"],
      "screenshot_at": ["after_load"],
      "timeout_seconds": 90
    },
    {
      "id": "ac4",
      "group": "group-d-0",
      "description": "Org members page loads",
      "url": "/o/verifyorg/settings/members",
      "steps": ["Navigate to URL", "Wait for page load"],
      "screenshot_at": ["after_load"],
      "timeout_seconds": 90
    }
  ]
}
```

**Step 2: Write the tests**

```typescript
import { describe, it, expect } from "vitest";
import { detectPreconditions } from "../src/stages/precondition-detector.js";
import type { PlannerOutput, AppIndex, ACGeneratorOutput } from "../src/lib/types.js";
import planFixture from "./fixtures/plan-needs-preconditions.json" with { type: "json" };

const mockAppIndex: AppIndex = {
  indexed_at: "2026-03-23T00:00:00Z",
  routes: {
    "/t/:teamUrl/documents/:id/edit": { component: "document-edit.tsx" },
    "/t/:teamUrl/templates": { component: "templates-list.tsx" },
    "/t/:teamUrl/templates/:id": { component: "template-detail.tsx" },
    "/settings": { component: "settings.tsx" },
    "/o/:orgSlug/settings/members": { component: "org-members.tsx" },
  },
  pages: {},
  data_model: {
    Envelope: {
      columns: { id: "id", title: "title", status: "status", teamId: "teamId" },
      table_name: "Envelope",
      enums: {},
      source: "schema.prisma",
      manual_id_columns: ["id"],
    },
    Template: {
      columns: { id: "id", title: "title", teamId: "teamId" },
      table_name: "Template",
      enums: {},
      source: "schema.prisma",
      manual_id_columns: ["id"],
    },
    Team: {
      columns: { id: "id", url: "url", type: "type" },
      table_name: "Team",
      enums: {},
      source: "schema.prisma",
      manual_id_columns: [],
    },
  },
  fixtures: {},
  db_url_env: "DATABASE_URL",
  feature_flags: [],
  seed_ids: {
    Team: ["personal_abc123"],
  },
  json_type_annotations: {},
  example_urls: {
    "/t/:teamUrl/documents/:id/edit": "/t/personal_abc123/documents/42/edit",
  },
};

// Groups from AC generator — all pure-UI (condition: null)
const mockGroups: ACGeneratorOutput = {
  groups: [
    { id: "group-a-0", condition: null, acs: [{ id: "ac1", description: "Document edit page loads" }] },
    { id: "group-b-0", condition: null, acs: [{ id: "ac2", description: "Templates list shows items" }] },
    { id: "group-c-0", condition: null, acs: [{ id: "ac3", description: "Settings page renders" }] },
    { id: "group-d-0", condition: null, acs: [{ id: "ac4", description: "Org members page loads" }] },
  ],
  skipped: [],
};

describe("detectPreconditions", () => {
  it("detects entity-at-URL when ID is not in seed data", () => {
    const result = detectPreconditions(planFixture as PlannerOutput, mockAppIndex, mockGroups);

    // ac1 navigates to /t/.../documents/99/edit — 99 is not in seed_ids
    expect(result.preconditions.has("group-a-0")).toBe(true);
    expect(result.preconditions.get("group-a-0")).toMatch(/document/i);
  });

  it("detects empty-list pages needing seed data", () => {
    const result = detectPreconditions(planFixture as PlannerOutput, mockAppIndex, mockGroups);

    // ac2 navigates to /t/.../templates — Template model has no seed_ids
    expect(result.preconditions.has("group-b-0")).toBe(true);
    expect(result.preconditions.get("group-b-0")).toMatch(/template/i);
  });

  it("skips groups that do not reference entities", () => {
    const result = detectPreconditions(planFixture as PlannerOutput, mockAppIndex, mockGroups);

    // ac3 navigates to /settings — no entity reference
    expect(result.preconditions.has("group-c-0")).toBe(false);
  });

  it("detects org/team references with unknown slugs", () => {
    const result = detectPreconditions(planFixture as PlannerOutput, mockAppIndex, mockGroups);

    // ac4 navigates to /o/verifyorg/... — verifyorg not in seed_ids
    expect(result.preconditions.has("group-d-0")).toBe(true);
    expect(result.preconditions.get("group-d-0")).toMatch(/organisation|organization|org/i);
  });

  it("does not override explicit conditions from AC generator", () => {
    const groupsWithCondition: ACGeneratorOutput = {
      ...mockGroups,
      groups: [
        { id: "group-a-0", condition: "user has admin role", acs: [{ id: "ac1", description: "test" }] },
      ],
    };
    const result = detectPreconditions(planFixture as PlannerOutput, mockAppIndex, groupsWithCondition);

    // group-a-0 already has a condition — should not be in preconditions
    expect(result.preconditions.has("group-a-0")).toBe(false);
  });

  it("returns empty when appIndex is null", () => {
    const result = detectPreconditions(planFixture as PlannerOutput, null, mockGroups);
    expect(result.preconditions.size).toBe(0);
    expect(result.details).toHaveLength(0);
  });

  it("populates details with individual detections", () => {
    const result = detectPreconditions(planFixture as PlannerOutput, mockAppIndex, mockGroups);
    expect(result.details.length).toBeGreaterThan(0);

    const docDetail = result.details.find(d => d.acId === "ac1");
    expect(docDetail).toBeDefined();
    expect(docDetail!.source).toBe("url_entity");
  });

  it("merges multiple AC preconditions within the same group", () => {
    // Two ACs in the same group, both needing data
    const twoAcPlan: PlannerOutput = {
      criteria: [
        { id: "ac1", group: "group-x", description: "doc edit", url: "/t/personal_abc123/documents/99/edit",
          steps: ["Navigate"], screenshot_at: [], timeout_seconds: 90 },
        { id: "ac2", group: "group-x", description: "doc settings", url: "/t/personal_abc123/documents/99/edit",
          steps: ["Navigate"], screenshot_at: [], timeout_seconds: 90 },
      ],
    };
    const twoAcGroups: ACGeneratorOutput = {
      groups: [{ id: "group-x", condition: null, acs: [
        { id: "ac1", description: "doc edit" },
        { id: "ac2", description: "doc settings" },
      ] }],
      skipped: [],
    };

    const result = detectPreconditions(twoAcPlan, mockAppIndex, twoAcGroups);

    // Should produce one merged condition, not duplicate
    expect(result.preconditions.has("group-x")).toBe(true);
    expect(result.details.length).toBeGreaterThanOrEqual(1);
  });
});
```

**Step 3: Run tests to verify they fail**

Run: `cd pipeline && npx vitest run test/precondition-detector.test.ts`
Expected: FAIL — module `../src/stages/precondition-detector.js` not found

**Step 4: Commit**

```bash
git add pipeline/test/precondition-detector.test.ts pipeline/test/fixtures/plan-needs-preconditions.json
git commit -m "test(precondition): add failing tests for precondition detector"
```

---

### Task 3: Implement `detectPreconditions`

**Files:**
- Create: `pipeline/src/stages/precondition-detector.ts`

**Step 1: Implement the detector**

```typescript
// pipeline/src/stages/precondition-detector.ts — Deterministic precondition detector
import type {
  PlannerOutput,
  AppIndex,
  ACGeneratorOutput,
  PreconditionResult,
  InferredPrecondition,
} from "../lib/types.js";

/**
 * Route parameter name → data model entity mapping.
 * Maps the parameter name in a route pattern (e.g., :id in /documents/:id)
 * to the model name and a human-readable entity name for condition strings.
 */
interface EntityMapping {
  /** Route segment before the param (e.g., "documents") */
  segment: string;
  /** Data model key in appIndex.data_model (e.g., "Envelope") */
  model: string;
  /** Human-readable name for condition strings */
  label: string;
}

/**
 * Heuristic mapping from URL path segments to data model entities.
 * The segment is the path part immediately before a parameterized :id.
 * Order matters — first match wins.
 */
const ENTITY_MAPPINGS: EntityMapping[] = [
  { segment: "documents", model: "Envelope", label: "document" },
  { segment: "templates", model: "Template", label: "template" },
  { segment: "members", model: "TeamMember", label: "team member" },
  { segment: "webhooks", model: "Webhook", label: "webhook" },
  { segment: "direct", model: "Template", label: "direct template signing token" },
];

/**
 * Route segments that imply an org/team entity reference.
 * When these appear with a slug parameter, we check if the slug is in seed_ids.
 */
const ORG_SEGMENTS = ["o", "org", "organisation", "organization"];
const TEAM_SEGMENTS = ["t", "team"];

/**
 * Detect data prerequisites from planned URLs.
 *
 * Scans each PlannedAC's URL against appIndex routes to find entity references.
 * When an entity is referenced but doesn't exist in seed data, generates a
 * condition string for the setup-writer.
 */
export function detectPreconditions(
  plan: PlannerOutput,
  appIndex: AppIndex | null,
  acGroups: ACGeneratorOutput,
): PreconditionResult {
  const empty: PreconditionResult = { preconditions: new Map(), details: [] };
  if (!appIndex) return empty;

  // Build lookup: groupId → condition from AC generator
  const existingConditions = new Map<string, string | null>();
  for (const group of acGroups.groups) {
    existingConditions.set(group.id, group.condition);
  }

  // Build route regexes with named capture groups for parameters
  const routePatterns = Object.keys(appIndex.routes).map((route) => {
    const paramNames: string[] = [];
    const segments = route.split("/");
    const regexParts = segments.map((seg) => {
      if (seg.startsWith(":")) {
        paramNames.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    });
    return {
      route,
      re: new RegExp(`^${regexParts.join("/")}$`),
      paramNames,
      segments,
    };
  });

  const allSeedIds = new Set<string>();
  for (const ids of Object.values(appIndex.seed_ids)) {
    for (const id of ids) allSeedIds.add(id);
  }

  const details: InferredPrecondition[] = [];
  // Track conditions per group to merge
  const groupConditionParts = new Map<string, Set<string>>();

  for (const ac of plan.criteria) {
    // Skip groups that already have explicit conditions
    if (existingConditions.get(ac.group)) continue;

    const urlBase = ac.url.split("?")[0];

    // Match URL against route patterns
    for (const { re, paramNames, segments } of routePatterns) {
      const match = re.exec(urlBase);
      if (!match) continue;

      // Extract parameter values
      const params = new Map<string, string>();
      for (let i = 0; i < paramNames.length; i++) {
        params.set(paramNames[i], match[i + 1]);
      }

      // Check each parameter against seed data and entity mappings
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (!seg.startsWith(":")) continue;

        const paramName = seg.slice(1);
        const paramValue = params.get(paramName);
        if (!paramValue) continue;

        // Find the preceding path segment to determine entity type
        const prevSeg = i > 0 ? segments[i - 1] : "";

        // Check org/team references
        if (ORG_SEGMENTS.includes(prevSeg.toLowerCase())) {
          if (!allSeedIds.has(paramValue)) {
            const condition = `An organisation with slug '${paramValue}' must exist`;
            addCondition(groupConditionParts, ac.group, condition);
            details.push({ groupId: ac.group, acId: ac.id, condition, source: "url_entity" });
          }
          continue;
        }

        if (TEAM_SEGMENTS.includes(prevSeg.toLowerCase())) {
          // Team slugs are usually seeded — only flag if missing
          if (!allSeedIds.has(paramValue)) {
            const condition = `A team with slug '${paramValue}' must exist`;
            addCondition(groupConditionParts, ac.group, condition);
            details.push({ groupId: ac.group, acId: ac.id, condition, source: "url_entity" });
          }
          continue;
        }

        // Check entity mappings
        const mapping = ENTITY_MAPPINGS.find((m) => m.segment === prevSeg);
        if (mapping) {
          // Check if the specific ID is in seed data
          const modelSeeds = appIndex.seed_ids[mapping.model] ?? [];
          if (!modelSeeds.includes(paramValue) && !allSeedIds.has(paramValue)) {
            const condition = `A ${mapping.label} must exist for the logged-in user's team`;
            addCondition(groupConditionParts, ac.group, condition);
            details.push({ groupId: ac.group, acId: ac.id, condition, source: "url_entity" });
          }
        }
      }

      // Check for list pages (route has no trailing :id param → entity list)
      const lastSeg = segments[segments.length - 1];
      if (!lastSeg.startsWith(":")) {
        const mapping = ENTITY_MAPPINGS.find((m) => m.segment === lastSeg);
        if (mapping) {
          const modelSeeds = appIndex.seed_ids[mapping.model] ?? [];
          if (modelSeeds.length === 0) {
            const condition = `At least one ${mapping.label} must exist for the logged-in user's team`;
            addCondition(groupConditionParts, ac.group, condition);
            details.push({ groupId: ac.group, acId: ac.id, condition, source: "empty_list" });
          }
        }
      }

      break; // First route match wins
    }
  }

  // Merge conditions per group into single strings
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

**Step 2: Run tests**

Run: `cd pipeline && npx vitest run test/precondition-detector.test.ts`
Expected: All tests PASS

**Step 3: Run full test suite**

Run: `cd pipeline && npx vitest run`
Expected: All existing tests still pass

**Step 4: Commit**

```bash
git add pipeline/src/stages/precondition-detector.ts
git commit -m "feat(precondition): add deterministic precondition detector from plan URLs"
```

---

### Task 4: Wire into orchestrator

**Files:**
- Modify: `pipeline/src/orchestrator.ts` (around lines 148-185)

**Step 1: Add import**

At the top of orchestrator.ts, add:

```typescript
import { detectPreconditions } from "./stages/precondition-detector.js";
```

**Step 2: Call detectPreconditions and merge into groupConditions**

After the `groupConditions` map is built (line 185) and before the setup/pureUI split (line 416), insert the precondition detection and merge. Find these lines:

```typescript
  // Find which groups need setup
  const groupConditions = new Map<string, string | null>();
  for (const group of acs.groups) {
    groupConditions.set(group.id, group.condition);
  }
```

Replace with:

```typescript
  // Find which groups need setup
  const groupConditions = new Map<string, string | null>();
  for (const group of acs.groups) {
    groupConditions.set(group.id, group.condition);
  }

  // Detect implicit preconditions from plan URLs
  const { preconditions, details: preconditionDetails } = detectPreconditions(plan, appIndex, acs);
  if (preconditions.size > 0) {
    callbacks.onLog(`  Inferred ${preconditions.size} preconditions from plan URLs:`);
    for (const [groupId, condition] of preconditions) {
      callbacks.onLog(`    ${groupId}: ${condition}`);
      // Merge: only add if group doesn't already have an explicit condition
      if (!groupConditions.get(groupId)) {
        groupConditions.set(groupId, condition);
      }
    }
  }
```

**Step 3: Run tests**

Run: `cd pipeline && npx vitest run`
Expected: All tests pass (orchestrator tests mock runClaude, so the new code path is safe)

**Step 4: Commit**

```bash
git add pipeline/src/orchestrator.ts
git commit -m "feat(orchestrator): merge inferred preconditions into groupConditions"
```

---

### Task 5: Add orchestrator integration test

**Files:**
- Modify: `pipeline/test/orchestrator.test.ts`

**Step 1: Find the existing orchestrator test file and add a test**

Add a test that verifies: when a pure-UI group has an AC with a URL referencing a non-seeded entity, the precondition detector promotes it to a setup group.

```typescript
it("promotes pure-UI groups to setup groups when preconditions are detected", async () => {
  // This test verifies the integration between detectPreconditions and the
  // orchestrator's group splitting logic. When a pure-UI group's planned URL
  // references an entity not in seed data, the group should be promoted to
  // a setup group (condition is set).

  // ... mock setup — use the patterns from existing orchestrator tests,
  // ensuring the AC generator output has condition: null for a group
  // whose planned URL references /t/slug/documents/999/edit
  // and 999 is not in seed_ids.

  // Assert: the group appears in setupGroupIds, not pureUIGroupIds
});
```

The exact mock structure depends on the existing test patterns. Read `pipeline/test/orchestrator.test.ts` to match the mock setup style before writing this test.

**Step 2: Run tests**

Run: `cd pipeline && npx vitest run test/orchestrator.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add pipeline/test/orchestrator.test.ts
git commit -m "test(orchestrator): verify precondition promotion integrates correctly"
```

---

### Task 6: Add CLI logging for precondition detections

**Files:**
- Modify: `pipeline/src/orchestrator.ts`

**Step 1: Log precondition details to timeline**

In the orchestrator, after the precondition merge block added in Task 4, add timeline logging:

```typescript
  // Log precondition details to timeline for eval analysis
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

This ensures eval runs capture what preconditions were detected, making it easy to analyze whether the detector is working on real PRs.

**Step 2: Run typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add pipeline/src/orchestrator.ts
git commit -m "feat(orchestrator): log precondition detections to timeline"
```

---

### Task 7: Run eval to validate

This is the real validation — run the updated pipeline against the same documenso eval set.

**Step 1: Run a single PR end-to-end**

Pick PR 2584 (dropdown fields, 4 ACs, all `missing_data` due to document 404):

```bash
cd pipeline && npx tsx src/cli.ts run \
  --spec /path/to/documenso/.verify/spec-pr-2584.md \
  --verify-dir /path/to/documenso/.verify
```

**Step 2: Check the timeline for precondition detections**

```bash
grep precondition_inferred /path/to/documenso/.verify/runs/*/logs/timeline.jsonl
```

Expected: At least one `precondition_inferred` event for the documents URL.

**Step 3: Check the verdicts**

If the setup-writer successfully creates a document, the browse agents should no longer hit 404s. The verdicts should change from `error` (missing_data) to `pass`, `fail`, or `spec_unclear`.

**Step 4: If successful, run the full eval set**

Use the eval runner to re-run all 10 PRs that had `missing_data` failures and compare before/after.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Setup-writer can't create complex entity graphs (FK chains) | Spike A will validate this separately. If FK failures are common, enhance setup-writer prompt with `json_type_annotations` and NOT NULL column awareness. |
| Entity mappings are too rigid (new entity types not covered) | ENTITY_MAPPINGS is easy to extend. The `empty_list` detection catches list pages generically. |
| Promoted groups run serially, slowing pipeline | Only groups with detected preconditions become serial. Pure-UI groups with no entity references stay parallel. |
| False positives — detecting preconditions that aren't needed | Low risk: condition string tells setup-writer what to create, and snapshot restore reverts on teardown. Worst case: unnecessary setup SQL that doesn't break anything. |

## Future work (not in this plan)

- **AC generator enhancement**: Teach the AC generator to emit `data_prerequisites` for semantic conditions like "document with nameless recipient missing signature fields"
- **Setup-writer FK awareness**: Give setup-writer knowledge of NOT NULL constraints and FK relationships to prevent constraint violations
- **Precondition caching**: If the same precondition is detected across multiple runs, cache the working SQL commands

---

## Eng Review: Strategic Pivot (2026-03-23)

### Review decision: PIVOT to upstream fix

After full eng review + Codex outside voice challenge, the plan is **pivoting from downstream detection to upstream enforcement**. Key findings:

#### Spike A results (live validation)
| PR | Difficulty | Status | Error |
|----|-----------|--------|-------|
| 2626 | hard | sql_error | wrong column name (`documentDataId` doesn't exist) |
| 2636 | medium | success | created org + related records correctly |
| 2605 | simple | success | template already exists (0 commands needed) |
| 2585 | hard | sql_error | missing NOT NULL (`updatedAt`) |

Setup-writer works for simple/medium cases (2/2) but fails on hard FK chains (0/2).

#### Codex challenge (accepted)
The detector compensates for planner failure with a weak inference layer and routes more traffic into setup-writer (which already breaks on hard cases). The simpler path:

1. **Upstream enforcement**: Add plan-validator check that rejects URLs with entity IDs not found in `seed_ids` or `example_urls`. Force planner retry with clearer instructions.
2. **Deterministic fixtures**: Use `app.json.fixtures` runners for common entity graphs instead of LLM-generated SQL.

#### Review decisions
| # | Issue | Decision |
|---|-------|----------|
| 1 | DRY: route-to-regex duplicated | Extract to shared lib/route-match.ts |
| 2 | Promoted groups go serial | Defer optimization — measure first |
| 3 | ENTITY_MAPPINGS hardcoded to Documenso | Infer from app.json data_model |
| 4 | Setup-writer failure on promoted groups | Fail gracefully, log, continue |
| 5 | `missing_seed` type unused | Remove (YAGNI) |
| 6 | Task 5 integration test is stub | Write full test code |
| 7 | 7 test gaps identified | Add all missing tests |
| 8 | Strategic pivot | Upstream enforcement + fixtures (Codex) |

### Revised approach (to be planned in follow-up)

```
BEFORE (this plan):
plan-validator ──→ detectPreconditions() ──→ promote to setup group ──→ setup-writer (LLM SQL)

AFTER (pivot):
plan-validator ──→ reject URLs with non-seeded IDs ──→ planner retry with example_urls
                                                        ↓
                                                   fixture runner (deterministic) for entity creation
```

**Next step:** Write a new plan implementing the upstream fix approach.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | ISSUES_FOUND | Strategic pivot recommended: upstream enforcement + fixtures |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES_OPEN (PLAN) | 8 issues, 0 critical gaps. Pivoted to upstream fix per Codex challenge |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |

- **CODEX:** Identified root cause mismatch — detector compensates for planner failure instead of fixing planner. Recommended upstream URL validation + deterministic fixtures.
- **CROSS-MODEL:** Review accepted detector approach; Codex challenged it. User sided with Codex — strategic pivot to upstream fix.
- **UNRESOLVED:** 0 decisions unresolved
- **VERDICT:** PLAN PIVOTED — original detector approach superseded by upstream enforcement strategy. New plan needed.
