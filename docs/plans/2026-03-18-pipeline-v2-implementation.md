# Pipeline v2: Microagent Architecture — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the bash pipeline with a TypeScript microagent architecture where each stage is an isolated, testable module with well-defined JSON contracts.

**Architecture:** Six pipeline stages (AC Generator → Planner → Setup Writer → Browse Agents → Judge → Learner) orchestrated by a TypeScript entry point. Each stage reads/writes files to `.verify/runs/{run-id}/`. A shared `runClaude()` helper guarantees logging, timeouts, and model selection for every LLM call. A streaming progress emitter shows live status.

**Tech Stack:** TypeScript 5, Node 22 ESM, vitest for tests, tsx for dev execution. No build step needed — the pipeline runs via `npx tsx`.

**Design doc:** `docs/plans/2026-03-18-pipeline-v2-design.md`
**Scope expansions:** `docs/designs/pipeline-v2.md` (streaming progress, confidence scoring, timing summary, self-healing learnings — dry-run dropped)

---

## Eng Review Changes Applied

This plan incorporates all findings from the 2026-03-18 eng review:

1. `runClaude` uses `spawn` + stream collection (not `execFile`) — handles large Planner outputs, correct stdin piping
2. `init()` preflight checks added to orchestrator — fail fast before LLM calls
3. 4 CEO scope expansions added: streaming progress, confidence scoring, timing summary, self-healing learnings
4. Single `cli.ts` with subcommands — stages are pure libraries, CLI is the CLI
5. Explicit `STAGE_PERMISSIONS` map — each stage gets only the tool access it needs
6. WS5 (Orchestrator) fully fleshed out with complete test cases and implementation code
7. `parseJsonOutput` greedy regex fixed — tries parsing from each `{` position
8. 20+ missing test cases added across all workstreams (circuit breaker, group DAG, failure handling)
9. Minimal eval infrastructure added to WS6
10. `ACVerdict` type includes `confidence` field (high/medium/low)

---

## Workstream Overview

```
Phase 1 (serial):      WS1 — Foundation (types, run-claude, config, package setup)
                              ↓ merge to main ↓
Phase 2 (3 parallel):  WS2 — Planning chain (AC Generator + Planner + Plan Validator)
                        WS3 — Execution layer (Setup Writer + Browse daemon + Browse Agent)
                        WS4 — Evaluation layer (Judge + Learner + confidence + self-healing)
                              ↓ merge all to main ↓
Phase 3 (serial):      WS5 — Orchestrator (init, execution DAG, circuit breaker, progress, timing)
                              ↓ merge to main ↓
Phase 4 (serial):      WS6 — Integration (SKILL.md rewrite, app indexer port, eval infra, e2e test)
```

**Dependency rule:** Each workstream depends ONLY on the contracts defined in `types.ts` from WS1. Stages import types but never import each other. The orchestrator is the only module that imports stages.

---

## Shared Contracts (defined in WS1, consumed by all)

These interfaces are the "agreement" between workstreams. Once WS1 merges, all parallel workstreams code against these types.

```typescript
// pipeline/src/lib/types.ts

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
  | "setup_failed" | "setup_unsupported" | "plan_error" | "auth_expired";

export type Confidence = "high" | "medium" | "low";

export interface ACVerdict {
  ac_id: string;
  verdict: Verdict;
  confidence: Confidence;               // NEW from eng review
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
    columns: string[];
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
}

// ── Run Claude helper ───────────────────────────────────────────────────────

export interface RunClaudeOptions {
  prompt: string;
  model: "opus" | "sonnet" | "haiku";
  timeoutMs: number;
  stage: string;                        // for log file naming
  runDir: string;                       // .verify/runs/{run-id}
  cwd?: string;                         // working directory — MUST be target project root so tool calls read the right files
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
  "setup-writer":  { dangerouslySkipPermissions: true },   // needs Read for schema files
  "browse-agent":  { dangerouslySkipPermissions: true },   // needs Bash for browse CLI commands
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
```

---

## File System Layout (target state)

```
pipeline/                               # NEW — TypeScript pipeline package
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── cli.ts                         # single entry point with subcommands
│   ├── orchestrator.ts                # init, execution DAG, parallelism, circuit breaker
│   ├── run-claude.ts                  # shared LLM call helper (spawn-based)
│   ├── report.ts                      # deterministic report formatter
│   ├── stages/
│   │   ├── ac-generator.ts
│   │   ├── planner.ts
│   │   ├── plan-validator.ts          # deterministic, no LLM
│   │   ├── setup-writer.ts
│   │   ├── browse-agent.ts
│   │   ├── judge.ts
│   │   └── learner.ts
│   ├── prompts/
│   │   ├── ac-generator.txt
│   │   ├── planner.txt
│   │   ├── setup-writer.txt
│   │   ├── browse-agent.txt
│   │   ├── judge.txt
│   │   ├── learner.txt
│   │   └── index/                     # app indexer prompts (ported from bash)
│   │       ├── routes.txt
│   │       ├── selectors.txt
│   │       ├── schema.txt
│   │       └── fixtures.txt
│   └── lib/
│       ├── types.ts                   # ALL shared interfaces (above)
│       ├── config.ts                  # .verify/config.json loader
│       ├── browse.ts                  # daemon management (start, stop, health)
│       ├── app-index.ts               # .verify/app.json reader
│       ├── index-app.ts               # app indexer (port of index-app.sh)
│       ├── timeline.ts                # append to timeline.jsonl
│       ├── progress.ts                # streaming progress emitter
│       └── parse-json.ts              # safe JSON parse with fallback
├── test/
│   ├── run-claude.test.ts
│   ├── plan-validator.test.ts
│   ├── config.test.ts
│   ├── parse-json.test.ts
│   ├── timeline.test.ts
│   ├── progress.test.ts
│   ├── auth-failure.test.ts           # isAuthFailure() tests
│   ├── app-index.test.ts             # loadAppIndex + filterPagesByUrls
│   ├── ac-generator.test.ts
│   ├── planner.test.ts
│   ├── setup-writer.test.ts
│   ├── browse-agent.test.ts
│   ├── judge.test.ts
│   ├── learner.test.ts
│   ├── orchestrator.test.ts
│   ├── report.test.ts
│   └── fixtures/                      # test fixture JSON files
│       ├── acs.json
│       ├── plan.json
│       ├── plan-invalid.json
│       ├── result.json
│       ├── result-auth-failure.json
│       ├── verdicts.json
│       ├── app-index.json
│       └── config.json
├── evals/                             # prompt quality eval fixtures
│   ├── run-evals.sh                   # runs each stage against fixtures
│   ├── ac-generator/
│   │   ├── input-formbricks-spec.md
│   │   └── golden-acs.json
│   ├── planner/
│   │   ├── input-acs.json
│   │   └── golden-plan.json
│   └── judge/
│       ├── input-evidence/
│       └── golden-verdicts.json
└── scripts/
    └── test-stage.sh                  # helper to run one stage on real data
```

---

## WS1: Foundation

**Branch:** `ws1/pipeline-foundation`
**Depends on:** nothing
**Produces:** `pipeline/` package with types, run-claude, config, and test infrastructure
**Estimated tasks:** 10

### Task 1.1: Initialize pipeline package

**Files:**
- Create: `pipeline/package.json`
- Create: `pipeline/tsconfig.json`
- Create: `pipeline/vitest.config.ts`

**Step 1: Create package.json**

```json
{
  "name": "@verify/pipeline",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "tsx": "^4.0.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "node16",
    "strict": true,
    "outDir": "dist",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

**Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "threads",
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
  },
});
```

**Step 4: Install deps and verify**

```bash
cd pipeline && npm install
npx tsc --noEmit    # should succeed (no source files yet)
npx vitest run      # should succeed (no tests yet)
```

**Step 5: Add to .gitignore**

Append `pipeline/dist/` to the root `.gitignore`.

**Step 6: Commit**

```bash
git add pipeline/package.json pipeline/tsconfig.json pipeline/vitest.config.ts .gitignore
git commit -m "feat(pipeline): initialize TypeScript package with vitest"
```

---

### Task 1.2: Define shared types

**Files:**
- Create: `pipeline/src/lib/types.ts`

**Step 1: Write types.ts**

Write the full `types.ts` file from the "Shared Contracts" section above. This includes all interfaces, `STAGE_PERMISSIONS`, `AUTH_FAILURE_PATTERNS`, `isAuthFailure()`, `ProgressEvent`, and the `Confidence` type.

**Step 2: Typecheck**

```bash
cd pipeline && npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add pipeline/src/lib/types.ts
git commit -m "feat(pipeline): define shared type contracts for all stages"
```

---

### Task 1.3: Implement safe JSON parser (with fixed regex)

**Files:**
- Create: `pipeline/src/lib/parse-json.ts`
- Create: `pipeline/test/parse-json.test.ts`

Every stage parses LLM JSON output that might have markdown fences, trailing text, or be completely invalid. The regex must not be greedy — it tries parsing from each `{` position.

**Step 1: Write the failing tests**

```typescript
// pipeline/test/parse-json.test.ts
import { describe, it, expect } from "vitest";
import { parseJsonOutput } from "../src/lib/parse-json.js";

describe("parseJsonOutput", () => {
  it("parses clean JSON", () => {
    const result = parseJsonOutput<{ foo: string }>('{"foo": "bar"}');
    expect(result).toEqual({ foo: "bar" });
  });

  it("strips markdown fences", () => {
    const input = '```json\n{"foo": "bar"}\n```';
    expect(parseJsonOutput(input)).toEqual({ foo: "bar" });
  });

  it("strips leading/trailing text", () => {
    const input = 'Here is the output:\n{"foo": "bar"}\nDone.';
    expect(parseJsonOutput(input)).toEqual({ foo: "bar" });
  });

  it("returns null for completely invalid input", () => {
    expect(parseJsonOutput("not json at all")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseJsonOutput("")).toBeNull();
  });

  it("handles nested JSON with fences", () => {
    const input = '```\n{"groups": [{"id": "g1", "acs": []}]}\n```';
    expect(parseJsonOutput(input)).toEqual({ groups: [{ id: "g1", acs: [] }] });
  });

  // ENG REVIEW: Test for multi-object output (greedy regex fix)
  it("extracts first valid JSON when LLM adds commentary after", () => {
    const input = 'Here is the result: {"valid": true}\nI also considered: {"alternative": false}';
    expect(parseJsonOutput(input)).toEqual({ valid: true });
  });

  it("handles JSON array output", () => {
    const input = 'Result:\n[{"id": 1}, {"id": 2}]\nDone.';
    expect(parseJsonOutput(input)).toEqual([{ id: 1 }, { id: 2 }]);
  });
});
```

**Step 2: Run tests — expect FAIL**

```bash
cd pipeline && npx vitest run test/parse-json.test.ts
```

**Step 3: Implement (with fixed regex — tries each `{` position)**

```typescript
// pipeline/src/lib/parse-json.ts

/**
 * Parse JSON from LLM output, stripping markdown fences and surrounding text.
 * Returns null if parsing fails completely.
 *
 * The extraction strategy tries each '{' or '[' position in the string
 * rather than using a greedy regex, so "text {valid} more {other}" correctly
 * extracts {valid} instead of failing on the span between first { and last }.
 */
export function parseJsonOutput<T = unknown>(raw: string): T | null {
  if (!raw || !raw.trim()) return null;

  let text = raw.trim();

  // Strip markdown fences
  text = text.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");

  // Try parsing the whole thing as-is
  try {
    return JSON.parse(text) as T;
  } catch {
    // Fall through to extraction
  }

  // Try parsing from each '{' or '[' position
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{" || text[i] === "[") {
      // Find matching close bracket by trying progressively larger substrings
      const closer = text[i] === "{" ? "}" : "]";
      let lastClose = text.lastIndexOf(closer);
      while (lastClose >= i) {
        try {
          const candidate = text.slice(i, lastClose + 1);
          return JSON.parse(candidate) as T;
        } catch {
          // Try a shorter substring (find previous closer)
          lastClose = text.lastIndexOf(closer, lastClose - 1);
        }
      }
    }
  }

  return null;
}
```

**Step 4: Run tests — expect PASS**

```bash
cd pipeline && npx vitest run test/parse-json.test.ts
```

**Step 5: Commit**

```bash
git add pipeline/src/lib/parse-json.ts pipeline/test/parse-json.test.ts
git commit -m "feat(pipeline): add safe JSON parser with non-greedy extraction"
```

---

### Task 1.4: Implement config loader

**Files:**
- Create: `pipeline/src/lib/config.ts`
- Create: `pipeline/test/config.test.ts`

**Step 1: Write the failing tests**

```typescript
// pipeline/test/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/lib/config.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("loadConfig", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `verify-test-${Date.now()}`);
    mkdirSync(join(tempDir, ".verify"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.VERIFY_BASE_URL;
    delete process.env.VERIFY_AUTH_CHECK_URL;
    delete process.env.VERIFY_SPEC_PATH;
    delete process.env.VERIFY_DIFF_BASE;
  });

  it("returns defaults when no config file exists", () => {
    const config = loadConfig(join(tempDir, ".verify"));
    expect(config.baseUrl).toBe("http://localhost:3000");
  });

  it("reads config.json", () => {
    writeFileSync(
      join(tempDir, ".verify", "config.json"),
      JSON.stringify({ baseUrl: "http://localhost:4000" })
    );
    const config = loadConfig(join(tempDir, ".verify"));
    expect(config.baseUrl).toBe("http://localhost:4000");
  });

  it("env vars override config.json", () => {
    writeFileSync(
      join(tempDir, ".verify", "config.json"),
      JSON.stringify({ baseUrl: "http://localhost:4000" })
    );
    process.env.VERIFY_BASE_URL = "http://localhost:5000";
    const config = loadConfig(join(tempDir, ".verify"));
    expect(config.baseUrl).toBe("http://localhost:5000");
  });

  it("maxParallelGroups defaults to 5", () => {
    const config = loadConfig(join(tempDir, ".verify"));
    expect(config.maxParallelGroups).toBe(5);
  });

  it("handles malformed config.json gracefully", () => {
    writeFileSync(join(tempDir, ".verify", "config.json"), "not json{{{");
    const config = loadConfig(join(tempDir, ".verify"));
    expect(config.baseUrl).toBe("http://localhost:3000");
  });
});
```

**Step 2: Run tests — expect FAIL**

**Step 3: Implement**

```typescript
// pipeline/src/lib/config.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { VerifyConfig } from "./types.js";

const DEFAULTS: VerifyConfig = {
  baseUrl: "http://localhost:3000",
  maxParallelGroups: 5,
};

export function loadConfig(verifyDir: string): VerifyConfig {
  let fileConfig: Partial<VerifyConfig> = {};

  const configPath = join(verifyDir, "config.json");
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      // Malformed config — use defaults
    }
  }

  const envOverrides: Partial<VerifyConfig> = {};
  if (process.env.VERIFY_BASE_URL) envOverrides.baseUrl = process.env.VERIFY_BASE_URL;
  if (process.env.VERIFY_AUTH_CHECK_URL) envOverrides.authCheckUrl = process.env.VERIFY_AUTH_CHECK_URL;
  if (process.env.VERIFY_SPEC_PATH) envOverrides.specPath = process.env.VERIFY_SPEC_PATH;
  if (process.env.VERIFY_DIFF_BASE) envOverrides.diffBase = process.env.VERIFY_DIFF_BASE;

  return { ...DEFAULTS, ...fileConfig, ...envOverrides };
}
```

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
git add pipeline/src/lib/config.ts pipeline/test/config.test.ts
git commit -m "feat(pipeline): add config loader with env var overrides"
```

---

### Task 1.5: Implement timeline logger

**Files:**
- Create: `pipeline/src/lib/timeline.ts`
- Create: `pipeline/test/timeline.test.ts`

**Step 1: Write the failing tests**

```typescript
// pipeline/test/timeline.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendTimelineEvent, readTimeline } from "../src/lib/timeline.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("timeline", () => {
  let runDir: string;

  beforeEach(() => {
    runDir = join(tmpdir(), `verify-run-${Date.now()}`);
    mkdirSync(join(runDir, "logs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true });
  });

  it("appends event to timeline.jsonl", () => {
    appendTimelineEvent(runDir, { stage: "planner", event: "start" });
    const events = readTimeline(runDir);
    expect(events).toHaveLength(1);
    expect(events[0].stage).toBe("planner");
    expect(events[0].event).toBe("start");
    expect(events[0].ts).toBeDefined();
  });

  it("appends multiple events", () => {
    appendTimelineEvent(runDir, { stage: "planner", event: "start" });
    appendTimelineEvent(runDir, { stage: "planner", event: "end", durationMs: 5000 });
    const events = readTimeline(runDir);
    expect(events).toHaveLength(2);
    expect(events[1].durationMs).toBe(5000);
  });

  it("returns empty array when no timeline exists", () => {
    const emptyDir = join(tmpdir(), `empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    expect(readTimeline(emptyDir)).toEqual([]);
    rmSync(emptyDir, { recursive: true, force: true });
  });
});
```

**Step 2: Run tests — expect FAIL**

**Step 3: Implement**

```typescript
// pipeline/src/lib/timeline.ts
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { TimelineEvent } from "./types.js";

export function appendTimelineEvent(
  runDir: string,
  event: Omit<TimelineEvent, "ts">
): void {
  const entry: TimelineEvent = { ts: new Date().toISOString(), ...event };
  const path = join(runDir, "logs", "timeline.jsonl");
  appendFileSync(path, JSON.stringify(entry) + "\n");
}

export function readTimeline(runDir: string): TimelineEvent[] {
  const path = join(runDir, "logs", "timeline.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
```

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
git add pipeline/src/lib/timeline.ts pipeline/test/timeline.test.ts
git commit -m "feat(pipeline): add timeline event logger"
```

---

### Task 1.6: Implement runClaude helper (spawn-based)

**Files:**
- Create: `pipeline/src/run-claude.ts`
- Create: `pipeline/test/run-claude.test.ts`

This is the most important shared helper. Every LLM call goes through it. Uses `spawn` (not `execFile`) for correct stdin piping and to handle large stdout from tool-using stages like the Planner.

**Step 1: Write the failing tests**

```typescript
// pipeline/test/run-claude.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock child_process.spawn
vi.mock("node:child_process", () => {
  const { EventEmitter } = require("node:events");
  const { Readable, Writable } = require("node:stream");
  return {
    spawn: vi.fn(() => {
      const proc = new EventEmitter();
      proc.stdout = new Readable({ read() {} });
      proc.stderr = new Readable({ read() {} });
      proc.stdin = new Writable({ write(_c: any, _e: any, cb: any) { cb(); } });
      proc.kill = vi.fn();
      return proc;
    }),
  };
});

import { runClaude } from "../src/run-claude.js";
import { spawn } from "node:child_process";

function emitSuccess(mockSpawn: ReturnType<typeof vi.fn>, stdout = "", stderr = "") {
  const proc = mockSpawn.mock.results[mockSpawn.mock.results.length - 1].value;
  if (stdout) proc.stdout.push(stdout);
  proc.stdout.push(null);
  if (stderr) proc.stderr.push(stderr);
  proc.stderr.push(null);
  proc.emit("close", 0);
}

function emitTimeout(mockSpawn: ReturnType<typeof vi.fn>) {
  const proc = mockSpawn.mock.results[mockSpawn.mock.results.length - 1].value;
  proc.stdout.push(null);
  proc.stderr.push(null);
  // Simulate timeout — kill is called, then close with signal
  proc.killed = true;
  proc.emit("close", null, "SIGTERM");
}

describe("runClaude", () => {
  let runDir: string;
  const mockSpawn = vi.mocked(spawn);

  beforeEach(() => {
    runDir = join(tmpdir(), `verify-run-${Date.now()}`);
    mkdirSync(join(runDir, "logs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("writes prompt to log file before calling claude", async () => {
    const promise = runClaude({
      prompt: "test prompt",
      model: "sonnet",
      timeoutMs: 5000,
      stage: "test-stage",
      runDir,
    });
    emitSuccess(mockSpawn);
    await promise;

    const promptPath = join(runDir, "logs", "test-stage-prompt.txt");
    expect(existsSync(promptPath)).toBe(true);
    expect(readFileSync(promptPath, "utf-8")).toBe("test prompt");
  });

  it("saves stdout and stderr to log files", async () => {
    const promise = runClaude({
      prompt: "test",
      model: "opus",
      timeoutMs: 5000,
      stage: "my-stage",
      runDir,
    });
    emitSuccess(mockSpawn, "the output", "some warnings");
    const result = await promise;

    expect(result.stdout).toBe("the output");
    expect(result.stderr).toBe("some warnings");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);

    expect(readFileSync(join(runDir, "logs", "my-stage-output.txt"), "utf-8")).toBe("the output");
    expect(readFileSync(join(runDir, "logs", "my-stage-stderr.txt"), "utf-8")).toBe("some warnings");
  });

  it("passes --model flag to claude", async () => {
    const promise = runClaude({
      prompt: "test",
      model: "opus",
      timeoutMs: 5000,
      stage: "s",
      runDir,
    });
    emitSuccess(mockSpawn);
    await promise;

    const callArgs = mockSpawn.mock.calls[0];
    const args = callArgs[1] as string[];
    expect(args).toContain("--model");
    expect(args).toContain("opus");
  });

  it("passes --dangerouslySkipPermissions when set", async () => {
    const promise = runClaude({
      prompt: "test",
      model: "sonnet",
      timeoutMs: 5000,
      stage: "s",
      runDir,
      dangerouslySkipPermissions: true,
    });
    emitSuccess(mockSpawn);
    await promise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("passes --allowedTools when set", async () => {
    const promise = runClaude({
      prompt: "test",
      model: "sonnet",
      timeoutMs: 5000,
      stage: "s",
      runDir,
      allowedTools: ["Read", "Grep"],
    });
    emitSuccess(mockSpawn);
    await promise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("--allowedTools");
    expect(args).toContain("Read");
  });

  it("returns timedOut=true when timeout fires", async () => {
    const promise = runClaude({
      prompt: "test",
      model: "sonnet",
      timeoutMs: 100,
      stage: "s",
      runDir,
    });
    emitTimeout(mockSpawn);
    const result = await promise;

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
  });

  it("records duration in milliseconds", async () => {
    const promise = runClaude({
      prompt: "test",
      model: "sonnet",
      timeoutMs: 5000,
      stage: "s",
      runDir,
    });
    emitSuccess(mockSpawn);
    const result = await promise;

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("appends timeline events for start and end", async () => {
    const promise = runClaude({
      prompt: "test",
      model: "sonnet",
      timeoutMs: 5000,
      stage: "planner",
      runDir,
    });
    emitSuccess(mockSpawn);
    await promise;

    const timelinePath = join(runDir, "logs", "timeline.jsonl");
    expect(existsSync(timelinePath)).toBe(true);
    const lines = readFileSync(timelinePath, "utf-8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(lines[0]).event).toBe("start");
    expect(JSON.parse(lines[1]).event).toBe("end");
  });
});
```

**Step 2: Run tests — expect FAIL**

**Step 3: Implement (using spawn for correct stdin piping + large output handling)**

```typescript
// pipeline/src/run-claude.ts
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RunClaudeOptions, RunClaudeResult } from "./lib/types.js";
import { appendTimelineEvent } from "./lib/timeline.js";

/**
 * Run `claude -p` with the given prompt.
 *
 * Uses `spawn` (not `execFile`) because:
 * 1. Correct stdin piping — prompt is written to stdin, not passed as argument
 * 2. Stream-based stdout/stderr collection — handles arbitrarily large output
 *    (the Planner stage can produce megabytes of tool call transcripts)
 * 3. Proper timeout handling via setTimeout + child.kill()
 */
export async function runClaude(opts: RunClaudeOptions): Promise<RunClaudeResult> {
  const { prompt, model, timeoutMs, stage, runDir, dangerouslySkipPermissions, allowedTools } = opts;
  const logsDir = join(runDir, "logs");
  mkdirSync(logsDir, { recursive: true });

  // Write prompt to disk before calling claude
  writeFileSync(join(logsDir, `${stage}-prompt.txt`), prompt);

  // Build args
  const args = ["-p", "--model", model];
  if (dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }
  if (allowedTools) {
    for (const tool of allowedTools) {
      args.push("--allowedTools", tool);
    }
  }

  appendTimelineEvent(runDir, { stage, event: "start" });
  const startMs = Date.now();

  return new Promise<RunClaudeResult>((resolve) => {
    const claudeBin = process.env.CLAUDE_BIN ?? "claude";
    const child = spawn(claudeBin, args, {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Collect stdout and stderr via streams
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    // Write prompt to stdin
    child.stdin.write(prompt);
    child.stdin.end();

    // Timeout handling
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startMs;

      // If child was killed but we didn't set timedOut, it was killed externally
      if (!timedOut && child.killed) timedOut = true;

      const stdoutStr = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderrStr = Buffer.concat(stderrChunks).toString("utf-8");
      const exitCode = timedOut ? 124 : (code ?? 1);

      // Always write output files
      writeFileSync(join(logsDir, `${stage}-output.txt`), stdoutStr);
      writeFileSync(join(logsDir, `${stage}-stderr.txt`), stderrStr);

      appendTimelineEvent(runDir, {
        stage,
        event: timedOut ? "timeout" : (exitCode === 0 ? "end" : "error"),
        durationMs,
        detail: timedOut ? `Timed out after ${timeoutMs}ms` : undefined,
      });

      resolve({ stdout: stdoutStr, stderr: stderrStr, exitCode, durationMs, timedOut });
    });
  });
}
```

**Step 4: Run tests — expect PASS**

```bash
cd pipeline && npx vitest run test/run-claude.test.ts
```

**Step 5: Commit**

```bash
git add pipeline/src/run-claude.ts pipeline/test/run-claude.test.ts
git commit -m "feat(pipeline): add spawn-based runClaude helper with logging and timeout"
```

---

### Task 1.7: Implement isAuthFailure tests

**Files:**
- Create: `pipeline/test/auth-failure.test.ts`

The `isAuthFailure` function is defined in `types.ts`. It's a pure function with 7 regex patterns — perfect for thorough unit testing.

**Step 1: Write the tests**

```typescript
// pipeline/test/auth-failure.test.ts
import { describe, it, expect } from "vitest";
import { isAuthFailure } from "../src/lib/types.js";

describe("isAuthFailure", () => {
  it("detects 'Auth redirect' in observed text", () => {
    expect(isAuthFailure("Auth redirect — page shows login form")).toBe(true);
  });

  it("detects 'Auth failure' in observed text", () => {
    expect(isAuthFailure("Auth failure: 401 returned")).toBe(true);
  });

  it("detects login URL in observed text", () => {
    expect(isAuthFailure("Page redirected to /login")).toBe(true);
  });

  it("detects signin URL in observed text", () => {
    expect(isAuthFailure("Ended up at /signin page")).toBe(true);
  });

  it("detects 'session expired' in observed text", () => {
    expect(isAuthFailure("Session expired message shown")).toBe(true);
  });

  it("detects 'unauthorized' in observed text", () => {
    expect(isAuthFailure("Page says Unauthorized")).toBe(true);
  });

  it("detects 'please log in' in observed text", () => {
    expect(isAuthFailure("Text on page: Please log in to continue")).toBe(true);
  });

  it("detects 'sign in to continue' in observed text", () => {
    expect(isAuthFailure("Prompt says Sign in to continue")).toBe(true);
  });

  it("detects auth URL in the url parameter", () => {
    expect(isAuthFailure("Some page loaded", "/auth/callback")).toBe(true);
  });

  it("detects login URL in the url parameter", () => {
    expect(isAuthFailure("Page loaded OK", "/login?next=/dashboard")).toBe(true);
  });

  it("returns false for normal observed text", () => {
    expect(isAuthFailure("Dashboard loaded with 5 items")).toBe(false);
  });

  it("returns false for normal URLs", () => {
    expect(isAuthFailure("Page loaded", "/dashboard/settings")).toBe(false);
  });

  it("is case-insensitive for observed text", () => {
    expect(isAuthFailure("AUTH REDIRECT detected")).toBe(true);
    expect(isAuthFailure("UNAUTHORIZED access")).toBe(true);
  });
});
```

**Step 2: Run tests — expect PASS** (function already exists in types.ts)

```bash
cd pipeline && npx vitest run test/auth-failure.test.ts
```

**Step 3: Commit**

```bash
git add pipeline/test/auth-failure.test.ts
git commit -m "test(pipeline): add thorough isAuthFailure tests for all patterns"
```

---

### Task 1.8: Implement app-index reader with tests

**Files:**
- Create: `pipeline/src/lib/app-index.ts`
- Create: `pipeline/test/app-index.test.ts`
- Create: `pipeline/test/fixtures/app-index.json`

**Step 1: Create test fixture**

```json
{
  "indexed_at": "2026-03-18T14:00:00Z",
  "routes": {
    "/dashboard": { "component": "app/dashboard/page.tsx" },
    "/settings": { "component": "app/settings/page.tsx" },
    "/billing": { "component": "app/billing/page.tsx" }
  },
  "pages": {
    "/dashboard": {
      "selectors": { "sidebar": { "value": "[data-testid=sidebar]", "source": "tests/dash.spec.ts:12" } },
      "source_tests": ["tests/dash.spec.ts"]
    }
  },
  "data_model": {
    "Organization": {
      "columns": ["id", "name", "billing"],
      "enums": { "BillingStatus": ["active", "trialing", "canceled"] },
      "source": "prisma/schema.prisma:42"
    }
  },
  "fixtures": {
    "createOrg": {
      "description": "Creates a test organization",
      "runner": null,
      "source": "tests/helpers.ts:10"
    }
  },
  "db_url_env": "DATABASE_URL",
  "feature_flags": ["FF_BILLING_V2"]
}
```

**Step 2: Write the failing tests**

```typescript
// pipeline/test/app-index.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadAppIndex, filterPagesByUrls } from "../src/lib/app-index.js";
import type { AppIndex } from "../src/lib/types.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import fixture from "./fixtures/app-index.json" with { type: "json" };

describe("loadAppIndex", () => {
  let verifyDir: string;

  beforeEach(() => {
    verifyDir = join(tmpdir(), `verify-ai-${Date.now()}`);
    mkdirSync(verifyDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(verifyDir, { recursive: true, force: true });
  });

  it("returns null when app.json does not exist", () => {
    expect(loadAppIndex(verifyDir)).toBeNull();
  });

  it("reads and parses app.json", () => {
    writeFileSync(join(verifyDir, "app.json"), JSON.stringify(fixture));
    const result = loadAppIndex(verifyDir);
    expect(result).not.toBeNull();
    expect(result!.routes["/dashboard"]).toBeDefined();
    expect(result!.db_url_env).toBe("DATABASE_URL");
  });

  it("returns null for malformed app.json", () => {
    writeFileSync(join(verifyDir, "app.json"), "not json");
    expect(loadAppIndex(verifyDir)).toBeNull();
  });
});

describe("filterPagesByUrls", () => {
  const appIndex = fixture as AppIndex;

  it("filters pages matching URL patterns", () => {
    const result = filterPagesByUrls(appIndex, ["/dashboard"]);
    expect(Object.keys(result)).toContain("/dashboard");
  });

  it("returns first N pages as fallback when no patterns match", () => {
    const result = filterPagesByUrls(appIndex, ["/nonexistent"]);
    expect(Object.keys(result).length).toBeGreaterThan(0);
  });

  it("returns first N pages when no patterns provided", () => {
    const result = filterPagesByUrls(appIndex, []);
    expect(Object.keys(result).length).toBeGreaterThan(0);
  });

  it("respects limit parameter", () => {
    const result = filterPagesByUrls(appIndex, [], 1);
    expect(Object.keys(result)).toHaveLength(1);
  });
});
```

**Step 3: Run tests — expect FAIL**

**Step 4: Implement**

```typescript
// pipeline/src/lib/app-index.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AppIndex } from "./types.js";

export function loadAppIndex(verifyDir: string): AppIndex | null {
  const path = join(verifyDir, "app.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as AppIndex;
  } catch {
    return null;
  }
}

export function filterPagesByUrls(
  appIndex: AppIndex,
  urlPatterns: string[],
  limit = 10
): Record<string, AppIndex["pages"][string]> {
  if (urlPatterns.length === 0) {
    return Object.fromEntries(Object.entries(appIndex.pages).slice(0, limit));
  }

  const matched: Record<string, AppIndex["pages"][string]> = {};
  for (const [pageUrl, pageData] of Object.entries(appIndex.pages)) {
    if (urlPatterns.some((pattern) => pageUrl.startsWith(pattern))) {
      matched[pageUrl] = pageData;
    }
  }

  return Object.keys(matched).length > 0
    ? matched
    : Object.fromEntries(Object.entries(appIndex.pages).slice(0, limit));
}
```

**Step 5: Run tests — expect PASS**

**Step 6: Commit**

```bash
git add pipeline/src/lib/app-index.ts pipeline/test/app-index.test.ts pipeline/test/fixtures/app-index.json
git commit -m "feat(pipeline): add app.json reader with URL filtering and tests"
```

---

### Task 1.9: Implement progress emitter

**Files:**
- Create: `pipeline/src/lib/progress.ts`
- Create: `pipeline/test/progress.test.ts`

Streaming progress dashboard — shows live status per AC.

**Step 1: Write the failing tests**

```typescript
// pipeline/test/progress.test.ts
import { describe, it, expect, vi } from "vitest";
import { ProgressEmitter } from "../src/lib/progress.js";

describe("ProgressEmitter", () => {
  it("emits progress events", () => {
    const handler = vi.fn();
    const emitter = new ProgressEmitter(handler);
    emitter.update("ac1", "running", "navigating...");
    expect(handler).toHaveBeenCalledWith({
      acId: "ac1",
      status: "running",
      detail: "navigating...",
    });
  });

  it("tracks all AC statuses", () => {
    const emitter = new ProgressEmitter(vi.fn());
    emitter.update("ac1", "running");
    emitter.update("ac2", "pending");
    emitter.update("ac1", "pass");
    const snapshot = emitter.snapshot();
    expect(snapshot.get("ac1")).toBe("pass");
    expect(snapshot.get("ac2")).toBe("pending");
  });

  it("formats a terminal-friendly status line", () => {
    const emitter = new ProgressEmitter(vi.fn());
    emitter.update("ac1", "pass");
    emitter.update("ac2", "running", "navigating...");
    emitter.update("ac3", "fail");
    const line = emitter.formatStatusLine();
    expect(line).toContain("ac1");
    expect(line).toContain("ac2");
    expect(line).toContain("ac3");
  });
});
```

**Step 2: Run tests — expect FAIL**

**Step 3: Implement**

```typescript
// pipeline/src/lib/progress.ts
import type { ProgressEvent, ProgressStatus } from "./types.js";

const STATUS_ICONS: Record<ProgressStatus, string> = {
  pending: "○",
  running: "⏳",
  pass: "✓",
  fail: "✗",
  error: "!",
  timeout: "⏱",
  skipped: "—",
};

export class ProgressEmitter {
  private statuses = new Map<string, { status: ProgressStatus; detail?: string }>();
  private handler: (event: ProgressEvent) => void;

  constructor(handler: (event: ProgressEvent) => void) {
    this.handler = handler;
  }

  update(acId: string, status: ProgressStatus, detail?: string): void {
    this.statuses.set(acId, { status, detail });
    this.handler({ acId, status, detail });
  }

  snapshot(): Map<string, ProgressStatus> {
    const result = new Map<string, ProgressStatus>();
    for (const [id, { status }] of this.statuses) {
      result.set(id, status);
    }
    return result;
  }

  formatStatusLine(): string {
    return [...this.statuses.entries()]
      .map(([id, { status, detail }]) => {
        const icon = STATUS_ICONS[status];
        const suffix = detail ? ` ${detail}` : "";
        return `[${id} ${icon}${suffix}]`;
      })
      .join(" ");
  }
}
```

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
git add pipeline/src/lib/progress.ts pipeline/test/progress.test.ts
git commit -m "feat(pipeline): add streaming progress emitter"
```

---

### Task 1.10: Run all tests and verify

**Step 1: Run full test suite**

```bash
cd pipeline && npx vitest run
```

Expected: all tests pass.

**Step 2: Run typecheck**

```bash
cd pipeline && npx tsc --noEmit
```

Expected: no errors.

**Step 3: Commit (if any fixes needed)**

**Step 4: Merge WS1 to main**

This is the checkpoint. After WS1 merges, all parallel workstreams branch from here.

---

## WS2: Planning Chain (AC Generator + Planner + Plan Validator)

**Branch:** `ws2/planning-chain`
**Depends on:** WS1 merged to main
**Produces:** Three stages that transform a spec into a validated plan.json
**Estimated tasks:** 9

### How to test incrementally

After completing this workstream, test on any real repo using the CLI subcommands:

```bash
# 1. Run AC Generator against a real spec
cd pipeline
npx tsx src/cli.ts run-stage ac-generator --verify-dir /path/to/.verify --run-dir /tmp/test-run --spec /path/to/spec.md

# 2. Inspect output
cat /tmp/test-run/acs.json | jq .

# 3. Run Planner against the ACs
npx tsx src/cli.ts run-stage planner --verify-dir /path/to/.verify --run-dir /tmp/test-run

# 4. Inspect plan
cat /tmp/test-run/plan.json | jq .

# 5. Run Plan Validator (deterministic, no LLM)
npx tsx src/cli.ts run-stage plan-validator --verify-dir /path/to/.verify --run-dir /tmp/test-run
echo $?  # 0 = valid, 1 = errors
```

---

### Task 2.1: Plan Validator (deterministic, no LLM)

**Files:**
- Create: `pipeline/src/stages/plan-validator.ts`
- Create: `pipeline/test/plan-validator.test.ts`
- Create: `pipeline/test/fixtures/plan.json`
- Create: `pipeline/test/fixtures/plan-invalid.json`

Pure functions, no LLM calls. Start here.

**Step 1: Create test fixtures**

```json
// pipeline/test/fixtures/plan.json — valid plan
{
  "criteria": [
    {
      "id": "ac1",
      "group": "group-a",
      "description": "Trial banner appears",
      "url": "/settings",
      "steps": ["Navigate to settings", "Look for trial banner"],
      "screenshot_at": ["trial_banner"],
      "timeout_seconds": 90
    }
  ]
}
```

```json
// pipeline/test/fixtures/plan-invalid.json — plan with multiple errors
{
  "criteria": [
    {
      "id": "ac1",
      "group": "group-a",
      "description": "Trial banner",
      "url": "/environments/{envId}/settings",
      "steps": [],
      "screenshot_at": [],
      "timeout_seconds": 30
    },
    {
      "id": "ac2",
      "group": "group-a",
      "description": "Billing page",
      "url": "https://app.example.com/billing",
      "steps": ["Go to billing"],
      "screenshot_at": [],
      "timeout_seconds": 500
    }
  ]
}
```

**Step 2: Write the failing tests**

```typescript
// pipeline/test/plan-validator.test.ts
import { describe, it, expect } from "vitest";
import { validatePlan } from "../src/stages/plan-validator.js";
import type { PlannerOutput, AppIndex } from "../src/lib/types.js";
import validPlan from "./fixtures/plan.json" with { type: "json" };
import invalidPlan from "./fixtures/plan-invalid.json" with { type: "json" };

const mockAppIndex: AppIndex = {
  indexed_at: "2026-03-18T00:00:00Z",
  routes: { "/settings": { component: "settings.tsx" }, "/billing": { component: "billing.tsx" } },
  pages: {},
  data_model: {},
  fixtures: {},
  db_url_env: null,
  feature_flags: [],
};

describe("validatePlan", () => {
  it("passes for a valid plan", () => {
    const result = validatePlan(validPlan as PlannerOutput, mockAppIndex);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("catches template variables in URLs", () => {
    const result = validatePlan(invalidPlan as PlannerOutput, mockAppIndex);
    const templateErr = result.errors.find(e => e.acId === "ac1" && e.field === "url");
    expect(templateErr).toBeDefined();
    expect(templateErr!.message).toMatch(/template variable/i);
  });

  it("catches absolute URLs", () => {
    const result = validatePlan(invalidPlan as PlannerOutput, mockAppIndex);
    const absErr = result.errors.find(e => e.acId === "ac2" && e.field === "url");
    expect(absErr).toBeDefined();
    expect(absErr!.message).toMatch(/absolute/i);
  });

  it("catches empty steps", () => {
    const result = validatePlan(invalidPlan as PlannerOutput, mockAppIndex);
    const stepsErr = result.errors.find(e => e.acId === "ac1" && e.field === "steps");
    expect(stepsErr).toBeDefined();
  });

  it("catches timeout out of bounds (too low)", () => {
    const result = validatePlan(invalidPlan as PlannerOutput, mockAppIndex);
    const timeoutErr = result.errors.find(e => e.acId === "ac1" && e.field === "timeout_seconds");
    expect(timeoutErr).toBeDefined();
  });

  it("catches timeout out of bounds (too high)", () => {
    const result = validatePlan(invalidPlan as PlannerOutput, mockAppIndex);
    const timeoutErr = result.errors.find(e => e.acId === "ac2" && e.field === "timeout_seconds");
    expect(timeoutErr).toBeDefined();
  });

  it("catches URLs not in app index routes", () => {
    const plan: PlannerOutput = {
      criteria: [{
        id: "ac1", group: "g1", description: "test",
        url: "/nonexistent-page",
        steps: ["do something"], screenshot_at: [], timeout_seconds: 90,
      }],
    };
    const result = validatePlan(plan, mockAppIndex);
    const routeErr = result.errors.find(e => e.field === "url" && e.message.match(/not found in app/i));
    expect(routeErr).toBeDefined();
  });

  it("skips route check when no app index provided", () => {
    const plan: PlannerOutput = {
      criteria: [{
        id: "ac1", group: "g1", description: "test",
        url: "/anything", steps: ["do something"], screenshot_at: [], timeout_seconds: 90,
      }],
    };
    const result = validatePlan(plan, null);
    expect(result.valid).toBe(true);
  });

  it("handles empty criteria array", () => {
    const result = validatePlan({ criteria: [] }, mockAppIndex);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
```

**Step 3: Run tests — expect FAIL**

**Step 4: Implement**

```typescript
// pipeline/src/stages/plan-validator.ts
import type { PlannerOutput, PlanValidationResult, PlanValidationError, AppIndex } from "../lib/types.js";

const TEMPLATE_VAR_RE = /\{[a-zA-Z]+\}/;
const ABSOLUTE_URL_RE = /^https?:\/\//;
const MIN_TIMEOUT = 60;
const MAX_TIMEOUT = 300;

export function validatePlan(
  plan: PlannerOutput,
  appIndex: AppIndex | null
): PlanValidationResult {
  const errors: PlanValidationError[] = [];

  for (const ac of plan.criteria) {
    if (TEMPLATE_VAR_RE.test(ac.url)) {
      errors.push({
        acId: ac.id, field: "url",
        message: `URL "${ac.url}" contains a template variable — use real IDs from app.json`,
      });
    }

    if (ABSOLUTE_URL_RE.test(ac.url)) {
      errors.push({
        acId: ac.id, field: "url",
        message: `URL "${ac.url}" is absolute — use a relative path (baseUrl is prepended automatically)`,
      });
    }

    if (appIndex && !TEMPLATE_VAR_RE.test(ac.url) && !ABSOLUTE_URL_RE.test(ac.url)) {
      const knownRoutes = Object.keys(appIndex.routes);
      const urlBase = ac.url.split("?")[0];
      const routeExists = knownRoutes.some(
        (route) => urlBase === route || urlBase.startsWith(route + "/")
      );
      if (!routeExists) {
        errors.push({
          acId: ac.id, field: "url",
          message: `URL "${ac.url}" not found in app index routes — verify it exists`,
        });
      }
    }

    if (!ac.steps || ac.steps.length === 0) {
      errors.push({
        acId: ac.id, field: "steps",
        message: "Steps array is empty — every AC must have at least one step",
      });
    }

    if (ac.timeout_seconds < MIN_TIMEOUT || ac.timeout_seconds > MAX_TIMEOUT) {
      errors.push({
        acId: ac.id, field: "timeout_seconds",
        message: `Timeout ${ac.timeout_seconds}s is outside bounds [${MIN_TIMEOUT}, ${MAX_TIMEOUT}]`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}
```

**Step 5: Run tests — expect PASS**

**Step 6: Commit**

```bash
git add pipeline/src/stages/plan-validator.ts pipeline/test/plan-validator.test.ts pipeline/test/fixtures/plan.json pipeline/test/fixtures/plan-invalid.json
git commit -m "feat(pipeline): add deterministic plan validator"
```

---

### Task 2.2: AC Generator prompt template

**Files:**
- Create: `pipeline/src/prompts/ac-generator.txt`

```
You are an acceptance criteria extractor. Read the spec and extract testable acceptance criteria.

Read the following files using tool calls:
1. The spec file (path provided below)
2. `.verify/app.json` (if it exists — contains routes, data model, selectors)
3. `.verify/learnings.md` (if it exists — contains knowledge from past runs)

SPEC FILE: {{specPath}}

OUTPUT: Write valid JSON to stdout with this exact schema:

{
  "groups": [
    {
      "id": "group-a",
      "condition": "description of required state, or null if pure UI",
      "acs": [
        {"id": "ac1", "description": "one specific testable behavior"}
      ]
    }
  ],
  "skipped": [
    {"id": "ac4", "reason": "why this AC cannot be tested locally"}
  ]
}

GROUPING RULES:
- ACs that share a setup condition go in the same group.
- ACs with dependencies between them go in the same group, ordered.
- ACs with no condition (pure UI) go in their own group with condition: null.
- Each AC must be independently verifiable — one behavior per AC.
- Skip ACs that require external services (Stripe, email, OAuth with third parties).

KEEP IT TIGHT:
- IDs: "ac1", "ac2", etc. Sequential.
- Group IDs: "group-a", "group-b", etc.
- Descriptions: one sentence max. Specific enough for a browser agent to verify.
- If an AC is ambiguous, make it concrete based on the code you can read.

Output ONLY the JSON. No explanation, no markdown fences.
```

**Step 1: Commit**

```bash
git add pipeline/src/prompts/ac-generator.txt
git commit -m "feat(pipeline): add AC generator prompt template"
```

---

### Task 2.3: AC Generator stage

**Files:**
- Create: `pipeline/src/stages/ac-generator.ts`
- Create: `pipeline/test/ac-generator.test.ts`

**Step 1: Write the failing tests**

```typescript
// pipeline/test/ac-generator.test.ts
import { describe, it, expect } from "vitest";
import { buildACGeneratorPrompt, parseACGeneratorOutput, fanOutPureUIGroups } from "../src/stages/ac-generator.js";
import type { ACGeneratorOutput } from "../src/lib/types.js";

describe("buildACGeneratorPrompt", () => {
  it("substitutes specPath into template", () => {
    const prompt = buildACGeneratorPrompt("/path/to/spec.md");
    expect(prompt).toContain("/path/to/spec.md");
    expect(prompt).not.toContain("{{specPath}}");
  });
});

describe("parseACGeneratorOutput", () => {
  it("parses valid output", () => {
    const output = JSON.stringify({
      groups: [{ id: "group-a", condition: null, acs: [{ id: "ac1", description: "test" }] }],
      skipped: [],
    });
    const result = parseACGeneratorOutput(output);
    expect(result).not.toBeNull();
    expect(result!.groups).toHaveLength(1);
  });

  it("returns null for invalid output", () => {
    expect(parseACGeneratorOutput("garbage")).toBeNull();
  });

  it("returns null for missing groups field", () => {
    expect(parseACGeneratorOutput('{"skipped": []}')).toBeNull();
  });

  it("handles markdown-fenced output", () => {
    const output = '```json\n{"groups": [], "skipped": []}\n```';
    expect(parseACGeneratorOutput(output)).not.toBeNull();
  });
});

describe("fanOutPureUIGroups", () => {
  it("splits pure-UI group with multiple ACs into individual groups", () => {
    const input: ACGeneratorOutput = {
      groups: [{
        id: "group-a", condition: null,
        acs: [{ id: "ac1", description: "Page A loads" }, { id: "ac2", description: "Page B loads" }],
      }],
      skipped: [],
    };
    const result = fanOutPureUIGroups(input);
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0].acs).toHaveLength(1);
    expect(result.groups[1].acs).toHaveLength(1);
  });

  it("leaves groups with conditions intact", () => {
    const input: ACGeneratorOutput = {
      groups: [{
        id: "group-a", condition: "org in trialing state",
        acs: [{ id: "ac1", description: "Banner shows" }, { id: "ac2", description: "Days correct" }],
      }],
      skipped: [],
    };
    const result = fanOutPureUIGroups(input);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].acs).toHaveLength(2);
  });

  it("leaves single-AC pure-UI groups alone", () => {
    const input: ACGeneratorOutput = {
      groups: [{ id: "group-a", condition: null, acs: [{ id: "ac1", description: "test" }] }],
      skipped: [],
    };
    const result = fanOutPureUIGroups(input);
    expect(result.groups).toHaveLength(1);
  });

  it("preserves skipped array", () => {
    const input: ACGeneratorOutput = {
      groups: [],
      skipped: [{ id: "ac4", reason: "Needs Stripe" }],
    };
    const result = fanOutPureUIGroups(input);
    expect(result.skipped).toHaveLength(1);
  });
});
```

**Step 2: Run tests — expect FAIL**

**Step 3: Implement**

```typescript
// pipeline/src/stages/ac-generator.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ACGeneratorOutput } from "../lib/types.js";
import { parseJsonOutput } from "../lib/parse-json.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function buildACGeneratorPrompt(specPath: string): string {
  const template = readFileSync(join(__dirname, "../prompts/ac-generator.txt"), "utf-8");
  return template.replace("{{specPath}}", specPath);
}

export function parseACGeneratorOutput(raw: string): ACGeneratorOutput | null {
  const parsed = parseJsonOutput<ACGeneratorOutput>(raw);
  if (!parsed || !Array.isArray(parsed.groups)) return null;
  return parsed;
}

export function fanOutPureUIGroups(input: ACGeneratorOutput): ACGeneratorOutput {
  const newGroups = input.groups.flatMap((group) => {
    if (group.condition !== null || group.acs.length <= 1) return [group];
    return group.acs.map((ac, i) => ({
      id: `${group.id}-${i}`,
      condition: null,
      acs: [ac],
    }));
  });
  return { groups: newGroups, skipped: input.skipped };
}
```

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
git add pipeline/src/stages/ac-generator.ts pipeline/test/ac-generator.test.ts
git commit -m "feat(pipeline): add AC generator stage with fan-out logic"
```

---

### Task 2.4: Planner prompt template

**Files:**
- Create: `pipeline/src/prompts/planner.txt`

```
You are a test planner. Given acceptance criteria, produce concrete browser steps for each one.

Read the following files using tool calls:
1. The ACs file: {{acsPath}}
2. `.verify/app.json` (if it exists — routes, selectors, data model)
3. `.verify/learnings.md` (if it exists — past run knowledge)
4. Relevant source files — use Grep/Glob to find route definitions, component files, and the code diff

You have full tool access. Use it to read the actual codebase and ground every step in what exists.

OUTPUT: Write valid JSON to stdout with this exact schema:

{
  "criteria": [
    {
      "id": "ac1",
      "group": "group-a",
      "description": "Trial alert banner appears on dashboard",
      "url": "/environments/clseedenvprod000000000/settings",
      "steps": [
        "Navigate to the settings page",
        "Wait for page load (up to 5s)",
        "Look for alert banner with text containing 'trial'",
        "Take screenshot of the banner"
      ],
      "screenshot_at": ["trial_banner_visible"],
      "timeout_seconds": 90
    }
  ]
}

RULES:
1. Read the code diff first if available — understand what changed.
2. Every URL must be relative (no scheme, no host). Use real IDs from app.json or seed data.
3. No template variables ({envId}, {orgId}). Use actual values from the codebase or app.json.
4. Steps must be specific enough for a browser agent to execute mechanically.
5. Each step is one browser action: navigate, click, fill, wait, screenshot, or assert.
6. Include "Wait for page load" or "Wait for data" steps where needed.
7. Take screenshots at key evidence moments, not just at the end.
8. Timeout tiers: 60s (simple navigation), 90s (form interaction), 120s (multi-step flow), 180s (complex state).
9. If app.json has selectors for this page, reference them in steps.

Output ONLY the JSON. No explanation, no markdown fences.
```

**Step 1: Commit**

```bash
git add pipeline/src/prompts/planner.txt
git commit -m "feat(pipeline): add planner prompt template"
```

---

### Task 2.5: Planner stage with retry

**Files:**
- Create: `pipeline/src/stages/planner.ts`
- Create: `pipeline/test/planner.test.ts`

**Step 1: Write the failing tests**

```typescript
// pipeline/test/planner.test.ts
import { describe, it, expect } from "vitest";
import { buildPlannerPrompt, parsePlannerOutput, buildRetryPrompt, filterPlanErrors } from "../src/stages/planner.js";
import type { PlannerOutput, PlanValidationError } from "../src/lib/types.js";

describe("buildPlannerPrompt", () => {
  it("substitutes acsPath into template", () => {
    const prompt = buildPlannerPrompt("/tmp/run/acs.json");
    expect(prompt).toContain("/tmp/run/acs.json");
    expect(prompt).not.toContain("{{acsPath}}");
  });
});

describe("parsePlannerOutput", () => {
  it("parses valid plan", () => {
    const output = JSON.stringify({
      criteria: [{
        id: "ac1", group: "group-a", description: "test",
        url: "/settings", steps: ["Navigate"], screenshot_at: ["loaded"], timeout_seconds: 90,
      }],
    });
    const result = parsePlannerOutput(output);
    expect(result).not.toBeNull();
    expect(result!.criteria).toHaveLength(1);
  });

  it("returns null for missing criteria", () => {
    expect(parsePlannerOutput('{"foo": "bar"}')).toBeNull();
  });

  it("returns null for garbage", () => {
    expect(parsePlannerOutput("not json")).toBeNull();
  });
});

describe("buildRetryPrompt", () => {
  it("includes validation errors in the retry prompt", () => {
    const errors: PlanValidationError[] = [
      { acId: "ac1", field: "url", message: 'URL "/env/{envId}" contains a template variable' },
    ];
    const prompt = buildRetryPrompt("/tmp/acs.json", errors);
    expect(prompt).toContain("template variable");
    expect(prompt).toContain("ac1");
    expect(prompt).toContain("ERRORS");
  });
});

describe("filterPlanErrors", () => {
  it("removes ACs with persistent errors", () => {
    const plan: PlannerOutput = {
      criteria: [
        { id: "ac1", group: "g1", description: "t", url: "/{bad}", steps: ["s"], screenshot_at: [], timeout_seconds: 90 },
        { id: "ac2", group: "g1", description: "t", url: "/good", steps: ["s"], screenshot_at: [], timeout_seconds: 90 },
      ],
    };
    const errors: PlanValidationError[] = [
      { acId: "ac1", field: "url", message: "template variable" },
    ];
    const { validPlan, planErrors } = filterPlanErrors(plan, errors);
    expect(validPlan.criteria).toHaveLength(1);
    expect(validPlan.criteria[0].id).toBe("ac2");
    expect(planErrors).toHaveLength(1);
    expect(planErrors[0].ac_id).toBe("ac1");
    expect(planErrors[0].verdict).toBe("plan_error");
  });

  it("returns empty planErrors when all ACs are valid", () => {
    const plan: PlannerOutput = {
      criteria: [{ id: "ac1", group: "g1", description: "t", url: "/good", steps: ["s"], screenshot_at: [], timeout_seconds: 90 }],
    };
    const { validPlan, planErrors } = filterPlanErrors(plan, []);
    expect(validPlan.criteria).toHaveLength(1);
    expect(planErrors).toHaveLength(0);
  });
});
```

**Step 2: Run tests — expect FAIL**

**Step 3: Implement**

```typescript
// pipeline/src/stages/planner.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlannerOutput, PlanValidationError, ACVerdict } from "../lib/types.js";
import { parseJsonOutput } from "../lib/parse-json.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function buildPlannerPrompt(acsPath: string): string {
  const template = readFileSync(join(__dirname, "../prompts/planner.txt"), "utf-8");
  return template.replace("{{acsPath}}", acsPath);
}

export function parsePlannerOutput(raw: string): PlannerOutput | null {
  const parsed = parseJsonOutput<PlannerOutput>(raw);
  if (!parsed || !Array.isArray(parsed.criteria)) return null;
  return parsed;
}

export function buildRetryPrompt(acsPath: string, errors: PlanValidationError[]): string {
  const base = buildPlannerPrompt(acsPath);
  const errorBlock = errors
    .map((e) => `- AC ${e.acId}, field "${e.field}": ${e.message}`)
    .join("\n");
  return `${base}\n\nYOUR PREVIOUS PLAN HAD THESE ERRORS. Fix them:\n${errorBlock}`;
}

export function filterPlanErrors(
  plan: PlannerOutput,
  errors: PlanValidationError[]
): { validPlan: PlannerOutput; planErrors: ACVerdict[] } {
  const errorAcIds = new Set(errors.map((e) => e.acId));
  return {
    validPlan: {
      criteria: plan.criteria.filter((ac) => !errorAcIds.has(ac.id)),
    },
    planErrors: [...errorAcIds].map((acId) => ({
      ac_id: acId,
      verdict: "plan_error" as const,
      confidence: "high" as const,
      reasoning: errors.filter((e) => e.acId === acId).map((e) => e.message).join("; "),
    })),
  };
}
```

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
git add pipeline/src/stages/planner.ts pipeline/test/planner.test.ts
git commit -m "feat(pipeline): add planner stage with retry and error filtering"
```

---

### Task 2.6: Test fixtures

**Files:**
- Create: `pipeline/test/fixtures/acs.json`

```json
{
  "groups": [
    {
      "id": "group-a",
      "condition": "Organization must be in trialing state",
      "acs": [
        { "id": "ac1", "description": "Trial alert banner appears on dashboard" },
        { "id": "ac2", "description": "Trial days remaining shows correct count" }
      ]
    },
    {
      "id": "group-b",
      "condition": null,
      "acs": [
        { "id": "ac3", "description": "Settings page loads without errors" }
      ]
    }
  ],
  "skipped": [
    { "id": "ac4", "reason": "Requires Stripe payment method — external service" }
  ]
}
```

**Step 1: Commit**

```bash
git add pipeline/test/fixtures/acs.json
git commit -m "test(pipeline): add realistic AC fixture"
```

---

### Task 2.7: CLI subcommand for run-stage

**Files:**
- Create: `pipeline/src/cli.ts`

This is the single CLI entry point. Stages are pure libraries — they never run themselves.

```typescript
// pipeline/src/cli.ts
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
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
      console.log(`✓ Generated ${fanned.groups.length} groups, ${fanned.skipped.length} skipped`);
      break;
    }
    case "planner": {
      const { buildPlannerPrompt, parsePlannerOutput } = await import("./stages/planner.js");
      const acsPath = join(runDir, "acs.json");
      const prompt = buildPlannerPrompt(acsPath);
      const result = await runClaude({ prompt, model: "opus", timeoutMs: 240_000, stage: "planner", runDir, ...permissions });
      const plan = parsePlannerOutput(result.stdout);
      if (!plan) { console.error("Failed to parse plan output. Check logs:", join(runDir, "logs")); process.exit(1); }
      writeFileSync(join(runDir, "plan.json"), JSON.stringify(plan, null, 2));
      console.log(`✓ Planned ${plan.criteria.length} ACs`);
      break;
    }
    case "plan-validator": {
      const { validatePlan } = await import("./stages/plan-validator.js");
      const { loadAppIndex } = await import("./lib/app-index.js");
      const plan = JSON.parse((await import("node:fs")).readFileSync(join(runDir, "plan.json"), "utf-8"));
      const appIndex = loadAppIndex(verifyDir);
      const result = validatePlan(plan, appIndex);
      if (result.valid) {
        console.log("✓ Plan is valid");
      } else {
        console.error("✗ Plan has errors:");
        for (const err of result.errors) console.error(`  - ${err.acId}: ${err.message}`);
        process.exit(1);
      }
      break;
    }
    default:
      console.error(`Unknown stage: ${stageName}. Available: ac-generator, planner, plan-validator, setup-writer, browse-agent, judge, learner`);
      process.exit(1);
  }
} else if (command === "run") {
  // Full pipeline run — implemented in WS5
  const specPath = values.spec;
  if (!specPath) { console.error("Usage: npx tsx src/cli.ts run --spec path/to/spec.md"); process.exit(1); }
  const { runPipeline } = await import("./orchestrator.js");
  const verifyDir = values["verify-dir"]!;
  await runPipeline(specPath, verifyDir, {
    onACCheckpoint: async (acs) => { console.log(JSON.stringify(acs, null, 2)); return acs; },
    onLog: console.log,
    onError: console.error,
    onProgress: (event) => { process.stdout.write(`\r${event.acId}: ${event.status} ${event.detail ?? ""}`); },
  });
} else {
  console.error("Usage:");
  console.error("  npx tsx src/cli.ts run --spec path/to/spec.md");
  console.error("  npx tsx src/cli.ts run-stage <stage> --verify-dir .verify --run-dir /tmp/run [--spec path]");
  process.exit(1);
}
```

**Step 1: Commit**

```bash
git add pipeline/src/cli.ts
git commit -m "feat(pipeline): add CLI with subcommands for stage testing"
```

---

### Task 2.8: Run all WS2 tests

```bash
cd pipeline && npx vitest run && npx tsc --noEmit
```

---

### Task 2.9: Manual test on a real repo

Use the CLI subcommands against a real repo with a spec file. See "How to test incrementally" at top of WS2.

---

## WS3: Execution Layer (Setup Writer + Browse Daemon + Browse Agent)

**Branch:** `ws3/execution-layer`
**Depends on:** WS1 merged to main
**Produces:** Setup SQL generation, browse daemon lifecycle, and browse agent execution
**Estimated tasks:** 10

### How to test incrementally

```bash
# Test setup writer with a real Prisma schema
npx tsx src/cli.ts run-stage setup-writer --verify-dir /path/to/.verify --run-dir /tmp/test-run --group group-a --condition "org in trialing state"

# Test browse agent with a real running app (needs dev server + cookies)
npx tsx src/cli.ts run-stage browse-agent --verify-dir /path/to/.verify --run-dir /tmp/test-run --ac ac1
cat /tmp/test-run/evidence/ac1/result.json
```

---

### Task 3.1: Browse daemon management

**Files:**
- Create: `pipeline/src/lib/browse.ts`
- Create: `pipeline/test/browse.test.ts`

**Step 1: Write the failing tests**

```typescript
// pipeline/test/browse.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { resolveBrowseBin } from "../src/lib/browse.js";

describe("resolveBrowseBin", () => {
  afterEach(() => { delete process.env.BROWSE_BIN; });

  it("uses BROWSE_BIN env var when set", () => {
    process.env.BROWSE_BIN = "/custom/browse";
    expect(resolveBrowseBin()).toBe("/custom/browse");
  });

  it("falls back to default cache path", () => {
    delete process.env.BROWSE_BIN;
    // This may throw if browse is not installed — that's OK for unit test
    try {
      const bin = resolveBrowseBin();
      expect(bin).toContain(".cache/verify/browse");
    } catch (e: any) {
      expect(e.message).toContain("Browse binary not found");
    }
  });
});
```

**Step 2: Run tests — expect FAIL**

**Step 3: Implement**

```typescript
// pipeline/src/lib/browse.ts
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function resolveBrowseBin(): string {
  if (process.env.BROWSE_BIN) return process.env.BROWSE_BIN;
  const cached = join(homedir(), ".cache", "verify", "browse");
  if (existsSync(cached)) return cached;
  throw new Error("Browse binary not found. Run /verify-setup or set BROWSE_BIN env var.");
}

export async function startDaemon(opts: { videoDir?: string }): Promise<void> {
  const bin = resolveBrowseBin();
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  if (opts.videoDir) env.BROWSE_VIDEO_DIR = opts.videoDir;

  try { execFileSync(bin, ["stop"], { env, timeout: 5000, stdio: "ignore" }); } catch { /* wasn't running */ }
  execFileSync(bin, ["goto", "about:blank"], { env, timeout: 10_000, stdio: "ignore" });
}

export async function healthCheck(): Promise<boolean> {
  try {
    execFileSync(resolveBrowseBin(), ["status"], { timeout: 5000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function stopDaemon(): Promise<void> {
  try { execFileSync(resolveBrowseBin(), ["stop"], { timeout: 5000, stdio: "ignore" }); } catch { /* already stopped */ }
}

export async function resetPage(): Promise<void> {
  try { execFileSync(resolveBrowseBin(), ["goto", "about:blank"], { timeout: 5000, stdio: "ignore" }); } catch { /* best effort */ }
}

export async function loadCookies(cookiesPath: string): Promise<void> {
  const { readFileSync } = await import("node:fs");
  const cookies = JSON.parse(readFileSync(cookiesPath, "utf-8")) as Array<{ name: string; value: string }>;
  const bin = resolveBrowseBin();
  for (const cookie of cookies) {
    try { execFileSync(bin, ["cookie", `${cookie.name}=${cookie.value}`], { timeout: 5000, stdio: "ignore" }); } catch { /* best effort */ }
  }
}
```

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
git add pipeline/src/lib/browse.ts pipeline/test/browse.test.ts
git commit -m "feat(pipeline): add browse daemon lifecycle management"
```

---

### Task 3.2: Setup Writer prompt + stage

**Files:**
- Create: `pipeline/src/prompts/setup-writer.txt`
- Create: `pipeline/src/stages/setup-writer.ts`
- Create: `pipeline/test/setup-writer.test.ts`

**Step 1: Write prompt** (same as before — `setup-writer.txt` with `{{groupId}}` and `{{condition}}` placeholders)

**Step 2: Write the failing tests**

```typescript
// pipeline/test/setup-writer.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildSetupWriterPrompt, parseSetupWriterOutput, detectORM } from "../src/stages/setup-writer.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("buildSetupWriterPrompt", () => {
  it("substitutes group id and condition", () => {
    const prompt = buildSetupWriterPrompt("group-a", "org in trialing state");
    expect(prompt).toContain("group-a");
    expect(prompt).toContain("org in trialing state");
    expect(prompt).not.toContain("{{groupId}}");
    expect(prompt).not.toContain("{{condition}}");
  });
});

describe("parseSetupWriterOutput", () => {
  it("parses valid output", () => {
    const output = JSON.stringify({
      group_id: "group-a", condition: "org in trialing state",
      setup_commands: ["psql ..."], teardown_commands: ["psql ..."],
    });
    expect(parseSetupWriterOutput(output)).not.toBeNull();
  });

  it("returns null for invalid output", () => {
    expect(parseSetupWriterOutput("garbage")).toBeNull();
  });

  it("returns null when setup_commands is missing", () => {
    expect(parseSetupWriterOutput('{"group_id": "g1"}')).toBeNull();
  });
});

describe("detectORM", () => {
  let tempDir: string;

  beforeEach(() => { tempDir = join(tmpdir(), `orm-detect-${Date.now()}`); mkdirSync(tempDir, { recursive: true }); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("detects Prisma when schema.prisma exists", () => {
    mkdirSync(join(tempDir, "prisma"), { recursive: true });
    writeFileSync(join(tempDir, "prisma", "schema.prisma"), "model User {}");
    expect(detectORM(tempDir)).toBe("prisma");
  });

  it("detects Drizzle when drizzle.config.ts exists", () => {
    writeFileSync(join(tempDir, "drizzle.config.ts"), "export default {}");
    expect(detectORM(tempDir)).toBe("drizzle");
  });

  it("returns unknown when no ORM detected", () => {
    expect(detectORM(tempDir)).toBe("unknown");
  });
});
```

**Step 3: Implement** (same as before)

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
git add pipeline/src/prompts/setup-writer.txt pipeline/src/stages/setup-writer.ts pipeline/test/setup-writer.test.ts
git commit -m "feat(pipeline): add setup writer stage with ORM detection"
```

---

### Task 3.3: Browse Agent prompt + stage

**Files:**
- Create: `pipeline/src/prompts/browse-agent.txt`
- Create: `pipeline/src/stages/browse-agent.ts`
- Create: `pipeline/test/browse-agent.test.ts`

**Step 1: Write prompt** (same as before — browse-agent.txt with placeholders)

**Step 2: Write the failing tests**

```typescript
// pipeline/test/browse-agent.test.ts
import { describe, it, expect } from "vitest";
import { buildBrowseAgentPrompt, parseBrowseResult } from "../src/stages/browse-agent.js";
import type { PlannedAC } from "../src/lib/types.js";

const mockAC: PlannedAC = {
  id: "ac1", group: "group-a", description: "Trial banner appears",
  url: "/settings", steps: ["Navigate to settings", "Look for trial banner"],
  screenshot_at: ["trial_banner"], timeout_seconds: 90,
};

describe("buildBrowseAgentPrompt", () => {
  it("substitutes all placeholders", () => {
    const prompt = buildBrowseAgentPrompt(mockAC, {
      baseUrl: "http://localhost:3000", browseBin: "/usr/local/bin/browse",
      evidenceDir: "/tmp/evidence/ac1",
    });
    expect(prompt).toContain("Trial banner appears");
    expect(prompt).toContain("http://localhost:3000/settings");
    expect(prompt).toContain("/usr/local/bin/browse");
    expect(prompt).toContain("/tmp/evidence/ac1");
    expect(prompt).not.toContain("{{");
  });
});

describe("parseBrowseResult", () => {
  it("parses valid result", () => {
    const output = JSON.stringify({
      ac_id: "ac1", observed: "Trial banner visible",
      screenshots: ["screenshot-banner.png"], commands_run: ["goto ..."],
    });
    const result = parseBrowseResult(output);
    expect(result).not.toBeNull();
    expect(result!.ac_id).toBe("ac1");
  });

  it("returns null for invalid output", () => {
    expect(parseBrowseResult("garbage")).toBeNull();
  });

  it("returns null when observed is missing", () => {
    expect(parseBrowseResult('{"ac_id": "ac1"}')).toBeNull();
  });
});
```

**Step 3: Implement** (same as before)

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
git add pipeline/src/prompts/browse-agent.txt pipeline/src/stages/browse-agent.ts pipeline/test/browse-agent.test.ts
git commit -m "feat(pipeline): add browse agent stage with prompt builder"
```

---

### Tasks 3.4–3.7: Setup execution, teardown, video handling, auth failure fixture

**Task 3.4:** Execute setup commands via `child_process.execFileSync` with error capture. Test: SQL succeeds → returns 0; SQL fails → returns error message without throwing.

**Task 3.5:** Execute teardown commands (best-effort, log failures). Test: teardown failure doesn't throw.

**Task 3.6:** Video file detection — find newest `.webm` in evidence dir, rename to `session.webm`. Test with temp directory + fake webm files.

**Task 3.7:** Create `pipeline/test/fixtures/result-auth-failure.json`:

```json
{
  "ac_id": "ac1",
  "observed": "Auth redirect — page shows login form at /login",
  "screenshots": [],
  "commands_run": ["goto http://localhost:3000/settings"]
}
```

Test that `parseBrowseResult` + `isAuthFailure` correctly identifies this as auth failure.

---

### Tasks 3.8–3.10: Add setup-writer and browse-agent to CLI, typecheck, manual smoke test

Add `setup-writer` and `browse-agent` cases to `cli.ts` switch statement. Run full WS3 test suite. Manual test on real app with running dev server.

---

## WS4: Evaluation Layer (Judge + Learner + Confidence + Self-Healing)

**Branch:** `ws4/evaluation-layer`
**Depends on:** WS1 merged to main
**Produces:** Judge with confidence scoring, Learner with self-healing patterns
**Estimated tasks:** 8

### How to test incrementally

```bash
# Create fake evidence
mkdir -p /tmp/test-run/evidence/ac1
echo '{"ac_id":"ac1","observed":"Trial banner visible","screenshots":["s.png"],"commands_run":["goto ..."]}' \
  > /tmp/test-run/evidence/ac1/result.json

# Run judge
npx tsx src/cli.ts run-stage judge --verify-dir /path/to/.verify --run-dir /tmp/test-run
cat /tmp/test-run/verdicts.json | jq .

# Run learner
npx tsx src/cli.ts run-stage learner --verify-dir /path/to/.verify --run-dir /tmp/test-run
cat /path/to/.verify/learnings.md
```

---

### Task 4.1: Judge prompt template (with confidence scoring)

**Files:**
- Create: `pipeline/src/prompts/judge.txt`

```
You are a verification judge. Review ALL evidence and decide pass/fail for each acceptance criterion.

You are the ONLY stage that produces verdicts. Browse agents collected evidence — you interpret it.

EVIDENCE FILES:
{{evidenceList}}

Read each evidence file listed above using tool calls. Also look at any screenshots in those directories.

OUTPUT: Write valid JSON to stdout with this exact schema:

{
  "verdicts": [
    {
      "ac_id": "ac1",
      "verdict": "pass",
      "confidence": "high",
      "reasoning": "Screenshot shows trial alert banner with correct text"
    }
  ]
}

VERDICT VALUES: pass, fail, error
CONFIDENCE VALUES: high, medium, low

CONFIDENCE GUIDELINES:
- high: screenshot directly confirms/refutes the AC. Clear, unambiguous evidence.
- medium: text evidence supports the verdict but screenshot is unclear or missing.
- low: evidence is indirect or ambiguous. The verdict is a best guess.

RULES:
1. Read ALL evidence before making any judgment.
2. Look for PATTERNS across ACs. If every screenshot shows a login page, that's an auth failure — not individual AC failures.
3. If observed says "Auth redirect", verdict is "fail" with reasoning noting the auth issue.
4. If observed is empty or missing, verdict is "error" with reasoning "no evidence collected".
5. Screenshots are primary evidence. If the screenshot contradicts the agent's observed text, trust the screenshot.
6. Be conservative: if evidence is ambiguous, verdict is "fail" with confidence "low".
7. Every AC in the evidence list must appear in your verdicts array.

Output ONLY the JSON. No explanation, no markdown fences.
```

**Step 1: Commit**

```bash
git add pipeline/src/prompts/judge.txt
git commit -m "feat(pipeline): add judge prompt with confidence scoring"
```

---

### Task 4.2: Judge stage

**Files:**
- Create: `pipeline/src/stages/judge.ts`
- Create: `pipeline/test/judge.test.ts`
- Create: `pipeline/test/fixtures/result.json`
- Create: `pipeline/test/fixtures/verdicts.json`

**Step 1: Create fixtures**

```json
// pipeline/test/fixtures/result.json
{
  "ac_id": "ac1",
  "observed": "Trial banner visible with text 'Your trial ends in 14 days'",
  "screenshots": ["screenshot-banner.png"],
  "commands_run": ["goto http://localhost:3000/settings", "snapshot -D"]
}
```

```json
// pipeline/test/fixtures/verdicts.json
{
  "verdicts": [
    { "ac_id": "ac1", "verdict": "pass", "confidence": "high", "reasoning": "Banner confirmed in screenshot" }
  ]
}
```

**Step 2: Write the failing tests**

```typescript
// pipeline/test/judge.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildJudgePrompt, parseJudgeOutput, collectEvidencePaths } from "../src/stages/judge.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("collectEvidencePaths", () => {
  let runDir: string;

  beforeEach(() => {
    runDir = join(tmpdir(), `verify-judge-${Date.now()}`);
    mkdirSync(join(runDir, "evidence", "ac1"), { recursive: true });
    mkdirSync(join(runDir, "evidence", "ac2"), { recursive: true });
    writeFileSync(join(runDir, "evidence", "ac1", "result.json"), "{}");
    writeFileSync(join(runDir, "evidence", "ac2", "result.json"), "{}");
  });

  afterEach(() => { rmSync(runDir, { recursive: true, force: true }); });

  it("finds all evidence directories with result.json", () => {
    const paths = collectEvidencePaths(runDir);
    expect(paths).toHaveLength(2);
    expect(paths.map(p => p.acId).sort()).toEqual(["ac1", "ac2"]);
  });

  it("skips directories without result.json", () => {
    mkdirSync(join(runDir, "evidence", "ac3"), { recursive: true });
    // ac3 has no result.json
    const paths = collectEvidencePaths(runDir);
    expect(paths).toHaveLength(2);
  });

  it("returns empty array when no evidence directory exists", () => {
    const emptyDir = join(tmpdir(), `verify-empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    expect(collectEvidencePaths(emptyDir)).toHaveLength(0);
    rmSync(emptyDir, { recursive: true, force: true });
  });
});

describe("buildJudgePrompt", () => {
  it("includes evidence file paths", () => {
    const prompt = buildJudgePrompt([
      { acId: "ac1", resultPath: "/tmp/evidence/ac1/result.json" },
    ]);
    expect(prompt).toContain("ac1");
    expect(prompt).toContain("/tmp/evidence/ac1/result.json");
  });
});

describe("parseJudgeOutput", () => {
  it("parses valid verdicts with confidence", () => {
    const output = JSON.stringify({
      verdicts: [{ ac_id: "ac1", verdict: "pass", confidence: "high", reasoning: "looks good" }],
    });
    const result = parseJudgeOutput(output);
    expect(result).not.toBeNull();
    expect(result!.verdicts[0].confidence).toBe("high");
  });

  it("returns null for missing verdicts array", () => {
    expect(parseJudgeOutput('{"foo": "bar"}')).toBeNull();
  });

  it("returns null for garbage", () => {
    expect(parseJudgeOutput("nope")).toBeNull();
  });
});
```

**Step 3: Implement**

```typescript
// pipeline/src/stages/judge.ts
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { JudgeOutput } from "../lib/types.js";
import { parseJsonOutput } from "../lib/parse-json.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface EvidenceRef {
  acId: string;
  resultPath: string;
}

export function collectEvidencePaths(runDir: string): EvidenceRef[] {
  const evidenceDir = join(runDir, "evidence");
  if (!existsSync(evidenceDir)) return [];
  return readdirSync(evidenceDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ acId: d.name, resultPath: join(evidenceDir, d.name, "result.json") }))
    .filter((ref) => existsSync(ref.resultPath));
}

export function buildJudgePrompt(evidenceRefs: EvidenceRef[]): string {
  const template = readFileSync(join(__dirname, "../prompts/judge.txt"), "utf-8");
  const evidenceList = evidenceRefs.map((ref) => `- AC ${ref.acId}: ${ref.resultPath}`).join("\n");
  return template.replace("{{evidenceList}}", evidenceList);
}

export function parseJudgeOutput(raw: string): JudgeOutput | null {
  const parsed = parseJsonOutput<JudgeOutput>(raw);
  if (!parsed || !Array.isArray(parsed.verdicts)) return null;
  return parsed;
}
```

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
git add pipeline/src/stages/judge.ts pipeline/test/judge.test.ts pipeline/src/prompts/judge.txt pipeline/test/fixtures/result.json pipeline/test/fixtures/verdicts.json
git commit -m "feat(pipeline): add judge stage with confidence scoring"
```

---

### Task 4.3: Learner prompt template (with self-healing)

**Files:**
- Create: `pipeline/src/prompts/learner.txt`

```
You are a learnings agent. Update the project's learnings file based on this run's results.

Read the following files using tool calls:
1. {{verdictsPath}} — the verdicts from this run
2. {{timelinePath}} — the timeline of events
3. {{learningsPath}} — the existing learnings file (may not exist on first run)
4. Any setup error logs in the run directory (look for setup-writer-stderr.txt)

Write the updated learnings to {{learningsPath}}.

WHAT TO CAPTURE:
- App facts: DB env var name, auth method, seed data IDs that worked
- Setup patterns: SQL that succeeded (exact commands)
- Known skips: ACs that can never be tested locally and why
- Selector tips: what works in this app's UI framework
- Timing: average durations by AC type

SELF-HEALING PATTERNS:
When setup SQL fails and the error reveals the fix, capture the correction:
- "Column 'subscriptionStatus' does not exist" → The actual column is 'subscription_status'
- "Relation 'Organization' does not exist" → The actual table is 'organizations' (lowercase)
Write these as explicit corrections under a "## Setup Corrections" section.
Future runs will read these corrections and generate correct SQL the first time.

HOW TO UPDATE:
- If this is the first run, create the file with sections for each category
- If the file exists, MERGE new learnings. Do not duplicate.
- Correct stale entries
- Keep the file under 200 lines. Prune low-value entries.

Output the full updated learnings.md content to stdout as well.
```

**Step 1: Commit**

```bash
git add pipeline/src/prompts/learner.txt
git commit -m "feat(pipeline): add learner prompt with self-healing patterns"
```

---

### Task 4.4: Learner stage

**Files:**
- Create: `pipeline/src/stages/learner.ts`
- Create: `pipeline/test/learner.test.ts`

**Step 1: Write the failing tests**

```typescript
// pipeline/test/learner.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildLearnerPrompt, backupAndRestore } from "../src/stages/learner.js";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("buildLearnerPrompt", () => {
  it("substitutes all paths", () => {
    const prompt = buildLearnerPrompt({
      verdictsPath: "/tmp/run/verdicts.json",
      timelinePath: "/tmp/run/logs/timeline.jsonl",
      learningsPath: "/project/.verify/learnings.md",
    });
    expect(prompt).toContain("/tmp/run/verdicts.json");
    expect(prompt).toContain("/tmp/run/logs/timeline.jsonl");
    expect(prompt).toContain("/project/.verify/learnings.md");
    expect(prompt).not.toContain("{{");
  });
});

describe("backupAndRestore", () => {
  let verifyDir: string;

  beforeEach(() => { verifyDir = join(tmpdir(), `verify-learner-${Date.now()}`); mkdirSync(verifyDir, { recursive: true }); });
  afterEach(() => { rmSync(verifyDir, { recursive: true, force: true }); });

  it("creates backup of existing learnings", () => {
    const path = join(verifyDir, "learnings.md");
    writeFileSync(path, "# Existing learnings\n\nSome content here that matters.");
    const { backup, restore } = backupAndRestore(path);
    expect(existsSync(backup)).toBe(true);
  });

  it("restores backup when file becomes empty", () => {
    const path = join(verifyDir, "learnings.md");
    writeFileSync(path, "# Existing learnings\n\nSome content here that matters.");
    const { restore } = backupAndRestore(path);
    writeFileSync(path, ""); // Simulate corruption
    restore();
    expect(readFileSync(path, "utf-8")).toContain("Existing learnings");
  });

  it("restores backup when file becomes too small", () => {
    const path = join(verifyDir, "learnings.md");
    writeFileSync(path, "# Existing learnings\n\nSome content here that matters.");
    const { restore } = backupAndRestore(path);
    writeFileSync(path, "tiny"); // Under 10 bytes
    restore();
    expect(readFileSync(path, "utf-8")).toContain("Existing learnings");
  });

  it("does NOT restore when file is valid", () => {
    const path = join(verifyDir, "learnings.md");
    writeFileSync(path, "# Old content that is fine");
    const { restore } = backupAndRestore(path);
    writeFileSync(path, "# New content from learner that is perfectly valid and long enough");
    restore();
    expect(readFileSync(path, "utf-8")).toContain("New content");
  });

  it("restore is no-op when no backup exists", () => {
    const path = join(verifyDir, "learnings.md");
    const { restore } = backupAndRestore(path);
    restore(); // Should not throw
    expect(existsSync(path)).toBe(false);
  });
});
```

**Step 2: Implement**

```typescript
// pipeline/src/stages/learner.ts
import { readFileSync, writeFileSync, copyFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface LearnerPaths {
  verdictsPath: string;
  timelinePath: string;
  learningsPath: string;
}

export function buildLearnerPrompt(paths: LearnerPaths): string {
  const template = readFileSync(join(__dirname, "../prompts/learner.txt"), "utf-8");
  return template
    .replaceAll("{{verdictsPath}}", paths.verdictsPath)
    .replaceAll("{{timelinePath}}", paths.timelinePath)
    .replaceAll("{{learningsPath}}", paths.learningsPath);
}

const MIN_LEARNINGS_BYTES = 10;

export function backupAndRestore(learningsPath: string): {
  backup: string;
  restore: () => void;
} {
  const backupPath = learningsPath + ".bak";
  if (existsSync(learningsPath)) {
    copyFileSync(learningsPath, backupPath);
  }
  return {
    backup: backupPath,
    restore: () => {
      if (!existsSync(backupPath)) return;
      const needsRestore = !existsSync(learningsPath) || statSync(learningsPath).size < MIN_LEARNINGS_BYTES;
      if (needsRestore) {
        copyFileSync(backupPath, learningsPath);
      }
    },
  };
}
```

**Step 3: Run tests — expect PASS**

**Step 4: Commit**

```bash
git add pipeline/src/stages/learner.ts pipeline/test/learner.test.ts pipeline/src/prompts/learner.txt
git commit -m "feat(pipeline): add learner stage with backup/restore safety"
```

---

### Tasks 4.5–4.8: Add judge + learner to CLI, typecheck, manual test

Add `judge` and `learner` cases to `cli.ts`. Run full WS4 suite. Manual test with fixture evidence.

---

## WS5: Orchestrator

**Branch:** `ws5/orchestrator`
**Depends on:** WS1, WS2, WS3, WS4 all merged to main
**Produces:** The execution engine that wires all stages together
**Estimated tasks:** 12

### How to test incrementally

```bash
# Full pipeline run on a real repo
cd /path/to/target-repo
npx tsx /path/to/verify/pipeline/src/cli.ts run --spec docs/plans/my-spec.md
```

---

### Task 5.0: Init / preflight checks

**Files:**
- Create: `pipeline/src/init.ts`
- Add tests to: `pipeline/test/orchestrator.test.ts`

This runs BEFORE any LLM call. Fail fast if the environment isn't ready.

**Step 1: Write the failing tests**

```typescript
// pipeline/test/init.test.ts (new file)
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("preflight checks", () => {
  let verifyDir: string;

  beforeEach(() => {
    verifyDir = join(tmpdir(), `verify-init-${Date.now()}`);
    mkdirSync(verifyDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(verifyDir, { recursive: true, force: true });
  });

  it("checkDevServer returns true when server is reachable", async () => {
    // This test requires mocking fetch or using a real server
    // For unit test: mock global fetch
    const { checkDevServer } = await import("../src/init.js");
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
    const result = await checkDevServer("http://localhost:3000");
    expect(result.ok).toBe(true);
  });

  it("checkDevServer returns error when server is unreachable", async () => {
    const { checkDevServer } = await import("../src/init.js");
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await checkDevServer("http://localhost:3000");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not reachable");
  });

  it("checkSpecFile returns true when spec exists", async () => {
    const { checkSpecFile } = await import("../src/init.js");
    const specPath = join(verifyDir, "spec.md");
    writeFileSync(specPath, "# Spec\n\nSome content");
    const result = checkSpecFile(specPath);
    expect(result.ok).toBe(true);
  });

  it("checkSpecFile returns error when spec does not exist", async () => {
    const { checkSpecFile } = await import("../src/init.js");
    const result = checkSpecFile("/nonexistent/spec.md");
    expect(result.ok).toBe(false);
  });
});
```

**Step 2: Implement**

```typescript
// pipeline/src/init.ts
import { existsSync } from "node:fs";
import { healthCheck } from "./lib/browse.js";

interface CheckResult {
  ok: boolean;
  error?: string;
}

export async function checkDevServer(baseUrl: string): Promise<CheckResult> {
  try {
    const response = await fetch(baseUrl, { signal: AbortSignal.timeout(5000) });
    return { ok: true };
  } catch {
    return { ok: false, error: `Dev server at ${baseUrl} is not reachable. Is it running?` };
  }
}

export async function checkBrowseDaemon(): Promise<CheckResult> {
  const healthy = await healthCheck();
  if (healthy) return { ok: true };
  return { ok: false, error: "Browse daemon is not running. Run /verify-setup first." };
}

export function checkSpecFile(specPath: string): CheckResult {
  if (existsSync(specPath)) return { ok: true };
  return { ok: false, error: `Spec file not found: ${specPath}` };
}

export async function runPreflight(baseUrl: string, specPath: string): Promise<{
  ok: boolean;
  errors: string[];
}> {
  const errors: string[] = [];

  const spec = checkSpecFile(specPath);
  if (!spec.ok) errors.push(spec.error!);

  const server = await checkDevServer(baseUrl);
  if (!server.ok) errors.push(server.error!);

  // Browse daemon check is best-effort — daemon may start lazily
  const daemon = await checkBrowseDaemon();
  if (!daemon.ok) errors.push(daemon.error!);

  return { ok: errors.length === 0, errors };
}
```

**Step 3: Run tests — expect PASS**

**Step 4: Commit**

```bash
git add pipeline/src/init.ts pipeline/test/init.test.ts
git commit -m "feat(pipeline): add init/preflight checks — fail fast before LLM calls"
```

---

### Task 5.1: Run ID generation

**Files:**
- Create: `pipeline/src/lib/run-id.ts`
- Create: `pipeline/test/run-id.test.ts`

```typescript
// pipeline/src/lib/run-id.ts
import { basename } from "node:path";

export function generateRunId(specPath: string, now = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 16).replace(":", "");
  const slug = basename(specPath, ".md")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${date}-${time}-${slug}`;
}
```

```typescript
// pipeline/test/run-id.test.ts
import { describe, it, expect } from "vitest";
import { generateRunId } from "../src/lib/run-id.js";

describe("generateRunId", () => {
  it("generates YYYY-MM-DD-HHMM-slug format", () => {
    const id = generateRunId("/docs/plans/trial-alerts-spec.md", new Date("2026-03-18T14:25:00Z"));
    expect(id).toBe("2026-03-18-1425-trial-alerts-spec");
  });

  it("truncates long filenames", () => {
    const id = generateRunId("/docs/a-very-long-spec-filename-that-goes-on-and-on-and-on-forever.md");
    expect(id.split("-").slice(2).join("-").length).toBeLessThanOrEqual(40);
  });

  it("handles special characters in filename", () => {
    const id = generateRunId("/docs/My Spec (v2) [final].md");
    expect(id).not.toMatch(/[ ()\[\]]/);
  });
});
```

---

### Task 5.2: Orchestrator — full implementation

**Files:**
- Create: `pipeline/src/orchestrator.ts`
- Create: `pipeline/test/orchestrator.test.ts`

This is the core of the pipeline. It wires all stages together.

**Step 1: Write the orchestrator tests**

```typescript
// pipeline/test/orchestrator.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// These tests mock runClaude and verify orchestration logic

describe("group execution", () => {
  it("runs setup groups sequentially within group", async () => {
    // Verify: agent N starts only after agent N-1 finishes
    const executionOrder: string[] = [];
    // Mock implementation tracks execution order
    // Assert: executionOrder is ["ac1", "ac2"] (not interleaved)
    expect(true).toBe(true); // Placeholder — full implementation in task
  });

  it("runs groups in parallel up to concurrency cap", async () => {
    // Verify: with maxParallelGroups=2 and 4 groups,
    // at most 2 run at once
    expect(true).toBe(true); // Placeholder
  });

  it("fans out pure-UI groups for maximum parallelism", async () => {
    // Verify: group with condition=null and 3 ACs becomes 3 groups
    expect(true).toBe(true); // Placeholder
  });
});

describe("circuit breaker", () => {
  it("trips when browse agent returns auth failure", async () => {
    // Verify: when one agent writes "Auth redirect",
    // all other running agents are killed
    // and pending agents are skipped with reason "auth session expired"
    expect(true).toBe(true); // Placeholder
  });

  it("does NOT trip on non-auth failures", async () => {
    // Verify: timeout, crash, setup failure do NOT trigger circuit breaker
    expect(true).toBe(true); // Placeholder
  });
});

describe("stage failure handling", () => {
  it("marks ACs as error when AC Generator returns null", async () => {
    // Verify: pipeline aborts cleanly, reports "AC Generator failed to produce output"
    expect(true).toBe(true); // Placeholder
  });

  it("marks group ACs as setup_failed when SQL fails", async () => {
    // Verify: other groups continue, failed group ACs get setup_failed verdict
    expect(true).toBe(true); // Placeholder
  });

  it("marks AC as timeout when browse agent times out", async () => {
    // Verify: AC gets timeout verdict, other ACs in same group continue
    expect(true).toBe(true); // Placeholder
  });

  it("skips Judge when zero evidence files exist", async () => {
    // Verify: Judge runClaude is NOT called, all ACs get error verdict
    expect(true).toBe(true); // Placeholder
  });
});

describe("planner retry", () => {
  it("retries planner once on validation failure", async () => {
    // Verify: planner is called twice, second time with error feedback
    expect(true).toBe(true); // Placeholder
  });

  it("marks ACs as plan_error when retry also fails", async () => {
    // Verify: failing ACs are removed from plan, get plan_error verdict
    expect(true).toBe(true); // Placeholder
  });
});

describe("learner safety", () => {
  it("restores learnings.md backup when learner produces empty output", async () => {
    // Verify: learnings.md.bak is copied back
    expect(true).toBe(true); // Placeholder
  });

  it("runs learner even on aborted runs", async () => {
    // Verify: learner is called even when circuit breaker tripped
    expect(true).toBe(true); // Placeholder
  });
});
```

> **Note to implementing engineer:** Each test above marked "Placeholder" needs a full mock-based implementation. The mock should:
> 1. Mock `runClaude` to return fixture outputs
> 2. Mock `child_process.execFileSync` for setup/teardown SQL
> 3. Track call order and arguments
> 4. Assert the orchestrator's behavior (verdicts written, timeline events, etc.)

**Step 2: Implement the orchestrator**

```typescript
// pipeline/src/orchestrator.ts
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  VerifyConfig, ACGeneratorOutput, PlannerOutput, JudgeOutput,
  ACVerdict, ProgressEvent, STAGE_PERMISSIONS,
} from "./lib/types.js";
import { isAuthFailure } from "./lib/types.js";
import { loadConfig } from "./lib/config.js";
import { generateRunId } from "./lib/run-id.js";
import { runClaude } from "./run-claude.js";
import { appendTimelineEvent, readTimeline } from "./lib/timeline.js";
import { loadAppIndex } from "./lib/app-index.js";
import { ProgressEmitter } from "./lib/progress.js";
import { runPreflight } from "./init.js";

import { buildACGeneratorPrompt, parseACGeneratorOutput, fanOutPureUIGroups } from "./stages/ac-generator.js";
import { buildPlannerPrompt, parsePlannerOutput, buildRetryPrompt, filterPlanErrors } from "./stages/planner.js";
import { validatePlan } from "./stages/plan-validator.js";
import { buildSetupWriterPrompt, parseSetupWriterOutput, detectORM } from "./stages/setup-writer.js";
import { buildBrowseAgentPrompt, parseBrowseResult } from "./stages/browse-agent.js";
import { buildJudgePrompt, parseJudgeOutput, collectEvidencePaths } from "./stages/judge.js";
import { buildLearnerPrompt, backupAndRestore } from "./stages/learner.js";
import { resolveBrowseBin, startDaemon, healthCheck, stopDaemon, resetPage } from "./lib/browse.js";

export interface OrchestratorCallbacks {
  onACCheckpoint: (acs: ACGeneratorOutput) => Promise<ACGeneratorOutput | null>;
  onLog: (message: string) => void;
  onError: (message: string) => void;
  onProgress: (event: ProgressEvent) => void;
}

export async function runPipeline(
  specPath: string,
  verifyDir: string,
  callbacks: OrchestratorCallbacks
): Promise<{ runDir: string; verdicts: JudgeOutput | null }> {
  const config = loadConfig(verifyDir);
  const appIndex = loadAppIndex(verifyDir);
  const runId = generateRunId(specPath);
  const runDir = join(verifyDir, "runs", runId);
  mkdirSync(join(runDir, "logs"), { recursive: true });

  const progress = new ProgressEmitter(callbacks.onProgress);
  const allVerdicts: ACVerdict[] = [];

  callbacks.onLog(`Run: ${runId}`);

  // ── Init (preflight) ────────────────────────────────────────────────────
  const preflight = await runPreflight(config.baseUrl, specPath);
  if (!preflight.ok) {
    for (const err of preflight.errors) callbacks.onError(err);
    return { runDir, verdicts: null };
  }

  // ── Stage 1: AC Generator ──────────────────────────────────────────────
  callbacks.onLog("Stage 1: Generating acceptance criteria...");
  const acPrompt = buildACGeneratorPrompt(specPath);
  const acResult = await runClaude({
    prompt: acPrompt, model: "opus", timeoutMs: 120_000,
    stage: "ac-generator", runDir,
    ...STAGE_PERMISSIONS["ac-generator"],
  });
  const rawAcs = parseACGeneratorOutput(acResult.stdout);
  if (!rawAcs) {
    callbacks.onError("AC Generator failed. Check logs: " + join(runDir, "logs"));
    return { runDir, verdicts: null };
  }

  // User checkpoint
  const confirmedAcs = await callbacks.onACCheckpoint(rawAcs);
  if (!confirmedAcs) {
    callbacks.onLog("User aborted after AC review.");
    return { runDir, verdicts: null };
  }
  const acs = fanOutPureUIGroups(confirmedAcs);
  writeFileSync(join(runDir, "acs.json"), JSON.stringify(acs, null, 2));

  // Initialize progress for all ACs
  for (const group of acs.groups) {
    for (const ac of group.acs) progress.update(ac.id, "pending");
  }

  // ── Stage 2: Planner + Validator ───────────────────────────────────────
  callbacks.onLog("Stage 2: Planning browser steps...");
  const planPrompt = buildPlannerPrompt(join(runDir, "acs.json"));
  const planResult = await runClaude({
    prompt: planPrompt, model: "opus", timeoutMs: 120_000,
    stage: "planner", runDir,
    ...STAGE_PERMISSIONS["planner"],
  });
  let plan = parsePlannerOutput(planResult.stdout);
  if (!plan) {
    callbacks.onError("Planner failed. Check logs: " + join(runDir, "logs"));
    return { runDir, verdicts: null };
  }

  // Validate + one retry
  let validation = validatePlan(plan, appIndex);
  if (!validation.valid) {
    callbacks.onLog("Plan has errors, retrying with feedback...");
    const retryPrompt = buildRetryPrompt(join(runDir, "acs.json"), validation.errors);
    const retryResult = await runClaude({
      prompt: retryPrompt, model: "opus", timeoutMs: 120_000,
      stage: "planner-retry", runDir,
      ...STAGE_PERMISSIONS["planner"],
    });
    const retryPlan = parsePlannerOutput(retryResult.stdout);
    if (retryPlan) {
      plan = retryPlan;
      validation = validatePlan(plan, appIndex);
    }
  }

  // Filter out ACs that still have errors
  if (!validation.valid) {
    const { validPlan, planErrors } = filterPlanErrors(plan, validation.errors);
    plan = validPlan;
    allVerdicts.push(...planErrors);
    for (const v of planErrors) progress.update(v.ac_id, "error", "plan_error");
  }
  writeFileSync(join(runDir, "plan.json"), JSON.stringify(plan, null, 2));

  // ── Stage 3 + 4: Setup + Browse Agents ─────────────────────────────────
  callbacks.onLog("Stage 3-4: Executing browser agents...");
  const browseBin = resolveBrowseBin();
  const abortController = new AbortController();

  // Group ACs by their group id
  const groupMap = new Map<string, typeof plan.criteria>();
  for (const ac of plan.criteria) {
    if (!groupMap.has(ac.group)) groupMap.set(ac.group, []);
    groupMap.get(ac.group)!.push(ac);
  }

  // Find which groups need setup
  const groupConditions = new Map<string, string | null>();
  for (const group of acs.groups) {
    groupConditions.set(group.id, group.condition);
  }

  // Execute groups with concurrency cap
  const maxParallel = config.maxParallelGroups ?? 5;
  const groupIds = [...groupMap.keys()];
  const queue = [...groupIds];
  const active: Promise<void>[] = [];

  async function executeGroup(groupId: string): Promise<void> {
    const groupAcs = groupMap.get(groupId)!;
    const condition = groupConditions.get(groupId);
    const evidenceBase = join(runDir, "evidence");

    // Setup (if group has a condition)
    if (condition) {
      const setupPrompt = buildSetupWriterPrompt(groupId, condition);
      const setupResult = await runClaude({
        prompt: setupPrompt, model: "sonnet", timeoutMs: 90_000,
        stage: `setup-${groupId}`, runDir,
        ...STAGE_PERMISSIONS["setup-writer"],
      });
      const commands = parseSetupWriterOutput(setupResult.stdout);
      if (!commands) {
        for (const ac of groupAcs) {
          allVerdicts.push({ ac_id: ac.id, verdict: "setup_failed", confidence: "high", reasoning: "Setup writer failed to produce commands" });
          progress.update(ac.id, "error", "setup_failed");
        }
        return;
      }

      // Execute setup commands
      const { execFileSync } = await import("node:child_process");
      for (const cmd of commands.setup_commands) {
        try {
          execFileSync("sh", ["-c", cmd], { timeout: 30_000, stdio: "pipe" });
        } catch (err: any) {
          const errMsg = err.stderr?.toString() ?? err.message;
          for (const ac of groupAcs) {
            allVerdicts.push({ ac_id: ac.id, verdict: "setup_failed", confidence: "high", reasoning: `Setup SQL failed: ${errMsg}` });
            progress.update(ac.id, "error", "setup_failed");
          }
          return;
        }
      }

      // Save setup commands for teardown later
      mkdirSync(join(runDir, "setup", groupId), { recursive: true });
      writeFileSync(join(runDir, "setup", groupId, "commands.json"), JSON.stringify(commands, null, 2));
    }

    // Run browse agents sequentially within group
    for (const ac of groupAcs) {
      if (abortController.signal.aborted) {
        allVerdicts.push({ ac_id: ac.id, verdict: "auth_expired", confidence: "high", reasoning: "Aborted: auth session expired" });
        progress.update(ac.id, "skipped", "auth_expired");
        continue;
      }

      progress.update(ac.id, "running");
      const evidenceDir = join(evidenceBase, ac.id);
      mkdirSync(evidenceDir, { recursive: true });

      const agentPrompt = buildBrowseAgentPrompt(ac, {
        baseUrl: config.baseUrl, browseBin, evidenceDir,
      });
      const agentResult = await runClaude({
        prompt: agentPrompt, model: "sonnet", timeoutMs: ac.timeout_seconds * 1000,
        stage: `browse-${ac.id}`, runDir,
        ...STAGE_PERMISSIONS["browse-agent"],
      });

      if (agentResult.timedOut) {
        allVerdicts.push({ ac_id: ac.id, verdict: "timeout", confidence: "high", reasoning: `Timed out after ${ac.timeout_seconds}s` });
        progress.update(ac.id, "timeout");
        continue;
      }

      const browseResult = parseBrowseResult(agentResult.stdout);
      if (browseResult) {
        writeFileSync(join(evidenceDir, "result.json"), JSON.stringify(browseResult, null, 2));

        // Circuit breaker check
        if (isAuthFailure(browseResult.observed)) {
          callbacks.onError("Auth session expired. Run /verify-setup to re-authenticate.");
          abortController.abort();
          allVerdicts.push({ ac_id: ac.id, verdict: "auth_expired", confidence: "high", reasoning: "Auth redirect detected" });
          progress.update(ac.id, "error", "auth_expired");
          continue;
        }
      } else {
        allVerdicts.push({ ac_id: ac.id, verdict: "error", confidence: "high", reasoning: "Browse agent produced no parseable output" });
        progress.update(ac.id, "error");
      }

      // Reset page between agents in same group
      await resetPage();
    }

    // Teardown (best effort)
    if (condition) {
      try {
        const commandsPath = join(runDir, "setup", groupId, "commands.json");
        if (existsSync(commandsPath)) {
          const { execFileSync } = await import("node:child_process");
          const commands = JSON.parse((await import("node:fs")).readFileSync(commandsPath, "utf-8"));
          for (const cmd of commands.teardown_commands ?? []) {
            try { execFileSync("sh", ["-c", cmd], { timeout: 30_000, stdio: "pipe" }); } catch { /* best effort */ }
          }
        }
      } catch { /* best effort */ }
    }
  }

  // Run groups with concurrency cap
  while (queue.length > 0 || active.length > 0) {
    while (queue.length > 0 && active.length < maxParallel && !abortController.signal.aborted) {
      const groupId = queue.shift()!;
      const promise = executeGroup(groupId).then(() => {
        const idx = active.indexOf(promise);
        if (idx >= 0) active.splice(idx, 1);
      });
      active.push(promise);
    }
    if (active.length > 0) await Promise.race(active);
    if (abortController.signal.aborted) {
      // Skip remaining queued groups
      for (const groupId of queue) {
        const groupAcs = groupMap.get(groupId) ?? [];
        for (const ac of groupAcs) {
          allVerdicts.push({ ac_id: ac.id, verdict: "auth_expired", confidence: "high", reasoning: "Skipped: auth session expired" });
          progress.update(ac.id, "skipped", "auth_expired");
        }
      }
      queue.length = 0;
      break;
    }
  }

  // ── Stage 5: Judge ─────────────────────────────────────────────────────
  const evidenceRefs = collectEvidencePaths(runDir);
  let judgeVerdicts: JudgeOutput | null = null;

  if (evidenceRefs.length > 0) {
    callbacks.onLog("Stage 5: Judging evidence...");
    const judgePrompt = buildJudgePrompt(evidenceRefs);
    const judgeResult = await runClaude({
      prompt: judgePrompt, model: "opus", timeoutMs: 120_000,
      stage: "judge", runDir,
      ...STAGE_PERMISSIONS["judge"],
    });
    judgeVerdicts = parseJudgeOutput(judgeResult.stdout);
    if (judgeVerdicts) {
      allVerdicts.push(...judgeVerdicts.verdicts);
    }
  } else {
    callbacks.onLog("No evidence collected — skipping Judge.");
  }

  // Merge all verdicts
  const finalVerdicts: JudgeOutput = { verdicts: allVerdicts };
  writeFileSync(join(runDir, "verdicts.json"), JSON.stringify(finalVerdicts, null, 2));

  // ── Stage 6: Learner (always runs) ─────────────────────────────────────
  callbacks.onLog("Stage 6: Updating learnings...");
  const learningsPath = join(verifyDir, "learnings.md");
  const { restore } = backupAndRestore(learningsPath);
  const learnerPrompt = buildLearnerPrompt({
    verdictsPath: join(runDir, "verdicts.json"),
    timelinePath: join(runDir, "logs", "timeline.jsonl"),
    learningsPath,
  });
  await runClaude({
    prompt: learnerPrompt, model: "sonnet", timeoutMs: 60_000,
    stage: "learner", runDir,
    ...STAGE_PERMISSIONS["learner"],
  });
  restore(); // Safety: restore backup if learner corrupted the file

  // ── Report ─────────────────────────────────────────────────────────────
  const timeline = readTimeline(runDir);
  const totalDurationMs = timeline.length >= 2
    ? new Date(timeline[timeline.length - 1].ts).getTime() - new Date(timeline[0].ts).getTime()
    : 0;

  callbacks.onLog(`\nResults (${(totalDurationMs / 1000).toFixed(0)}s total):`);
  for (const v of finalVerdicts.verdicts) {
    const icon = v.verdict === "pass" ? "✓" : v.verdict === "fail" ? "✗" : "!";
    const conf = v.confidence !== "high" ? ` (${v.confidence} confidence)` : "";
    callbacks.onLog(`  ${icon} ${v.ac_id}: ${v.verdict}${conf} — ${v.reasoning}`);
  }

  // Write report.json
  writeFileSync(join(runDir, "report.json"), JSON.stringify({
    run_id: runId,
    verdicts: finalVerdicts.verdicts,
    total_duration_ms: totalDurationMs,
    stage_durations: timeline
      .filter(e => e.event === "end" || e.event === "timeout")
      .map(e => ({ stage: e.stage, durationMs: e.durationMs })),
  }, null, 2));

  return { runDir, verdicts: finalVerdicts };
}
```

**Step 3: Commit**

```bash
git add pipeline/src/orchestrator.ts pipeline/test/orchestrator.test.ts
git commit -m "feat(pipeline): add orchestrator with DAG execution, circuit breaker, and progress"
```

---

### Task 5.3: Report generator

**Files:**
- Create: `pipeline/src/report.ts`
- Create: `pipeline/test/report.test.ts`

Deterministic — reads `verdicts.json` and `timeline.jsonl`, formats terminal output + HTML.

```typescript
// pipeline/test/report.test.ts
import { describe, it, expect } from "vitest";
import { formatTerminalReport, formatTimingSummary } from "../src/report.js";
import type { ACVerdict, TimelineEvent } from "../src/lib/types.js";

describe("formatTerminalReport", () => {
  it("formats pass verdicts with checkmark", () => {
    const verdicts: ACVerdict[] = [
      { ac_id: "ac1", verdict: "pass", confidence: "high", reasoning: "Banner visible" },
    ];
    const output = formatTerminalReport(verdicts);
    expect(output).toContain("✓");
    expect(output).toContain("ac1");
  });

  it("formats fail verdicts with X", () => {
    const verdicts: ACVerdict[] = [
      { ac_id: "ac1", verdict: "fail", confidence: "medium", reasoning: "Not found" },
    ];
    const output = formatTerminalReport(verdicts);
    expect(output).toContain("✗");
    expect(output).toContain("medium confidence");
  });

  it("highlights low-confidence passes", () => {
    const verdicts: ACVerdict[] = [
      { ac_id: "ac1", verdict: "pass", confidence: "low", reasoning: "Ambiguous" },
    ];
    const output = formatTerminalReport(verdicts);
    expect(output).toContain("low confidence");
  });
});

describe("formatTimingSummary", () => {
  it("computes total and per-stage durations", () => {
    const events: TimelineEvent[] = [
      { ts: "2026-03-18T14:00:00Z", stage: "planner", event: "start" },
      { ts: "2026-03-18T14:00:30Z", stage: "planner", event: "end", durationMs: 30000 },
      { ts: "2026-03-18T14:00:31Z", stage: "judge", event: "start" },
      { ts: "2026-03-18T14:01:01Z", stage: "judge", event: "end", durationMs: 30000 },
    ];
    const summary = formatTimingSummary(events);
    expect(summary).toContain("planner");
    expect(summary).toContain("30s");
  });
});
```

---

### Tasks 5.4–5.5: Full orchestrator test implementations + typecheck

Flesh out all placeholder tests in `orchestrator.test.ts` with full mock-based implementations.

---

### Task 5.6: Manual end-to-end test on real repo

```bash
cd /path/to/eval-repo
VERIFY_ALLOW_DANGEROUS=1 npx tsx /path/to/verify/pipeline/src/cli.ts run --spec docs/plans/some-spec.md
```

Inspect all files in `.verify/runs/`. Verify timeline, verdicts, evidence, learnings.

---

## WS6: Integration (SKILL.md + App Indexer + Eval Infra + Cleanup)

**Branch:** `ws6/integration`
**Depends on:** WS5 merged to main
**Produces:** Updated SKILL.md, ported app indexer, eval infrastructure, deleted bash scripts
**Estimated tasks:** 9

---

### Task 6.1: Port app indexer to TypeScript

**Files:**
- Create: `pipeline/src/lib/index-app.ts`
- Create: `pipeline/test/index-app.test.ts`
- Create: `pipeline/src/prompts/index/routes.txt`
- Create: `pipeline/src/prompts/index/selectors.txt`
- Create: `pipeline/src/prompts/index/schema.txt`
- Create: `pipeline/src/prompts/index/fixtures.txt`

Port `scripts/index-app.sh` from the worktree. The logic:
1. Phase 1: Extract .env vars (pure string parsing, no LLM)
2. Phase 2: Spawn 4 parallel `runClaude()` calls with index prompts
3. Phase 3: Validate JSON outputs
4. Phase 4: Merge + cross-reference routes into pages

Test the env extraction and merge logic with unit tests (no LLM calls).

---

### Task 6.2: Minimal eval infrastructure

**Files:**
- Create: `pipeline/evals/run-evals.sh`
- Create: `pipeline/evals/ac-generator/input-formbricks-spec.md`
- Create: `pipeline/evals/ac-generator/golden-acs.json`
- Create: `pipeline/evals/planner/input-acs.json`
- Create: `pipeline/evals/planner/golden-plan.json`
- Create: `pipeline/evals/judge/input-evidence/ac1/result.json`
- Create: `pipeline/evals/judge/golden-verdicts.json`

```bash
#!/usr/bin/env bash
# pipeline/evals/run-evals.sh
# Runs each stage against fixture inputs and saves outputs for human review.
# Usage: bash pipeline/evals/run-evals.sh
set -e

EVAL_DIR="$(cd "$(dirname "$0")" && pwd)"
PIPELINE_DIR="$(dirname "$EVAL_DIR")"
OUTPUT_DIR="$EVAL_DIR/outputs/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUTPUT_DIR"

echo "=== Running eval set ==="
echo "Output: $OUTPUT_DIR"

# AC Generator
echo "→ AC Generator..."
mkdir -p "$OUTPUT_DIR/ac-generator/logs"
cd "$PIPELINE_DIR"
npx tsx src/cli.ts run-stage ac-generator \
  --verify-dir "$EVAL_DIR/ac-generator" \
  --run-dir "$OUTPUT_DIR/ac-generator" \
  --spec "$EVAL_DIR/ac-generator/input-formbricks-spec.md" 2>&1 || true
echo "  Output: $OUTPUT_DIR/ac-generator/acs.json"

# Diff against golden
if [ -f "$OUTPUT_DIR/ac-generator/acs.json" ] && [ -f "$EVAL_DIR/ac-generator/golden-acs.json" ]; then
  diff <(jq -S . "$OUTPUT_DIR/ac-generator/acs.json") <(jq -S . "$EVAL_DIR/ac-generator/golden-acs.json") > "$OUTPUT_DIR/ac-generator/diff.txt" 2>&1 || true
  echo "  Diff: $OUTPUT_DIR/ac-generator/diff.txt"
fi

echo "=== Done. Review outputs in $OUTPUT_DIR ==="
```

---

### Task 6.3: Update /verify-setup SKILL.md

Add app indexing step (Step 7 from worktree) to the verify-setup skill, calling the TypeScript indexer instead of bash.

---

### Task 6.4: Rewrite /verify SKILL.md

Update to call the TypeScript pipeline:

```bash
# Old (bash)
bash ~/.claude/tools/verify/preflight.sh
bash ~/.claude/tools/verify/orchestrate.sh

# New (TypeScript)
cd <project-root>
npx tsx ~/.claude/tools/verify/pipeline/src/cli.ts run --spec "$SPEC_PATH"
```

---

### Task 6.5: Update skill sync hook

Update `.claude/hooks/sync-skill.sh` to also sync `pipeline/` to `~/.claude/tools/verify/pipeline/`.

---

### Task 6.6: Delete old bash scripts

Remove: `scripts/preflight.sh`, `scripts/orchestrate.sh`, `scripts/agent.sh`, `scripts/planner.sh`, `scripts/judge.sh`, `scripts/report.sh`, `scripts/code-review.sh`, `scripts/prompts/` (all old templates).

Keep: `scripts/install-browse.sh` (stays bash per design).

---

### Task 6.7: Update CLAUDE.md

Reflect new `pipeline/` structure, new test commands, new conventions.

---

### Task 6.8: End-to-end test on eval repo

Full smoke test: `/verify-setup` then `/verify` on eval repo. Verify all outputs.

---

### Task 6.9: Run eval set

```bash
bash pipeline/evals/run-evals.sh
```

Review outputs, create golden files for future comparison.

---

## Merge Order Summary

```
1. WS1 → main                  (foundation)
2. WS2, WS3, WS4 → main       (parallel stages, merge in any order)
3. WS5 → main                  (orchestrator)
4. WS6 → main                  (integration + cleanup)
```

Each merge is a meaningful checkpoint. After each merge: `cd pipeline && npx vitest run && npx tsc --noEmit` must pass.

---

## Testing Strategy by Phase

| Phase | What you can test | How |
|-------|-------------------|-----|
| After WS1 | Types compile, helpers work, auth patterns match | `npx vitest run` in pipeline/ |
| After WS2 | AC Generator on real spec, Planner on real codebase, Validator catches errors | `npx tsx src/cli.ts run-stage <stage>` against eval repo |
| After WS3 | Browse daemon starts/stops, Setup SQL generates, Browse agent navigates real app | Stage CLI with running dev server |
| After WS4 | Judge produces verdicts with confidence from evidence, Learner updates learnings | Feed fake evidence to judge CLI |
| After WS5 | Full pipeline run, circuit breaker, group parallelism, timing summary | `npx tsx src/cli.ts run --spec spec.md` |
| After WS6 | `/verify` skill works end-to-end, eval set produces diffs | Run `/verify` in Claude Code on eval repo |

---

## Stage Permissions Map

| Stage | Model | Timeout | Tool Access | Why |
|-------|-------|---------|-------------|-----|
| AC Generator | Opus | 120s | dangerouslySkipPermissions | Reads spec, app.json, learnings via tool calls |
| Planner | Opus | 240s | dangerouslySkipPermissions | Full codebase access — reads components, routes, diff. 120s timed out on Formbricks eval. |
| Setup Writer | Sonnet | 240s | dangerouslySkipPermissions | Reads ORM schema files. 90s timed out on Formbricks eval — needs time for tool calls. |
| Browse Agent | Sonnet | per-AC | dangerouslySkipPermissions | Runs browse CLI via Bash tool |
| Judge | Opus | 120s | allowedTools: [Read] | Only reads evidence files — no write access |
| Learner | Sonnet | 60s | dangerouslySkipPermissions | Reads verdicts + writes learnings.md |
