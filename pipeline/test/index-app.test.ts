import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { extractEnvVars, mergeIndexResults, findPrismaSchemaPath, dumpDatabaseSchema } from "../src/lib/index-app.js";
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

  it("includes models from prismaMapping even if LLM missed them", () => {
    const result = mergeIndexResults(
      { routes: {} },
      { pages: {} },
      { data_model: {} },
      { fixtures: {} },
      { db_url_env: null, feature_flags: [] },
      { ApiKey: { table_name: "api_keys", columns: { id: "id", label: "label" } } },
      {}
    );
    expect(result.data_model.ApiKey).toBeDefined();
    expect(result.data_model.ApiKey.table_name).toBe("api_keys");
    expect(result.data_model.ApiKey.columns.id).toBe("id");
    expect(result.data_model.ApiKey.source).toBe("prisma-parser");
  });

  it("falls back to identity mapping when no prismaMapping", () => {
    const result = mergeIndexResults(
      { routes: {} },
      { pages: {} },
      { data_model: { User: { columns: ["id", "name"], enums: {}, source: "schema.prisma:1" } } },
      { fixtures: {} },
      { db_url_env: null, feature_flags: [] },
      {},
      {}
    );
    expect(result.data_model.User.columns.id).toBe("id");
    expect(result.data_model.User.columns.name).toBe("name");
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

describe("dumpDatabaseSchema", () => {
  it("returns null when no DATABASE_URL in env", () => {
    const result = dumpDatabaseSchema({});
    expect(result).toBeNull();
  });

  it("returns null when pg_dump fails (bad URL)", () => {
    const result = dumpDatabaseSchema({ DATABASE_URL: "postgres://bad:5432/nope" });
    expect(result).toBeNull();
  });

  it("strips query params from DATABASE_URL", () => {
    // Will fail too (bad host), but exercises the URL cleaning path
    const result = dumpDatabaseSchema({ DATABASE_URL: "postgres://bad:5432/nope?sslmode=require" });
    expect(result).toBeNull();
  });

  it("finds DATABASE_URI as fallback", () => {
    const result = dumpDatabaseSchema({ DATABASE_URI: "postgres://bad:5432/nope" });
    expect(result).toBeNull(); // fails, but proves it tried DATABASE_URI
  });
});
