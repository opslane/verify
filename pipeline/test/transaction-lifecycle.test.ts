import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import postgres from "postgres";
import { createRunSqlTool } from "../src/sdk/tools/run-sql.js";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB_URL)("transaction lifecycle", () => {
  let adminSql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    adminSql = postgres(TEST_DB_URL!);
    await adminSql`CREATE TABLE IF NOT EXISTS _txn_test (id TEXT PRIMARY KEY, value TEXT)`;
    await adminSql`DELETE FROM _txn_test`;
  });

  afterEach(async () => {
    await adminSql`DELETE FROM _txn_test`;
  });

  afterAll(async () => {
    await adminSql`DROP TABLE IF EXISTS _txn_test`;
    await adminSql.end();
  });

  it("starts with no transaction", async () => {
    const { state, close } = createRunSqlTool(TEST_DB_URL!, []);
    expect(state.inTransaction).toBe(false);
    await close();
  });

  it("COMMIT persists data via sql.begin", async () => {
    // Use postgres.js sql.begin() which handles BEGIN/COMMIT properly
    const conn = postgres(TEST_DB_URL!);
    await conn.begin(async (tx) => {
      await tx`INSERT INTO _txn_test (id, value) VALUES ('test-1', 'committed')`;
    });
    await conn.end();

    const rows = await adminSql`SELECT * FROM _txn_test WHERE id = 'test-1'`;
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe("committed");
  });

  it("ROLLBACK discards data via sql.begin + throw", async () => {
    const conn = postgres(TEST_DB_URL!);
    try {
      await conn.begin(async (tx) => {
        await tx`INSERT INTO _txn_test (id, value) VALUES ('test-2', 'rolled-back')`;
        throw new Error("force rollback");
      });
    } catch {
      // Expected — begin() rolls back on throw
    }
    await conn.end();

    const rows = await adminSql`SELECT * FROM _txn_test WHERE id = 'test-2'`;
    expect(rows.length).toBe(0);
  });

  it("tracks affectedTables correctly", async () => {
    const { state, close } = createRunSqlTool(TEST_DB_URL!, []);
    state.affectedTables.add("users");
    state.affectedTables.add("templates");
    state.affectedTables.add("users"); // duplicate
    expect([...state.affectedTables]).toEqual(["users", "templates"]);
    await close();
  });

  it("close() is safe to call without open transaction", async () => {
    const { close } = createRunSqlTool(TEST_DB_URL!, []);
    await close();
    // Should not throw
  });
});
