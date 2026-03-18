// pipeline/src/lib/run-id.ts — Deterministic run ID from spec path + timestamp
import { basename } from "node:path";

export function generateRunId(specPath: string, now = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 16).replace(":", "");
  const slug = basename(specPath, ".md")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${date}-${time}-${slug}`;
}
