import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { JudgeOutput } from "../lib/types.js";
import { parseJsonOutput } from "../lib/parse-json.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface EvidenceRef {
  acId: string;
  resultPath: string;
}

export function collectEvidencePaths(runDir: string): EvidenceRef[] {
  const evidenceDir = join(runDir, "evidence");
  if (!existsSync(evidenceDir)) return [];
  return readdirSync(evidenceDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ acId: d.name, resultPath: join(evidenceDir, d.name, "result.json") }))
    .filter((ref) => existsSync(ref.resultPath));
}

export function buildJudgePrompt(evidenceRefs: EvidenceRef[]): string {
  const template = readFileSync(join(__dirname, "../prompts/judge.txt"), "utf-8");
  const evidenceList = evidenceRefs.map((ref) => `- AC ${ref.acId}: ${ref.resultPath}`).join("\n");
  return template.replace("{{evidenceList}}", evidenceList);
}

const VALID_VERDICTS = new Set(["pass", "fail", "error", "timeout", "skipped", "setup_failed", "setup_unsupported", "plan_error", "auth_expired"]);
const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);

export function parseJudgeOutput(raw: string): JudgeOutput | null {
  const parsed = parseJsonOutput<JudgeOutput>(raw);
  if (!parsed || !Array.isArray(parsed.verdicts)) return null;
  // Validate each verdict has required fields with valid values
  const valid = parsed.verdicts.every(
    (v) => typeof v.ac_id === "string" && VALID_VERDICTS.has(v.verdict) && VALID_CONFIDENCE.has(v.confidence)
  );
  if (!valid) return null;
  return parsed;
}
