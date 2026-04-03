// pipeline/src/stages/browse-agent.ts — Browse Agent stage
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlannedAC, BrowseResult, AC } from "../lib/types.js";
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
  if (!parsed) return null;

  // Nav failure result: no observed, but has nav_failure
  if (parsed.nav_failure && typeof parsed.nav_failure.failed_step === "string") {
    if (!parsed.nav_failure.kind) {
      parsed.nav_failure.kind = "navigation";
    } else if (parsed.nav_failure.kind !== "navigation" && parsed.nav_failure.kind !== "interaction") {
      return null;
    }

    // Synthesize an observed string for downstream consumers (judge, etc.)
    if (typeof parsed.observed !== "string" || !parsed.observed) {
      const failedStep = parsed.nav_failure.failed_step.trim();
      const error = parsed.nav_failure.error?.trim();
      parsed.observed = error
        ? `Nav failure during ${failedStep}: ${error}`
        : `Nav failure during ${failedStep}`;
    }
  } else if (typeof parsed.observed !== "string") {
    return null;
  }

  // Ensure arrays default to empty if LLM omits them
  if (!Array.isArray(parsed.screenshots)) parsed.screenshots = [];
  if (!Array.isArray(parsed.commands_run)) parsed.commands_run = [];
  return parsed;
}

// ── Executor (v1 — self-navigating, self-judging) ────────────────────────────

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

interface ExecutorOpts {
  baseUrl: string;
  browseBin: string;
  evidenceDir: string;
  diffHints: string;
}

export function buildExecutorPrompt(ac: AC, opts: ExecutorOpts): string {
  const template = readFileSync(join(__dirname, "../prompts/executor.txt"), "utf-8");
  return template
    .replaceAll("{{ac_description}}", ac.description)
    .replaceAll("{{acId}}", ac.id)
    .replaceAll("{{baseUrl}}", opts.baseUrl)
    .replaceAll("{{browseBin}}", opts.browseBin)
    .replaceAll("{{evidenceDir}}", opts.evidenceDir)
    .replaceAll("{{diffHints}}", opts.diffHints);
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

// ── Replan (nav failure recovery) ──────────────────────────────────────────

export interface ReplanOutput {
  revised_steps: string[] | null;
}

export function buildReplanPrompt(replanInputPath: string): string {
  const template = readFileSync(join(__dirname, "../prompts/browse-replan.txt"), "utf-8");
  return template.replaceAll("{{replanInputPath}}", replanInputPath);
}

export function parseReplanOutput(raw: string): ReplanOutput | null {
  const parsed = parseJsonOutput<ReplanOutput>(raw);
  if (!parsed) return null;
  // revised_steps must be a non-empty array of strings, or null
  if (parsed.revised_steps !== null && !Array.isArray(parsed.revised_steps)) return null;
  // Treat empty array as null — zero revised steps means nothing to retry
  if (Array.isArray(parsed.revised_steps) && parsed.revised_steps.length === 0) {
    parsed.revised_steps = null;
  }
  return parsed;
}
