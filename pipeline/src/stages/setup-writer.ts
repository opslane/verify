// pipeline/src/stages/setup-writer.ts — Setup Writer stage
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SetupCommands } from "../lib/types.js";
import { parseJsonOutput } from "../lib/parse-json.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function buildSetupWriterPrompt(groupId: string, condition: string, projectRoot: string): string {
  // Select prompt based on detected ORM
  let promptFile = "setup-writer.txt";
  const orm = detectORM(projectRoot);
  if (orm === "prisma") promptFile = "setup-writer-prisma.txt";
  // Future: "drizzle" → "setup-writer-drizzle.txt"

  const template = readFileSync(join(__dirname, "../prompts", promptFile), "utf-8");
  return template.replaceAll("{{groupId}}", groupId).replaceAll("{{condition}}", condition);
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
        env[key] = value;
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
