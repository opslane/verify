import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlannerOutput, PlanValidationError, ACVerdict } from "../lib/types.js";
import { parseJsonOutput } from "../lib/parse-json.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function buildPlannerPrompt(acsPath: string): string {
  const template = readFileSync(join(__dirname, "../prompts/planner.txt"), "utf-8");
  return template.replace("{{acsPath}}", acsPath);
}

export function parsePlannerOutput(raw: string): PlannerOutput | null {
  const parsed = parseJsonOutput<PlannerOutput>(raw);
  if (!parsed || !Array.isArray(parsed.criteria)) return null;
  return parsed;
}

export function buildRetryPrompt(acsPath: string, errors: PlanValidationError[]): string {
  const base = buildPlannerPrompt(acsPath);
  const errorBlock = errors
    .map((e) => `- AC ${e.acId}, field "${e.field}": ${e.message}`)
    .join("\n");
  return `${base}\n\nYOUR PREVIOUS PLAN HAD THESE ERRORS. Fix them:\n${errorBlock}`;
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
      verdict: "plan_error" as const,
      confidence: "high" as const,
      reasoning: errors.filter((e) => e.acId === acId).map((e) => e.message).join("; "),
    })),
  };
}
