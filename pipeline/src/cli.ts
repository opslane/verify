#!/usr/bin/env node
import { parseArgs } from "node:util";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { collectEvidencePaths, buildJudgePrompt, parseJudgeOutput } from "./stages/judge.js";
import { buildLearnerPrompt, backupAndRestore } from "./stages/learner.js";
import { runClaude } from "./run-claude.js";
import { STAGE_PERMISSIONS } from "./lib/types.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "verify-dir": { type: "string", default: ".verify" },
    "run-dir": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

function usage(): never {
  console.log(`Usage: cli.ts <command> [options]

Commands:
  run-stage judge     Run the judge stage on collected evidence
  run-stage learner   Run the learner stage to update learnings

Options:
  --verify-dir <path>   Path to .verify directory (default: .verify)
  --run-dir <path>      Path to the run directory (required for judge)
  -h, --help            Show this help
`);
  process.exit(0);
}

if (values.help) usage();

const [command, stage] = positionals;

if (command !== "run-stage" || !stage) {
  console.error("Error: expected 'run-stage <judge|learner>'");
  process.exit(1);
}

const verifyDir = values["verify-dir"]!;
const runDir = values["run-dir"];

if (!runDir) {
  console.error("Error: --run-dir is required");
  process.exit(1);
}

async function runJudge(): Promise<void> {
  const evidenceRefs = collectEvidencePaths(runDir!);
  if (evidenceRefs.length === 0) {
    console.log('{"verdicts":[]}');
    return;
  }

  const prompt = buildJudgePrompt(evidenceRefs);
  const result = await runClaude({
    prompt,
    model: "opus",
    timeoutMs: 120_000,
    stage: "judge",
    runDir: runDir!,
    ...STAGE_PERMISSIONS["judge"],
  });

  const verdicts = parseJudgeOutput(result.stdout);
  if (verdicts) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(runDir!, "verdicts.json"), JSON.stringify(verdicts, null, 2));
    console.log(JSON.stringify(verdicts, null, 2));
  } else {
    console.error("Judge failed to produce valid output");
    process.exit(1);
  }
}

async function runLearner(): Promise<void> {
  const learningsPath = join(verifyDir, "learnings.md");
  const { restore } = backupAndRestore(learningsPath);

  const prompt = buildLearnerPrompt({
    verdictsPath: join(runDir!, "verdicts.json"),
    timelinePath: join(runDir!, "logs", "timeline.jsonl"),
    learningsPath,
  });

  mkdirSync(join(runDir!, "logs"), { recursive: true });

  await runClaude({
    prompt,
    model: "sonnet",
    timeoutMs: 60_000,
    stage: "learner",
    runDir: runDir!,
    ...STAGE_PERMISSIONS["learner"],
  });

  restore();
  console.log("Learner complete. Learnings at:", learningsPath);
}

switch (stage) {
  case "judge":
    await runJudge();
    break;
  case "learner":
    await runLearner();
    break;
  default:
    console.error(`Unknown stage: ${stage}. Expected 'judge' or 'learner'.`);
    process.exit(1);
}
