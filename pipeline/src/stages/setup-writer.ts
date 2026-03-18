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
  if (!parsed || !Array.isArray(parsed.setup_commands)) return null;
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

export function executeSetupCommands(commands: string[]): SetupResult {
  if (commands.length === 0) return { success: true };
  for (const cmd of commands) {
    try {
      execSync(cmd, { timeout: 30_000, stdio: "pipe" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Setup command failed: ${cmd}\n${message}` };
    }
  }
  return { success: true };
}
