// pipeline/src/stages/browse-agent.ts — Browse Agent stage
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AC } from "../lib/types.js";
import { parseJsonOutput } from "../lib/parse-json.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ExecutorResult {
  ac_id: string;
  verdict: "pass" | "fail" | "blocked" | "unclear";
  confidence: "high" | "medium" | "low";
  reasoning: string;
  observed: string;
  steps_taken: string[];
  screenshots: string[];
  blocker?: string;
}

export function parseExecutorResult(raw: string): ExecutorResult | null {
  const parsed = parseJsonOutput<ExecutorResult>(raw);
  if (!parsed || typeof parsed.verdict !== "string") return null;
  const validVerdicts = ["pass", "fail", "blocked", "unclear"];
  if (!validVerdicts.includes(parsed.verdict)) return null;
  if (!parsed.confidence) parsed.confidence = "medium";
  if (!parsed.reasoning) parsed.reasoning = "";
  if (!parsed.observed) parsed.observed = "";
  if (!Array.isArray(parsed.screenshots)) parsed.screenshots = [];
  if (!Array.isArray(parsed.steps_taken)) parsed.steps_taken = [];
  return parsed;
}

// ── Session executor (v1.1 — all ACs in one session) ─────────────────────────

interface SessionOpts {
  baseUrl: string;
  browseBin: string;
  evidenceBaseDir: string;
  diffHints: string;
  appRoutes?: string;
}

export function buildSessionPrompt(acs: AC[], opts: SessionOpts): string {
  const template = readFileSync(join(__dirname, "../prompts/executor-session.txt"), "utf-8");
  const acList = acs.map((ac, i) => `${i + 1}. [${ac.id}] ${ac.description}`).join("\n");
  return template
    .replaceAll("{{acList}}", acList)
    .replaceAll("{{baseUrl}}", opts.baseUrl)
    .replaceAll("{{browseBin}}", opts.browseBin)
    .replaceAll("{{evidenceBaseDir}}", opts.evidenceBaseDir)
    .replaceAll("{{diffHints}}", opts.diffHints)
    .replaceAll("{{appRoutes}}", opts.appRoutes ?? "No app index available. Navigate using the app UI.");
}

/**
 * Read per-AC result.json files written by the session executor.
 * Returns results for ACs that have files, null for those that don't.
 */
export function readSessionResults(
  acs: AC[],
  evidenceBaseDir: string,
): Map<string, ExecutorResult | null> {
  const results = new Map<string, ExecutorResult | null>();
  for (const ac of acs) {
    const resultPath = join(evidenceBaseDir, ac.id, "result.json");
    try {
      const raw = readFileSync(resultPath, "utf-8");
      results.set(ac.id, parseExecutorResult(raw));
    } catch {
      results.set(ac.id, null);
    }
  }
  return results;
}
