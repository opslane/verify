// pipeline/src/stages/setup-writer.ts — Setup Writer stage
import { readFileSync, existsSync } from "node:fs";
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
