import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ACGeneratorOutput } from "../lib/types.js";
import { parseJsonOutput } from "../lib/parse-json.js";

const __dirname = dirname(fileURLToPath(import.meta.url));


/**
 * Build the AC generator prompt with all content inlined.
 * No tool access needed — the LLM just reads the prompt and outputs JSON.
 */
export function buildACGeneratorPrompt(specPath: string, verifyDir?: string): string {
  const template = readFileSync(join(__dirname, "../prompts/ac-generator.txt"), "utf-8");

  // Read spec content
  const specContent = readFileSync(specPath, "utf-8");

  // Read optional context files
  let appRoutes = "No app routes available.";
  let seedData = "No seed data available.";
  let learnings = "No learnings from past runs.";

  if (verifyDir) {
    // App routes from app.json
    const appJsonPath = join(verifyDir, "app.json");
    if (existsSync(appJsonPath)) {
      try {
        const appIndex = JSON.parse(readFileSync(appJsonPath, "utf-8"));
        if (appIndex.routes && typeof appIndex.routes === "object") {
          const routes = Object.keys(appIndex.routes as Record<string, unknown>);
          if (routes.length > 0) appRoutes = routes.join("\n");
        }
      } catch { /* ignore parse errors */ }
    }

    // Seed data (truncate to avoid blowing up the prompt)
    const seedPath = join(verifyDir, "seed-data.txt");
    if (existsSync(seedPath)) {
      const raw = readFileSync(seedPath, "utf-8");
      seedData = raw.length > 8000 ? raw.slice(0, 8000) + "\n... (truncated)" : raw;
    }

    // Learnings
    const learningsPath = join(verifyDir, "learnings.md");
    if (existsSync(learningsPath)) {
      learnings = readFileSync(learningsPath, "utf-8");
    }
  }

  return template
    .replaceAll("{{specContent}}", specContent)
    .replaceAll("{{appRoutes}}", appRoutes)
    .replaceAll("{{seedData}}", seedData)
    .replaceAll("{{learnings}}", learnings);
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
