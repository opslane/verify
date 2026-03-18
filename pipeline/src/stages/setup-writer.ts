// pipeline/src/stages/setup-writer.ts — Setup Writer stage
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SetupCommands } from "../lib/types.js";
import { parseJsonOutput } from "../lib/parse-json.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function buildSetupWriterPrompt(groupId: string, condition: string): string {
  const template = readFileSync(join(__dirname, "../prompts/setup-writer.txt"), "utf-8");
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

export function executeSetupCommands(commands: string[], env?: Record<string, string>): SetupResult {
  if (commands.length === 0) return { success: true };
  const execEnv = env ?? (process.env as Record<string, string>);
  for (const cmd of commands) {
    try {
      execSync(cmd, { timeout: 30_000, stdio: "pipe", env: execEnv });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Setup command failed: ${cmd}\n${message}` };
    }
  }
  return { success: true };
}

export function executeTeardownCommands(commands: string[], env?: Record<string, string>): string[] {
  const errors: string[] = [];
  const execEnv = env ?? (process.env as Record<string, string>);
  for (const cmd of commands) {
    try {
      execSync(cmd, { timeout: 30_000, stdio: "pipe", env: execEnv });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`Teardown command failed: ${cmd}\n${message}`);
    }
  }
  return errors;
}
