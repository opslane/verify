import { describe, it, expect } from "vitest";
import { validateSQL, extractTableName } from "../src/sdk/tools/run-sql.js";

describe("validateSQL", () => {
  const seedIds = ["clseed-user-1", "clseed-template-1"];

  it("blocks DROP TABLE", () => {
    // Operation mismatch fires first (DROP != DELETE), but DDL would catch it too
    const result = validateSQL("DROP TABLE users", "DELETE", seedIds);
    expect(result.blocked).toBe(true);
  });

  it("blocks TRUNCATE", () => {
    const result = validateSQL("TRUNCATE users", "DELETE", seedIds);
    expect(result.blocked).toBe(true);
  });

  it("blocks ALTER TABLE", () => {
    const result = validateSQL("ALTER TABLE users ADD COLUMN foo TEXT", "INSERT", seedIds);
    expect(result.blocked).toBe(true);
  });

  it("blocks DELETE without WHERE", () => {
    const result = validateSQL("DELETE FROM users", "DELETE", seedIds);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("WHERE");
  });

  it("allows DELETE with WHERE", () => {
    const result = validateSQL("DELETE FROM users WHERE id = 'test-123'", "DELETE", seedIds);
    expect(result.blocked).toBe(false);
  });

  it("blocks mutation touching seed ID", () => {
    const result = validateSQL("UPDATE users SET name = 'x' WHERE id = 'clseed-user-1'", "UPDATE", seedIds);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("seed");
  });

  it("allows SELECT with seed ID", () => {
    const result = validateSQL("SELECT * FROM users WHERE id = 'clseed-user-1'", "SELECT", seedIds);
    expect(result.blocked).toBe(false);
  });

  it("allows valid INSERT", () => {
    const result = validateSQL("INSERT INTO templates (name) VALUES ('test')", "INSERT", []);
    expect(result.blocked).toBe(false);
  });

  // Bypass prevention tests
  it("blocks multi-statement DDL (SELECT then DROP)", () => {
    const result = validateSQL("SELECT 1; DROP TABLE users;", "SELECT", seedIds);
    expect(result.blocked).toBe(true);
    // Multi-statement check fires before DDL check
    expect(result.reason).toContain("Multi-statement");
  });

  it("blocks DDL hidden after comment", () => {
    const result = validateSQL("/* harmless */ DROP TABLE users", "DELETE", seedIds);
    expect(result.blocked).toBe(true);
  });

  it("blocks CREATE TABLE", () => {
    const result = validateSQL("CREATE TABLE evil (id TEXT)", "INSERT", seedIds);
    expect(result.blocked).toBe(true);
  });

  it("blocks operation mismatch — DELETE declared as SELECT", () => {
    const result = validateSQL("DELETE FROM users WHERE id = 'x'", "SELECT", seedIds);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("does not match");
  });

  it("blocks operation mismatch — INSERT declared as SELECT", () => {
    const result = validateSQL("INSERT INTO users (name) VALUES ('x')", "SELECT", seedIds);
    expect(result.blocked).toBe(true);
  });

  it("blocks multi-statement via semicolon", () => {
    const result = validateSQL("INSERT INTO users (name) VALUES ('x'); UPDATE users SET role = 'admin'", "INSERT", []);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("Multi-statement");
  });

  it("allows semicolons inside string literals", () => {
    const result = validateSQL("INSERT INTO notes (body) VALUES ('hello; world')", "INSERT", []);
    expect(result.blocked).toBe(false);
  });

  it("blocks semicolon after string literal", () => {
    const result = validateSQL("INSERT INTO notes (body) VALUES ('ok'); DROP TABLE users", "INSERT", []);
    expect(result.blocked).toBe(true);
  });

  it("blocks -- comment bypass on operation mismatch", () => {
    const result = validateSQL("-- just checking\nDELETE FROM users WHERE id = 'x'", "SELECT", []);
    expect(result.blocked).toBe(true);
  });

  it("allows WITH (CTE) for SELECT", () => {
    const result = validateSQL("WITH cte AS (SELECT 1) SELECT * FROM cte", "SELECT", []);
    expect(result.blocked).toBe(false);
  });
});

describe("extractTableName", () => {
  it("extracts from INSERT INTO", () => {
    expect(extractTableName('INSERT INTO "users" (name) VALUES (\'x\')')).toBe("users");
  });

  it("extracts from UPDATE", () => {
    expect(extractTableName("UPDATE templates SET name = 'x'")).toBe("templates");
  });

  it("extracts from DELETE FROM", () => {
    expect(extractTableName("DELETE FROM documents WHERE id = '1'")).toBe("documents");
  });

  it("returns null for SELECT", () => {
    expect(extractTableName("SELECT * FROM users")).toBeNull();
  });

  it("extracts table from schema-qualified name", () => {
    expect(extractTableName('INSERT INTO "public"."users" (name) VALUES (\'x\')')).toBe("users");
  });
});
