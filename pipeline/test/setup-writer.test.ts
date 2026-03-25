// pipeline/test/setup-writer.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildSetupWriterPrompt, buildSetupWriterRetryPrompt, parseSetupWriterOutput, detectORM, executeSetupCommands, executeTeardownCommands, validateTeardownCommands } from "../src/stages/setup-writer.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("buildSetupWriterPrompt", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = join(tmpdir(), `verify-setup-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });
  });
  afterEach(() => { rmSync(projectDir, { recursive: true, force: true }); });

  it("includes group id and condition in prompt", () => {
    const prompt = buildSetupWriterPrompt("group-a", "org in trialing state", projectDir);
    expect(prompt).toContain("group-a");
    expect(prompt).toContain("org in trialing state");
  });

  it("includes psql connection command", () => {
    const prompt = buildSetupWriterPrompt("group-a", "trialing state", projectDir);
    expect(prompt).toContain("psql");
    expect(prompt).toContain("DATABASE_URL");
  });

  it("includes AUTH CONTEXT section when authEmail is provided", () => {
    const prompt = buildSetupWriterPrompt("group-a", "org in trialing state", projectDir, "test@example.com");
    expect(prompt).toContain("AUTH CONTEXT");
    expect(prompt).toContain("test@example.com");
    expect(prompt).toContain("logged-in user");
  });

  it("AUTH CONTEXT appears before DATABASE ACCESS", () => {
    const prompt = buildSetupWriterPrompt("group-a", "trialing state", projectDir, "test@example.com");
    const authIdx = prompt.indexOf("AUTH CONTEXT");
    const dbIdx = prompt.indexOf("DATABASE ACCESS");
    expect(authIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeLessThan(dbIdx);
  });

  it("works without authEmail (backwards compatible)", () => {
    const prompt = buildSetupWriterPrompt("group-a", "org in trialing state", projectDir);
    expect(prompt).not.toContain("AUTH CONTEXT");
    expect(prompt).toContain("group-a");
    expect(prompt).toContain("org in trialing state");
  });

  it("includes ROLE ASSIGNMENT when app.json has role enums", () => {
    mkdirSync(join(projectDir, ".verify"), { recursive: true });
    writeFileSync(join(projectDir, ".verify", "app.json"), JSON.stringify({
      indexed_at: "", routes: {}, pages: {}, fixtures: {},
      db_url_env: "DATABASE_URL", feature_flags: [], seed_ids: {},
      json_type_annotations: {}, example_urls: {},
      data_model: {
        User: {
          table_name: "users",
          columns: { id: "id", email: "email", role: "role" },
          enums: { Role: ["ADMIN", "USER", "MEMBER"] },
          source: "prisma/schema.prisma:1",
          manual_id_columns: [],
        },
      },
    }));
    const prompt = buildSetupWriterPrompt("group-a", "some condition", projectDir);
    expect(prompt).toContain("ROLE ASSIGNMENT");
    expect(prompt).toContain("Role: ADMIN, USER, MEMBER");
  });

  it("omits ROLE ASSIGNMENT when app.json has no role enums", () => {
    mkdirSync(join(projectDir, ".verify"), { recursive: true });
    writeFileSync(join(projectDir, ".verify", "app.json"), JSON.stringify({
      indexed_at: "", routes: {}, pages: {}, fixtures: {},
      db_url_env: "DATABASE_URL", feature_flags: [], seed_ids: {},
      json_type_annotations: {}, example_urls: {},
      data_model: {
        User: {
          table_name: "users",
          columns: { id: "id", email: "email" },
          enums: {},
          source: "prisma/schema.prisma:1",
          manual_id_columns: [],
        },
      },
    }));
    const prompt = buildSetupWriterPrompt("group-a", "some condition", projectDir);
    expect(prompt).not.toContain("ROLE ASSIGNMENT");
  });

  it("includes schema from app.json when available", () => {
    mkdirSync(join(projectDir, ".verify"), { recursive: true });
    writeFileSync(join(projectDir, ".verify", "app.json"), JSON.stringify({
      indexed_at: "", routes: {}, pages: {}, fixtures: {},
      db_url_env: "MY_DB_URL", feature_flags: [], seed_ids: {},
      json_type_annotations: {},
      data_model: {
        User: { table_name: "users", columns: { id: "id", email: "email" }, enums: {}, source: "", manual_id_columns: [] },
      },
    }));
    const prompt = buildSetupWriterPrompt("group-a", "trialing state", projectDir);
    expect(prompt).toContain('User ("users")');
    expect(prompt).toContain("MY_DB_URL");
  });
});

describe("buildSetupWriterRetryPrompt", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = join(tmpdir(), `verify-setup-retry-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });
  });
  afterEach(() => { rmSync(projectDir, { recursive: true, force: true }); });

  it("includes psql error and failed commands for exec_error", () => {
    const prompt = buildSetupWriterRetryPrompt("group-a", "trialing state", projectDir, {
      type: "exec_error",
      failedCommands: ["psql -c 'UPDATE \"User\" SET LIMIT 1'"],
      error: "ERROR: syntax error at or near \"LIMIT\"",
    });
    expect(prompt).toContain("group-a");
    expect(prompt).toContain("trialing state");
    expect(prompt).toContain("YOUR PREVIOUS SQL FAILED");
    expect(prompt).toContain("LIMIT");
    expect(prompt).toContain("syntax error");
    // Error block should appear BEFORE the final "Output ONLY" marker
    const errorIdx = prompt.indexOf("YOUR PREVIOUS SQL FAILED");
    const outputIdx = prompt.lastIndexOf("Output ONLY the JSON");
    expect(errorIdx).toBeLessThan(outputIdx);
  });

  it("passes authEmail through to base prompt", () => {
    const prompt = buildSetupWriterRetryPrompt("group-a", "trialing state", projectDir, {
      type: "exec_error",
      failedCommands: ["psql -c 'SELECT 1'"],
      error: "connection refused",
    }, "test@example.com");
    expect(prompt).toContain("AUTH CONTEXT");
    expect(prompt).toContain("test@example.com");
    expect(prompt).toContain("YOUR PREVIOUS SQL FAILED");
  });

  it("includes parse error message for parse_error", () => {
    const prompt = buildSetupWriterRetryPrompt("group-b", "org with members", projectDir, {
      type: "parse_error",
    });
    expect(prompt).toContain("group-b");
    expect(prompt).toContain("YOUR PREVIOUS OUTPUT WAS NOT VALID JSON");
    expect(prompt).toContain("Output ONLY the JSON");
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
