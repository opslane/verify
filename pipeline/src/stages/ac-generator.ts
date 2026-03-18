import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ACGeneratorOutput } from "../lib/types.js";
import { parseJsonOutput } from "../lib/parse-json.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function buildACGeneratorPrompt(specPath: string): string {
  const template = readFileSync(join(__dirname, "../prompts/ac-generator.txt"), "utf-8");
  return template.replace("{{specPath}}", specPath);
}

export function parseACGeneratorOutput(raw: string): ACGeneratorOutput | null {
  const parsed = parseJsonOutput<ACGeneratorOutput>(raw);
  if (!parsed || !Array.isArray(parsed.groups)) return null;
  return parsed;
}

export function fanOutPureUIGroups(input: ACGeneratorOutput): ACGeneratorOutput {
  const newGroups = input.groups.flatMap((group) => {
    if (group.condition !== null || group.acs.length <= 1) return [group];
    return group.acs.map((ac, i) => ({
      id: `${group.id}-${i}`,
      condition: null,
      acs: [ac],
    }));
  });
  return { groups: newGroups, skipped: input.skipped };
}
