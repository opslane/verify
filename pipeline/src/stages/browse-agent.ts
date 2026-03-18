// pipeline/src/stages/browse-agent.ts — Browse Agent stage
import { readFileSync } from "node:fs";
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

export function buildBrowseAgentPrompt(ac: PlannedAC, opts: BrowseAgentOpts): string {
  const template = readFileSync(join(__dirname, "../prompts/browse-agent.txt"), "utf-8");
  const path = ac.url.startsWith("/") ? ac.url : `/${ac.url}`;
  const fullUrl = `${opts.baseUrl.replace(/\/$/, "")}${path}`;
  return template
    .replaceAll("{{acId}}", ac.id)
    .replaceAll("{{description}}", ac.description)
    .replaceAll("{{fullUrl}}", fullUrl)
    .replaceAll("{{steps}}", ac.steps.map((s, i) => `${i + 1}. ${s}`).join("\n"))
    .replaceAll("{{screenshotAt}}", ac.screenshot_at.join(", "))
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
