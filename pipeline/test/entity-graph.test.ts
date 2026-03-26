import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildEntityGraphs, topoSort } from "../src/lib/entity-graph.js";

// Mock the shared psql helper
vi.mock("../src/lib/psql.js", () => ({
  psqlQuery: vi.fn().mockReturnValue(""),
}));

import { psqlQuery } from "../src/lib/psql.js";
const mockPsqlQuery = vi.mocked(psqlQuery);

describe("topoSort", () => {
  it("sorts parents before children", () => {
    const deps = new Map([
      ["Envelope", ["DocumentMeta", "User"]],
      ["DocumentMeta", []],
      ["User", []],
      ["Recipient", ["Envelope"]],
    ]);
    const sorted = topoSort(deps);
    expect(sorted.indexOf("DocumentMeta")).toBeLessThan(sorted.indexOf("Envelope"));
    expect(sorted.indexOf("User")).toBeLessThan(sorted.indexOf("Envelope"));
    expect(sorted.indexOf("Envelope")).toBeLessThan(sorted.indexOf("Recipient"));
  });

  it("handles tables with no dependencies", () => {
    const deps = new Map([["TableA", []], ["TableB", []]]);
    const sorted = topoSort(deps);
    expect(sorted).toHaveLength(2);
    expect(sorted).toContain("TableA");
    expect(sorted).toContain("TableB");
  });

  it("handles self-referential FK", () => {
    const deps = new Map([
      ["Category", ["Category"]],  // self-referencing
      ["Product", ["Category"]],
    ]);
    const sorted = topoSort(deps);
    expect(sorted).toContain("Category");
    expect(sorted).toContain("Product");
    expect(sorted.indexOf("Category")).toBeLessThan(sorted.indexOf("Product"));
  });

  it("handles A→B→A cycle by appending remaining", () => {
    const deps = new Map([
      ["A", ["B"]],
      ["B", ["A"]],
    ]);
    const sorted = topoSort(deps);
    expect(sorted).toHaveLength(2);
    expect(sorted).toContain("A");
    expect(sorted).toContain("B");
  });
});

describe("buildEntityGraphs", () => {
  beforeEach(() => {
    mockPsqlQuery.mockReset();
  });

  it("returns empty object when psqlCmd is empty", () => {
    const result = buildEntityGraphs("", {});
    expect(result).toEqual({});
  });

  it("builds graph from batched query results", () => {
    // Mock batched FK query: Envelope has FK to DocumentMeta
    mockPsqlQuery.mockImplementation((_cmd, sql) => {
      if (sql.includes("table_constraints") && sql.includes("FOREIGN KEY")) {
        // FK edges batch: child_table, fk_column, parent_table, parent_column, required
        return "Envelope\tdocumentMetaId\tDocumentMeta\tid\trequired";
      }
      if (sql.includes("information_schema.columns")) {
        // Columns batch: table_name, column_name, udt_name, is_nullable, column_default
        return [
          "Envelope\tid\ttext\tNO\t",
          "Envelope\tdocumentMetaId\ttext\tNO\t",
          "DocumentMeta\tid\ttext\tNO\t",
        ].join("\n");
      }
      return "";
    });

    const dataModel = {
      Envelope: { table_name: "Envelope", columns: { id: "id" }, enums: {}, source: "prisma-parser", manual_id_columns: [] },
      DocumentMeta: { table_name: "DocumentMeta", columns: { id: "id" }, enums: {}, source: "prisma-parser", manual_id_columns: [] },
    };
    const result = buildEntityGraphs("psql connstr", dataModel);
    expect(Object.keys(result).length).toBeGreaterThan(0);
  });
});
