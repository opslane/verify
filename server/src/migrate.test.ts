import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { runMigrations } from './migrate.js';

// Requires TEST_DATABASE_URL env var pointing to a real Postgres instance
// e.g. postgres://localhost:5432/verify_test
const TEST_DB = process.env.TEST_DATABASE_URL;

describe('runMigrations', () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    if (!TEST_DB) throw new Error('TEST_DATABASE_URL not set');
    sql = postgres(TEST_DB);
    // Clean slate
    await sql`DROP TABLE IF EXISTS github_installations, users, orgs CASCADE`;
    await sql`DROP EXTENSION IF EXISTS pgcrypto CASCADE`;
  });

  afterAll(async () => {
    await sql.end();
  });

  it('creates all three tables', async () => {
    await runMigrations(TEST_DB!);

    const tables = await sql`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      AND tablename IN ('orgs', 'users', 'github_installations')
      ORDER BY tablename
    `;
    expect(tables.map((r) => r.tablename)).toEqual([
      'github_installations',
      'orgs',
      'users',
    ]);
  });

  it('is idempotent — running twice does not error', async () => {
    await expect(runMigrations(TEST_DB!)).resolves.not.toThrow();
  });
});
