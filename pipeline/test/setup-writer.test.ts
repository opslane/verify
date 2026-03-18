// pipeline/test/setup-writer.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildSetupWriterPrompt, parseSetupWriterOutput, detectORM, executeSetupCommands, executeTeardownCommands, validateTeardownCommands } from "../src/stages/setup-writer.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("buildSetupWriterPrompt", () => {
  it("substitutes group id and condition", () => {
    const prompt = buildSetupWriterPrompt("group-a", "org in trialing state");
    expect(prompt).toContain("group-a");
    expect(prompt).toContain("org in trialing state");
    expect(prompt).not.toContain("{{groupId}}");
    expect(prompt).not.toContain("{{condition}}");
  });
});

describe("parseSetupWriterOutput", () => {
  it("parses valid output", () => {
    const output = JSON.stringify({
      group_id: "group-a", condition: "org in trialing state",
      setup_commands: ["psql ..."], teardown_commands: ["psql ..."],
    });
    expect(parseSetupWriterOutput(output)).not.toBeNull();
  });

  it("returns null for invalid output", () => {
    expect(parseSetupWriterOutput("garbage")).toBeNull();
  });

  it("returns null when setup_commands is missing", () => {
    expect(parseSetupWriterOutput('{"group_id": "g1"}')).toBeNull();
  });

  it("returns null when teardown_commands is missing", () => {
    expect(parseSetupWriterOutput('{"group_id": "g1", "setup_commands": ["x"]}')).toBeNull();
  });
});

describe("detectORM", () => {
  let tempDir: string;

  beforeEach(() => { tempDir = join(tmpdir(), `orm-detect-${Date.now()}`); mkdirSync(tempDir, { recursive: true }); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("detects Prisma when schema.prisma exists", () => {
    mkdirSync(join(tempDir, "prisma"), { recursive: true });
    writeFileSync(join(tempDir, "prisma", "schema.prisma"), "model User {}");
    expect(detectORM(tempDir)).toBe("prisma");
  });

  it("detects Drizzle when drizzle.config.ts exists", () => {
    writeFileSync(join(tempDir, "drizzle.config.ts"), "export default {}");
    expect(detectORM(tempDir)).toBe("drizzle");
  });

  it("returns unknown when no ORM detected", () => {
    expect(detectORM(tempDir)).toBe("unknown");
  });
});

describe("executeSetupCommands", () => {
  it("returns success for valid commands", () => {
    const result = executeSetupCommands(["echo hello", "echo world"]);
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("returns error message for failing commands without throwing", () => {
    const result = executeSetupCommands(["exit 1"]);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns success for empty command list", () => {
    const result = executeSetupCommands([]);
    expect(result.success).toBe(true);
  });
});

describe("executeTeardownCommands", () => {
  it("runs valid teardown commands", () => {
    const errors = executeTeardownCommands(["echo cleanup"]);
    expect(errors).toHaveLength(0);
  });

  it("does not throw on failing teardown commands", () => {
    const errors = executeTeardownCommands(["exit 1", "echo still-runs"]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("returns empty array for empty command list", () => {
    const errors = executeTeardownCommands([]);
    expect(errors).toHaveLength(0);
  });
});

describe("validateTeardownCommands", () => {
  const seedIds = ["clseedenvprod000000000", "clseedorg0000000000000"];

  it("blocks DELETE that references a seed ID", () => {
    const { safe, blocked } = validateTeardownCommands(
      ['psql -c "DELETE FROM \\"Environment\\" WHERE id = \'clseedenvprod000000000\';"'],
      seedIds
    );
    expect(blocked).toHaveLength(1);
    expect(blocked[0].reason).toContain("seed data");
    expect(safe).toHaveLength(0);
  });

  it("blocks DELETE that doesn't target verify-test data", () => {
    const { safe, blocked } = validateTeardownCommands(
      ['psql -c "DELETE FROM \\"User\\" WHERE id = \'some-random-id\';"'],
      seedIds
    );
    expect(blocked).toHaveLength(1);
    expect(safe).toHaveLength(0);
  });

  it("allows DELETE of verify-test data", () => {
    const { safe, blocked } = validateTeardownCommands(
      ['psql -c "DELETE FROM \\"User\\" WHERE id = \'verify-test-user-001\';"'],
      seedIds
    );
    expect(blocked).toHaveLength(0);
    expect(safe).toHaveLength(1);
  });

  it("blocks SET column = NULL", () => {
    const { safe, blocked } = validateTeardownCommands(
      ['psql -c "UPDATE \\"OrganizationBilling\\" SET stripe = NULL WHERE organization_id = \'clseedorg0000000000000\';"'],
      seedIds
    );
    expect(blocked).toHaveLength(1);
    expect(blocked[0].reason).toContain("NULL");
  });

  it("allows UPDATE that restores to a value", () => {
    const { safe, blocked } = validateTeardownCommands(
      ['psql -c "UPDATE \\"OrganizationBilling\\" SET stripe = \'{\\"subscriptionStatus\\":\\"active\\"}\' WHERE organization_id = \'clseedorg0000000000000\';"'],
      seedIds
    );
    expect(blocked).toHaveLength(0);
    expect(safe).toHaveLength(1);
  });

  it("blocks DROP and TRUNCATE", () => {
    const { blocked } = validateTeardownCommands(
      ['psql -c "DROP TABLE \\"User\\";"', 'psql -c "TRUNCATE \\"Organization\\";"'],
      seedIds
    );
    expect(blocked).toHaveLength(2);
  });
});
