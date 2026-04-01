// pipeline/src/stages/planner-sdk.ts — SDK-based planner using native Read/Grep/Glob tools
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PlannerError } from "../sdk/errors.js";
import { buildPlannerPrompt, parsePlannerOutput, buildRetryPrompt } from "./planner.js";
import { validatePlan } from "./plan-validator.js";
import type { PlannerOutput, AppIndex } from "../lib/types.js";

export interface PlannerSDKResult {
  plan: PlannerOutput | null;
  error?: PlannerError;
  errorDetail?: string;
  durationMs: number;
}

export async function runPlannerSDK(opts: {
  acsPath: string;
  appIndex: AppIndex | null;
  timeoutMs: number;
  stage: string;
  runDir: string;
  cwd: string;
}): Promise<PlannerSDKResult> {
  const { acsPath, appIndex, timeoutMs, stage, runDir, cwd } = opts;
  const logsDir = join(runDir, "logs");
  mkdirSync(logsDir, { recursive: true });

  const prompt = buildPlannerPrompt(acsPath, appIndex);
  writeFileSync(join(logsDir, `${stage}-prompt.txt`), prompt);

  const log = (msg: string) => console.error(`  [sdk:${stage}] ${msg}`);
  const logLines: string[] = [];
  const addLog = (msg: string) => { logLines.push(`${new Date().toISOString()} ${msg}`); log(msg); };

  const start = Date.now();
  let finalText = "";
  let error: PlannerError | undefined;
  let errorDetail: string | undefined;

  try {
    addLog(`Starting SDK session (timeout=${timeoutMs}ms, maxTurns=25, cwd=${cwd})`);

    const controller = new AbortController();
    const timer = setTimeout(() => {
      addLog(`Timeout fired after ${timeoutMs}ms — aborting`);
      controller.abort();
    }, timeoutMs);

    let messageCount = 0;
    for await (const msg of query({
      prompt,
      options: {
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 40,
        cwd,
        abortController: controller,
      },
    })) {
      messageCount++;
      if ("result" in msg) {
        finalText = msg.result;
        const subtype = "subtype" in msg ? (msg as Record<string, unknown>).subtype : undefined;
        if (subtype === "error_max_turns") {
          error = PlannerError.MAX_TURNS;
          addLog(`Hit max turns (40)`);
        }
        addLog(`Result received (${finalText.length} chars, subtype=${String(subtype ?? "none")})`);
      }
    }

    clearTimeout(timer);
    addLog(`Session ended normally (${messageCount} messages)`);

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const elapsed = Date.now() - start;
    if (msg.includes("abort") || msg.includes("aborted")) {
      error = PlannerError.TIMEOUT;
      errorDetail = `Aborted after ${elapsed}ms: ${msg}`;
      addLog(`Aborted: ${msg} (${elapsed}ms)`);
    } else {
      error = PlannerError.SPAWN_ERROR;
      errorDetail = `Spawn/session error after ${elapsed}ms: ${msg}`;
      addLog(`Error: ${msg} (${elapsed}ms)`);
    }
  }

  // Parse output
  let plan = parsePlannerOutput(finalText);
  if (!plan && !error) {
    error = finalText ? PlannerError.PARSE_ERROR : PlannerError.EMPTY_RESPONSE;
    addLog(`${error}: ${finalText.slice(0, 100)}`);
  }

  // Validate + one retry (mirrors CLI path in orchestrator)
  if (plan) {
    let validation = validatePlan(plan, appIndex);
    if (!validation.valid) {
      addLog(`Plan has ${validation.errors.length} errors, retrying...`);

      const retryPrompt = buildRetryPrompt(acsPath, validation.errors, appIndex);
      writeFileSync(join(logsDir, `${stage}-retry-prompt.txt`), retryPrompt);

      try {
        const retryController = new AbortController();
        const retryTimer = setTimeout(() => {
          addLog(`Retry timeout fired — aborting`);
          retryController.abort();
        }, timeoutMs);

        let retryText = "";
        for await (const msg of query({
          prompt: retryPrompt,
          options: {
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            maxTurns: 40,
            cwd,
            abortController: retryController,
          },
        })) {
          if ("result" in msg) {
            retryText = msg.result;
          }
        }
        clearTimeout(retryTimer);

        const retryPlan = parsePlannerOutput(retryText);
        if (retryPlan) {
          plan = retryPlan;
          validation = validatePlan(plan, appIndex);
          writeFileSync(join(logsDir, `${stage}-retry-output.txt`), retryText);
          addLog(`Retry produced ${retryPlan.criteria.length} ACs (${validation.valid ? "valid" : `${validation.errors.length} errors`})`);
        } else {
          addLog(`Retry parse failed`);
        }
      } catch (retryErr: unknown) {
        const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        addLog(`Retry error: ${msg}`);
      }
    }
  }

  const durationMs = Date.now() - start;
  addLog(`Done in ${durationMs}ms — ${error ? `ERROR: ${error}` : `OK (${plan?.criteria.length ?? 0} ACs)`}`);

  // Write logs
  try {
    writeFileSync(join(logsDir, `${stage}-output.txt`), finalText);
    writeFileSync(join(logsDir, `${stage}-session.log`), logLines.join("\n") + "\n");
  } catch {
    // Log dir may not exist if we failed very early
  }

  return { plan, error, errorDetail, durationMs };
}
