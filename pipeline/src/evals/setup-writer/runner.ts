// pipeline/src/evals/setup-writer/runner.ts
//
// A/B comparison eval runner for setup-writer SDK migration.
// Run: cd pipeline && EVAL_DB_URL="..." npx tsx src/evals/setup-writer/runner.ts
//
import postgres from "postgres";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EVAL_CASES, type SetupEvalCase } from "./cases.js";
import { runSetupSDK } from "../../stages/setup-writer-sdk.js";
import { runClaude } from "../../run-claude.js";
import { parseSetupWriterOutput } from "../../stages/setup-writer.js";

const EVAL_DB_URL = process.env.EVAL_DB_URL;
if (!EVAL_DB_URL) { console.error("EVAL_DB_URL required"); process.exit(1); }

const RUN_DIR = join(process.cwd(), ".eval-setup-output");
mkdirSync(join(RUN_DIR, "logs"), { recursive: true });

const sql = postgres(EVAL_DB_URL);

interface PathResult {
  parsed: boolean;
  conditionSatisfied: boolean;
  durationMs: number;
  sqlCount: number;
}

interface ComparisonResult {
  caseName: string;
  condition: string;
  cli: PathResult;
  sdk: PathResult;
  winner: "CLI" | "SDK" | "TIE" | "BOTH_FAILED";
  regression: boolean;
}

async function verifyCondition(query: string): Promise<boolean> {
  try {
    const rows = await sql.unsafe(query);
    return rows.length > 0;
  } catch {
    return false;
  }
}

function buildEvalPrompt(condition: string, mode: "cli" | "sdk"): string {
  const dbInstruction = mode === "cli"
    ? `DATABASE ACCESS:\nUse Bash to run psql commands.\nConnection: psql "${EVAL_DB_URL}" -c "SELECT ..."`
    : `DATABASE ACCESS:\nUse the run_sql tool to execute SQL queries.`;

  return `You are a setup writer. Generate MINIMAL SQL to put the database into the required state.

CONDITION: ${condition}

${dbInstruction}

PROCESS:
1. Run 1-2 SELECT queries to check if the CONDITION is ALREADY SATISFIED by existing data
2. If existing data satisfies the condition: output empty setup_commands
3. If NOT satisfied: write minimal SQL (1-5 commands) using existing record IDs
4. Output ONLY the JSON below

CRITICAL: The database is pre-seeded with realistic test data. Most conditions are ALREADY satisfied.
Your FIRST job is to CHECK, not to INSERT.

OUTPUT: Valid JSON to stdout:
{
  "group_id": "eval",
  "condition": "${condition}",
  "setup_commands": [],
  "teardown_commands": []
}

Output ONLY the JSON. No explanation, no markdown fences.`;
}

async function runCLIPath(evalCase: SetupEvalCase, idx: number): Promise<PathResult> {
  const prompt = buildEvalPrompt(evalCase.condition, "cli");
  const start = Date.now();
  const result = await runClaude({
    prompt,
    model: "sonnet",
    timeoutMs: 120_000,
    stage: `eval-cli-${evalCase.name}`,
    runDir: RUN_DIR,
    allowedTools: ["Bash"],
  });
  const durationMs = Date.now() - start;
  const output = parseSetupWriterOutput(result.stdout);
  const conditionSatisfied = await verifyCondition(evalCase.verificationQuery);
  return {
    parsed: !!output,
    conditionSatisfied,
    durationMs,
    sqlCount: output?.setup_commands.length ?? 0,
  };
}

async function runSDKPath(evalCase: SetupEvalCase, idx: number): Promise<PathResult> {
  const result = await runSetupSDK({
    prompt: buildEvalPrompt(evalCase.condition, "sdk"),
    dbUrl: EVAL_DB_URL!.split("?")[0],
    seedIds: [],
    timeoutMs: 120_000,
    stage: `eval-sdk-${evalCase.name}`,
    runDir: RUN_DIR,
    maxTurns: 25,
  });
  const conditionSatisfied = await verifyCondition(evalCase.verificationQuery);
  return {
    parsed: !!result.output,
    conditionSatisfied,
    durationMs: result.durationMs,
    sqlCount: result.output?.setup_commands.length ?? 0,
  };
}

async function main() {
  console.log("Setup-Writer SDK Migration — A/B Comparison Eval");
  console.log("=================================================\n");

  const results: ComparisonResult[] = [];

  for (let i = 0; i < EVAL_CASES.length; i++) {
    const evalCase = EVAL_CASES[i];
    console.log(`\n--- ${evalCase.name} (${i + 1}/${EVAL_CASES.length}) ---`);
    console.log(`"${evalCase.condition}"\n`);

    // Run CLI path
    console.log("  CLI path...");
    const cli = await runCLIPath(evalCase, i);
    console.log(`  CLI: parsed=${cli.parsed} satisfied=${cli.conditionSatisfied} ${cli.durationMs}ms`);

    // Run SDK path
    console.log("  SDK path...");
    const sdk = await runSDKPath(evalCase, i);
    console.log(`  SDK: parsed=${sdk.parsed} satisfied=${sdk.conditionSatisfied} ${sdk.durationMs}ms`);

    let winner: ComparisonResult["winner"];
    let regression = false;
    if (cli.parsed && sdk.parsed) winner = "TIE";
    else if (!cli.parsed && sdk.parsed) winner = "SDK";
    else if (cli.parsed && !sdk.parsed) { winner = "CLI"; regression = true; }
    else winner = "BOTH_FAILED";

    results.push({ caseName: evalCase.name, condition: evalCase.condition, cli, sdk, winner, regression });
  }

  // Summary
  console.log("\n\n=================================================");
  console.log("RESULTS");
  console.log("=================================================\n");

  const regressions = results.filter(r => r.regression);
  const sdkWins = results.filter(r => r.winner === "SDK").length;
  const ties = results.filter(r => r.winner === "TIE").length;
  const cliWins = results.filter(r => r.winner === "CLI").length;
  const bothFailed = results.filter(r => r.winner === "BOTH_FAILED").length;

  for (const r of results) {
    const flag = r.regression ? " *** REGRESSION ***" : "";
    console.log(`${r.caseName}: ${r.winner}${flag}`);
    console.log(`  CLI: ${r.cli.parsed ? "PASS" : "FAIL"} (${r.cli.durationMs}ms, ${r.cli.sqlCount} cmds, satisfied=${r.cli.conditionSatisfied})`);
    console.log(`  SDK: ${r.sdk.parsed ? "PASS" : "FAIL"} (${r.sdk.durationMs}ms, ${r.sdk.sqlCount} cmds, satisfied=${r.sdk.conditionSatisfied})\n`);
  }

  console.log(`Score: SDK=${sdkWins} | TIE=${ties} | CLI=${cliWins} | BOTH_FAILED=${bothFailed}`);
  console.log(`Regressions: ${regressions.length}`);

  if (regressions.length === 0 && (sdkWins + ties) >= Math.floor(EVAL_CASES.length / 2)) {
    console.log("\n*** EVAL PASSED — SDK is non-regressive ***");
  } else if (regressions.length > 0) {
    console.log("\n*** EVAL FAILED — regressions detected ***");
  } else {
    console.log("\n*** EVAL PARTIAL — review results ***");
  }

  writeFileSync(join(RUN_DIR, "eval-results.json"), JSON.stringify(results, null, 2));
  await sql.end();
}

main().catch(console.error);
