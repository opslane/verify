// pipeline/src/lib/index-app.ts — App indexer: merges LLM agent results with deterministic parsing
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AppIndex } from "./types.js";

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
  // Merge prisma column mappings into data_model (union of LLM + deterministic sources)
  const dataModel: AppIndex["data_model"] = {};
  const allModelNames = new Set([
    ...Object.keys(schema.data_model ?? {}),
    ...Object.keys(prismaMapping),
  ]);
  for (const modelName of allModelNames) {
    const llmData = (schema.data_model ?? {})[modelName];
    const mapping = prismaMapping[modelName];
    dataModel[modelName] = {
      columns: mapping?.columns ?? (llmData ? Object.fromEntries(llmData.columns.map(c => [c, c])) : {}),
      table_name: mapping?.table_name ?? modelName,
      enums: llmData?.enums ?? {},
      source: llmData?.source ?? "prisma-parser",
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
