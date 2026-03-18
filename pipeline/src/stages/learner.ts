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
