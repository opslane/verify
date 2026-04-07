# Zero-Input Init Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current multi-flag `init` command with a zero-input flow that auto-detects base URL, imports cookies from the user's browser, and indexes routes + selectors only.

**Architecture:** Remove credential-based auth (email/password/loginSteps) from config and pipeline. Replace with cookie-based auth via `browse cookie-import-browser`. Trim `index-app` to routes + selectors only (drop schema, fixtures, seed IDs, entity graphs). Add layered port detection (deterministic first, LLM fallback).

**Tech Stack:** TypeScript, Node 22 ESM, gstack browse binary, `claude -p` for LLM agents

**Design doc:** `docs/plans/2026-04-06-zero-input-init-design.md`

---

### Task 1: Layered port detection + rewrite init command

Replaces the old `init` that required `--email`, `--password`, `--login-steps` with a zero-input flow.

**Files:**
- Modify: `pipeline/src/cli.ts` — rewrite `init` handler (lines 86-148), remove `email`/`password`/`login-steps` CLI flags, update usage text (lines 414-433)
- Create: `pipeline/src/lib/detect-port.ts` — deterministic port detection
- Create: `pipeline/src/prompts/index/base-url.txt` — LLM fallback prompt
- Create: `pipeline/src/lib/__tests__/detect-port.test.ts`

**Step 1: Write failing tests for deterministic port detection**

```typescript
// pipeline/src/lib/__tests__/detect-port.test.ts
import { describe, it, expect } from "vitest";
import { detectPort } from "../detect-port.js";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("detectPort", () => {
  function makeTempProject(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "detect-port-"));
    for (const [name, content] of Object.entries(files)) {
      const path = join(dir, name);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content);
    }
    return dir;
  }

  it("extracts port from next dev -p flag", () => {
    const dir = makeTempProject({
      "package.json": JSON.stringify({ scripts: { dev: "next dev -p 3001" } }),
    });
    expect(detectPort(dir)).toEqual({ port: 3001, source: "package.json scripts.dev" });
  });

  it("extracts port from --port flag", () => {
    const dir = makeTempProject({
      "package.json": JSON.stringify({ scripts: { dev: "vite --port 5173" } }),
    });
    expect(detectPort(dir)).toEqual({ port: 5173, source: "package.json scripts.dev" });
  });

  it("reads PORT from .env", () => {
    const dir = makeTempProject({
      "package.json": JSON.stringify({ scripts: { dev: "node server.js" } }),
      ".env": "PORT=4000\nDATABASE_URL=postgres://...",
    });
    expect(detectPort(dir)).toEqual({ port: 4000, source: ".env" });
  });

  it("returns null when no port found", () => {
    const dir = makeTempProject({
      "package.json": JSON.stringify({ scripts: { dev: "node server.js" } }),
    });
    expect(detectPort(dir)).toBeNull();
  });

  it("prefers dev script over start script", () => {
    const dir = makeTempProject({
      "package.json": JSON.stringify({
        scripts: { dev: "next dev -p 3001", start: "next start -p 3000" },
      }),
    });
    expect(detectPort(dir)).toEqual({ port: 3001, source: "package.json scripts.dev" });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd pipeline && npx vitest run src/lib/__tests__/detect-port.test.ts`
Expected: FAIL — module not found

**Step 3: Implement deterministic port detection**

```typescript
// pipeline/src/lib/detect-port.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

interface PortResult {
  port: number;
  source: string;
}

/**
 * Deterministic port detection from project files.
 * Checks package.json scripts, .env files, and framework configs.
 * Returns null if no port can be determined — caller should fall back to LLM or default.
 */
export function detectPort(projectDir: string): PortResult | null {
  // 1. Check package.json scripts
  const pkgPath = join(projectDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const scripts = pkg.scripts ?? {};
      // Check dev, start, serve in priority order
      for (const key of ["dev", "start", "serve"]) {
        const script = scripts[key];
        if (!script) continue;
        // Match -p <port> or --port <port> or --port=<port>
        const portMatch = script.match(/(?:-p|--port)[=\s]+(\d+)/);
        if (portMatch) {
          return { port: parseInt(portMatch[1], 10), source: `package.json scripts.${key}` };
        }
      }
    } catch { /* malformed package.json */ }
  }

  // 2. Check .env files for PORT=
  for (const envFile of [".env", ".env.local", ".env.development"]) {
    const envPath = join(projectDir, envFile);
    if (!existsSync(envPath)) continue;
    try {
      const content = readFileSync(envPath, "utf-8");
      const portMatch = content.match(/^PORT=(\d+)/m);
      if (portMatch) {
        return { port: parseInt(portMatch[1], 10), source: envFile };
      }
    } catch { /* unreadable */ }
  }

  // 3. Check vite.config for server.port (simple regex — covers most cases)
  for (const configFile of ["vite.config.ts", "vite.config.js", "vite.config.mjs"]) {
    const configPath = join(projectDir, configFile);
    if (!existsSync(configPath)) continue;
    try {
      const content = readFileSync(configPath, "utf-8");
      const portMatch = content.match(/port\s*:\s*(\d+)/);
      if (portMatch) {
        return { port: parseInt(portMatch[1], 10), source: configFile };
      }
    } catch { /* unreadable */ }
  }

  return null;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd pipeline && npx vitest run src/lib/__tests__/detect-port.test.ts`
Expected: PASS

**Step 5: Create the LLM fallback prompt**

Create `pipeline/src/prompts/index/base-url.txt`:

```text
Find the dev server URL for this project. Check:

1. package.json scripts — look for "dev", "start", "serve" commands. Extract port numbers from flags like `-p 3000`, `--port 5173`, or env refs like `PORT`.
2. Framework configs — next.config.js/ts/mjs, vite.config.ts/js, nuxt.config.ts, angular.json. Look for port settings.
3. .env / .env.local / .env.development — look for PORT= or similar.
4. docker-compose.yml — look for port mappings like "3000:3000".

Return ONLY a JSON object to stdout:

{"port": 3000, "source": "package.json scripts.dev"}

If you find multiple ports, pick the one from the "dev" script. If you can't determine the port, return:

{"port": 3000, "source": "default"}
```

**Step 6: Rewrite the init command in cli.ts**

Replace the `init` block (lines 86-148) with:

```typescript
} else if (command === "init") {
  const projectDir = values["project-dir"] ?? process.cwd();
  const verifyDir = values["verify-dir"] === ".verify"
    ? join(projectDir, ".verify")
    : values["verify-dir"]!;

  // Step 1: Scaffold .verify/ and config
  mkdirSync(verifyDir, { recursive: true });
  const configPath = join(verifyDir, "config.json");

  // Update .gitignore
  const gitignorePath = join(projectDir, ".gitignore");
  const patterns = [
    ".verify/config.json", ".verify/evidence/", ".verify/prompts/",
    ".verify/report.json", ".verify/browse.json", ".verify/report.html",
    ".verify/progress.jsonl",
  ];
  let gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
  for (const p of patterns) {
    if (!gitignore.includes(p)) gitignore += `\n${p}`;
  }
  writeFileSync(gitignorePath, gitignore.replace(/^\n+/, ""));
  console.log("✓ .gitignore updated");

  // Step 2: Detect base URL (layered: deterministic → LLM fallback → default)
  let baseUrl = values["base-url"];
  if (!baseUrl) {
    const { detectPort } = await import("./lib/detect-port.js");
    const detected = detectPort(projectDir);

    if (detected) {
      baseUrl = `http://localhost:${detected.port}`;
      console.log(`  Detected: ${baseUrl} (from ${detected.source})`);
    } else {
      // LLM fallback for unusual project structures
      console.log("  No port in package.json or .env — asking LLM agent...");
      const { ensureBrowseBin } = await import("./lib/browse.js");
      await ensureBrowseBin();
      const promptPath = join(dirname(fileURLToPath(import.meta.url)), "prompts", "index", "base-url.txt");
      const prompt = readFileSync(promptPath, "utf-8");
      const detectRunDir = join(verifyDir, "runs", `detect-${Date.now()}`);
      mkdirSync(join(detectRunDir, "logs"), { recursive: true });

      const result = await runClaude({
        prompt,
        model: "haiku",
        timeoutMs: 30_000,
        stage: "detect-base-url",
        runDir: detectRunDir,
        cwd: projectDir,
        dangerouslySkipPermissions: true,
        tools: ["Read", "Glob", "Grep"],
      });

      // Parse JSON from LLM output
      let port = 3000;
      let source = "default";
      try {
        const jsonStr = result.stdout.match(/\{[\s\S]*\}/)?.[0];
        if (jsonStr) {
          const parsed = JSON.parse(jsonStr) as { port?: number; source?: string };
          port = parsed.port ?? 3000;
          source = parsed.source ?? "llm-agent";
        }
      } catch { /* use defaults */ }
      baseUrl = `http://localhost:${port}`;
      console.log(`  Detected: ${baseUrl} (from ${source})`);
    }
  }

  // Verify dev server is running
  try {
    await fetch(baseUrl, { signal: AbortSignal.timeout(5000) });
    console.log(`✓ Dev server running at ${baseUrl}`);
  } catch {
    console.error(`✗ Dev server not running at ${baseUrl}. Start it and re-run \`npx @opslane/verify init\`.`);
    process.exit(1);
  }

  // Write config
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try { config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>; } catch { /* fresh */ }
  }
  config.baseUrl = baseUrl;
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`✓ Config written: ${configPath}`);

  // Step 3: Import cookies
  console.log("Importing browser cookies...");
  const { importCookiesToDaemon } = await import("./init.js");
  const cookieResult = importCookiesToDaemon(baseUrl);
  if (!cookieResult.ok) {
    console.error(`✗ ${cookieResult.error}`);
    process.exit(1);
  }
  console.log("✓ Cookies imported from browser");

  // Step 4: Index routes + selectors
  console.log("Indexing app...");
  const { execFileSync } = await import("node:child_process");
  execFileSync(process.execPath, [
    ...process.execArgv,
    fileURLToPath(import.meta.url),
    "index-app",
    "--project-dir", projectDir,
  ], { stdio: "inherit" });

  console.log("\n✓ Setup complete. Run `npx @opslane/verify run --spec <spec.md>` to verify.");
```

**Step 7: Remove dead CLI flags and update usage text**

In the `parseArgs` options at the top of `cli.ts`, remove `email`, `password`, and `"login-steps"`.

Update the usage text (lines 414-433) to:

```typescript
} else {
  console.error("Usage:");
  console.error("  verify run --spec <path> [--verify-dir .verify]");
  console.error("  verify init [--base-url <url>] [--project-dir .]");
  console.error("  verify index [--project-dir .] [--output .verify/app.json]");
  console.error("  verify run-stage <stage> --verify-dir .verify --run-dir /tmp/run [options]");
  console.error("");
  console.error("Commands:");
  console.error("  run            Full pipeline run (orchestrator)");
  console.error("  init           One-time project setup (auto-detect URL, import cookies, index app)");
  console.error("  index          Build app.json index (routes + selectors)");
  console.error("  index-app      Alias for index");
  console.error("  run-stage      Run a single stage for debugging");
  console.error("");
  console.error("Stages:");
  console.error("  ac-generator   --spec <path>");
  console.error("  browse-agent   --ac <id>");
  process.exit(1);
}
```

**Step 8: Run type checker**

Run: `cd pipeline && npx tsc --noEmit`
Expected: Errors in init.ts and orchestrator.ts (auth references) — fixed in Task 2.

**Step 9: Commit**

```bash
git add pipeline/src/cli.ts pipeline/src/lib/detect-port.ts pipeline/src/lib/__tests__/detect-port.test.ts pipeline/src/prompts/index/base-url.txt
git commit -m "feat: zero-input init with layered port detection and cookie import"
```

---

### Task 2: Replace credential auth with cookie auth (atomic)

One atomic change: remove LoginStep/auth from types, rewrite init.ts, update orchestrator, remove verify-login stage, clean up all dead code. The codebase must compile before and after this commit.

**Files:**
- Modify: `pipeline/src/lib/types.ts` — remove `LoginStep` type and `auth` field from `VerifyConfig`
- Modify: `pipeline/src/init.ts` — remove `loginOnDaemon`, `loginWithCredentials`, `waitForAuth`; add `importCookiesToDaemon`; simplify `runPreflight`
- Modify: `pipeline/src/orchestrator.ts` — use `importCookiesToDaemon` instead of `loginOnDaemon`
- Modify: `pipeline/src/cli.ts` — remove `verify-login` run-stage case (lines 393-408)
- Modify: `pipeline/src/lib/config.ts` — remove any auth-related config handling (if present)
- Delete or modify: `pipeline/src/lib/route-resolver.ts` — remove if no longer imported
- Delete or modify: `pipeline/src/lib/prisma-parser.ts` — remove if no longer imported
- Delete or modify: `pipeline/src/lib/seed-extractor.ts` — remove if no longer imported
- Modify: `pipeline/src/lib/index-app.ts` — remove dead functions (dumpDatabaseSchema, dumpSeedData, findPrismaSchemaPath, findSeedFiles, extractEnvVars)
- Modify: test files — `pipeline/test/init.test.ts`, `pipeline/test/orchestrator.test.ts`, `pipeline/test/config.test.ts`, `pipeline/test/cli.test.ts` — update to remove auth references
- Delete: `pipeline/test/prisma-parser.test.ts`, `pipeline/test/route-resolver.test.ts` — if they only test deleted code

**Step 1: Remove LoginStep and auth from VerifyConfig**

In `pipeline/src/lib/types.ts`, remove:
- The `LoginStep` type (lines 5-9)
- The `auth?` field from `VerifyConfig` (lines 16-20)

New VerifyConfig:

```typescript
export interface VerifyConfig {
  baseUrl: string;
  specPath?: string;
  diffBase?: string;
  maxParallelGroups?: number;
}
```

**Step 2: Rewrite init.ts**

Replace the entire file:

```typescript
// pipeline/src/init.ts — Preflight checks (run before any LLM call)
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { healthCheck, resolveBrowseBin, startDaemon } from "./lib/browse.js";

interface CheckResult {
  ok: boolean;
  error?: string;
}

export async function checkDevServer(baseUrl: string): Promise<CheckResult> {
  try {
    await fetch(baseUrl, { signal: AbortSignal.timeout(5000) });
    return { ok: true };
  } catch {
    return { ok: false, error: `Dev server at ${baseUrl} is not reachable. Is it running?` };
  }
}

export function checkBrowseDaemon(): CheckResult {
  const healthy = healthCheck();
  if (healthy) return { ok: true };
  return { ok: false, error: "Browse daemon is not running." };
}

export function checkSpecFile(specPath: string): CheckResult {
  if (existsSync(specPath)) return { ok: true };
  return { ok: false, error: `Spec file not found: ${specPath}` };
}

/**
 * Import cookies from the user's Chromium browser into a specific browse daemon.
 * Replaces the old loginOnDaemon — no credentials or login steps needed.
 * Uses gstack's browse binary: `browse cookie-import-browser --domain <domain>`
 */
export function importCookiesToDaemon(
  baseUrl: string,
  extraEnv: Record<string, string> = {},
): CheckResult {
  const bin = resolveBrowseBin();
  const domain = new URL(baseUrl).hostname;
  const spawnEnv: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };

  try {
    execFileSync(bin, ["cookie-import-browser", "--domain", domain], {
      timeout: 30_000,
      encoding: "utf-8",
      env: spawnEnv,
    });

    // Verify we're authenticated by navigating and checking for login page
    execFileSync(bin, ["goto", baseUrl], { timeout: 10_000, stdio: "ignore", env: spawnEnv });
    const snapshot = execFileSync(bin, ["snapshot", "-i"], {
      timeout: 5_000,
      encoding: "utf-8",
      env: spawnEnv,
    });

    const isLoginPage =
      /\[textbox\].*password|\[text\].*password/i.test(snapshot) ||
      /\[textbox\]\s*"•+"/i.test(snapshot) ||
      /\[button\]\s*"(Sign [Ii]n|Log [Ii]n)"/i.test(snapshot);

    if (isLoginPage) {
      return {
        ok: false,
        error: `Cookies imported but still on login page. Log into ${baseUrl} in Chrome and re-run init.`,
      };
    }

    return { ok: true };
  } catch (err: unknown) {
    return {
      ok: false,
      error: `Cookie import failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Preflight checks: spec exists + dev server reachable.
 * Does NOT import cookies — that happens per-group in the orchestrator.
 */
export async function runPreflight(
  baseUrl: string,
  specPath: string,
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];

  const spec = checkSpecFile(specPath);
  if (!spec.ok) errors.push(spec.error!);

  const server = await checkDevServer(baseUrl);
  if (!server.ok) errors.push(server.error!);

  return { ok: errors.length === 0, errors };
}
```

Note: `runPreflight` no longer takes `verifyDir` or `config` params. It no longer starts a daemon — the orchestrator handles daemon lifecycle per-group.

**Step 3: Update orchestrator.ts**

Change import:
```typescript
// OLD
import { runPreflight, loginOnDaemon } from "./init.js";
// NEW
import { runPreflight, importCookiesToDaemon } from "./init.js";
```

Change preflight call (line 64):
```typescript
// OLD
const preflight = await runPreflight(config.baseUrl, specPath, verifyDir, config);
// NEW
const preflight = await runPreflight(config.baseUrl, specPath);
```

Change per-group auth (lines 161-166):
```typescript
// OLD
const loginResult = loginOnDaemon(config, daemonEnv);
if (!loginResult.ok) {
  callbacks.onError(`Login failed: ${loginResult.error}`);
  stopGroupDaemon(stateDir);
  return { runDir, verdicts: null };
}
// NEW
const cookieResult = importCookiesToDaemon(config.baseUrl, daemonEnv);
if (!cookieResult.ok) {
  callbacks.onError(`Cookie auth failed: ${cookieResult.error}`);
  stopGroupDaemon(stateDir);
  return { runDir, verdicts: null };
}
```

**Step 4: Remove verify-login run-stage from cli.ts**

Delete the `case "verify-login":` block (lines 393-408). Update the `default:` error message to remove `verify-login` from the available stages list.

**Step 5: Remove dead code**

Grep for all auth-related symbols and delete unreferenced code:

```bash
cd pipeline && rg -l "loginSteps|LoginStep|loginWithCredentials|loginOnDaemon|parsePrismaSchema|groupSeedIdsByContext|findSeedFiles|findPrismaSchemaPath|dumpDatabaseSchema|dumpSeedData|extractJsonFieldAnnotations|resolveExampleUrls|psqlQuery" src/ test/
```

For each file found:
- If the entire file is dead (e.g., `prisma-parser.ts`, `seed-extractor.ts`, `route-resolver.ts`), delete the file AND its corresponding test file
- If only some exports are dead (e.g., functions in `index-app.ts`), remove just those exports
- Update test files (`init.test.ts`, `orchestrator.test.ts`, `config.test.ts`, `cli.test.ts`) to remove auth references

Also remove the `resolveExampleUrls`, `psqlQuery` imports from cli.ts and the `loadConfig` import from init.ts (no longer needed there).

**Step 6: Run type checker + tests**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`
Expected: PASS — no type errors, all tests pass.

**Step 7: Commit**

```bash
git add pipeline/src/lib/types.ts pipeline/src/init.ts pipeline/src/orchestrator.ts pipeline/src/cli.ts pipeline/src/lib/config.ts pipeline/src/lib/index-app.ts pipeline/test/
# Also stage any deleted files
git add pipeline/src/lib/prisma-parser.ts pipeline/src/lib/seed-extractor.ts pipeline/src/lib/route-resolver.ts pipeline/test/prisma-parser.test.ts pipeline/test/route-resolver.test.ts
git commit -m "feat: replace credential auth with cookie-based auth

Remove LoginStep, loginOnDaemon, loginWithCredentials, verify-login stage.
Add importCookiesToDaemon using browse cookie-import-browser.
Delete dead code: prisma-parser, seed-extractor, route-resolver.
Simplify runPreflight to spec + dev-server check only."
```

---

### Task 3: Trim index-app to routes + selectors, update AppIndex type

**Files:**
- Modify: `pipeline/src/cli.ts` — simplify `index-app` command handler (lines 150-329)
- Modify: `pipeline/src/lib/types.ts` — trim `AppIndex` interface to routes + pages only
- Modify: `pipeline/src/lib/index-app.ts` — keep only `mergeIndexResults` if still useful, or remove entirely
- Delete: `pipeline/src/prompts/index/schema.txt`, `pipeline/src/prompts/index/fixtures.txt` — no longer used
- Modify: `pipeline/test/index-app.test.ts` — update for trimmed index

**Step 1: Trim AppIndex interface**

In `pipeline/src/lib/types.ts`, replace the full `AppIndex` interface with:

```typescript
export interface AppIndex {
  indexed_at: string;
  routes: Record<string, { component: string }>;
  pages: Record<string, {
    selectors: Record<string, { value: string; source: string }>;
    source_tests: string[];
  }>;
}
```

**Step 2: Grep for code reading removed AppIndex fields**

```bash
cd pipeline && rg "example_urls|data_model|fixtures|seed_ids|db_url_env|json_type_annotations|entity_graphs|feature_flags" src/
```

For each reference found in source code (not prompts, not tests): update or remove the code that reads these fields. Key places to check:
- `orchestrator.ts` lines 126-131 reads `example_urls` from `app.json` — remove this block; the `appRoutes` variable should just use `routes` directly
- `stages/ac-generator.ts` — if it substitutes `seedData` into the AC prompt, remove that substitution

**Step 3: Simplify the index-app command handler**

Replace the index-app block in cli.ts. Key changes:
- Remove all Prisma parsing, JSONB annotations, seed ID extraction, env var extraction, DB schema dump
- Run only 2 agents (routes + selectors) in parallel
- Use `Object.assign({}, ...results)` for key-based merge instead of positional indexing

```typescript
} else if (command === "index-app" || command === "index") {
  const projectDir = values["project-dir"] ?? process.cwd();
  const outputPath = values.output ?? join(projectDir, ".verify", "app.json");
  const runDir = join(projectDir, ".verify", "runs", `index-${Date.now()}`);
  mkdirSync(join(runDir, "logs"), { recursive: true });
  mkdirSync(dirname(outputPath), { recursive: true });

  console.log("Indexing app...");
  const promptDir = join(dirname(fileURLToPath(import.meta.url)), "prompts", "index");

  const agents = [
    { name: "routes",    prompt: "routes.txt",    outputKey: "routes",    outputFile: join(runDir, "routes.json") },
    { name: "selectors", prompt: "selectors.txt", outputKey: "pages",     outputFile: join(runDir, "selectors.json") },
  ];

  const results = await Promise.all(
    agents.map(async (agent) => {
      const promptText = readFileSync(join(promptDir, agent.prompt), "utf-8")
        .replace("OUTPUT_FILE", agent.outputFile);

      const result = await runClaude({
        prompt: promptText,
        model: "sonnet",
        timeoutMs: 300_000,
        stage: `index-${agent.name}`,
        runDir,
        cwd: projectDir,
        dangerouslySkipPermissions: true,
      });

      if (result.exitCode !== 0) {
        console.warn(`  ⚠ ${agent.name} agent failed (exit ${result.exitCode})`);
        return { [agent.outputKey]: {} };
      }

      try {
        return JSON.parse(readFileSync(agent.outputFile, "utf-8")) as Record<string, unknown>;
      } catch {
        console.warn(`  ⚠ ${agent.name} output not parseable`);
        return { [agent.outputKey]: {} };
      }
    })
  );

  // Key-based merge — order-independent
  const merged = Object.assign({}, ...results) as Record<string, unknown>;
  const appIndex = {
    indexed_at: new Date().toISOString(),
    routes: merged.routes ?? {},
    pages: merged.pages ?? {},
  };

  writeFileSync(outputPath, JSON.stringify(appIndex, null, 2));

  const routeCount = Object.keys(appIndex.routes as Record<string, unknown>).length;
  const pageCount = Object.keys(appIndex.pages as Record<string, unknown>).length;
  console.log(`✓ App index built: ${routeCount} routes, ${pageCount} pages`);
  console.log(`  Written to: ${outputPath}`);
```

**Step 4: Remove unused imports from cli.ts**

Remove `resolveExampleUrls`, `psqlQuery`, `RouteResolverContext` imports if not already removed in Task 2. Remove `loadConfig` import if only the `run` command uses it (check).

**Step 5: Delete unused prompt files and clean up index-app.ts**

```bash
rm pipeline/src/prompts/index/schema.txt
rm pipeline/src/prompts/index/fixtures.txt
rm pipeline/src/prompts/index/route-resolver.txt
```

In `pipeline/src/lib/index-app.ts`, remove all functions that are no longer called (`dumpDatabaseSchema`, `dumpSeedData`, `findPrismaSchemaPath`, `findSeedFiles`, `extractEnvVars`, `mergeIndexResults`). If the file becomes empty, delete it.

**Step 6: Run type checker + tests**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`
Expected: PASS

**Step 7: Commit**

```bash
git add pipeline/src/cli.ts pipeline/src/lib/types.ts pipeline/src/lib/index-app.ts pipeline/test/index-app.test.ts
git add pipeline/src/prompts/index/schema.txt pipeline/src/prompts/index/fixtures.txt pipeline/src/prompts/index/route-resolver.txt
git commit -m "feat: trim index-app to routes + selectors only

Remove schema, fixtures, seed IDs, entity graphs from AppIndex.
Delete schema.txt, fixtures.txt, route-resolver.txt prompts.
Use key-based merge instead of positional array indexing."
```

---

### Task 4: Update docs and skills

**Files:**
- Modify: `skills/verify-setup/SKILL.md`
- Modify: `pipeline/CLAUDE.md`
- Modify: `README.md`

**Step 1: Rewrite verify-setup skill**

```markdown
---
name: verify-setup
description: One-time setup for /verify. Auto-detects dev server, imports browser cookies, and indexes the app.
---

# /verify-setup

Run once before using /verify on a new project.

## Prerequisites

- Dev server running locally (any framework)
- Logged into the app in Chrome/Arc/Brave (your real browser)
- Node.js 22+

## Steps

### 1. Run init

\`\`\`bash
npx @opslane/verify init
\`\`\`

This automatically:
1. Creates `.verify/` directory and updates `.gitignore`
2. Detects your dev server port from `package.json` and framework configs
3. Imports session cookies from your default Chromium browser
4. Indexes your app's routes and selectors

### 2. Verify setup worked

\`\`\`bash
cat .verify/config.json
cat .verify/app.json | head -20
\`\`\`

You should see your `baseUrl` in config and routes in `app.json`.

### 3. Troubleshooting

**"Dev server not running"** — Start your dev server and re-run `npx @opslane/verify init`.

**"No session cookies found"** — Open your app in Chrome, log in, then re-run init.

**Wrong port detected** — Override with: `npx @opslane/verify init --base-url http://localhost:YOUR_PORT`
```

**Step 2: Update pipeline/CLAUDE.md**

Change the init command line to:
```
Init setup: `npx @opslane/verify init` (zero-input — auto-detects URL, imports cookies, indexes app)
```

Change the index description to:
```
Index app: `npx @opslane/verify index --project-dir .` (routes + selectors only)
```

**Step 3: Update README.md**

Search for `--email`, `--password`, `--login-steps`, `verify-login` and update to reflect the new zero-input flow.

**Step 4: Commit**

```bash
git add skills/verify-setup/SKILL.md pipeline/CLAUDE.md README.md
git commit -m "docs: update docs and skills for zero-input init"
```

---

### Task 5: End-to-end verification

This is a verification checklist, not a code task. Run against a real project (e.g., Documenso at `~/Projects/opslane/evals/documenso`).

**Checklist:**

- [ ] `cd ~/Projects/opslane/evals/documenso && rm -rf .verify`
- [ ] Start dev server: `pnpm dev` (runs on :3000)
- [ ] Log into the app in Chrome
- [ ] `npx tsx ~/conductor/workspaces/verify/perth/pipeline/src/cli.ts init --project-dir .`
- [ ] Verify: no interactive prompts (except macOS Keychain)
- [ ] Verify: `.verify/config.json` has correct `baseUrl`
- [ ] Verify: `.verify/app.json` has `routes` and `pages` keys
- [ ] Verify: `.gitignore` updated
- [ ] `npx tsx ~/conductor/workspaces/verify/perth/pipeline/src/cli.ts run --spec .verify/spec.md`
- [ ] Verify: executor authenticates via cookies (no auth failure)
- [ ] Verify: report generated
- [ ] `cd ~/conductor/workspaces/verify/perth/pipeline && npx tsc --noEmit && npx vitest run`
- [ ] All pass, no type errors
