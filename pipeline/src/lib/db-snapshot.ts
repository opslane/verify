// pipeline/src/lib/db-snapshot.ts — Generic DB snapshot/restore for safe setup
import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Extract table names from a list of SQL commands.
 * Looks for INSERT INTO "TableName", UPDATE "TableName", DELETE FROM "TableName".
 */
export function extractTableNames(commands: string[]): string[] {
  const tables = new Set<string>();
  for (const cmd of commands) {
    // Match "TableName" (quoted) or TableName (unquoted) after INSERT INTO / UPDATE / DELETE FROM
    const matches = cmd.matchAll(/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi);
    for (const m of matches) {
      tables.add(m[1]);
    }
  }
  return [...tables];
}

/**
 * Snapshot the current state of the given tables using pg_dump --data-only.
 * Returns the path to the snapshot SQL file.
 */
export function snapshotTables(
  tables: string[],
  snapshotDir: string,
  env: Record<string, string>
): string | null {
  if (tables.length === 0) return null;

  mkdirSync(snapshotDir, { recursive: true });
  const snapshotPath = join(snapshotDir, "db-snapshot.sql");

  // Build pg_dump command with --data-only for each table
  const dbUrl = env.DATABASE_URL;
  if (!dbUrl) return null;

  // Strip Prisma query params
  const cleanUrl = dbUrl.split("?")[0];

  const tableFlags = tables.map(t => `-t '"${t}"'`).join(" ");
  const cmd = `pg_dump --data-only --inserts --on-conflict-do-nothing ${tableFlags} "${cleanUrl}"`;

  try {
    const output = execSync(cmd, { timeout: 30_000, encoding: "utf-8", env, stdio: ["pipe", "pipe", "pipe"] });
    writeFileSync(snapshotPath, output);
    return snapshotPath;
  } catch {
    // pg_dump failed — can't snapshot
    return null;
  }
}

/**
 * Restore tables from a snapshot by:
 * 1. DELETE all rows from the affected tables (in reverse FK order)
 * 2. Re-insert from the snapshot
 *
 * This is a brute-force restore that works for any Postgres schema.
 */
export function restoreSnapshot(
  snapshotPath: string,
  tables: string[],
  env: Record<string, string>
): { success: boolean; error?: string } {
  if (!existsSync(snapshotPath)) return { success: false, error: "Snapshot file not found" };

  const dbUrl = env.DATABASE_URL;
  if (!dbUrl) return { success: false, error: "DATABASE_URL not set" };
  const cleanUrl = dbUrl.split("?")[0];

  try {
    // Delete current data from affected tables (reverse order for FKs)
    const reverseTables = [...tables].reverse();
    for (const table of reverseTables) {
      try {
        execSync(`psql "${cleanUrl}" -c 'DELETE FROM "${table}"'`, {
          timeout: 30_000, env, stdio: "pipe",
        });
      } catch {
        // Some tables may have FK constraints — continue best effort
      }
    }

    // Restore from snapshot
    execSync(`psql "${cleanUrl}" < "${snapshotPath}"`, {
      timeout: 30_000, env, stdio: "pipe", shell: "/bin/sh",
    });

    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Restore failed: ${message}` };
  }
}
