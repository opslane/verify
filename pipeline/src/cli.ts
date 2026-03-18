// pipeline/src/cli.ts — CLI entry point for running pipeline stages
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { loadConfig } from "./lib/config.js";
import { runClaude } from "./run-claude.js";
import { STAGE_PERMISSIONS } from "./lib/types.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "verify-dir": { type: "string", default: ".verify" },
    "run-dir": { type: "string" },
    spec: { type: "string" },
    group: { type: "string" },
    condition: { type: "string" },
    ac: { type: "string" },
    timeout: { type: "string" },
  },
});

const [command, stageName] = positionals;

if (command === "run") {
  // Full pipeline run via orchestrator
  const { runPipeline } = await import("./orchestrator.js");
  const verifyDir = values["verify-dir"]!;
  const config = (await import("./lib/config.js")).loadConfig(verifyDir);
  const specPath = values.spec ?? config.specPath;
  if (!specPath) { console.error("No --spec provided and no specPath in config"); process.exit(1); }

  const result = await runPipeline(specPath, verifyDir, {
    onACCheckpoint: async (acs) => {
      // In CLI mode, auto-approve ACs (no interactive prompt)
      console.log(`Generated ${acs.groups.length} groups, ${acs.skipped.length} skipped`);
      return acs;
    },
    onLog: (msg) => console.log(msg),
    onError: (msg) => console.error(msg),
    onProgress: (evt) => {
      process.stdout.write(`\r  ${evt.acId}: ${evt.status}${evt.detail ? ` — ${evt.detail}` : ""}   `);
    },
  });

  if (!result.verdicts) {
    console.error("Pipeline failed. Check logs in:", result.runDir);
    process.exit(1);
  }

  const passCount = result.verdicts.verdicts.filter(v => v.verdict === "pass").length;
  const total = result.verdicts.verdicts.length;
  process.exit(passCount === total ? 0 : 1);

} else if (command === "run-stage" && stageName) {
  const verifyDir = values["verify-dir"]!;
  const runDir = values["run-dir"] ?? join(verifyDir, "runs", `manual-${Date.now()}`);
  mkdirSync(join(runDir, "logs"), { recursive: true });

  // Derive project root from verify-dir (.verify is always a direct child of project root)
  const projectRoot = resolve(verifyDir, "..");

  // Parse --timeout with validation
  let timeoutOverrideMs: number | undefined;
  if (values.timeout) {
    const t = parseInt(values.timeout, 10);
    if (isNaN(t) || t <= 0) { console.error("--timeout must be a positive integer (seconds)"); process.exit(1); }
    timeoutOverrideMs = t * 1000;
  }

  const config = loadConfig(verifyDir);
  const permissions = { ...STAGE_PERMISSIONS[stageName] ?? {}, cwd: projectRoot };

  switch (stageName) {
    case "ac-generator": {
      const { buildACGeneratorPrompt, parseACGeneratorOutput, fanOutPureUIGroups } = await import("./stages/ac-generator.js");
      const specPath = values.spec ?? config.specPath;
      if (!specPath) { console.error("No --spec provided and no specPath in config"); process.exit(1); }
      const prompt = buildACGeneratorPrompt(specPath);
      const result = await runClaude({ prompt, model: "opus", timeoutMs: 120_000, stage: "ac-generator", runDir, ...permissions });
      const acs = parseACGeneratorOutput(result.stdout);
      if (!acs) { console.error("Failed to parse AC output. Check logs:", join(runDir, "logs")); process.exit(1); }
      const fanned = fanOutPureUIGroups(acs);
      writeFileSync(join(runDir, "acs.json"), JSON.stringify(fanned, null, 2));
      console.log(`Generated ${fanned.groups.length} groups, ${fanned.skipped.length} skipped`);
      break;
    }
    case "planner": {
      const { buildPlannerPrompt, parsePlannerOutput } = await import("./stages/planner.js");
      const acsPath = join(runDir, "acs.json");
      const prompt = buildPlannerPrompt(acsPath);
      const result = await runClaude({ prompt, model: "opus", timeoutMs: timeoutOverrideMs ?? 240_000, stage: "planner", runDir, ...permissions });
      const plan = parsePlannerOutput(result.stdout);
      if (!plan) { console.error("Failed to parse plan output. Check logs:", join(runDir, "logs")); process.exit(1); }
      writeFileSync(join(runDir, "plan.json"), JSON.stringify(plan, null, 2));
      console.log(`Planned ${plan.criteria.length} ACs`);
      break;
    }
    case "plan-validator": {
      const { validatePlan } = await import("./stages/plan-validator.js");
      const { loadAppIndex } = await import("./lib/app-index.js");
      const plan = JSON.parse(readFileSync(join(runDir, "plan.json"), "utf-8"));
      const appIndex = loadAppIndex(verifyDir);
      const result = validatePlan(plan, appIndex);
      if (result.valid) {
        console.log("Plan is valid");
      } else {
        console.error("Plan has errors:");
        for (const err of result.errors) console.error(`  - ${err.acId}: ${err.message}`);
        process.exit(1);
      }
      break;
    }
    case "setup-writer": {
      const groupId = values.group;
      const condition = values.condition ?? "";
      if (!groupId) { console.error("--group is required for setup-writer"); process.exit(1); }
      const { buildSetupWriterPrompt, parseSetupWriterOutput } = await import("./stages/setup-writer.js");
      const prompt = buildSetupWriterPrompt(groupId, condition);
      const result = await runClaude({ prompt, model: "sonnet", timeoutMs: timeoutOverrideMs ?? 240_000, stage: "setup-writer", runDir, ...permissions });
      const parsed = parseSetupWriterOutput(result.stdout);
      if (!parsed) { console.error("Failed to parse setup writer output. Check logs:", join(runDir, "logs")); process.exit(1); }
      writeFileSync(join(runDir, "setup.json"), JSON.stringify(parsed, null, 2));
      console.log(`Setup writer: ${parsed.setup_commands.length} setup, ${parsed.teardown_commands.length} teardown commands`);
      break;
    }
    case "browse-agent": {
      const acId = values.ac;
      if (!acId) { console.error("--ac is required for browse-agent"); process.exit(1); }
      const planPath = join(runDir, "plan.json");
      const plan = JSON.parse(readFileSync(planPath, "utf-8")) as { criteria: Array<{ id: string; group: string; description: string; url: string; steps: string[]; screenshot_at: string[]; timeout_seconds: number }> };
      const ac = plan.criteria.find(c => c.id === acId);
      if (!ac) { console.error(`AC ${acId} not found in plan.json`); process.exit(1); }
      const { resolveBrowseBin } = await import("./lib/browse.js");
      const { buildBrowseAgentPrompt, parseBrowseResult } = await import("./stages/browse-agent.js");
      const evidenceDir = join(runDir, "evidence", acId);
      mkdirSync(evidenceDir, { recursive: true });
      const prompt = buildBrowseAgentPrompt(ac, {
        baseUrl: config.baseUrl,
        browseBin: resolveBrowseBin(),
        evidenceDir,
      });
      const result = await runClaude({ prompt, model: "sonnet", timeoutMs: (ac.timeout_seconds ?? 90) * 1000, stage: `browse-agent-${acId}`, runDir, ...permissions });
      const parsed = parseBrowseResult(result.stdout);
      if (parsed) {
        writeFileSync(join(evidenceDir, "result.json"), JSON.stringify(parsed, null, 2));
        console.log(`Browse agent ${acId}: ${parsed.observed.slice(0, 80)}`);
      } else {
        console.error(`Failed to parse browse agent output for ${acId}. Check logs:`, join(runDir, "logs"));
        process.exit(1);
      }
      break;
    }
    case "judge": {
      const { collectEvidencePaths, buildJudgePrompt, parseJudgeOutput } = await import("./stages/judge.js");
      const evidenceRefs = collectEvidencePaths(runDir);
      if (evidenceRefs.length === 0) {
        console.log('{"verdicts":[]}');
        break;
      }
      const prompt = buildJudgePrompt(evidenceRefs);
      const result = await runClaude({ prompt, model: "opus", timeoutMs: 120_000, stage: "judge", runDir, ...permissions });
      const verdicts = parseJudgeOutput(result.stdout);
      if (verdicts) {
        writeFileSync(join(runDir, "verdicts.json"), JSON.stringify(verdicts, null, 2));
        console.log(JSON.stringify(verdicts, null, 2));
      } else {
        console.error("Judge failed to produce valid output. Check logs:", join(runDir, "logs"));
        process.exit(1);
      }
      break;
    }
    case "learner": {
      const { buildLearnerPrompt, backupAndRestore } = await import("./stages/learner.js");
      const learningsPath = join(verifyDir, "learnings.md");
      const { restore } = backupAndRestore(learningsPath);
      const prompt = buildLearnerPrompt({
        verdictsPath: join(runDir, "verdicts.json"),
        timelinePath: join(runDir, "logs", "timeline.jsonl"),
        learningsPath,
      });
      await runClaude({ prompt, model: "sonnet", timeoutMs: 60_000, stage: "learner", runDir, ...permissions });
      restore();
      console.log("Learner complete. Learnings at:", learningsPath);
      break;
    }
    default:
      console.error(`Unknown stage: ${stageName}. Available: ac-generator, planner, plan-validator, setup-writer, browse-agent, judge, learner`);
      process.exit(1);
  }
} else {
  console.error("Usage:");
  console.error("  npx tsx src/cli.ts run --spec <path> [--verify-dir .verify]");
  console.error("  npx tsx src/cli.ts run-stage <stage> --verify-dir .verify --run-dir /tmp/run [options]");
  console.error("");
  console.error("Commands:");
  console.error("  run            Full pipeline run (orchestrator)");
  console.error("  run-stage      Run a single stage for debugging");
  console.error("");
  console.error("Stages:");
  console.error("  ac-generator   --spec <path>");
  console.error("  planner");
  console.error("  plan-validator");
  console.error("  setup-writer   --group <id> [--condition <text>]");
  console.error("  browse-agent   --ac <id>");
  console.error("  judge");
  console.error("  learner");
  process.exit(1);
}
