import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlannerOutput, PlanValidationError, ACVerdict, AppIndex } from "../lib/types.js";
import { parseJsonOutput } from "../lib/parse-json.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function buildPlannerPrompt(acsPath: string, appIndex?: AppIndex | null): string {
  const template = readFileSync(join(__dirname, "../prompts/planner.txt"), "utf-8");
  const base = template.replaceAll("{{acsPath}}", acsPath);

  // If no appIndex, return the original prompt (model reads app.json via tools)
  if (!appIndex) return base;

  // Pre-inject app.json sections so the model doesn't need to tool-call for them.
  // This reduces tool calls from ~30 to ~5-10, making plans more deterministic.
  const injected: string[] = [];
  injected.push("");
  injected.push("# app.json (pre-loaded — already in this prompt, do NOT read .verify/app.json)");
  injected.push("");
  injected.push("## routes");
  injected.push("```json");
  injected.push(JSON.stringify(appIndex.routes, null, 2));
  injected.push("```");
  injected.push("");
  injected.push("## example_urls (pre-resolved concrete URLs — use these directly, do NOT invent IDs)");
  injected.push("```json");
  injected.push(JSON.stringify(appIndex.example_urls, null, 2));
  injected.push("```");
  injected.push("");

  // Include page selectors — match by AC content to keep prompt smaller
  const acsText = readFileSync(acsPath, "utf-8");
  const relevantPages: Record<string, unknown> = {};
  for (const [pageUrl, pageData] of Object.entries(appIndex.pages)) {
    const urlParts = pageUrl.split("/").filter((p) => p.length > 2);
    if (urlParts.some((part) => acsText.includes(part))) {
      relevantPages[pageUrl] = pageData;
    }
  }
  if (Object.keys(relevantPages).length === 0) {
    for (const k of Object.keys(appIndex.pages).slice(0, 30)) {
      relevantPages[k] = appIndex.pages[k];
    }
  }
  injected.push(`## pages (${Object.keys(relevantPages).length} relevant pages with selectors)`);
  injected.push("```json");
  injected.push(JSON.stringify(relevantPages, null, 2));
  injected.push("```");
  injected.push("");

  if (appIndex.seed_ids && Object.keys(appIndex.seed_ids).length > 0) {
    injected.push("## seed_ids");
    injected.push("```json");
    injected.push(JSON.stringify(appIndex.seed_ids, null, 2));
    injected.push("```");
    injected.push("");
  }

  // Insert injected content before the OUTPUT section
  const outputMarker = "OUTPUT:";
  const outputIdx = base.indexOf(outputMarker);
  if (outputIdx === -1) {
    return base + "\n" + injected.join("\n");
  }
  return base.slice(0, outputIdx) + injected.join("\n") + "\n" + base.slice(outputIdx);
}

export function parsePlannerOutput(raw: string): PlannerOutput | null {
  const parsed = parseJsonOutput<PlannerOutput>(raw);
  if (!parsed || !Array.isArray(parsed.criteria)) return null;
  return parsed;
}

export function buildRetryPrompt(acsPath: string, errors: PlanValidationError[], appIndex?: AppIndex | null): string {
  const base = buildPlannerPrompt(acsPath, appIndex);
  const errorBlock = errors
    .map((e) => `- AC ${e.acId}, field "${e.field}": ${e.message}`)
    .join("\n");
  // Insert error block before the "Output ONLY" line so the JSON-only instruction stays last
  const marker = "Output ONLY the JSON.";
  const markerIdx = base.indexOf(marker);
  if (markerIdx === -1) {
    return `${base}\n\nYOUR PREVIOUS PLAN HAD THESE ERRORS. Fix them:\n${errorBlock}`;
  }
  const before = base.slice(0, markerIdx);
  const after = base.slice(markerIdx);
  return `${before}YOUR PREVIOUS PLAN HAD THESE ERRORS. Fix them:\n${errorBlock}\n\n${after}`;
}

export function filterPlanErrors(
  plan: PlannerOutput,
  errors: PlanValidationError[]
): { validPlan: PlannerOutput; planErrors: ACVerdict[] } {
  const errorAcIds = new Set(errors.map((e) => e.acId));
  return {
    validPlan: {
      criteria: plan.criteria.filter((ac) => !errorAcIds.has(ac.id)),
    },
    planErrors: [...errorAcIds].map((acId) => ({
      ac_id: acId,
      verdict: "plan_error",
      confidence: "high",
      reasoning: errors.filter((e) => e.acId === acId).map((e) => e.message).join("; "),
    })),
  };
}
