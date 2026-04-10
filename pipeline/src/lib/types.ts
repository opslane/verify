// pipeline/src/lib/types.ts — Shared contracts for all pipeline stages

// ── Config ──────────────────────────────────────────────────────────────────

export interface VerifyConfig {
  baseUrl: string;
  specPath?: string;
  diffBase?: string;
  maxParallelGroups?: number;           // default 5
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

// ── Judge output (with confidence scoring) ──────────────────────────────────

export type Verdict = "pass" | "fail" | "blocked" | "unclear" | "error" | "timeout" | "skipped"
  | "auth_expired" | "spec_unclear";

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

// ── App Index (from /verify-setup) ──────────────────────────────────────────

export interface AppIndex {
  indexed_at: string;
  routes: Record<string, { component: string }>;
  pages: Record<string, {
    selectors: Record<string, { value: string; source: string }>;
    source_tests: string[];
  }>;
}

// ── Stage progress (stream-json observability) ──────────────────────────────

export interface StageProgressEvent {
  stage: string;
  event: "tool_call" | "output" | "heartbeat";
  detail?: string;
  /** For tool_call events: the tool input (e.g. the bash command). */
  toolInput?: string;
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
  allowedTools?: string[];              // e.g. ["Bash", "Read", "Glob", "Grep"] — DEPRECATED, use tools
  tools?: string[];                     // replaces the entire tool set via --tools (e.g. ["Bash", "Read"], or [] for no tools)
  effort?: "low" | "medium" | "high" | "max";
  settingSources?: string;              // defaults to "" (no hooks/skills); set "user,project" to opt in
  onProgress?: (event: StageProgressEvent) => void;
  env?: Record<string, string>;         // extra env vars merged into subprocess (e.g. BROWSE_STATE_FILE)
}

export interface RunClaudeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

export type RunClaudeFn = (opts: RunClaudeOptions) => Promise<RunClaudeResult>;

// ── Stage permissions ───────────────────────────────────────────────────────
// Each stage gets ONLY the tool access it needs. This is the explicit map.

export const STAGE_PERMISSIONS: Record<string, Pick<RunClaudeOptions, "dangerouslySkipPermissions" | "allowedTools" | "tools">> = {
  // ac-generator: no entry — content inlined in prompt, tools: [] set in orchestrator
  "executor":      { dangerouslySkipPermissions: true, tools: ["Bash", "Read"] },  // skip-permissions for browse binary + restrict tool set
  "index-agent":   { dangerouslySkipPermissions: true },    // needs Read, Grep, Glob for codebase indexing
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

/** Auth page URL patterns — ACs testing these pages should not trigger the circuit breaker.
 *  Uses boundary-aware matching to avoid false matches on /authorize, /author, etc. */
const AUTH_PAGE_PATTERNS = /\/login(?:\/|$|\?)|\/signin(?:\/|$|\?)|\/signup(?:\/|$|\?)|\/auth(?:\/|$|\?)|\/forgot-password/i;

export function isAuthFailure(observed: string, acTargetUrl?: string): boolean {
  // If this AC intentionally targets an auth page, don't trigger on auth patterns
  // in the observed text — the agent was supposed to be on that page.
  if (acTargetUrl && AUTH_PAGE_PATTERNS.test(acTargetUrl)) {
    return false;
  }

  return AUTH_FAILURE_PATTERNS.some(p => p.test(observed));
}
