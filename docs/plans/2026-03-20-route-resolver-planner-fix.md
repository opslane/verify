# Route Resolver + Param-Aware Plan Validator

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Resolve parameterized route URLs (`:teamUrl`, `:id`) to concrete values in app.json so the planner can generate working browser steps.

**Architecture:** Add a route resolver agent (haiku) to index-app that maps parameterized routes to concrete example URLs using seed data. Fix the plan validator with regex-based param matching (no LLM — deterministic). Update the planner prompt to reference the new `example_urls` field.

**Tech Stack:** TypeScript, Node 22 ESM, `claude -p` (haiku for resolver only), vitest

---

## Context

The planner generates URLs like `/t/__TEAM_URL__/settings/document` or `/t/personal_abc/settings/document` because app.json only has parameterized routes (`/t/:teamUrl/settings/document`). The planner can't resolve `:teamUrl` to a real value because:
1. Documenso's `seed_ids` is empty
2. Even when seed_ids exist, they're UUIDs — not URL slugs that route params need
3. `seed-data.txt` has the values but is unstructured text

The plan validator then rejects these URLs because it does literal string matching.

### Data flow (current → new):

```
CURRENT:
  index-app: routes agent → parameterized routes → app.json
  planner:   reads app.json → can't resolve :params → generates bad URLs
  validator: literal match → rejects → plan_error

NEW:
  index-app: routes agent → parameterized routes
           → resolver agent (haiku): routes + seed-data.txt → example_urls
           → app.json (now has example_urls)
  planner:   reads app.json → uses example_urls → generates correct URLs
  validator: regex param matching (:param → [^/]+) → validates correctly
```

### Review findings incorporated:
- Keep TEMPLATE_VAR_RE check (deterministic, catches {envId} etc.)
- Validator stays synchronous (regex, not LLM) — no orchestrator async changes
- Truncate seed data on section boundaries, not raw chars
- Defensive markdown fence stripping on all JSON parse sites
- Match validator results by AC ID, not URL string (N/A — no LLM validator now)
- Add example_urls to all test fixtures that construct AppIndex

---

### Task 1: Add `example_urls` to AppIndex type

**Files:**
- Modify: `pipeline/src/lib/types.ts:117-140`

**Step 1: Add the field to AppIndex interface**

After `json_type_annotations` (line 139), add:

```typescript
  example_urls: Record<string, string>;  // parameterized route → concrete example URL
```

**Step 2: Run typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: Errors in `mergeIndexResults` and test fixtures (missing field) — expected, fixed in Tasks 2-3.

**Step 3: Commit**

```bash
git add pipeline/src/lib/types.ts
git commit -m "feat(pipeline): add example_urls field to AppIndex type"
```

---

### Task 2: Create route resolver prompt and wire into index-app

**Files:**
- Create: `pipeline/src/prompts/index/route-resolver.txt`
- Modify: `pipeline/src/cli.ts:181-204`
- Modify: `pipeline/src/lib/index-app.ts` (mergeIndexResults — add param)

**Step 1: Write the resolver prompt**

Create `pipeline/src/prompts/index/route-resolver.txt`:

```
You are a route parameter resolver. Given parameterized routes, seed data from a database, and a data model, produce concrete example URLs.

INPUT (provided inline below):

PARAMETERIZED ROUTES:
__ROUTES__

SEED DATA (sampled rows from the database):
__SEED_DATA__

DATA MODEL (table names and columns):
__DATA_MODEL__

TASK:
For each parameterized route (containing :paramName), find a real value from the seed data to substitute for each parameter. Use the data model column names and seed data values to infer which table/column maps to each parameter. For example, if a route has :teamUrl and the Team table has a "url" column with value "bxeevwkyrmcdctic", substitute that value.

OUTPUT: Write valid JSON with this schema:
{
  "example_urls": {
    "/t/:teamUrl/settings/document": "/t/bxeevwkyrmcdctic/settings/document",
    "/admin/documents/:id": "/admin/documents/42",
    "/o/:orgUrl/settings": "/o/org_bmcflitiwsyvwvso/settings"
  }
}

Only include routes where ALL parameters could be resolved to real values from the seed data. Skip routes with unresolvable params.
Output ONLY the JSON. No explanation, no markdown fences.
```

**Step 2: Add `exampleUrls` param to mergeIndexResults**

In `pipeline/src/lib/index-app.ts`, add `exampleUrls` as the last parameter to the existing `mergeIndexResults` function signature (do NOT replace the signature):

```typescript
export function mergeIndexResults(
  routes: /* existing */,
  selectors: /* existing */,
  schema: /* existing */,
  fixtures: /* existing */,
  envVars: /* existing */,
  prismaMapping: /* existing */,
  seedIds: /* existing */,
  jsonAnnotations: /* existing */,
  exampleUrls: Record<string, string> = {},  // NEW — default empty
): AppIndex {
```

Add to the return object:

```typescript
    example_urls: exampleUrls,
```

**Step 3: Wire resolver agent in CLI after seed data dump**

In `pipeline/src/cli.ts`, after the seed data dump (line 202) and before `writeFileSync(outputPath, ...)` (line 204), add:

```typescript
  // Step 3.5: Route resolver — map parameterized routes to concrete URLs using seed data
  let exampleUrls: Record<string, string> = {};
  const paramRoutes = Object.keys(appIndex.routes).filter(r => r.includes(":"));
  if (paramRoutes.length > 0 && seedDataDump) {
    console.log(`  Resolving ${paramRoutes.length} parameterized routes...`);
    const resolverPromptTemplate = readPrompt(join(promptDir, "route-resolver.txt"), "utf-8");

    // Build compact data model summary (table names + column names only)
    const dataModelSummary = Object.entries(appIndex.data_model)
      .map(([model, info]) => `${model} (table: ${info.table_name}): ${Object.keys(info.columns).join(", ")}`)
      .join("\n");

    // Truncate seed data on section boundaries (-- ModelName lines) to fit context
    const sections = seedDataDump.split(/^(?=-- )/m);
    let truncatedSeedData = "";
    for (const section of sections) {
      if (truncatedSeedData.length + section.length > 16_000) break;
      truncatedSeedData += section;
    }

    const resolverPrompt = resolverPromptTemplate
      .replace("__ROUTES__", paramRoutes.join("\n"))
      .replace("__SEED_DATA__", truncatedSeedData)
      .replace("__DATA_MODEL__", dataModelSummary);

    try {
      const resolverResult = await runClaude({
        prompt: resolverPrompt,
        model: "haiku",
        timeoutMs: 60_000,
        stage: "index-resolver",
        runDir,
        cwd: projectDir,
        dangerouslySkipPermissions: true,
      });

      // Defensive: strip markdown fences (haiku frequently wraps despite instructions)
      const cleaned = resolverResult.stdout.replace(/^```json?\n?|\n?```$/g, "").trim();
      const parsed = JSON.parse(cleaned);
      if (parsed?.example_urls && typeof parsed.example_urls === "object") {
        exampleUrls = parsed.example_urls;
        console.log(`  Resolved ${Object.keys(exampleUrls).length} example URLs`);
      }
    } catch (err) {
      console.warn("  Warning: route resolver failed, continuing without example URLs:", (err as Error).message);
    }
  }

  // Update appIndex with resolved URLs
  appIndex.example_urls = exampleUrls;
```

**Step 4: Run typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: May still have test fixture errors — fixed in Task 4.

**Step 5: Commit**

```bash
git add pipeline/src/prompts/index/route-resolver.txt pipeline/src/cli.ts pipeline/src/lib/index-app.ts
git commit -m "feat(pipeline): add route resolver agent to index-app

Haiku LLM agent runs after seed data dump, maps parameterized routes
to concrete example URLs using seed data + data model context.
Truncates seed data on section boundaries. Defensive markdown fence
stripping on JSON parse."
```

---

### Task 3: Update planner prompt to reference example_urls

**Files:**
- Modify: `pipeline/src/prompts/planner.txt`

**Step 1: Update the prompt**

Replace line 8:
```
app.json has everything you need: routes with real IDs, page selectors with data-testid values, seed record IDs, and the full data model. DO NOT grep through the codebase for information that's already in app.json.
```
With:
```
app.json has everything you need: route patterns, example_urls with concrete URLs for parameterized routes, page selectors with data-testid values, seed record IDs, and the full data model. DO NOT grep through the codebase for information that's already in app.json.
```

Replace rule 1 (line 33):
```
1. FIRST: Read `.verify/app.json` to get real environment IDs, route patterns, and seed data IDs. You MUST use these real IDs in all URLs. Never invent IDs like "group-a-env-001" — always look up the actual values.
```
With:
```
1. FIRST: Read `.verify/app.json`. For URLs, check `example_urls` first — these are concrete, resolved URLs ready to use. If a route you need isn't in example_urls, check `routes` for the pattern and resolve parameters using seed data from the data model. Never invent IDs.
```

Replace rule 3 (line 35):
```
3. Every URL must be relative (no scheme, no host). Use real IDs from app.json routes (e.g., if app.json has route "/environments/clseedenvprod000000000/settings", use that exact ID).
```
With:
```
3. Every URL must be relative (no scheme, no host). Prefer example_urls from app.json when available (e.g., if example_urls maps "/t/:teamUrl/settings" to "/t/bxeevwkyrmcdctic/settings", use the concrete URL).
```

**Step 2: Commit**

```bash
git add pipeline/src/prompts/planner.txt
git commit -m "feat(pipeline): update planner prompt to use example_urls from app.json"
```

---

### Task 4: Fix plan validator with regex param matching

**Files:**
- Modify: `pipeline/src/stages/plan-validator.ts`

**Step 1: Replace literal route matching with regex-based param matching**

Replace the entire file:

```typescript
import type { PlannerOutput, PlanValidationResult, PlanValidationError, AppIndex } from "../lib/types.js";

const TEMPLATE_VAR_RE = /\{[a-zA-Z]+\}|__[A-Z_]+__/;
const ABSOLUTE_URL_RE = /^https?:\/\//;

/** Convert a parameterized route like /t/:teamUrl/settings to a regex */
function routeToRegex(route: string): RegExp {
  const pattern = route.replace(/:[a-zA-Z]+/g, "[^/]+");
  return new RegExp(`^${pattern}$`);
}

export function validatePlan(
  plan: PlannerOutput,
  appIndex: AppIndex | null
): PlanValidationResult {
  const errors: PlanValidationError[] = [];
  const knownRoutes = appIndex ? Object.keys(appIndex.routes) : [];
  const routePatterns = knownRoutes.map(r => ({ route: r, re: routeToRegex(r) }));

  for (const ac of plan.criteria) {
    if (TEMPLATE_VAR_RE.test(ac.url)) {
      errors.push({
        acId: ac.id, field: "url",
        message: `URL "${ac.url}" contains a template variable — use real IDs from app.json example_urls`,
      });
    }

    if (ABSOLUTE_URL_RE.test(ac.url)) {
      errors.push({
        acId: ac.id, field: "url",
        message: `URL "${ac.url}" is absolute — use a relative path (baseUrl is prepended automatically)`,
      });
    }

    if (appIndex && !TEMPLATE_VAR_RE.test(ac.url) && !ABSOLUTE_URL_RE.test(ac.url)) {
      const urlBase = ac.url.split("?")[0];
      const routeExists = routePatterns.some(
        ({ re }) => re.test(urlBase)
      );
      if (!routeExists) {
        errors.push({
          acId: ac.id, field: "url",
          message: `URL "${ac.url}" not found in app index routes — verify it exists`,
        });
      }
    }

    if (!ac.steps || ac.steps.length === 0) {
      errors.push({
        acId: ac.id, field: "steps",
        message: "Steps array is empty — every AC must have at least one step",
      });
    }
  }

  return { valid: errors.length === 0, errors };
}
```

Key changes from original:
- `TEMPLATE_VAR_RE` now catches both `{envId}` and `__TEAM_URL__` styles
- `routeToRegex` converts `:param` segments to `[^/]+` for matching
- Stays synchronous — no LLM, no async, no orchestrator changes needed
- All existing deterministic checks preserved

**Step 2: Run typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: Clean

**Step 3: Commit**

```bash
git add pipeline/src/stages/plan-validator.ts
git commit -m "fix(pipeline): param-aware route matching in plan validator

Convert :param segments to [^/]+ regex for matching. Now /t/abc/settings
correctly matches /t/:teamUrl/settings. Also catches __PLACEHOLDER__
style template vars. Stays synchronous — no LLM needed."
```

---

### Task 5: Update tests

**Files:**
- Modify: `pipeline/test/plan-validator.test.ts`
- Modify: any other test files that construct AppIndex objects

**Step 1: Add `example_urls` to all AppIndex test fixtures**

Search for `mockAppIndex` and `AppIndex` across all test files:

```bash
cd pipeline && grep -rn "mockAppIndex\|as AppIndex\|: AppIndex" test/
```

Add `example_urls: {}` to every fixture. For `plan-validator.test.ts`, the mock at line 7-15 becomes:

```typescript
const mockAppIndex: AppIndex = {
  indexed_at: "2026-03-18T00:00:00Z",
  routes: { "/settings": { component: "settings.tsx" }, "/billing": { component: "billing.tsx" } },
  pages: {},
  data_model: {},
  fixtures: {},
  db_url_env: null,
  feature_flags: [],
  seed_ids: {},
  json_type_annotations: {},
  example_urls: {},
};
```

**Step 2: Add test for parameterized route matching**

```typescript
it("passes when URL matches a parameterized route", () => {
  const appIndex = {
    ...mockAppIndex,
    routes: { "/t/:teamUrl/settings": { component: "settings.tsx" } },
  };
  const plan: PlannerOutput = {
    criteria: [{
      id: "ac1", group: "group-a",
      description: "test",
      url: "/t/bxeevwkyrmcdctic/settings",
      steps: ["Navigate to settings"],
      screenshot_at: [],
    }],
  };
  const result = validatePlan(plan, appIndex);
  expect(result.valid).toBe(true);
});
```

**Step 3: Add test for __PLACEHOLDER__ detection**

```typescript
it("catches __PLACEHOLDER__ style template variables", () => {
  const plan: PlannerOutput = {
    criteria: [{
      id: "ac1", group: "group-a",
      description: "test",
      url: "/t/__TEAM_URL__/settings",
      steps: ["Navigate"],
      screenshot_at: [],
    }],
  };
  const result = validatePlan(plan, mockAppIndex);
  expect(result.valid).toBe(false);
  expect(result.errors[0].message).toContain("template variable");
});
```

**Step 4: Run tests**

Run: `cd pipeline && npx vitest run`
Expected: All pass

**Step 5: Commit**

```bash
git add pipeline/test/
git commit -m "test(pipeline): add param route matching + __PLACEHOLDER__ tests

Add example_urls to all AppIndex test fixtures. Test that /t/abc/settings
matches /t/:teamUrl/settings. Test that __TEAM_URL__ is caught as a
template variable."
```

---

### Task 6: E2E verification on both eval apps

**Step 1: Re-index documenso**

```bash
pkill -9 -f "bun run.*browse/src/server.ts" 2>/dev/null; sleep 3
cd ~/Projects/opslane/evals/documenso
npx tsx ~/Projects/opslane/verify/pipeline/src/cli.ts index-app --project-dir . --output .verify/app.json
```

Expected: "Resolved N example URLs" in output. Check `.verify/app.json` has `example_urls` with concrete `/t/...` and `/o/...` URLs.

**Step 2: Run full pipeline on documenso**

```bash
pkill -9 -f "bun run.*browse/src/server.ts" 2>/dev/null; sleep 3
cd ~/Projects/opslane/evals/documenso
npx tsx ~/Projects/opslane/verify/pipeline/src/cli.ts run --spec .verify/spec.md --verify-dir .verify
```

Expected: No plan_error verdicts for URL issues.

**Step 3: Re-index and run calcom**

```bash
pkill -9 -f "bun run.*browse/src/server.ts" 2>/dev/null; sleep 3
cd ~/Projects/opslane/evals/calcom
npx tsx ~/Projects/opslane/verify/pipeline/src/cli.ts index-app --project-dir . --output .verify/app.json
```

Then run full pipeline and verify all ACs pass.
