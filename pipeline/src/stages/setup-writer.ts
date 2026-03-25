// pipeline/src/stages/setup-writer.ts — Setup Writer stage
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SetupCommands } from "../lib/types.js";
import { parseJsonOutput } from "../lib/parse-json.js";
import { loadAppIndex } from "../lib/app-index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function buildSetupWriterPrompt(groupId: string, condition: string, projectRoot: string, authEmail?: string): string {
  const verifyDir = join(projectRoot, ".verify");
  const appIndex = loadAppIndex(verifyDir);
  const dbUrlEnv = appIndex?.db_url_env ?? "DATABASE_URL";

  // Build compact schema reference: model → table_name + columns
  const schemaLines: string[] = [];
  if (appIndex) {
    for (const [model, info] of Object.entries(appIndex.data_model)) {
      const cols = Object.entries(info.columns).map(([prisma, pg]) => prisma === pg ? pg : `${prisma}->${pg}`);
      const manualIds = info.manual_id_columns.length > 0 ? ` [manual IDs: ${info.manual_id_columns.join(", ")}]` : "";
      schemaLines.push(`${model} ("${info.table_name}"): ${cols.join(", ")}${manualIds}`);
    }
  }

  // Extract role-like enums for elevated test user permissions
  const roleEnumLines: string[] = [];
  if (appIndex) {
    for (const [, info] of Object.entries(appIndex.data_model)) {
      for (const [enumName, values] of Object.entries(info.enums)) {
        if (/role/i.test(enumName)) {
          roleEnumLines.push(`${enumName}: ${values.join(", ")}`);
        }
      }
    }
  }

  const roleBlock = roleEnumLines.length > 0
    ? `
ROLE ASSIGNMENT:
The app has role-based access control. Assign the test user the highest-privilege role available.
Role enums found: ${roleEnumLines.join("; ")}.
Use the most privileged value (typically ADMIN, OWNER, or similar) to ensure the test user can access all pages.
`
    : "";

  // Resolve the actual DB URL so the LLM doesn't need env var expansion
  const projectEnv = loadProjectEnv(projectRoot);
  const dbUrl = projectEnv[dbUrlEnv] ?? projectEnv.DATABASE_URL ?? projectEnv.DATABASE_URI ?? "";
  const cleanDbUrl = dbUrl.split("?")[0];
  const psqlCmd = cleanDbUrl ? `psql "${cleanDbUrl}"` : `psql "\${${dbUrlEnv}%%\\?*}"`;

  // Load learnings if present
  const learningsPath = join(verifyDir, "learnings.md");
  const learnings = existsSync(learningsPath) ? readFileSync(learningsPath, "utf-8").trim() : "";
  const learningsBlock = learnings
    ? `\nLEARNINGS FROM PAST RUNS (apply these corrections):\n${learnings}\n`
    : "";

  // Build auth context section if email is available
  const authContextBlock = authEmail
    ? `
AUTH CONTEXT:
The logged-in user's email is: ${authEmail}
When the CONDITION refers to "the logged-in user", "their team", or "their personal team":
1. First query to find this user's ID from the "User" table using their email
2. Then discover their team(s) by following FK relationships in the SCHEMA above
3. Scope ALL subsequent queries and INSERTs to that user's team
Do NOT use data from other users or teams.
`
    : "";

  return `You are a setup writer. Generate MINIMAL SQL to put the database into the required state.

GROUP: ${groupId}
CONDITION: ${condition}
${authContextBlock}${roleBlock}
DATABASE ACCESS:
Use Bash to run psql commands to query the database and understand current state.
Connection: ${psqlCmd} -c "SELECT ..."

SCHEMA (model -> table, columns):
${schemaLines.join("\n")}
${learningsBlock}
PROCESS:
1. Run 2-3 psql SELECT queries to understand current data relevant to the CONDITION
2. Write the minimal SQL (1-5 commands) to achieve the condition
3. Output ONLY the JSON below — nothing else

IMPORTANT: You have a strict time limit. Do NOT explore extensively.
Run at most 3-4 SELECT queries, then output the JSON immediately.
Do NOT read files, grep, or explore the codebase.

COLUMN NAMES: Schema shows "prismaName->pgName" for mapped columns. Always use the Postgres name in SQL.

MANUAL ID COLUMNS: If a model shows [manual IDs: ...], provide an explicit value for those columns in INSERTs (e.g., gen_random_uuid() or 'verify-test-${groupId}-001').

OUTPUT: Valid JSON to stdout:

{
  "group_id": "${groupId}",
  "condition": "${condition}",
  "setup_commands": [
    "${psqlCmd} --set ON_ERROR_STOP=1 -c \\"UPDATE ...\\""
  ],
  "teardown_commands": []
}

RULES:
1. Use \`${psqlCmd} --set ON_ERROR_STOP=1 -c "..."\` for setup commands.
2. Prefer UPDATE on existing rows. Use INSERT only when new rows are needed.
3. Use Postgres column names (not Prisma field names) in all SQL.
4. Minimal changes — only what's needed for the condition.
5. teardown_commands must be empty — orchestrator handles DB restoration.
6. Keep it to 1-5 commands max.
7. Do NOT read files or explore the codebase. Only use psql.
8. If the condition is null or empty, output empty arrays.
9. NEVER invent IDs or tokens for foreign key columns. If a column references another table, you MUST first SELECT a valid value from that table or INSERT a new row into it. Use gen_random_uuid() only for primary key columns, never for FK references to existing data.

Output ONLY the JSON. No explanation, no markdown fences.`;
}

export type SetupRetryContext =
  | { type: "parse_error" }
  | { type: "exec_error"; failedCommands: string[]; error: string };

/**
 * Build a retry prompt that includes the original prompt + error context.
 * For exec_error: appends the failed SQL commands and psql error message.
 * For parse_error: tells the LLM its output was not valid JSON.
 */
export function buildSetupWriterRetryPrompt(
  groupId: string, condition: string, projectRoot: string,
  retryContext: SetupRetryContext,
  authEmail?: string,
): string {
  const base = buildSetupWriterPrompt(groupId, condition, projectRoot, authEmail);

  let retryBlock: string;
  if (retryContext.type === "exec_error") {
    const failedBlock = retryContext.failedCommands
      .map((c, i) => `  Command ${i + 1}: ${c}`)
      .join("\n");
    retryBlock = [
      "",
      "YOUR PREVIOUS SQL FAILED. Fix the error and try again.",
      "",
      "Failed commands:",
      failedBlock,
      "",
      `Error: ${retryContext.error}`,
      "",
      "Analyze the error, fix the SQL, and output corrected JSON.",
      "Common fixes: use Postgres syntax (not MySQL), provide explicit IDs for columns",
      "without defaults, use correct column names from app.json, ensure JSONB values are valid.",
    ].join("\n");
  } else {
    retryBlock = [
      "",
      "YOUR PREVIOUS OUTPUT WAS NOT VALID JSON.",
      "You must output ONLY a JSON object with group_id, condition, setup_commands, and teardown_commands.",
      "No markdown fences, no explanation, no extra text.",
    ].join("\n");
  }

  // Insert before the LAST "Output ONLY" marker so the JSON-only instruction stays last
  const marker = "Output ONLY the JSON.";
  const markerIdx = base.lastIndexOf(marker);
  if (markerIdx === -1) {
    return `${base}\n${retryBlock}`;
  }
  const before = base.slice(0, markerIdx);
  const after = base.slice(markerIdx);
  return `${before}${retryBlock}\n\n${after}`;
}

export function parseSetupWriterOutput(raw: string): SetupCommands | null {
  const parsed = parseJsonOutput<SetupCommands>(raw);
  if (!parsed || !Array.isArray(parsed.setup_commands) || !Array.isArray(parsed.teardown_commands)) return null;
  return parsed;
}

export function detectORM(projectDir: string): "prisma" | "drizzle" | "unknown" {
  if (existsSync(join(projectDir, "prisma", "schema.prisma"))) return "prisma";
  if (existsSync(join(projectDir, "drizzle.config.ts"))) return "drizzle";
  return "unknown";
}

export interface SetupResult {
  success: boolean;
  error?: string;
}

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

export interface ExecOptions {
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * Validate that setup commands don't re-parent or corrupt seed records.
 * Blocks ON CONFLICT ... DO UPDATE that changes FK columns (projectId, organizationId)
 * on rows with seed IDs.
 */
export function validateSetupCommands(commands: string[], seedIds: string[]): { safe: string[]; blocked: Array<{ cmd: string; reason: string }> } {
  const safe: string[] = [];
  const blocked: Array<{ cmd: string; reason: string }> = [];

  for (const cmd of commands) {
    // Check if the command updates FK columns on seed records
    const referencedSeedId = seedIds.find(id => cmd.includes(id));
    if (referencedSeedId) {
      const upper = cmd.toUpperCase();
      // Block UPDATE that changes projectId or organizationId on seed records
      if (upper.includes("DO UPDATE") && /\"projectId\"|\"organizationId\"/.test(cmd) && upper.includes("EXCLUDED")) {
        blocked.push({ cmd, reason: `Would re-parent seed record ${referencedSeedId} — changing FK relationships on seed data` });
        continue;
      }
    }
    safe.push(cmd);
  }

  return { safe, blocked };
}

export function executeSetupCommands(commands: string[], env?: Record<string, string>, cwd?: string, seedIds?: string[]): SetupResult {
  if (commands.length === 0) return { success: true };
  const execEnv = env ?? (process.env as Record<string, string>);

  // Validate setup safety if seed IDs provided
  let safeCommands = commands;
  if (seedIds && seedIds.length > 0) {
    const validation = validateSetupCommands(commands, seedIds);
    if (validation.blocked.length > 0) {
      const reasons = validation.blocked.map(b => b.reason).join("; ");
      return { success: false, error: `Setup blocked — would corrupt seed data: ${reasons}` };
    }
    safeCommands = validation.safe;
  }

  for (const cmd of safeCommands) {
    try {
      execSync(cmd, { timeout: 30_000, stdio: "pipe", env: execEnv, ...(cwd ? { cwd } : {}) });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Setup command failed: ${cmd}\n${message}` };
    }
  }
  return { success: true };
}

/**
 * Validate that teardown commands don't delete seed data.
 * Returns list of blocked commands with reasons.
 */
export function validateTeardownCommands(commands: string[], seedIds: string[]): { safe: string[]; blocked: Array<{ cmd: string; reason: string }> } {
  const safe: string[] = [];
  const blocked: Array<{ cmd: string; reason: string }> = [];

  for (const cmd of commands) {
    const upper = cmd.toUpperCase();

    // Block DELETE commands that reference seed IDs
    if (upper.includes("DELETE")) {
      const matchesSeedId = seedIds.some(id => cmd.includes(id));
      if (matchesSeedId) {
        blocked.push({ cmd, reason: "DELETE references a seed data ID — would destroy existing data" });
        continue;
      }
      // Allow DELETE only for verify-test-* IDs
      if (!cmd.includes("verify-test") && !cmd.includes("groupb-") && !cmd.includes("groupc-") && !cmd.includes("groupa-")) {
        blocked.push({ cmd, reason: "DELETE does not target verify-test data — may destroy seed data" });
        continue;
      }
    }

    // Block SET column = NULL on core tables
    if (upper.includes("SET") && /=\s*NULL/i.test(cmd)) {
      blocked.push({ cmd, reason: "SET column = NULL may corrupt seed data — teardown should restore original values" });
      continue;
    }

    // Block DROP/TRUNCATE
    if (upper.includes("DROP ") || upper.includes("TRUNCATE")) {
      blocked.push({ cmd, reason: "DROP/TRUNCATE is never allowed in teardown" });
      continue;
    }

    safe.push(cmd);
  }

  return { safe, blocked };
}

export function executeTeardownCommands(commands: string[], env?: Record<string, string>, cwd?: string, seedIds?: string[]): string[] {
  const errors: string[] = [];
  const execEnv = env ?? (process.env as Record<string, string>);

  // Validate teardown safety if seed IDs provided
  let safeCommands = commands;
  if (seedIds && seedIds.length > 0) {
    const validation = validateTeardownCommands(commands, seedIds);
    for (const b of validation.blocked) {
      errors.push(`BLOCKED teardown: ${b.reason}\n  Command: ${b.cmd}`);
    }
    safeCommands = validation.safe;
  }

  for (const cmd of safeCommands) {
    try {
      execSync(cmd, { timeout: 30_000, stdio: "pipe", env: execEnv, ...(cwd ? { cwd } : {}) });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`Teardown command failed: ${cmd}\n${message}`);
    }
  }
  return errors;
}
