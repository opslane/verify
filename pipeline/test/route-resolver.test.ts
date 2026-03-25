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
