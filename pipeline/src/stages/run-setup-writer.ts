// pipeline/src/stages/run-setup-writer.ts — shared setup-writer runner (SDK → graph-informed → fallback)
import { graphInformedSetup } from "./graph-setup.js";
import { buildSetupWriterPrompt, parseSetupWriterOutput } from "./setup-writer.js";
import { runSetupSDK } from "./setup-writer-sdk.js";
import type { ToolCallLog } from "../sdk/tools/run-sql.js";
import type { SetupCommands, AppIndex, RunClaudeOptions, RunClaudeFn } from "../lib/types.js";
import type { SetupRetryContext } from "./setup-writer.js";

export interface SetupWriterResult {
  commands: SetupCommands;
  /** Tables affected by SDK path (direct DB execution). When set, orchestrator
   *  should use these for snapshotting instead of parsing setup_commands strings. */
  affectedTables?: string[];
  /** When true, SQL was already executed (SDK path). Orchestrator should skip executeSetupCommands. */
  sqlExecuted?: boolean;
  /** Tool call log from SDK path — used for retry context on failure. */
  toolCalls?: ToolCallLog[];
}

/** Returned when SDK path fails, so orchestrator can build sdk_error retry context. */
let _lastSdkFailure: { toolCalls: ToolCallLog[]; error?: string } | null = null;

/** Get the last SDK failure info (for orchestrator retry context). Clears after read. */
export function consumeLastSdkFailure(): { toolCalls: ToolCallLog[]; error?: string } | null {
  const f = _lastSdkFailure;
  _lastSdkFailure = null;
  return f;
}

/**
 * Run setup-writer: try SDK path first (if enabled), then graph-informed CLI, then monolithic CLI.
 * Used by both orchestrator and CLI run-stage.
 */
export async function runSetupWriter(opts: {
  groupId: string;
  condition: string;
  appIndex: AppIndex | null;
  projectEnv: Record<string, string>;
  projectRoot: string;
  authEmail?: string;
  retryContext: SetupRetryContext | null;
  runDir: string;
  stageName: string;
  runClaudeFn: RunClaudeFn;
  permissions: Pick<RunClaudeOptions, "dangerouslySkipPermissions" | "allowedTools">;
  timeoutMs: number;
}): Promise<SetupWriterResult | null> {
  // SDK path — opt-in via VERIFY_SETUP_SDK=1
  if (process.env.VERIFY_SETUP_SDK === "1" && opts.appIndex) {
    // Build SDK retry context from previous attempt if available
    const sdkRetry = opts.retryContext?.type === "sdk_error" ? opts.retryContext : null;

    const sdkResult = await trySDKPath({
      groupId: opts.groupId,
      condition: opts.condition,
      appIndex: opts.appIndex,
      projectEnv: opts.projectEnv,
      authEmail: opts.authEmail,
      runDir: opts.runDir,
      stageName: opts.stageName,
      timeoutMs: opts.timeoutMs,
      retryContext: sdkRetry,
    });
    // SDK is authoritative when enabled — return success or failure, don't fall through to CLI
    return sdkResult;
  }

  // Try graph-informed CLI first
  let commands: SetupCommands | null = null;
  if (opts.appIndex) {
    commands = await graphInformedSetup(
      opts.groupId, opts.condition, opts.appIndex, opts.projectEnv, opts.authEmail,
      opts.runDir, opts.stageName, opts.runClaudeFn,
    );
  }

  // Fallback to old monolithic setup-writer
  if (!commands) {
    const prompt = opts.retryContext && opts.retryContext.type !== "sdk_error"
      ? (await import("./setup-writer.js")).buildSetupWriterRetryPrompt(opts.groupId, opts.condition, opts.projectRoot, opts.retryContext, opts.authEmail)
      : buildSetupWriterPrompt(opts.groupId, opts.condition, opts.projectRoot, opts.authEmail);
    const result = await opts.runClaudeFn({
      prompt, model: "sonnet", timeoutMs: opts.timeoutMs,
      stage: opts.stageName, runDir: opts.runDir, ...opts.permissions,
    });
    commands = parseSetupWriterOutput(result.stdout);
  }

  return commands ? { commands } : null;
}

// ── SDK prompt builder ──────────────────────────────────────────────────────

type EntityGraphs = NonNullable<AppIndex["entity_graphs"]>;

/** Build graph data section (shared between CLI and SDK prompts). */
function buildGraphDataSection(
  entityGraphs: EntityGraphs,
  existingTables: string[],
  authEmail?: string,
): { graphBlock: string; authBlock: string; existingBlock: string } {
  const graphDetails: string[] = [];
  for (const [rootTable, graph] of Object.entries(entityGraphs)) {
    const lines: string[] = [`--- ${rootTable} ---`, `Insert order: ${graph.insert_order.join(" → ")}`];
    for (const [tableName, meta] of Object.entries(graph.tables)) {
      const cols = meta.columns.map(c => `${c.name} (${c.pg_type})`).join(", ");
      const fks = meta.fk_parents.map(fk => `${fk.column} → ${fk.parent_table}.${fk.parent_column}${fk.required ? " [required]" : ""}`).join(", ");
      lines.push(`  ${tableName}: columns=[${cols}]${fks ? ` fks=[${fks}]` : ""}`);
    }
    graphDetails.push(lines.join("\n"));
  }

  const authBlock = authEmail ? `\nAUTH CONTEXT:\nemail: ${authEmail}\n` : "";
  const existingBlock = existingTables.length > 0
    ? `\nALREADY EXIST (tables with seed data — do NOT recreate):\n${existingTables.join(", ")}\n`
    : "";

  return {
    graphBlock: `ENTITY GRAPHS (tables and their required columns + FK relationships):\n${graphDetails.join("\n\n")}`,
    authBlock,
    existingBlock,
  };
}

/** Build SDK prompt — tells LLM to execute mutations directly via run_sql. */
function buildSdkPrompt(
  groupId: string,
  condition: string,
  appIndex: AppIndex,
  authEmail?: string,
  retryContext?: SdkRetryContext,
): string {
  const entityGraphs = appIndex.entity_graphs;
  let schemaSection = "";
  let authBlock = "";
  let existingBlock = "";

  if (entityGraphs && Object.keys(entityGraphs).length > 0) {
    const existingTables = Object.keys(appIndex.seed_ids ?? {});
    const data = buildGraphDataSection(entityGraphs, existingTables, authEmail);
    schemaSection = data.graphBlock;
    authBlock = data.authBlock;
    existingBlock = data.existingBlock;
  } else {
    authBlock = authEmail ? `\nAUTH CONTEXT:\nemail: ${authEmail}\n` : "";
  }

  const retryBlock = retryContext ? buildSdkRetryBlock(retryContext) : "";

  return `You are a database setup agent. Your job is to EXECUTE SQL to put the database into the required state.

CONDITION: ${condition}
${authBlock}${schemaSection ? `\n${schemaSection}\n` : ""}${existingBlock}
You have one tool: run_sql. Use it for ALL database operations.

STEP 1 — CHECK: Call run_sql(operation="SELECT", sql="...") to see if the condition is already met.
STEP 2 — MUTATE: If not met, call run_sql(operation="INSERT", sql="...") or UPDATE/DELETE to fix it.
  - If an INSERT fails with fk_violation, SELECT to find the parent record, then INSERT with the correct FK.
  - If it fails with column_not_found, SELECT from information_schema.columns to find the right name.
  - Keep trying until the mutation succeeds.
STEP 3 — VERIFY: Call run_sql(operation="SELECT", sql="...") to confirm the condition is now satisfied.
STEP 4 — OUTPUT: Print this JSON (and nothing else):
{"group_id":"${groupId}","condition":"${condition}","satisfied":true}

If the condition was already satisfied in step 1, skip to step 4.
If you could not satisfy the condition after trying, output: {"group_id":"${groupId}","condition":"${condition}","satisfied":false}

RULES:
- ALL database changes MUST go through run_sql tool calls. Do NOT output SQL strings without executing them.
- Use Postgres column names in all SQL (quoted, e.g. "teamId").
- Use gen_random_uuid() for IDs.
- NEVER create new User, Team, or Organisation records — use existing ones.
- Output ONLY the JSON. No explanation, no markdown.${retryBlock}`;
}

// ── SDK retry context ───────────────────────────────────────────────────────

interface SdkRetryContext {
  toolCalls: ToolCallLog[];
  error?: string;
}

function buildSdkRetryBlock(ctx: SdkRetryContext): string {
  const errorCalls = ctx.toolCalls.filter(c => c.error);
  const successMutations = ctx.toolCalls.filter(c => !c.error && c.operation !== "SELECT");
  const successSelects = ctx.toolCalls.filter(c => !c.error && c.operation === "SELECT");

  const parts: string[] = [
    "",
    "",
    "YOUR PREVIOUS ATTEMPT DID NOT SATISFY THE CONDITION. Here is what happened:",
  ];

  if (successSelects.length > 0) {
    parts.push("", "Successful SELECTs:");
    for (const c of successSelects) {
      parts.push(`  ${c.result ?? "ok"} — ${c.sql.slice(0, 120)}`);
    }
  }

  if (successMutations.length > 0) {
    parts.push("", "Successful mutations (these were committed):");
    for (const c of successMutations) {
      parts.push(`  ${c.operation}: ${c.sql.slice(0, 120)}`);
    }
  }

  if (errorCalls.length > 0) {
    parts.push("", "Failed queries:");
    for (const c of errorCalls) {
      parts.push(`  ${c.operation} "${c.sql.slice(0, 100)}"`);
      parts.push(`    → ERROR (${c.errorType ?? "unknown"}): ${c.error}`);
    }
    parts.push("", "Fix hints:");
    parts.push("  fk_violation → missing parent record, INSERT the parent first");
    parts.push("  column_not_found → wrong column name, SELECT from information_schema.columns");
    parts.push("  unique_violation → record exists, use UPDATE or different ID");
    parts.push("  table_not_found → wrong table name, SELECT from information_schema.tables");
  }

  if (ctx.error) {
    parts.push("", `Overall error: ${ctx.error}`);
  }

  parts.push("", "Analyze the above and try again. EXECUTE mutations via run_sql — do not just list them.");
  return parts.join("\n");
}

// ── SDK path ────────────────────────────────────────────────────────────────

/** Attempt SDK path using run_sql MCP tool. Returns null on failure (caller falls back to CLI). */
async function trySDKPath(opts: {
  groupId: string;
  condition: string;
  appIndex: AppIndex;
  projectEnv: Record<string, string>;
  authEmail?: string;
  runDir: string;
  stageName: string;
  timeoutMs: number;
  retryContext: SdkRetryContext | null;
}): Promise<SetupWriterResult | null> {
  const { appIndex, projectEnv } = opts;

  // Resolve DB URL
  const dbUrlEnv = appIndex.db_url_env ?? "DATABASE_URL";
  const dbUrl = projectEnv[dbUrlEnv] ?? projectEnv.DATABASE_URL ?? "";
  if (!dbUrl) return null;
  const cleanDbUrl = dbUrl.split("?")[0];

  // Collect seed IDs for protection
  const seedIds: string[] = [];
  for (const ids of Object.values(appIndex.seed_ids ?? {})) {
    seedIds.push(...ids);
  }

  const prompt = buildSdkPrompt(
    opts.groupId, opts.condition, opts.appIndex, opts.authEmail,
    opts.retryContext ?? undefined,
  );

  const result = await runSetupSDK({
    prompt,
    dbUrl: cleanDbUrl,
    seedIds,
    timeoutMs: opts.timeoutMs,
    stage: `${opts.stageName}-sdk`,
    runDir: opts.runDir,
    maxTurns: 25,
  });

  if (result.output) {
    return {
      commands: result.output,
      affectedTables: result.affectedTables,
      sqlExecuted: true,
      toolCalls: result.toolCalls,
    };
  }
  if (result.error) {
    console.error(`  [setup-sdk] ${opts.stageName} failed: ${result.error} (${result.durationMs}ms, ${result.toolCalls.length} tool calls)`);
  }
  // Store failure info so orchestrator can build sdk_error retry context
  _lastSdkFailure = { toolCalls: result.toolCalls, error: result.error };
  return null;
}
