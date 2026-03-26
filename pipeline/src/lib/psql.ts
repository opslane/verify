// pipeline/src/lib/psql.ts — Shared helper for running psql queries
import { execSync } from "node:child_process";

export function psqlQuery(psqlCmd: string, sql: string): string {
  try {
    return (execSync(
      `${psqlCmd} -t -A -F'\t' -c ${JSON.stringify(sql.replace(/\s+/g, " ").trim())}`,
      { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ) as string).trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  psql query failed: ${msg}`);
    return "";
  }
}
