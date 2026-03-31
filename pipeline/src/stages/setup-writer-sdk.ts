// pipeline/src/stages/setup-writer-sdk.ts — SDK-based setup-writer using run_sql MCP tool
import { createSdkMcpServer, query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRunSqlTool } from "../sdk/tools/run-sql.js";
import type { ToolCallLog } from "../sdk/tools/run-sql.js";
import { SetupError } from "../sdk/errors.js";
import type { SetupCommands } from "../lib/types.js";
import { parseSetupWriterOutput } from "./setup-writer.js";

export interface RunSetupSDKResult {
  output: SetupCommands | null;
  error?: SetupError;
  errorDetail?: string;
  toolCalls: ToolCallLog[];
  affectedTables: string[];
  durationMs: number;
}

export async function runSetupSDK(opts: {
  prompt: string;
  dbUrl: string;
  seedIds: string[];
  timeoutMs: number;
  stage: string;
  runDir: string;
  maxTurns?: number;
}): Promise<RunSetupSDKResult> {
  const { prompt, dbUrl, seedIds, timeoutMs, stage, runDir, maxTurns = 15 } = opts;
  const logsDir = join(runDir, "logs");
  mkdirSync(logsDir, { recursive: true });

  writeFileSync(join(logsDir, `${stage}-prompt.txt`), prompt);

  const log = (msg: string) => console.error(`  [sdk:${stage}] ${msg}`);
  const logLines: string[] = [];
  const addLog = (msg: string) => { logLines.push(`${new Date().toISOString()} ${msg}`); log(msg); };

  let state: { affectedTables: Set<string>; toolCalls: ToolCallLog[] } = { affectedTables: new Set(), toolCalls: [] };
  let closeFn: (() => Promise<void>) | undefined;

  const start = Date.now();
  let finalText = "";
  let error: SetupError | undefined;
  let errorDetail: string | undefined;

  try {
    addLog(`Starting SDK session (timeout=${timeoutMs}ms, maxTurns=${maxTurns})`);
    const { tool: runSqlTool, state: toolState, close } = createRunSqlTool(dbUrl, seedIds);
    state = toolState;
    closeFn = close;
    const server = createSdkMcpServer({ name: "setup", tools: [runSqlTool] });

    const controller = new AbortController();
    const timer = setTimeout(() => {
      addLog(`Timeout fired after ${timeoutMs}ms — aborting`);
      controller.abort();
    }, timeoutMs);

    let messageCount = 0;
    for await (const msg of query({
      prompt,
      options: {
        mcpServers: { setup: server },
        allowedTools: ["mcp__setup__run_sql"],
        permissionMode: "dontAsk",
        maxTurns,
        abortController: controller,
      },
    })) {
      messageCount++;
      if ("result" in msg) {
        finalText = msg.result;
        const subtype = "subtype" in msg ? (msg as Record<string, unknown>).subtype : undefined;
        if (subtype === "error_max_turns") {
          error = SetupError.MAX_TURNS;
          addLog(`Hit max turns (${maxTurns})`);
        }
        addLog(`Result received (${finalText.length} chars, subtype=${String(subtype ?? "none")})`);
      }
    }

    clearTimeout(timer);
    addLog(`Session ended normally (${messageCount} messages, ${state.toolCalls.length} tool calls, ${state.affectedTables.size} tables affected)`);

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const elapsed = Date.now() - start;
    if (msg.includes("abort") || msg.includes("aborted")) {
      error = SetupError.TIMEOUT;
      errorDetail = `Aborted after ${elapsed}ms: ${msg}`;
      addLog(`Aborted: ${msg} (${elapsed}ms, ${state.toolCalls.length} tool calls so far)`);
    } else {
      error = SetupError.SPAWN_ERROR;
      errorDetail = `Spawn/session error after ${elapsed}ms: ${msg}`;
      addLog(`Error: ${msg} (${elapsed}ms)`);
    }
  }

  // Build output from tool call state
  const mutationsExecuted = state.affectedTables.size > 0;
  const executedSql = state.toolCalls
    .filter(c => c.operation !== "SELECT" && !c.error)
    .map(c => c.sql);
  const failedCalls = state.toolCalls.filter(c => c.error);

  let output: SetupCommands | null = null;
  if (mutationsExecuted) {
    output = {
      group_id: "sdk",
      condition: "",
      setup_commands: executedSql,
      teardown_commands: [],
    };
    addLog(`Built output from tool state: ${executedSql.length} mutations, ${failedCalls.length} errors`);
  } else {
    output = parseSetupWriterOutput(finalText);
    if (!output) {
      // Check for {"satisfied": true} format
      try {
        const cleaned = finalText.trim().replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
        const parsed = JSON.parse(cleaned) as Record<string, unknown>;
        if (parsed.satisfied === true || parsed.satisfied === false) {
          output = {
            group_id: typeof parsed.group_id === "string" ? parsed.group_id : "sdk",
            condition: typeof parsed.condition === "string" ? parsed.condition : "",
            setup_commands: [],
            teardown_commands: [],
          };
          addLog(`Parsed satisfied=${String(parsed.satisfied)} from output`);
        }
      } catch {
        // Not valid JSON
      }
    }
    // If LLM ran SELECTs, got results, and produced no mutations, the condition
    // is likely already satisfied. Treat prose output as success with empty commands.
    if (!output && !error && state.toolCalls.length > 0 && state.toolCalls.every(c => c.operation === "SELECT")) {
      output = {
        group_id: "sdk",
        condition: "",
        setup_commands: [],
        teardown_commands: [],
      };
      addLog(`Condition already satisfied (${state.toolCalls.length} SELECTs, 0 mutations, prose output)`);
    }

    if (output) {
      addLog(`Parsed output: ${output.setup_commands.length} commands`);
    } else {
      addLog(`Failed to parse output (${finalText.length} chars): ${finalText.slice(0, 100)}`);
    }
  }

  if (!output && !error) error = finalText ? SetupError.PARSE_ERROR : SetupError.EMPTY_RESPONSE;

  const durationMs = Date.now() - start;
  addLog(`Done in ${durationMs}ms — ${error ? `ERROR: ${error}` : "OK"}`);

  // Write logs
  try {
    writeFileSync(join(logsDir, `${stage}-tool-calls.jsonl`), state.toolCalls.map(c => JSON.stringify(c)).join("\n") + "\n");
    writeFileSync(join(logsDir, `${stage}-output.txt`), finalText);
    writeFileSync(join(logsDir, `${stage}-session.log`), logLines.join("\n") + "\n");
  } catch {
    // Log dir may not exist if we failed very early
  }

  // Close DB connection — don't let this throw
  try {
    await closeFn?.();
  } catch {
    addLog("Warning: close() threw — connection may have been killed by timeout");
  }

  return {
    output,
    error,
    errorDetail,
    toolCalls: state.toolCalls,
    affectedTables: [...state.affectedTables],
    durationMs,
  };
}
