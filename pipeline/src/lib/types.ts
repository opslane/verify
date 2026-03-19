// pipeline/src/lib/types.ts — Shared contracts for all pipeline stages

// ── Config ──────────────────────────────────────────────────────────────────

export interface VerifyConfig {
  baseUrl: string;
  authCheckUrl?: string;
  specPath?: string;
  diffBase?: string;
  maxParallelGroups?: number;           // default 5
  auth?: {
    method: "credentials" | "cookies";
    loginUrl?: string;
    email?: string;
    password?: string;
  };
}

// ── AC Generator output ─────────────────────────────────────────────────────

export interface ACGroup {
  id: string;                           // "group-a"
  condition: string | null;             // null = pure UI, no setup needed
  acs: AC[];
}

export interface AC {
  id: string;                           // "ac1"
  description: string;
}

export interface ACGeneratorOutput {
  groups: ACGroup[];
  skipped: Array<{ id: string; reason: string }>;
}

// ── Planner output ──────────────────────────────────────────────────────────

export interface PlannedAC {
  id: string;
  group: string;                        // matches ACGroup.id
  description: string;
  url: string;                          // relative, e.g. "/settings"
  steps: string[];
  screenshot_at: string[];
  timeout_seconds: number;              // 60-300
}

export interface PlannerOutput {
  criteria: PlannedAC[];
}

// ── Plan Validator ──────────────────────────────────────────────────────────

export interface PlanValidationError {
  acId: string;
  field: string;
  message: string;
}

export interface PlanValidationResult {
  valid: boolean;
  errors: PlanValidationError[];
}

// ── Setup Writer output ─────────────────────────────────────────────────────

export interface SetupCommands {
  group_id: string;
  condition: string;
  setup_commands: string[];
  teardown_commands: string[];
}

// ── Browse Agent output ─────────────────────────────────────────────────────

export interface BrowseResult {
  ac_id: string;
  observed: string;
  screenshots: string[];                // filenames relative to evidence dir
  commands_run: string[];
}

// ── Judge output (with confidence scoring) ──────────────────────────────────

export type Verdict = "pass" | "fail" | "error" | "timeout" | "skipped"
  | "setup_failed" | "setup_unsupported" | "plan_error" | "auth_expired"
  | "spec_unclear";

export type Confidence = "high" | "medium" | "low";

export interface ACVerdict {
  ac_id: string;
  verdict: Verdict;
  confidence: Confidence;
  reasoning: string;
}

export interface JudgeOutput {
  verdicts: ACVerdict[];
}

// ── Learner (no structured output — writes learnings.md) ────────────────────

// ── App Index (from /verify-setup) ──────────────────────────────────────────

export interface AppIndex {
  indexed_at: string;
  routes: Record<string, { component: string }>;
  pages: Record<string, {
    selectors: Record<string, { value: string; source: string }>;
    source_tests: string[];
  }>;
  data_model: Record<string, {
    columns: Record<string, string>;    // prismaFieldName → postgresColumnName
    table_name: string;                 // actual Postgres table name (from @@map, or model name)
    enums: Record<string, string[]>;
    source: string;
  }>;
  fixtures: Record<string, {
    description: string;
    runner: string | null;
    source: string;
  }>;
  db_url_env: string | null;
  feature_flags: string[];
  seed_ids: Record<string, string[]>;   // modelName → array of known seed record IDs
  json_type_annotations: Record<string, Record<string, string>>;  // model → { field → TypeName }
}

// ── Run Claude helper ───────────────────────────────────────────────────────

export interface RunClaudeOptions {
  prompt: string;
  model: "opus" | "sonnet" | "haiku";
  timeoutMs: number;
  stage: string;                        // for log file naming
  runDir: string;                       // .verify/runs/{run-id}
  cwd?: string;                         // working directory for claude (target project root)
  dangerouslySkipPermissions?: boolean;
  allowedTools?: string[];              // e.g. ["Bash", "Read", "Glob", "Grep"]
}

export interface RunClaudeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

// ── Stage permissions ───────────────────────────────────────────────────────
// Each stage gets ONLY the tool access it needs. This is the explicit map.

export const STAGE_PERMISSIONS: Record<string, Pick<RunClaudeOptions, "dangerouslySkipPermissions" | "allowedTools">> = {
  "ac-generator":  { dangerouslySkipPermissions: true },   // needs Read, Grep for spec + app.json
  "planner":       { dangerouslySkipPermissions: true },   // needs Read, Grep, Glob for full codebase
  "setup-writer":  { allowedTools: ["Bash", "Read"] },      // Bash for psql, Read for app.json/schema.sql/learnings.md
  "browse-agent":  { allowedTools: ["Bash", "Read"] },      // Bash for browse CLI, Read for instructions.json
  "judge":         { allowedTools: ["Read"] },              // only reads evidence files
  "learner":       { dangerouslySkipPermissions: true },   // needs Read + Write for learnings.md
};

// ── Timeline event ──────────────────────────────────────────────────────────

export interface TimelineEvent {
  ts: string;                           // ISO timestamp
  stage: string;
  event: "start" | "end" | "error" | "timeout" | "skip";
  durationMs?: number;
  detail?: string;
}

// ── Progress event (for streaming dashboard) ────────────────────────────────

export type ProgressStatus = "pending" | "running" | "pass" | "fail" | "error" | "timeout" | "skipped";

export interface ProgressEvent {
  acId: string;
  status: ProgressStatus;
  detail?: string;                      // e.g. "navigating...", "waiting for setup"
}

// ── Auth failure patterns ───────────────────────────────────────────────────

export const AUTH_FAILURE_PATTERNS = [
  /auth redirect/i,
  /auth failure/i,
  /\/login|\/signin|\/auth/i,
  /session expired/i,
  /unauthorized/i,
  /please log in/i,
  /sign in to continue/i,
] as const;

export function isAuthFailure(observed: string, url?: string): boolean {
  if (AUTH_FAILURE_PATTERNS.some(p => p.test(observed))) return true;
  if (url && /\/login|\/signin|\/auth/.test(url)) return true;
  return false;
}
