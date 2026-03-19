# WS6: Integration — Detailed Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete the pipeline v2 by extending the app indexer with Prisma column mappings and seed IDs, porting it to TypeScript, updating SKILL.md files, and running a full e2e validation.

**Architecture:** The app indexer runs once during `/verify-setup` to build `.verify/app.json`. It combines 4 parallel LLM agents (routes, selectors, schema, fixtures) with a deterministic Prisma `@map` parser and seed ID extractor. The setup writer then reads `app.json` for correct Postgres column names and existing seed record IDs.

**Tech Stack:** TypeScript 5, Node 22 ESM, vitest, tsx. Prisma schema parsing is pure regex — no LLM, no dependencies.

**Parent plan:** `docs/plans/2026-03-18-pipeline-v2-implementation.md` (WS6 section)

---

## Context from E2E Testing

11 eval runs against Formbricks revealed these setup writer failures:

1. **Column name mismatch:** Setup writer used Prisma names (`stripeCustomerId`) but Postgres has `stripe_customer_id` (via `@map`). SQL failed with `column does not exist`.
2. **Created new records instead of updating seed data:** Invented `groupb-org-00000000000001` instead of updating `clseedorg0000000000000`. Created FK chains that broke on teardown.
3. **Teardown destroyed seed data:** Fixed with DB snapshot/restore (already on main). But setup still needs correct column names and seed IDs.

Both fixes are deterministic — parse `@map` from Prisma schema, grep seed IDs from seed files. No LLM needed.

---

## Task 1: Extend AppIndex type with column mappings and seed IDs

**Files:**
- Modify: `pipeline/src/lib/types.ts`

**Step 1: Write the type changes**

Change `data_model` from:
```typescript
data_model: Record<string, {
  columns: string[];
  enums: Record<string, string[]>;
  source: string;
}>;
```

To:
```typescript
data_model: Record<string, {
  columns: Record<string, string>;    // prismaFieldName → postgresColumnName
  table_name: string;                 // actual Postgres table name (from @@map, or model name)
  enums: Record<string, string[]>;
  source: string;
}>;
```

Add new top-level field after `feature_flags`:
```typescript
seed_ids: Record<string, string[]>;   // modelName → array of known seed record IDs
```

**Step 2: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: Errors in `app-index.test.ts` and fixture file (type shape changed). That's fine — we fix those next.

**Step 3: Commit**

```bash
git add pipeline/src/lib/types.ts
git commit -m "feat(pipeline): extend AppIndex type with column mappings and seed IDs"
```

---

## Task 2: Update test fixture and app-index tests

**Files:**
- Modify: `pipeline/test/fixtures/app-index.json`
- Modify: `pipeline/test/app-index.test.ts`

**Step 1: Update fixture to new shape**

```json
{
  "indexed_at": "2026-03-18T14:00:00Z",
  "routes": {
    "/dashboard": { "component": "app/dashboard/page.tsx" },
    "/settings": { "component": "app/settings/page.tsx" },
    "/billing": { "component": "app/billing/page.tsx" }
  },
  "pages": {
    "/dashboard": {
      "selectors": { "sidebar": { "value": "[data-testid=sidebar]", "source": "tests/dash.spec.ts:12" } },
      "source_tests": ["tests/dash.spec.ts"]
    }
  },
  "data_model": {
    "Organization": {
      "columns": { "id": "id", "name": "name", "billingStatus": "billing_status" },
      "table_name": "Organization",
      "enums": { "BillingStatus": ["active", "trialing", "canceled"] },
      "source": "prisma/schema.prisma:42"
    }
  },
  "fixtures": {
    "createOrg": {
      "description": "Creates a test organization",
      "runner": null,
      "source": "tests/helpers.ts:10"
    }
  },
  "db_url_env": "DATABASE_URL",
  "feature_flags": ["FF_BILLING_V2"],
  "seed_ids": {
    "Organization": ["clseedorg0000000000000"],
    "Environment": ["clseedenvprod000000000"]
  }
}
```

**Step 2: Update app-index.test.ts**

Update the test that reads the fixture to use the new `columns` shape (Record instead of array). Also add a test for `seed_ids`:

```typescript
it("reads and parses app.json with column mappings", () => {
  writeFileSync(join(verifyDir, "app.json"), JSON.stringify(fixture));
  const result = loadAppIndex(verifyDir);
  expect(result).not.toBeNull();
  expect(result!.data_model.Organization.columns.billingStatus).toBe("billing_status");
  expect(result!.data_model.Organization.table_name).toBe("Organization");
  expect(result!.seed_ids.Organization).toContain("clseedorg0000000000000");
});
```

**Step 3: Run tests — expect PASS**

Run: `cd pipeline && npx vitest run test/app-index.test.ts`

**Step 4: Run full suite — expect PASS**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`

**Step 5: Commit**

```bash
git add pipeline/test/fixtures/app-index.json pipeline/test/app-index.test.ts
git commit -m "test(pipeline): update app-index fixture and tests for column mappings"
```

---

## Task 3: Implement parsePrismaSchema

**Files:**
- Create: `pipeline/src/lib/prisma-parser.ts`
- Create: `pipeline/test/prisma-parser.test.ts`

This is a pure, deterministic string parser. No LLM, no network. It reads a Prisma schema file and extracts model→table name mappings and field→column name mappings from `@map` and `@@map` annotations.

**Step 1: Write the failing tests**

```typescript
// pipeline/test/prisma-parser.test.ts
import { describe, it, expect } from "vitest";
import { parsePrismaSchema } from "../src/lib/prisma-parser.js";

describe("parsePrismaSchema", () => {
  it("extracts column mappings from @map annotations", () => {
    const schema = `
model OrganizationBilling {
  organizationId   String @id @map("organization_id")
  stripeCustomerId String? @map("stripe_customer_id")
  limits           Json   @default("{}")
  stripe           Json   @default("{}")
  createdAt        DateTime @default(now()) @map("created_at")
  updatedAt        DateTime @updatedAt @map("updated_at")

  @@map("OrganizationBilling")
}`;
    const result = parsePrismaSchema(schema);
    expect(result.OrganizationBilling).toBeDefined();
    expect(result.OrganizationBilling.columns.stripeCustomerId).toBe("stripe_customer_id");
    expect(result.OrganizationBilling.columns.organizationId).toBe("organization_id");
    expect(result.OrganizationBilling.columns.limits).toBe("limits");
    expect(result.OrganizationBilling.columns.stripe).toBe("stripe");
    expect(result.OrganizationBilling.columns.createdAt).toBe("created_at");
  });

  it("uses model name as table name when no @@map", () => {
    const schema = `
model User {
  id    String @id @default(cuid())
  name  String
  email String @unique
}`;
    const result = parsePrismaSchema(schema);
    expect(result.User.table_name).toBe("User");
    expect(result.User.columns.id).toBe("id");
    expect(result.User.columns.name).toBe("name");
  });

  it("uses @@map value as table name", () => {
    const schema = `
model ApiKey {
  id        String @id
  label     String
  createdAt DateTime @default(now()) @map("created_at")

  @@map("api_keys")
}`;
    const result = parsePrismaSchema(schema);
    expect(result.ApiKey.table_name).toBe("api_keys");
  });

  it("handles multiple models", () => {
    const schema = `
model User {
  id   String @id
  name String
}

model Organization {
  id   String @id
  name String
  isAIEnabled Boolean @default(false) @map("is_ai_enabled")
}`;
    const result = parsePrismaSchema(schema);
    expect(Object.keys(result)).toHaveLength(2);
    expect(result.User.columns.id).toBe("id");
    expect(result.Organization.columns.isAIEnabled).toBe("is_ai_enabled");
  });

  it("skips relation fields (no scalar type)", () => {
    const schema = `
model User {
  id           String        @id
  name         String
  memberships  Membership[]
  organization Organization? @relation(fields: [orgId], references: [id])
  orgId        String?       @map("org_id")
}`;
    const result = parsePrismaSchema(schema);
    expect(result.User.columns.id).toBe("id");
    expect(result.User.columns.name).toBe("name");
    expect(result.User.columns.orgId).toBe("org_id");
    // Relation fields should NOT appear as columns
    expect(result.User.columns.memberships).toBeUndefined();
    expect(result.User.columns.organization).toBeUndefined();
  });

  it("handles empty schema", () => {
    const result = parsePrismaSchema("");
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("handles schema with only enums and datasource", () => {
    const schema = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  owner
  admin
  member
}`;
    const result = parsePrismaSchema(schema);
    expect(Object.keys(result)).toHaveLength(0);
  });
});
```

**Step 2: Run tests — expect FAIL**

Run: `cd pipeline && npx vitest run test/prisma-parser.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement**

```typescript
// pipeline/src/lib/prisma-parser.ts

interface PrismaModel {
  table_name: string;
  columns: Record<string, string>; // prismaFieldName → postgresColumnName
}

// Scalar types that represent actual DB columns (not relations)
const SCALAR_TYPES = new Set([
  "String", "Int", "Float", "Boolean", "DateTime", "Json", "BigInt", "Decimal", "Bytes",
]);

/**
 * Parse a Prisma schema file and extract model→table and field→column mappings.
 *
 * - @map("column_name") on a field → that field's Postgres column name
 * - @@map("table_name") on a model → that model's Postgres table name
 * - No @map → Postgres name = Prisma name
 * - Relation fields (type is another model or Model[]) are skipped
 */
export function parsePrismaSchema(content: string): Record<string, PrismaModel> {
  const models: Record<string, PrismaModel> = {};

  // Match each "model ModelName { ... }" block
  const modelRegex = /model\s+(\w+)\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;

  while ((match = modelRegex.exec(content)) !== null) {
    const modelName = match[1];
    const body = match[2];

    // Check for @@map("table_name")
    const tableMapMatch = body.match(/@@map\(\s*"([^"]+)"\s*\)/);
    const tableName = tableMapMatch ? tableMapMatch[1] : modelName;

    const columns: Record<string, string> = {};

    // Parse each line in the model body
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("@@")) continue;

      // Match: fieldName  Type  ...modifiers...
      const fieldMatch = trimmed.match(/^(\w+)\s+(\w+)(\?|\[\])?\s*(.*)/);
      if (!fieldMatch) continue;

      const [, fieldName, fieldType, modifier] = fieldMatch;

      // Skip relation fields: type[] or type that's not a scalar
      if (modifier === "[]") continue;
      if (!SCALAR_TYPES.has(fieldType)) continue;

      // Check for @map("column_name")
      const mapMatch = trimmed.match(/@map\(\s*"([^"]+)"\s*\)/);
      columns[fieldName] = mapMatch ? mapMatch[1] : fieldName;
    }

    models[modelName] = { table_name: tableName, columns };
  }

  return models;
}
```

**Step 4: Run tests — expect PASS**

Run: `cd pipeline && npx vitest run test/prisma-parser.test.ts`

**Step 5: Commit**

```bash
git add pipeline/src/lib/prisma-parser.ts pipeline/test/prisma-parser.test.ts
git commit -m "feat(pipeline): add deterministic Prisma @map parser for column name extraction"
```

---

## Task 4: Implement seed ID extractor

**Files:**
- Create: `pipeline/src/lib/seed-extractor.ts`
- Create: `pipeline/test/seed-extractor.test.ts`

Extracts hardcoded IDs from seed files by looking for patterns like CUIDs, UUIDs, and prefixed IDs.

**Step 1: Write the failing tests**

```typescript
// pipeline/test/seed-extractor.test.ts
import { describe, it, expect } from "vitest";
import { extractSeedIds, groupSeedIdsByContext } from "../src/lib/seed-extractor.js";

describe("extractSeedIds", () => {
  it("finds CUID-like IDs (cl prefix + alphanumeric)", () => {
    const content = `
      const orgId = "clseedorg0000000000000";
      const envId = "clseedenvprod000000000";
    `;
    const ids = extractSeedIds(content);
    expect(ids).toContain("clseedorg0000000000000");
    expect(ids).toContain("clseedenvprod000000000");
  });

  it("finds UUIDs", () => {
    const content = `const id = "a0b1c2d3-e4f5-6789-abcd-ef0123456789";`;
    const ids = extractSeedIds(content);
    expect(ids).toContain("a0b1c2d3-e4f5-6789-abcd-ef0123456789");
  });

  it("deduplicates", () => {
    const content = `
      const a = "clseedorg0000000000000";
      const b = "clseedorg0000000000000";
    `;
    const ids = extractSeedIds(content);
    expect(ids.filter(id => id === "clseedorg0000000000000")).toHaveLength(1);
  });

  it("ignores short strings and non-ID patterns", () => {
    const content = `
      const name = "hello";
      const email = "user@example.com";
      const count = "12345";
    `;
    const ids = extractSeedIds(content);
    expect(ids).toHaveLength(0);
  });
});

describe("groupSeedIdsByContext", () => {
  it("groups IDs by nearby model/table references", () => {
    const content = `
      // Seed Organization
      const orgId = "clseedorg0000000000000";
      await prisma.organization.create({ data: { id: orgId }});

      // Seed Environment
      const envId = "clseedenvprod000000000";
      await prisma.environment.create({ data: { id: envId }});
    `;
    const grouped = groupSeedIdsByContext(content);
    expect(grouped.Organization ?? grouped.organization).toContain("clseedorg0000000000000");
    expect(grouped.Environment ?? grouped.environment).toContain("clseedenvprod000000000");
  });

  it("returns ungrouped IDs under '_unknown'", () => {
    const content = `const id = "clsomerandoid000000000";`;
    const grouped = groupSeedIdsByContext(content);
    expect(grouped._unknown).toContain("clsomerandoid000000000");
  });
});
```

**Step 2: Run tests — expect FAIL**

**Step 3: Implement**

```typescript
// pipeline/src/lib/seed-extractor.ts

// CUID pattern: starts with 'cl' or 'cm' followed by 15+ alphanumeric chars
const CUID_RE = /\b(c[lm][a-z0-9]{15,})\b/g;
// UUID pattern
const UUID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

/**
 * Extract hardcoded seed IDs from file content.
 * Looks for CUIDs, UUIDs, and similar patterns inside quotes.
 */
export function extractSeedIds(content: string): string[] {
  const ids = new Set<string>();

  // Find quoted strings that look like IDs
  const quotedStrings = content.matchAll(/["']([^"']{15,})["']/g);
  for (const m of quotedStrings) {
    const val = m[1];
    if (CUID_RE.test(val)) { ids.add(val); CUID_RE.lastIndex = 0; }
    else if (UUID_RE.test(val)) { ids.add(val); UUID_RE.lastIndex = 0; }
  }

  return [...ids];
}

/**
 * Group seed IDs by nearby model/table references.
 * Looks for prisma.modelName or "ModelName" within 5 lines of the ID.
 */
export function groupSeedIdsByContext(content: string): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const lineIds = extractSeedIds(lines[i]);
    if (lineIds.length === 0) continue;

    // Search surrounding lines (±5) for model references
    let modelName: string | null = null;
    for (let j = Math.max(0, i - 5); j <= Math.min(lines.length - 1, i + 5); j++) {
      // prisma.modelName.create/upsert
      const prismaMatch = lines[j].match(/prisma\.(\w+)\./);
      if (prismaMatch) {
        // Capitalize first letter to match Prisma model convention
        modelName = prismaMatch[1].charAt(0).toUpperCase() + prismaMatch[1].slice(1);
        break;
      }
      // "ModelName" in a comment
      const commentMatch = lines[j].match(/(?:Seed|Create|Insert)\s+(\w+)/i);
      if (commentMatch) {
        modelName = commentMatch[1];
        break;
      }
    }

    const key = modelName ?? "_unknown";
    if (!groups[key]) groups[key] = [];
    for (const id of lineIds) {
      if (!groups[key].includes(id)) groups[key].push(id);
    }
  }

  return groups;
}
```

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
git add pipeline/src/lib/seed-extractor.ts pipeline/test/seed-extractor.test.ts
git commit -m "feat(pipeline): add seed ID extractor for setup writer grounding"
```

---

## Task 5: Implement index-app.ts (app indexer port)

**Files:**
- Create: `pipeline/src/lib/index-app.ts`
- Create: `pipeline/test/index-app.test.ts`
- Create: `pipeline/src/prompts/index/routes.txt`
- Create: `pipeline/src/prompts/index/selectors.txt`
- Create: `pipeline/src/prompts/index/schema.txt`
- Create: `pipeline/src/prompts/index/fixtures.txt`

Port `index-app.sh` from the worktree. This is the main indexer that `/verify-setup` calls.

**Step 1: Copy prompt templates from the worktree analysis**

The 4 prompt files are documented in the codebase analysis from earlier in this conversation. Create them at `pipeline/src/prompts/index/`. Each prompt instructs Claude to write its JSON to a specific output file (the `OUTPUT_FILE` placeholder is substituted at runtime).

**routes.txt:**
```
Find all user-facing pages and routes in this app. Look for route definitions, page components, URL patterns.

Check any framework: Next.js (app/ or pages/), Remix (routes/), React Router configs, Express/Hono route definitions, etc. This may be a monorepo — check under apps/, packages/, src/.

Write the result as JSON to the file: OUTPUT_FILE

Schema:
{"routes": {"/path": {"component": "file/path.tsx"}}}

The root key MUST be "routes". Each key is a URL path. Each value has a "component" field with the file path. Skip API routes (/api/*). Only include user-facing pages.

If you can't find any routes, write: {"routes": {}}
```

**selectors.txt:**
```
Find the e2e/integration test suite in this project. For each test file, extract the selectors used and the page URLs they test against.

Look for: Playwright tests (.spec.ts), Cypress tests (.cy.ts), or similar. This may be a monorepo — check under packages/, apps/, tests/, e2e/.

For each test, extract:
- URLs from page.goto(), cy.visit(), or equivalent navigation calls
- Selectors from page.locator(), page.getByTestId(), page.getByRole(), cy.get(), etc.
- If tests use Page Object Models or helper files, follow the imports to resolve actual selectors

Group selectors by the URL/page they're used on. Keep it compact — max 10 selectors per page. Prefer data-testid and role selectors.

Write the result as JSON to the file: OUTPUT_FILE

Schema:
{"pages": {"/url": {"selectors": {"name": {"value": ".selector", "source": "file:line"}}, "source_tests": ["file.spec.ts"]}}}

The root key MUST be "pages". Selector names should be human-readable keys.

If you can't find any test suite, write: {"pages": {}}
```

**schema.txt:**
```
Find the database schema in this project. Look for Prisma schema, Drizzle schema, SQL migrations, or ORM model definitions. This may be a monorepo — check under packages/, prisma/, db/, src/.

Extract all models/tables with their columns and any enums.

Write the result as JSON to the file: OUTPUT_FILE

Schema:
{"data_model": {"ModelName": {"columns": ["id", "name", "email"], "enums": {"RoleName": ["admin", "member"]}, "source": "prisma/schema.prisma:42"}}}

The root key MUST be "data_model". Each key is a model/table name. Columns is an array of column names (use the Prisma field names). Enums maps enum names to their values. Include source file and line.

If you can't find any schema, write: {"data_model": {}}
```

**fixtures.txt:**
```
Find test setup helpers, fixture factories, and seed scripts in this project. Look for functions that create test data (users, organizations, documents, etc).

Check: test helper files, fixture directories, beforeEach/beforeAll blocks, factory functions, seed scripts. This may be a monorepo — check under packages/, tests/, e2e/.

For each fixture, identify what state it creates, how to invoke it, and where it's defined.

Write the result as JSON to the file: OUTPUT_FILE

Schema:
{"fixtures": {"functionName": {"description": "what it creates", "runner": "command to run it or null", "source": "file:line"}}}

The root key MUST be "fixtures". Use the function name as the key. "runner" is a shell command to invoke it (null if only callable from test code). Include source file and line.

If you can't find any fixtures, write: {"fixtures": {}}
```

**Step 2: Write the failing tests for index-app.ts**

```typescript
// pipeline/test/index-app.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { extractEnvVars, mergeIndexResults, findPrismaSchemaPath } from "../src/lib/index-app.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("extractEnvVars", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = join(tmpdir(), `verify-index-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });
  });
  afterEach(() => { rmSync(projectDir, { recursive: true, force: true }); });

  it("finds DATABASE_URL from .env", () => {
    writeFileSync(join(projectDir, ".env"), "DATABASE_URL=postgres://localhost/db\nSECRET=abc");
    const result = extractEnvVars(projectDir);
    expect(result.db_url_env).toBe("DATABASE_URL");
  });

  it("finds FEATURE_FLAG_ vars", () => {
    writeFileSync(join(projectDir, ".env"), "FEATURE_FLAG_BILLING=1\nFF_NEW_UI=true\nOTHER=value");
    const result = extractEnvVars(projectDir);
    expect(result.feature_flags).toContain("FEATURE_FLAG_BILLING");
    expect(result.feature_flags).toContain("FF_NEW_UI");
  });

  it("returns nulls when no .env exists", () => {
    const result = extractEnvVars(projectDir);
    expect(result.db_url_env).toBeNull();
    expect(result.feature_flags).toEqual([]);
  });
});

describe("mergeIndexResults", () => {
  it("merges 4 agent results + env + prisma mappings", () => {
    const result = mergeIndexResults(
      { routes: { "/dashboard": { component: "dash.tsx" } } },
      { pages: {} },
      { data_model: { User: { columns: ["id", "name"], enums: {}, source: "schema.prisma:1" } } },
      { fixtures: {} },
      { db_url_env: "DATABASE_URL", feature_flags: [] },
      { User: { table_name: "User", columns: { id: "id", name: "name" } } },
      { User: ["clseeduser0000000000000"] }
    );
    expect(result.routes["/dashboard"]).toBeDefined();
    expect(result.data_model.User.columns.id).toBe("id");
    expect(result.data_model.User.table_name).toBe("User");
    expect(result.seed_ids.User).toContain("clseeduser0000000000000");
    expect(result.indexed_at).toBeDefined();
  });

  it("cross-references routes into pages", () => {
    const result = mergeIndexResults(
      { routes: { "/settings": { component: "settings.tsx" } } },
      { pages: {} },
      { data_model: {} },
      { fixtures: {} },
      { db_url_env: null, feature_flags: [] },
      {},
      {}
    );
    expect(result.pages["/settings"]).toBeDefined();
    expect(result.pages["/settings"].selectors).toEqual({});
  });
});

describe("findPrismaSchemaPath", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = join(tmpdir(), `verify-prisma-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });
  });
  afterEach(() => { rmSync(projectDir, { recursive: true, force: true }); });

  it("finds prisma/schema.prisma at root", () => {
    mkdirSync(join(projectDir, "prisma"), { recursive: true });
    writeFileSync(join(projectDir, "prisma", "schema.prisma"), "model User {}");
    expect(findPrismaSchemaPath(projectDir)).toContain("schema.prisma");
  });

  it("finds packages/database/schema.prisma in monorepo", () => {
    mkdirSync(join(projectDir, "packages", "database"), { recursive: true });
    writeFileSync(join(projectDir, "packages", "database", "schema.prisma"), "model User {}");
    expect(findPrismaSchemaPath(projectDir)).toContain("schema.prisma");
  });

  it("returns null when no schema exists", () => {
    expect(findPrismaSchemaPath(projectDir)).toBeNull();
  });
});
```

**Step 3: Run tests — expect FAIL**

**Step 4: Implement index-app.ts**

```typescript
// pipeline/src/lib/index-app.ts
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AppIndex } from "./types.js";
import { parsePrismaSchema } from "./prisma-parser.js";
import { extractSeedIds, groupSeedIdsByContext } from "./seed-extractor.js";

/**
 * Extract DATABASE_URL env var name and feature flags from .env files.
 * Pure string parsing — no LLM.
 */
export function extractEnvVars(projectRoot: string): {
  db_url_env: string | null;
  feature_flags: string[];
} {
  let dbUrlEnv: string | null = null;
  const featureFlags: string[] = [];

  for (const candidate of [".env.example", ".env", ".env.local"]) {
    const envPath = join(projectRoot, candidate);
    if (!existsSync(envPath)) continue;
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx);
      if (!dbUrlEnv && /DATABASE/i.test(key)) dbUrlEnv = key;
      if (/^(FEATURE_FLAG_|FF_)/i.test(key)) featureFlags.push(key);
    }
    break;
  }

  return { db_url_env: dbUrlEnv, feature_flags: featureFlags };
}

/**
 * Find the Prisma schema file in a project. Checks common monorepo locations.
 */
export function findPrismaSchemaPath(projectRoot: string): string | null {
  const candidates = [
    join(projectRoot, "prisma", "schema.prisma"),
    join(projectRoot, "packages", "database", "schema.prisma"),
    join(projectRoot, "packages", "database", "prisma", "schema.prisma"),
    join(projectRoot, "packages", "db", "schema.prisma"),
    join(projectRoot, "schema.prisma"),
  ];
  // Also search packages/*/schema.prisma and packages/*/prisma/schema.prisma
  const packagesDir = join(projectRoot, "packages");
  if (existsSync(packagesDir)) {
    try {
      for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
        if (!pkg.isDirectory()) continue;
        candidates.push(join(packagesDir, pkg.name, "schema.prisma"));
        candidates.push(join(packagesDir, pkg.name, "prisma", "schema.prisma"));
      }
    } catch { /* permission errors, etc */ }
  }
  return candidates.find(p => existsSync(p)) ?? null;
}

/**
 * Find seed files in a project. Returns file paths.
 */
export function findSeedFiles(projectRoot: string): string[] {
  const candidates = [
    join(projectRoot, "prisma", "seed.ts"),
    join(projectRoot, "prisma", "seed.js"),
    join(projectRoot, "packages", "database", "src", "seed.ts"),
    join(projectRoot, "packages", "database", "seed.ts"),
    join(projectRoot, "seed.ts"),
    join(projectRoot, "seed.sql"),
  ];
  // Also check packages/database/src/seed/ directory
  const seedDir = join(projectRoot, "packages", "database", "src", "seed");
  if (existsSync(seedDir)) {
    try {
      for (const f of readdirSync(seedDir, { withFileTypes: true })) {
        if (f.isFile() && (f.name.endsWith(".ts") || f.name.endsWith(".js"))) {
          candidates.push(join(seedDir, f.name));
        }
      }
    } catch { /* permission errors */ }
  }
  return candidates.filter(p => existsSync(p));
}

/**
 * Merge all index results into a single AppIndex.
 */
export function mergeIndexResults(
  routes: { routes: Record<string, { component: string }> },
  selectors: { pages: Record<string, { selectors: Record<string, { value: string; source: string }>; source_tests: string[] }> },
  schema: { data_model: Record<string, { columns: string[]; enums: Record<string, string[]>; source: string }> },
  fixtures: { fixtures: Record<string, { description: string; runner: string | null; source: string }> },
  envVars: { db_url_env: string | null; feature_flags: string[] },
  prismaMapping: Record<string, { table_name: string; columns: Record<string, string> }>,
  seedIds: Record<string, string[]>
): AppIndex {
  // Merge prisma column mappings into data_model
  const dataModel: AppIndex["data_model"] = {};
  for (const [modelName, modelData] of Object.entries(schema.data_model ?? {})) {
    const mapping = prismaMapping[modelName];
    dataModel[modelName] = {
      columns: mapping?.columns ?? Object.fromEntries(modelData.columns.map(c => [c, c])),
      table_name: mapping?.table_name ?? modelName,
      enums: modelData.enums,
      source: modelData.source,
    };
  }

  // Cross-reference: ensure every route has a pages entry
  const pages = { ...selectors.pages };
  for (const routeKey of Object.keys(routes.routes ?? {})) {
    if (!pages[routeKey]) {
      pages[routeKey] = { selectors: {}, source_tests: [] };
    }
  }

  return {
    indexed_at: new Date().toISOString(),
    routes: routes.routes ?? {},
    pages,
    data_model: dataModel,
    fixtures: fixtures.fixtures ?? {},
    db_url_env: envVars.db_url_env,
    feature_flags: envVars.feature_flags,
    seed_ids: seedIds,
  };
}
```

**Step 5: Run tests — expect PASS**

Run: `cd pipeline && npx vitest run test/index-app.test.ts`

**Step 6: Commit**

```bash
git add pipeline/src/lib/index-app.ts pipeline/test/index-app.test.ts pipeline/src/prompts/index/
git commit -m "feat(pipeline): port app indexer with Prisma column mapping and seed ID extraction"
```

---

## Task 6: Update setup writer prompt to use column mappings

**Files:**
- Modify: `pipeline/src/prompts/setup-writer.txt`

**Step 1: Update the prompt**

Replace the current `pipeline/src/prompts/setup-writer.txt` with:

```
You are a setup writer. Your job is to generate SQL commands to put the application database into a specific state for testing.

GROUP: {{groupId}}
CONDITION: {{condition}}

FIRST: Read `.verify/app.json`. It contains:
- data_model: each model has "columns" mapping Prisma field names to actual Postgres column names,
  and "table_name" for the actual Postgres table name.
- seed_ids: existing record IDs per table — UPDATE these, don't create new records.
- db_url_env: the env var name for the database URL.

Also read `.verify/learnings.md` if present — it has corrections from past runs.

CRITICAL — COLUMN NAMES:
The "columns" field in app.json maps Prisma names (keys) to Postgres names (values).
ALWAYS use the Postgres name (the VALUE) in your SQL, never the Prisma name (the KEY).

Example — app.json says:
  "OrganizationBilling": {
    "table_name": "OrganizationBilling",
    "columns": {"organizationId": "organization_id", "stripeCustomerId": "stripe_customer_id", "stripe": "stripe"}
  }
  "seed_ids": {"Organization": ["clseedorg0000000000000"]}

CORRECT SQL:
  UPDATE "OrganizationBilling" SET stripe = '{"subscriptionStatus":"trialing"}'
    WHERE organization_id = 'clseedorg0000000000000';

WRONG SQL (uses Prisma field name as column):
  WHERE "organizationId" = '...'   ← WRONG, Postgres column is "organization_id"
  WHERE "stripeCustomerId" = '...' ← WRONG, Postgres column is "stripe_customer_id"

OUTPUT: Write valid JSON to stdout with this exact schema:

{
  "group_id": "{{groupId}}",
  "condition": "{{condition}}",
  "setup_commands": [
    "psql \"${DATABASE_URL%%\\?*}\" --set ON_ERROR_STOP=1 -c \"UPDATE ...\""
  ],
  "teardown_commands": []
}

RULES:
1. ALWAYS use `psql "${DATABASE_URL%%\?*}" --set ON_ERROR_STOP=1 -c "..."`.
2. ALWAYS look up column names in app.json before writing SQL. Use the Postgres column name (the value in the columns mapping), not the Prisma field name (the key).
3. PREFER updating existing seed records (from seed_ids) over creating new ones.
4. Use INSERT ... ON CONFLICT DO UPDATE for idempotent setup when you must create new rows.
5. Quote mixed-case table/column names with double quotes.
6. If the condition is null or empty, output empty arrays.
7. teardown_commands must be an empty array — the orchestrator handles DB restoration via snapshots.

Output ONLY the JSON. No explanation, no markdown fences.
```

**Step 2: Commit**

```bash
git add pipeline/src/prompts/setup-writer.txt
git commit -m "feat(pipeline): setup writer prompt reads column mappings + seed IDs from app.json"
```

---

## Task 7: Add index-app CLI subcommand

**Files:**
- Modify: `pipeline/src/cli.ts`

Add an `index-app` subcommand so `/verify-setup` can call it:

```bash
npx tsx pipeline/src/cli.ts index-app --project-dir /path/to/project --output .verify/app.json
```

Add to the CLI after the `run-stage` switch:

```typescript
} else if (command === "index-app") {
  const projectDir = values["project-dir"] ?? process.cwd();
  const output = values.output ?? join(projectDir, ".verify", "app.json");

  const { extractEnvVars, findPrismaSchemaPath, findSeedFiles, mergeIndexResults } = await import("./lib/index-app.js");
  const { parsePrismaSchema } = await import("./lib/prisma-parser.js");
  const { groupSeedIdsByContext } = await import("./lib/seed-extractor.js");
  const { runClaude } = await import("./run-claude.js");
  const { STAGE_PERMISSIONS } = await import("./lib/types.js");
  // ... spawn 4 parallel runClaude agents, merge results, write to output
}
```

Add `"project-dir"` and `"output"` to the parseArgs options.

**Step 1: Implement**

**Step 2: Commit**

```bash
git add pipeline/src/cli.ts
git commit -m "feat(pipeline): add index-app CLI subcommand for /verify-setup"
```

---

## Task 8: E2E checkpoint — verify setup writer with column mappings

**This is a manual test, not automated.**

1. Run the indexer against the Formbricks eval repo:

```bash
cd pipeline
npx tsx src/cli.ts index-app \
  --project-dir ~/Projects/opslane/evals/formbricks \
  --output ~/Projects/opslane/evals/formbricks/.verify/app.json
```

2. Inspect `app.json` — verify column mappings:

```bash
jq '.data_model.OrganizationBilling.columns' ~/Projects/opslane/evals/formbricks/.verify/app.json
# Should show: {"organizationId": "organization_id", "stripeCustomerId": "stripe_customer_id", ...}
```

3. Verify seed IDs:

```bash
jq '.seed_ids' ~/Projects/opslane/evals/formbricks/.verify/app.json
# Should show: {"Organization": ["clseedorg0000000000000"], "Environment": ["clseedenvprod000000000"], ...}
```

4. Run the setup writer and check it uses Postgres column names:

```bash
npx tsx src/cli.ts run-stage setup-writer \
  --verify-dir ~/Projects/opslane/evals/formbricks/.verify \
  --run-dir /tmp/ws6-test \
  --group group-a \
  --condition "Organization in trialing state with no payment method"
cat /tmp/ws6-test/setup.json | jq '.setup_commands'
# Should use "organization_id" not "organizationId"
```

5. Run the full pipeline:

```bash
npx tsx src/cli.ts run \
  --spec ~/Projects/opslane/evals/formbricks/.verify/spec.md \
  --verify-dir ~/Projects/opslane/evals/formbricks/.verify
```

**If the setup writer still uses wrong column names, debug before continuing.**

---

## Task 9: Update /verify-setup SKILL.md

**Files:**
- Modify: `skills/verify-setup/SKILL.md`

Add Step 7 (app indexing) to the skill. After auth is confirmed, run:

```bash
npx tsx ~/.claude/tools/verify/pipeline/src/cli.ts index-app \
  --project-dir . \
  --output .verify/app.json
```

Then display a summary (pages, routes, models, seed IDs).

**Step 1: Commit**

```bash
git add skills/verify-setup/SKILL.md
git commit -m "feat(pipeline): add app indexing step to /verify-setup"
```

---

## Task 10: Rewrite /verify SKILL.md

**Files:**
- Modify: `skills/verify/SKILL.md`

Replace all bash script calls with the TypeScript pipeline:

```bash
# Old
VERIFY_ALLOW_DANGEROUS=1 bash ~/.claude/tools/verify/orchestrate.sh

# New
npx tsx ~/.claude/tools/verify/pipeline/src/cli.ts run --spec "$SPEC_PATH"
```

The conversation flow stays the same (spec intake → ambiguity resolution → execution → results). Only the execution commands change.

**Step 1: Commit**

```bash
git add skills/verify/SKILL.md
git commit -m "feat(pipeline): rewrite /verify SKILL.md to use TypeScript pipeline"
```

---

## Task 11: Update skill sync hook

**Files:**
- Modify: `.claude/hooks/sync-skill.sh`

Add a case for `pipeline/` files:

```bash
*pipeline/src/*|*pipeline/package.json|*pipeline/tsconfig.json)
  mkdir -p ~/.claude/tools/verify/pipeline
  rsync -a --delete pipeline/ ~/.claude/tools/verify/pipeline/
  echo "synced pipeline/ → ~/.claude/tools/verify/pipeline/" >&2
  ;;
```

**Step 1: Commit**

```bash
git add .claude/hooks/sync-skill.sh
git commit -m "feat(pipeline): add pipeline/ sync to skill hook"
```

---

## Task 12: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

Update:
- Pipeline section → points to `pipeline/` instead of `scripts/`
- Commands → `cd pipeline && npx vitest run` instead of `bash tests/test_*.sh`
- Structure → reflect new layout
- Verification → `cd pipeline && npx tsc --noEmit && npx vitest run`

**Step 1: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for pipeline v2"
```

---

## Task 13: Full end-to-end test

Run the complete flow on the Formbricks eval repo:

1. `/verify-setup` (generates app.json with column mappings + seed IDs)
2. `/verify` against the trial alerts spec
3. Verify: all ACs reach the browse agent, setup SQL uses correct column names, no seed data destruction, judge produces verdicts

This is the final acceptance test for pipeline v2.

---

## Verification Checklist

After all tasks, verify:

```bash
cd pipeline && npx tsc --noEmit       # No type errors
cd pipeline && npx vitest run          # All tests pass
# Full pipeline run against formbricks  # At least 3/6 ACs pass
```
