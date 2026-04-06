// pipeline/src/lib/env.ts — Load env vars from a project's .env file
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Load env vars from a project's .env file.
 * Parses KEY=VALUE and KEY='VALUE' and KEY="VALUE" lines.
 * Returns merged env: process.env + .env overrides.
 */
export function loadProjectEnv(projectRoot: string): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  for (const candidate of [".env.local", ".env"]) {
    const envPath = join(projectRoot, candidate);
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx);
        let value = trimmed.slice(eqIdx + 1);
        // Strip surrounding quotes
        if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
          value = value.slice(1, -1);
        }
        // Skip empty values — tools like psql reject empty PGSSLMODE=""
        if (value !== "") {
          env[key] = value;
        }
      }
      break; // Use first found
    }
  }
  return env;
}
