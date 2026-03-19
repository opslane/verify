import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadAppIndex, filterPagesByUrls } from "../src/lib/app-index.js";
import type { AppIndex } from "../src/lib/types.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import fixture from "./fixtures/app-index.json" with { type: "json" };

describe("loadAppIndex", () => {
  let verifyDir: string;

  beforeEach(() => {
    verifyDir = join(tmpdir(), `verify-ai-${Date.now()}`);
    mkdirSync(verifyDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(verifyDir, { recursive: true, force: true });
  });

  it("returns null when app.json does not exist", () => {
    expect(loadAppIndex(verifyDir)).toBeNull();
  });

  it("reads and parses app.json with column mappings", () => {
    writeFileSync(join(verifyDir, "app.json"), JSON.stringify(fixture));
    const result = loadAppIndex(verifyDir);
    expect(result).not.toBeNull();
    expect(result!.routes["/dashboard"]).toBeDefined();
    expect(result!.db_url_env).toBe("DATABASE_URL");
    expect(result!.data_model.Organization.columns.billingStatus).toBe("billing_status");
    expect(result!.data_model.Organization.table_name).toBe("Organization");
    expect(result!.seed_ids.Organization).toContain("clseedorg0000000000000");
  });

  it("returns null for malformed app.json", () => {
    writeFileSync(join(verifyDir, "app.json"), "not json");
    expect(loadAppIndex(verifyDir)).toBeNull();
  });
});

describe("filterPagesByUrls", () => {
  const appIndex = fixture as AppIndex;

  it("filters pages matching URL patterns", () => {
    const result = filterPagesByUrls(appIndex, ["/dashboard"]);
    expect(Object.keys(result)).toContain("/dashboard");
  });

  it("returns first N pages as fallback when no patterns match", () => {
    const result = filterPagesByUrls(appIndex, ["/nonexistent"]);
    expect(Object.keys(result).length).toBeGreaterThan(0);
  });

  it("returns first N pages when no patterns provided", () => {
    const result = filterPagesByUrls(appIndex, []);
    expect(Object.keys(result).length).toBeGreaterThan(0);
  });

  it("respects limit parameter", () => {
    const result = filterPagesByUrls(appIndex, [], 1);
    expect(Object.keys(result)).toHaveLength(1);
  });
});
