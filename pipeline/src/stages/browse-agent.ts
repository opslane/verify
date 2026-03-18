// pipeline/src/stages/browse-agent.ts — Browse Agent stage
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlannedAC, BrowseResult } from "../lib/types.js";
import { parseJsonOutput } from "../lib/parse-json.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface BrowseAgentOpts {
  baseUrl: string;
  browseBin: string;
  evidenceDir: string;
}

/**
 * Write the AC instructions to a JSON file in the evidence directory.
 * The browse agent reads this file instead of parsing the prompt — filesystem
 * is the source of truth to avoid LLM truncation of long IDs.
 */
export function writeInstructionsFile(ac: PlannedAC, opts: BrowseAgentOpts): string {
  mkdirSync(opts.evidenceDir, { recursive: true });
  const path = ac.url.startsWith("/") ? ac.url : `/${ac.url}`;
  const fullUrl = `${opts.baseUrl.replace(/\/$/, "")}${path}`;
  const instructions = {
    ac_id: ac.id,
    description: ac.description,
    url: fullUrl,
    steps: ac.steps,
    screenshot_at: ac.screenshot_at,
    evidence_dir: opts.evidenceDir,
  };
  const instructionsPath = join(opts.evidenceDir, "instructions.json");
  writeFileSync(instructionsPath, JSON.stringify(instructions, null, 2));
  return instructionsPath;
}

export function buildBrowseAgentPrompt(ac: PlannedAC, opts: BrowseAgentOpts): string {
  const instructionsPath = writeInstructionsFile(ac, opts);
  const template = readFileSync(join(__dirname, "../prompts/browse-agent.txt"), "utf-8");
  return template
    .replaceAll("{{instructionsPath}}", instructionsPath)
    .replaceAll("{{browseBin}}", opts.browseBin)
    .replaceAll("{{evidenceDir}}", opts.evidenceDir);
}

export function parseBrowseResult(raw: string): BrowseResult | null {
  const parsed = parseJsonOutput<BrowseResult>(raw);
  if (!parsed || typeof parsed.observed !== "string") return null;
  // Ensure arrays default to empty if LLM omits them
  if (!Array.isArray(parsed.screenshots)) parsed.screenshots = [];
  if (!Array.isArray(parsed.commands_run)) parsed.commands_run = [];
  return parsed;
}
