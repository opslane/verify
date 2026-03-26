// pipeline/src/stages/graph-setup.ts — graph-informed setup-writer
import type { AppIndex, SetupCommands, RunClaudeFn } from "../lib/types.js";
import { parseJsonOutput } from "../lib/parse-json.js";

type EntityGraphs = NonNullable<AppIndex["entity_graphs"]>;

interface AuthCtx {
  userId?: string;
  teamId?: string;
  email?: string;
}

// ── buildGraphPrompt ────────────────────────────────────────────────────────

/**
 * Build a compact prompt (~1.2K tokens) listing available entity graphs,
 * the condition to satisfy, and output format instructions.
 */
export function buildGraphPrompt(
  condition: string,
  entityGraphs: EntityGraphs,
  existingTables: string[],
  authCtx: AuthCtx,
  learnings?: string,
  psqlCmd?: string,
): string {
  // Build per-table graph details
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

  // Auth context
  const authLines: string[] = [];
  if (authCtx.userId) authLines.push(`userId: ${authCtx.userId}`);
  if (authCtx.teamId) authLines.push(`teamId: ${authCtx.teamId}`);
  if (authCtx.email) authLines.push(`email: ${authCtx.email}`);
  const authBlock = authLines.length > 0 ? `\nAUTH CONTEXT:\n${authLines.join("\n")}\n` : "";

  const existingBlock = existingTables.length > 0
    ? `\nALREADY EXIST (tables with seed data — do NOT recreate):\n${existingTables.join(", ")}\n`
    : "";

  const learningsBlock = learnings ? `\nLEARNINGS (from previous runs):\n${learnings}\n` : "";

  return `You are a setup writer. Generate MINIMAL SQL to put the database into the required state.

CONDITION: ${condition}
${authBlock}
ENTITY GRAPHS (tables and their required columns + FK relationships):
${graphDetails.join("\n\n")}
${existingBlock}${learningsBlock}
DATABASE ACCESS:
Use Bash to run psql commands to query the database and understand current state.
Connection: ${psqlCmd || "psql"} -c "SELECT ..."

PROCESS:
1. Run 1-2 psql SELECT queries to check if the CONDITION is ALREADY SATISFIED by existing data
2. If existing data satisfies the condition: output empty setup_commands
3. If NOT satisfied: write minimal SQL (1-5 commands) using existing record IDs from your SELECT results
4. Output ONLY the JSON below — nothing else

CRITICAL: The database is pre-seeded with realistic test data. Most conditions are ALREADY satisfied.
Your FIRST job is to CHECK, not to INSERT. If you find existing records, return empty setup_commands.

COLUMN NAMES: Use Postgres column names in all SQL (quoted, e.g. "teamId").
MANUAL ID COLUMNS: Use gen_random_uuid() for IDs. Do NOT use hardcoded IDs like 'verify-test-001'.
NEVER create new User, Team, or Organisation records — use existing ones from the auth context.

OUTPUT: Valid JSON to stdout:
{
  "group_id": "setup",
  "condition": "${condition}",
  "setup_commands": ["${psqlCmd || "psql"} --set ON_ERROR_STOP=1 -c \\"UPDATE ...\\""],
  "teardown_commands": []
}

Use \`${psqlCmd || "psql"} --set ON_ERROR_STOP=1 -c "..."\` for setup commands.
Output ONLY the JSON. No explanation, no markdown fences.`;
}

// ── graphInformedSetup ──────────────────────────────────────────────────────

/**
 * Graph-informed setup-writer: build a compact prompt from entity graphs,
 * call a single LLM pass (no tools), generate PL/pgSQL deterministically.
 *
 * Returns null if entity_graphs missing or LLM output unparseable (caller falls back).
 */
export async function graphInformedSetup(
  groupId: string,
  condition: string,
  appIndex: AppIndex,
  projectEnv: Record<string, string>,
  authEmail: string | undefined,
  runDir: string,
  stageName: string,
  runClaudeFn: RunClaudeFn,
): Promise<SetupCommands | null> {
  // Check entity_graphs
  const entityGraphs = appIndex.entity_graphs;
  if (!entityGraphs || Object.keys(entityGraphs).length === 0) {
    return null;
  }

  // Determine existing tables from seed_ids
  const existingTables = Object.keys(appIndex.seed_ids ?? {});

  // Build psql command for DB access
  const dbUrlEnv = appIndex.db_url_env ?? "DATABASE_URL";
  const dbUrl = projectEnv[dbUrlEnv] ?? projectEnv.DATABASE_URL ?? "";
  const cleanDbUrl = dbUrl ? dbUrl.split("?")[0] : "";
  const psqlCmd = cleanDbUrl ? `psql "${cleanDbUrl}"` : "";

  // Build auth context
  const authCtx: AuthCtx = {};
  if (authEmail) authCtx.email = authEmail;

  // Build prompt — include psql connection so LLM can query DB via Bash
  const prompt = buildGraphPrompt(condition, entityGraphs, existingTables, authCtx, undefined, psqlCmd);

  // Call LLM — with Bash tool so it can SELECT to verify existing data
  const result = await runClaudeFn({
    prompt,
    model: "sonnet",
    timeoutMs: 120_000,
    stage: stageName,
    runDir,
    allowedTools: ["Bash"],
  });

  // Parse JSON from LLM output — now expecting SetupCommands format (same as old setup-writer)
  const parsed = parseJsonOutput<{ setup_commands?: string[]; teardown_commands?: string[] }>(result.stdout);
  if (!parsed || !Array.isArray(parsed.setup_commands)) {
    console.error(`  [graph-setup] Failed to parse LLM output for ${groupId}`);
    return null;
  }

  return {
    group_id: groupId,
    condition,
    setup_commands: parsed.setup_commands,
    teardown_commands: parsed.teardown_commands ?? [],
  };
}
