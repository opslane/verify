// pipeline/src/evals/setup-writer/realistic-eval.ts
//
// Realistic eval: calls runSetupWriter through the actual code path
// (same as orchestrator), with real app.json, entity graphs, auth context.
//
// Run:
//   cd pipeline
//   EVAL_DB_URL="..." EVAL_PROJECT_DIR="/path/to/eval/repo" npx tsx src/evals/setup-writer/realistic-eval.ts
//   Add EVAL_CASES_SET=calcom for calcom cases

import postgres from "postgres";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EVAL_CASES, type SetupEvalCase } from "./cases.js";
import { CALCOM_EVAL_CASES } from "./cases-calcom.js";
import { runSetupWriter, type SetupWriterResult } from "../../stages/run-setup-writer.js";
import { runClaude } from "../../run-claude.js";
import { loadAppIndex } from "../../lib/app-index.js";
import { loadProjectEnv } from "../../stages/setup-writer.js";
import type { RunClaudeOptions } from "../../lib/types.js";

const MAX_ATTEMPTS = 3;

// Lazy-initialized in main()
let EVAL_DB_URL: string;
let EVAL_PROJECT_DIR: string;
let CASE_SET: SetupEvalCase[];
let CASE_SET_NAME: string;
let RUN_DIR: string;
let sql: ReturnType<typeof postgres>;

function verifyCondition(query: string): Promise<boolean> {
  return sql.unsafe(query).then(rows => rows.length > 0).catch((err: unknown) => {
    console.error(`  [verify] Query failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  });
}

// ── Main ────────────────────────────────────────────────────────────────────

interface AttemptResult {
  satisfied: boolean;
  sdkUsed: boolean;
  durationMs: number;
  error?: string;
}

interface CaseResult {
  name: string;
  condition: string;
  cli: { attempts: AttemptResult[]; finalSatisfied: boolean };
  sdk: { attempts: AttemptResult[]; finalSatisfied: boolean };
}

async function runRealPath(
  evalCase: SetupEvalCase,
  attempt: number,
  useSdk: boolean,
): Promise<AttemptResult> {
  const verifyDir = join(EVAL_PROJECT_DIR!, ".verify");
  const appIndex = loadAppIndex(verifyDir);
  const projectEnv = loadProjectEnv(EVAL_PROJECT_DIR!);
  const configRaw = await import("node:fs").then(fs => {
    try { return JSON.parse(fs.readFileSync(join(verifyDir, "config.json"), "utf-8")); }
    catch { return {}; }
  });
  const authEmail = configRaw?.auth?.email;

  const mode = useSdk ? "sdk" : "cli";
  const stageName = `realistic-${mode}-${evalCase.name}-a${attempt}`;
  const permissions: Pick<RunClaudeOptions, "dangerouslySkipPermissions" | "allowedTools"> = { allowedTools: ["Bash"] };

  // Set/unset SDK flag
  if (useSdk) process.env.VERIFY_SETUP_SDK = "1";
  else delete process.env.VERIFY_SETUP_SDK;

  const start = Date.now();
  try {
    const result = await runSetupWriter({
      groupId: `eval-${evalCase.name}`,
      condition: evalCase.condition,
      appIndex,
      projectEnv,
      projectRoot: EVAL_PROJECT_DIR!,
      authEmail,
      retryContext: null,
      runDir: RUN_DIR,
      stageName,
      runClaudeFn: runClaude,
      permissions,
      timeoutMs: 180_000,
    });

    const durationMs = Date.now() - start;
    const satisfied = await verifyCondition(evalCase.verificationQuery);

    return {
      satisfied,
      sdkUsed: !!(result?.sqlExecuted),
      durationMs,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    return { satisfied: false, sdkUsed: false, durationMs, error: msg };
  }
}

export async function main() {
  EVAL_DB_URL = process.env.EVAL_DB_URL ?? "";
  EVAL_PROJECT_DIR = process.env.EVAL_PROJECT_DIR ?? "";
  if (!EVAL_DB_URL) { console.error("EVAL_DB_URL required"); process.exitCode = 1; return; }
  if (!EVAL_PROJECT_DIR) { console.error("EVAL_PROJECT_DIR required"); process.exitCode = 1; return; }

  CASE_SET = process.env.EVAL_CASES_SET === "calcom" ? CALCOM_EVAL_CASES : EVAL_CASES;
  CASE_SET_NAME = process.env.EVAL_CASES_SET === "calcom" ? "calcom" : "documenso";
  RUN_DIR = join(process.cwd(), ".eval-realistic-output");
  mkdirSync(join(RUN_DIR, "logs"), { recursive: true });
  mkdirSync(join(RUN_DIR, "setup"), { recursive: true });
  sql = postgres(EVAL_DB_URL);
  console.log(`Realistic Setup-Writer Eval (${CASE_SET_NAME})`);
  console.log("=".repeat(50));
  console.log(`Project: ${EVAL_PROJECT_DIR}`);

  const verifyDir = join(EVAL_PROJECT_DIR!, ".verify");
  const appIndex = loadAppIndex(verifyDir);
  console.log(`App index: ${appIndex ? `loaded (${Object.keys(appIndex.data_model ?? {}).length} models, ${appIndex.entity_graphs ? Object.keys(appIndex.entity_graphs).length : 0} entity graphs)` : "NOT FOUND — SDK will fall through to CLI"}`);
  console.log(`Max attempts: ${MAX_ATTEMPTS}\n`);

  const mutationCases = CASE_SET.filter(c => c.expected.shouldGenerateSQL);
  console.log(`Running ${mutationCases.length} mutation cases\n`);

  const results: CaseResult[] = [];

  for (const evalCase of mutationCases) {
    console.log(`\n━━━ ${evalCase.name} ━━━`);
    console.log(`"${evalCase.condition}"\n`);

    // CLI path
    console.log("  CLI path (VERIFY_SETUP_SDK unset):");
    const cliAttempts: AttemptResult[] = [];
    for (let a = 1; a <= MAX_ATTEMPTS; a++) {
      const result = await runRealPath(evalCase, a, false);
      cliAttempts.push(result);
      console.log(`    attempt ${a}: satisfied=${result.satisfied} sdkUsed=${result.sdkUsed} ${result.durationMs}ms${result.error ? ` err="${result.error.slice(0, 60)}"` : ""}`);
      if (result.satisfied) break;
    }

    // SDK path
    console.log("  SDK path (VERIFY_SETUP_SDK=1):");
    const sdkAttempts: AttemptResult[] = [];
    for (let a = 1; a <= MAX_ATTEMPTS; a++) {
      const result = await runRealPath(evalCase, a, true);
      sdkAttempts.push(result);
      console.log(`    attempt ${a}: satisfied=${result.satisfied} sdkUsed=${result.sdkUsed} ${result.durationMs}ms${result.error ? ` err="${result.error.slice(0, 60)}"` : ""}`);
      if (result.satisfied) break;
    }

    results.push({
      name: evalCase.name,
      condition: evalCase.condition,
      cli: { attempts: cliAttempts, finalSatisfied: cliAttempts[cliAttempts.length - 1].satisfied },
      sdk: { attempts: sdkAttempts, finalSatisfied: sdkAttempts[sdkAttempts.length - 1].satisfied },
    });

    // Cooldown
    console.log("  (5s cooldown)");
    await new Promise(r => setTimeout(r, 5000));
  }

  // Summary
  console.log("\n\n" + "=".repeat(50));
  console.log("REALISTIC EVAL RESULTS");
  console.log("=".repeat(50) + "\n");

  let cliSatisfied = 0, sdkSatisfied = 0;
  let cliFirstAttempt = 0, sdkFirstAttempt = 0;

  for (const r of results) {
    if (r.cli.finalSatisfied) cliSatisfied++;
    if (r.sdk.finalSatisfied) sdkSatisfied++;
    if (r.cli.attempts[0].satisfied) cliFirstAttempt++;
    if (r.sdk.attempts[0].satisfied) sdkFirstAttempt++;

    const winner = r.cli.finalSatisfied === r.sdk.finalSatisfied
      ? "TIE" : r.sdk.finalSatisfied ? "SDK" : "CLI";

    const cliTries = r.cli.attempts.length;
    const sdkTries = r.sdk.attempts.length;
    const cliMs = r.cli.attempts.reduce((s, a) => s + a.durationMs, 0);
    const sdkMs = r.sdk.attempts.reduce((s, a) => s + a.durationMs, 0);
    const sdkActuallyUsed = r.sdk.attempts.some(a => a.sdkUsed);

    console.log(`${r.name}: ${winner}`);
    console.log(`  CLI: ${r.cli.finalSatisfied ? "SATISFIED" : "UNSATISFIED"} in ${cliTries} attempt(s) (${cliMs}ms)`);
    console.log(`  SDK: ${r.sdk.finalSatisfied ? "SATISFIED" : "UNSATISFIED"} in ${sdkTries} attempt(s) (${sdkMs}ms)${sdkActuallyUsed ? "" : " [fell through to CLI — no app.json/entity graphs]"}\n`);
  }

  const cliTotal = results.reduce((s, r) => s + r.cli.attempts.reduce((s2, a) => s2 + a.durationMs, 0), 0);
  const sdkTotal = results.reduce((s, r) => s + r.sdk.attempts.reduce((s2, a) => s2 + a.durationMs, 0), 0);

  console.log("─── Scorecard ───");
  console.log(`Cases satisfied:   CLI ${cliSatisfied}/${results.length}  |  SDK ${sdkSatisfied}/${results.length}`);
  console.log(`First-attempt win: CLI ${cliFirstAttempt}/${results.length}  |  SDK ${sdkFirstAttempt}/${results.length}`);
  console.log(`Total time:        CLI ${(cliTotal / 1000).toFixed(1)}s  |  SDK ${(sdkTotal / 1000).toFixed(1)}s`);

  writeFileSync(join(RUN_DIR, "realistic-results.json"), JSON.stringify(results, null, 2));
  await sql.end();
}

// Run standalone or via CLI `eval-setup` command
const isDirectRun = process.argv[1]?.includes("realistic-eval");
if (isDirectRun) main().catch(console.error);
