import { describe, it, expect, vi } from "vitest";
import { buildGraphPrompt, graphInformedSetup } from "../src/stages/graph-setup.js";
import type { AppIndex, RunClaudeResult } from "../src/lib/types.js";

// Shared test graph fixture
function makeGraph(): NonNullable<AppIndex["entity_graphs"]>[string] {
  return {
    insert_order: ["DocumentMeta", "Envelope"],
    tables: {
      DocumentMeta: {
        columns: [
          { name: "id", pg_type: "text", nullable: false, has_default: false },
          { name: "language", pg_type: "text", nullable: false, has_default: false },
          { name: "subject", pg_type: "text", nullable: false, has_default: false },
        ],
        fk_parents: [],
      },
      Envelope: {
        columns: [
          { name: "id", pg_type: "text", nullable: false, has_default: false },
          { name: "teamId", pg_type: "int4", nullable: false, has_default: false },
          { name: "documentMetaId", pg_type: "text", nullable: false, has_default: false },
        ],
        fk_parents: [{ column: "documentMetaId", parent_table: "DocumentMeta", parent_column: "id", required: true }],
      },
    },
  };
}

function makeEntityGraphs(): NonNullable<AppIndex["entity_graphs"]> {
  return { Envelope: makeGraph(), Template: makeGraph() };
}

function mockRunClaudeResult(stdout: string): RunClaudeResult {
  return { stdout, stderr: "", exitCode: 0, durationMs: 1000, timedOut: false };
}

describe("buildGraphPrompt", () => {
  it("includes all entity graph table names, condition, and ALREADY EXIST section", () => {
    const prompt = buildGraphPrompt(
      "A draft document exists",
      makeEntityGraphs(),
      ["User", "Team"],
      { userId: "9", teamId: "7", email: "test@test.com" },
    );
    expect(prompt).toContain("ENTITY GRAPHS");
    expect(prompt).toContain("Envelope");
    expect(prompt).toContain("draft document");
    expect(prompt).toContain("ALREADY EXIST");
    expect(prompt).toContain("setup_commands");
    expect(prompt.length).toBeLessThan(5000);
  });

  it("includes CHECK FIRST instruction", () => {
    const prompt = buildGraphPrompt("A draft document exists", makeEntityGraphs(), ["User"], {});
    expect(prompt).toMatch(/check|already satisfied|SELECT/i);
  });
});

describe("graphInformedSetup", () => {
  it("returns SetupCommands on valid LLM response", async () => {
    const llmOutput = JSON.stringify({
      group_id: "setup",
      condition: "test",
      setup_commands: ["psql connstr --set ON_ERROR_STOP=1 -c \"INSERT INTO ...\""],
      teardown_commands: [],
    });
    const mockRunClaude = vi.fn().mockResolvedValue(mockRunClaudeResult(llmOutput));
    const appIndex = {
      entity_graphs: makeEntityGraphs(),
      data_model: { Envelope: { table_name: "Envelope", columns: {}, enums: {}, source: "prisma-parser", manual_id_columns: [] } },
      seed_ids: {},
    } as unknown as AppIndex;

    const result = await graphInformedSetup(
      "group-1", "A draft document exists", appIndex, {}, "test@test.com",
      "/tmp/run", "setup-group-1", mockRunClaude,
    );
    expect(result).not.toBeNull();
    expect(result!.setup_commands.length).toBeGreaterThan(0);
  });

  it("returns null when entity_graphs is missing", async () => {
    const mockRunClaude = vi.fn();
    const appIndex = { entity_graphs: undefined, data_model: {}, seed_ids: {} } as unknown as AppIndex;

    const result = await graphInformedSetup(
      "group-1", "condition", appIndex, {}, undefined,
      "/tmp/run", "setup-group-1", mockRunClaude,
    );
    expect(result).toBeNull();
    expect(mockRunClaude).not.toHaveBeenCalled();
  });

  it("returns null when LLM returns unparseable output", async () => {
    const mockRunClaude = vi.fn().mockResolvedValue(mockRunClaudeResult("not json at all"));
    const appIndex = {
      entity_graphs: makeEntityGraphs(),
      data_model: {},
      seed_ids: {},
    } as unknown as AppIndex;

    const result = await graphInformedSetup(
      "group-1", "condition", appIndex, {}, undefined,
      "/tmp/run", "setup-group-1", mockRunClaude,
    );
    expect(result).toBeNull();
  });

  it("returns empty setup_commands when LLM says condition is already satisfied", async () => {
    const llmOutput = JSON.stringify({
      group_id: "setup",
      condition: "test",
      setup_commands: [],
      teardown_commands: [],
    });
    const mockRunClaude = vi.fn().mockResolvedValue(mockRunClaudeResult(llmOutput));
    const appIndex = {
      entity_graphs: makeEntityGraphs(),
      data_model: {},
      seed_ids: {},
    } as unknown as AppIndex;

    const result = await graphInformedSetup(
      "group-1", "condition", appIndex, {}, undefined,
      "/tmp/run", "setup-group-1", mockRunClaude,
    );
    expect(result).not.toBeNull();
    expect(result!.setup_commands).toHaveLength(0);
  });
});
