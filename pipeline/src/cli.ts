import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./lib/config.js";
import { runClaude } from "./run-claude.js";
import { STAGE_PERMISSIONS } from "./lib/types.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "verify-dir": { type: "string", default: ".verify" },
    "run-dir": { type: "string" },
    spec: { type: "string" },
  },
});

const [command, stageName] = positionals;

if (command === "run-stage" && stageName) {
  const verifyDir = values["verify-dir"]!;
  const runDir = values["run-dir"] ?? join(verifyDir, "runs", `manual-${Date.now()}`);
  mkdirSync(join(runDir, "logs"), { recursive: true });

  const config = loadConfig(verifyDir);
  const permissions = STAGE_PERMISSIONS[stageName] ?? {};

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
      const result = await runClaude({ prompt, model: "opus", timeoutMs: 120_000, stage: "planner", runDir, ...permissions });
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
    default:
      console.error(`Unknown stage: ${stageName}. Available: ac-generator, planner, plan-validator`);
      process.exit(1);
  }
} else {
  console.error("Usage:");
  console.error("  npx tsx src/cli.ts run-stage <stage> --verify-dir .verify --run-dir /tmp/run [--spec path]");
  process.exit(1);
}
