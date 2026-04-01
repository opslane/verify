import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { JudgeOutput } from "../lib/types.js";
import { parseJsonOutput } from "../lib/parse-json.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface EvidenceRef {
  acId: string;
  resultPath: string;
  description?: string;  // AC description — what the judge should evaluate against
}

export function collectEvidencePaths(runDir: string): EvidenceRef[] {
  const evidenceDir = join(runDir, "evidence");
  if (!existsSync(evidenceDir)) return [];
  return readdirSync(evidenceDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const acDir = join(evidenceDir, d.name);
      const ref: EvidenceRef = { acId: d.name, resultPath: join(acDir, "result.json") };
      // Read AC description from instructions.json if available
      const instrPath = join(acDir, "instructions.json");
      if (existsSync(instrPath)) {
        try {
          const instr = JSON.parse(readFileSync(instrPath, "utf-8")) as { description?: string };
          if (instr.description) ref.description = instr.description;
        } catch { /* ignore malformed instructions.json */ }
      }
      return ref;
    })
    .filter((ref) => existsSync(ref.resultPath));
}

export function buildJudgePrompt(evidenceRefs: EvidenceRef[]): string {
  const template = readFileSync(join(__dirname, "../prompts/judge.txt"), "utf-8");
  const evidenceList = evidenceRefs.map((ref) => {
    const desc = ref.description ? ` — "${ref.description}"` : "";
    return `- AC ${ref.acId}${desc}: ${ref.resultPath}`;
  }).join("\n");
  return template.replace("{{evidenceList}}", evidenceList);
}

const VALID_VERDICTS = new Set(["pass", "fail", "error", "timeout", "skipped", "setup_failed", "setup_unsupported", "plan_error", "auth_expired", "spec_unclear"]);
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
