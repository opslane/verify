import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowseEvalResult } from "./browse-eval-score.js";
import { scoreBrowseEvalArtifacts } from "./browse-eval-score.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PIPELINE_DIR = resolve(__dirname, "..", "..");
const CASES_DIR = join(PIPELINE_DIR, "evals", "browse-agent", "cases");

export function discoverCaseDirs(root = CASES_DIR): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .sort();
}

export function formatBrowseEvalSummary(results: BrowseEvalResult[]): string {
  const passed = results.filter((result) => result.passed).length;
  const durations = results.map((result) => result.durationMs).sort((a, b) => a - b);
  const medianDurationMs = durations.length === 0
    ? 0
    : durations.length % 2 === 1
      ? durations[Math.floor(durations.length / 2)]
      : Math.round((durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2);
  const timeoutLikeFailures = results.filter((result) =>
    result.failures.some((failure) => failure.includes("duration"))
  ).length;

  return [
    `Summary: ${passed}/${results.length} passed`,
    `Median duration: ${(medianDurationMs / 1000).toFixed(1)}s`,
    `Timeout-like failures: ${timeoutLikeFailures}`,
  ].join("\n");
}

function createBrowseShim(tmpRoot: string): string {
  const shimPath = join(tmpRoot, "fake-browse");
  const tsxPath = join(PIPELINE_DIR, "node_modules", ".bin", "tsx");
  const fakeBrowsePath = join(PIPELINE_DIR, "src", "evals", "fake-browse.ts");
  writeFileSync(shimPath, `#!/bin/sh\nexec "${tsxPath}" "${fakeBrowsePath}" "$@"\n`);
  chmodSync(shimPath, 0o755);
  return shimPath;
}

export function runBrowseEvalCase(caseDir: string): BrowseEvalResult {
  const caseId = basename(caseDir);
  const tmpRoot = mkdtempSync(join(tmpdir(), "verify-browse-eval-"));
  const verifyDir = join(tmpRoot, ".verify");
  const runDir = join(tmpRoot, "run");
  const shimPath = createBrowseShim(tmpRoot);
  const tracePath = join(runDir, "trace.jsonl");

  mkdirSync(verifyDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(verifyDir, "config.json"), JSON.stringify({ baseUrl: "http://localhost:3000" }));
  copyFileSync(join(caseDir, "plan.json"), join(runDir, "plan.json"));

  try {
    execFileSync("npx", [
      "tsx", "src/cli.ts", "run-stage", "browse-agent",
      "--verify-dir", verifyDir,
      "--run-dir", runDir,
      "--ac", "ac1",
    ], {
      cwd: PIPELINE_DIR,
      env: {
        ...process.env,
        BROWSE_BIN: shimPath,
        BROWSE_EVAL_SCRIPT: join(caseDir, "browse-script.json"),
        BROWSE_EVAL_TRACE: tracePath,
      },
      stdio: "pipe",
    });
  } catch {
    // Keep going — the scorer should still inspect whatever artifacts were produced.
  }

  const result = scoreBrowseEvalArtifacts({
    caseId,
    expectedPath: join(caseDir, "expected.json"),
    resultPath: join(runDir, "evidence", "ac1", "result.json"),
    tracePath,
    streamPath: join(runDir, "logs", "browse-agent-ac1-stream.jsonl"),
  });

  rmSync(tmpRoot, { recursive: true, force: true });
  return result;
}

export function runBrowseEvals(caseDirs = discoverCaseDirs()): BrowseEvalResult[] {
  return caseDirs.map((caseDir) => runBrowseEvalCase(caseDir));
}

function main(): void {
  const results = runBrowseEvals();
  for (const result of results) {
    if (result.passed) {
      console.log(`PASS ${result.caseId}  ${result.commandCount} cmds  ${result.durationMs}ms`);
      continue;
    }
    console.log(`FAIL ${result.caseId}  ${result.failures.join("; ")}`);
  }
  console.log(formatBrowseEvalSummary(results));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
