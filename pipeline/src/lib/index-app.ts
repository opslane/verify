// pipeline/src/lib/index-app.ts — App indexer: merges LLM agent results with deterministic parsing
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import type { AppIndex } from "./types.js";
import type { PrismaModel } from "./prisma-parser.js";

/**
 * Run pg_dump --schema-only against the project's database.
 * Returns raw DDL string, or null if DATABASE_URL is missing or pg_dump fails.
 * Generic — works for any Postgres-backed project regardless of ORM.
 */
export function dumpDatabaseSchema(env: Record<string, string | undefined>, dbUrlEnv?: string | null): string | null {
  const dbUrl = (dbUrlEnv ? env[dbUrlEnv] : undefined) ?? env.DATABASE_URL ?? env.DATABASE_URI ?? env.DB_URL;
  if (!dbUrl) return null;

  // Strip query params for pg_dump (same pattern as setup-writer psql commands)
  const cleanUrl = dbUrl.split("?")[0];

  try {
    const ddl = execSync(`pg_dump --schema-only "${cleanUrl}"`, {
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return ddl.toString("utf-8");
  } catch {
    return null;
  }
}

/**
 * Sample actual rows from all data_model tables so the setup-writer can reference real data.
 * For each model in data_model, runs SELECT * LIMIT 5 with column truncation.
 * Returns a human-readable text dump, or null if DB is unreachable.
 */
export function dumpSeedData(
  dataModel: AppIndex["data_model"],
  env: Record<string, string | undefined>,
  dbUrlEnv?: string | null,
): string | null {
  // Use the app-specific env var name if provided (e.g., NEXT_PRIVATE_DATABASE_URL)
  const dbUrl = (dbUrlEnv ? env[dbUrlEnv] : undefined) ?? env.DATABASE_URL ?? env.DATABASE_URI ?? env.DB_URL;
  if (!dbUrl) return null;

  const tableEntries = Object.entries(dataModel);
  if (tableEntries.length === 0) return null;

  const cleanUrl = dbUrl.split("?")[0];
  const sections: string[] = [];

  for (const [modelName, model] of tableEntries) {
    try {
      const output = execSync(
        `psql "${cleanUrl}" -P columns=120 -c "SELECT * FROM \\"${model.table_name}\\" LIMIT 5"`,
        { timeout: 10_000, encoding: "utf-8", env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] },
      );
      if (output.trim()) {
        sections.push(`-- ${modelName} (table: "${model.table_name}")\n${output.trim()}`);
      }
    } catch {
      // Table may not exist or query failed — skip silently
    }
  }

  return sections.length > 0 ? sections.join("\n\n") : null;
}

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
    break; // use first found .env file
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
    join(projectRoot, "scripts", "seed.ts"),
    join(projectRoot, "seed.ts"),
    join(projectRoot, "seed.sql"),
  ];

  // Scan directories that commonly contain seed files or seed subdirectories
  const seedDirs = [
    join(projectRoot, "packages", "database", "src", "seed"),
    join(projectRoot, "packages", "prisma", "seed"),
    join(projectRoot, "prisma", "seed"),
    join(projectRoot, "scripts"),
  ];
  for (const seedDir of seedDirs) {
    if (!existsSync(seedDir)) continue;
    try {
      for (const f of readdirSync(seedDir, { withFileTypes: true })) {
        if (f.isFile() && /^seed[.\-_]/.test(f.name) && (f.name.endsWith(".ts") || f.name.endsWith(".js"))) {
          candidates.push(join(seedDir, f.name));
        }
      }
    } catch { /* permission errors */ }
  }

  // Also scan packages/*/seed.ts and packages/*/prisma/seed* for monorepos
  const packagesDir = join(projectRoot, "packages");
  if (existsSync(packagesDir)) {
    try {
      for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
        if (!pkg.isDirectory()) continue;
        const pkgDir = join(packagesDir, pkg.name);
        candidates.push(join(pkgDir, "seed.ts"));
        candidates.push(join(pkgDir, "seed.js"));
        // Check for seed directory inside package
        const pkgSeedDir = join(pkgDir, "seed");
        if (existsSync(pkgSeedDir)) {
          try {
            for (const f of readdirSync(pkgSeedDir, { withFileTypes: true })) {
              if (f.isFile() && (f.name.endsWith(".ts") || f.name.endsWith(".js"))) {
                candidates.push(join(pkgSeedDir, f.name));
              }
            }
          } catch { /* permission errors */ }
        }
      }
    } catch { /* permission errors */ }
  }

  // Deduplicate before filtering — monorepo scan may rediscover static candidates
  return [...new Set(candidates)].filter(p => existsSync(p));
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
  prismaMapping: Record<string, PrismaModel>,
  seedIds: Record<string, string[]>,
  jsonAnnotations?: Record<string, Record<string, string>>,
  exampleUrls: Record<string, string> = {},
): AppIndex {
  // Merge prisma column mappings into data_model (union of LLM + deterministic sources)
  // The deterministic parser is authoritative for column mappings; LLM enriches with enums/source
  const dataModel: AppIndex["data_model"] = {};
  const llmModels = schema.data_model ?? {};
  const allModelNames = new Set([
    ...Object.keys(llmModels),
    ...Object.keys(prismaMapping),
  ]);
  for (const modelName of allModelNames) {
    const llmData = llmModels[modelName];
    const mapping = prismaMapping[modelName];

    // Column mapping: prefer deterministic parser, fall back to LLM array→identity, then empty
    let columns: Record<string, string> = {};
    if (mapping?.columns) {
      columns = mapping.columns;
    } else if (llmData?.columns && Array.isArray(llmData.columns)) {
      columns = Object.fromEntries(llmData.columns.map(c => [c, c]));
    }

    dataModel[modelName] = {
      columns,
      table_name: mapping?.table_name ?? modelName,
      enums: (llmData && typeof llmData.enums === "object" && !Array.isArray(llmData.enums)) ? llmData.enums : {},
      source: llmData?.source ?? "prisma-parser",
      manual_id_columns: mapping?.manual_id_columns ?? [],
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
    json_type_annotations: jsonAnnotations ?? {},
    example_urls: exampleUrls,
  };
}
