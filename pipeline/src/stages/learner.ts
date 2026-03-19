import { readFileSync, copyFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface LearnerPaths {
  verdictsPath: string;
  timelinePath: string;
  learningsPath: string;
}

export function buildLearnerPrompt(paths: LearnerPaths): string {
  const template = readFileSync(join(__dirname, "../prompts/learner.txt"), "utf-8");
  return template
    .replaceAll("{{verdictsPath}}", paths.verdictsPath)
    .replaceAll("{{timelinePath}}", paths.timelinePath)
    .replaceAll("{{learningsPath}}", paths.learningsPath);
}

// ── Learnings post-validator ──────────────────────────────────────────────

const ALLOWED_SECTIONS = new Set([
  "SQL Corrections",
  "Column Mappings",
  "Required Fields",
  "Timing",
]);

const BANNED_PATTERNS = [
  /\bMUST\b/,
  /\bNEVER\b/,
  /\bALWAYS\b/,
  /\bUNTESTABLE\b/i,
  /\bplanner\s+(must|should)\b/i,
  /\bac\s+generator\s+(must|should)\b/i,
  /\blogin\s+steps?\b/i,
  /\bauth(entication)?\s+(must|should|steps?)\b/i,
];

/** Lines starting with ERROR: or FIX: are exempt from banned pattern checks */
const ERROR_FIX_LINE = /^\s*-?\s*(ERROR|FIX):/i;

/**
 * Validate learnings.md — strip unauthorized sections and banned patterns.
 * Defense-in-depth: the prompt tells the LLM what to write, this enforces it.
 */
export function validateLearnings(content: string): string {
  if (!content.trim()) return content;

  const lines = content.split("\n");
  const result: string[] = [];
  let inAllowedSection = false;
  let headerSeen = false;
  let anySectionSeen = false;

  for (const line of lines) {
    // Keep the top-level header
    if (line.startsWith("# ") && !line.startsWith("## ") && !headerSeen) {
      result.push(line);
      headerSeen = true;
      continue;
    }

    // Blank lines before any ## section are preamble — keep them
    if (headerSeen && !anySectionSeen && line.trim() === "") {
      result.push(line);
      continue;
    }

    // Any heading (##, ###, ####, etc.) is a section boundary
    if (/^#{2,}\s/.test(line)) {
      anySectionSeen = true;
      // Only ## (h2) can be an allowed section; h3+ always resets to disallowed
      if (line.startsWith("## ") && !line.startsWith("### ")) {
        const sectionName = line.slice(3).trim();
        inAllowedSection = ALLOWED_SECTIONS.has(sectionName);
        if (inAllowedSection) result.push(line);
      } else {
        // h3+ sub-section — treat as unauthorized boundary
        inAllowedSection = false;
      }
      continue;
    }

    // Only include lines from allowed sections
    if (!inAllowedSection) continue;

    // ERROR/FIX lines are exempt from banned pattern checks
    if (!ERROR_FIX_LINE.test(line) && BANNED_PATTERNS.some((p) => p.test(line))) continue;

    result.push(line);
  }

  return result.join("\n");
}

const MIN_LEARNINGS_BYTES = 10;

export function backupAndRestore(learningsPath: string): {
  backup: string;
  restore: () => void;
} {
  const backupPath = learningsPath + ".bak";
  if (existsSync(learningsPath)) {
    copyFileSync(learningsPath, backupPath);
  }
  return {
    backup: backupPath,
    restore: () => {
      if (!existsSync(backupPath)) return;
      const needsRestore = !existsSync(learningsPath) || statSync(learningsPath).size < MIN_LEARNINGS_BYTES;
      if (needsRestore) {
        copyFileSync(backupPath, learningsPath);
      }
    },
  };
}
