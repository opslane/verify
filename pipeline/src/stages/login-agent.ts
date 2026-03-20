// pipeline/src/stages/login-agent.ts — Login agent stage (used during /verify-setup only)
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { LoginStep } from "../lib/types.js";
import { parseJsonOutput } from "../lib/parse-json.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface LoginAgentOpts {
  baseUrl: string;
  email: string;
  password: string;
  browseBin: string;
}

export function buildLoginAgentPrompt(opts: LoginAgentOpts): string {
  const template = readFileSync(join(__dirname, "../prompts/login-agent.txt"), "utf-8");
  return template
    .replaceAll("__BASE_URL__", opts.baseUrl)
    .replaceAll("__BROWSE_BIN__", opts.browseBin)
    .replaceAll("__EMAIL__", opts.email)
    .replaceAll("__PASSWORD__", opts.password);
}

interface LoginAgentSuccess {
  success: true;
  loginSteps: LoginStep[];
}

interface LoginAgentFailure {
  success: false;
  error: string;
  page_snapshot?: string;
}

type LoginAgentResult = LoginAgentSuccess | LoginAgentFailure;

const AT_REF_PATTERN = /@e\d+/;

export function parseLoginAgentOutput(raw: string): LoginAgentResult | null {
  const parsed = parseJsonOutput<LoginAgentResult>(raw);
  if (!parsed || typeof parsed.success !== "boolean") return null;

  if (!parsed.success) {
    if (typeof parsed.error !== "string") return null;
    return parsed;
  }

  if (!Array.isArray(parsed.loginSteps) || parsed.loginSteps.length === 0) return null;

  // Validate each step
  for (const step of parsed.loginSteps) {
    if (!step || typeof step.action !== "string") return null;

    switch (step.action) {
      case "goto":
        if (typeof step.url !== "string" || !step.url) return null;
        break;
      case "fill":
        if (typeof step.selector !== "string" || !step.selector) return null;
        if (typeof step.value !== "string") return null;
        if (AT_REF_PATTERN.test(step.selector)) return null;
        break;
      case "click":
        if (typeof step.selector !== "string" || !step.selector) return null;
        if (AT_REF_PATTERN.test(step.selector)) return null;
        break;
      case "sleep":
        if (typeof step.ms !== "number" || step.ms <= 0) return null;
        break;
      default:
        return null;
    }
  }

  // Must have at least one goto and one fill
  const hasGoto = parsed.loginSteps.some(s => s.action === "goto");
  const hasFill = parsed.loginSteps.some(s => s.action === "fill");
  if (!hasGoto || !hasFill) return null;

  return parsed;
}
