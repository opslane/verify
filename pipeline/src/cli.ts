#!/usr/bin/env node
// pipeline/src/cli.ts — CLI entry point for @opslane/verify
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./lib/config.js";
import { runClaude } from "./run-claude.js";
import { STAGE_PERMISSIONS } from "./lib/types.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "verify-dir": { type: "string", default: ".verify" },
    "run-dir": { type: "string" },
    "project-dir": { type: "string" },
    output: { type: "string" },
    spec: { type: "string" },
    ac: { type: "string" },
    timeout: { type: "string" },
    "base-url": { type: "string" },
    "browse-bin": { type: "string" },
    version: { type: "boolean", short: "v", default: false },
  },
});

// --version flag
if (values.version) {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
  console.log(pkg.version);
  process.exit(0);
}

const [command, stageName] = positionals;

if (command === "run") {
  // Full pipeline run via orchestrator
  const { runPipeline } = await import("./orchestrator.js");
  const verifyDir = values["verify-dir"]!;
  const config = loadConfig(verifyDir);
  const specPath = values.spec ?? config.specPath;
  if (!specPath) { console.error("No --spec provided and no specPath in config"); process.exit(1); }

  const result = await runPipeline(specPath, verifyDir, {
    onACCheckpoint: async (acs) => {
      // In CLI mode, auto-approve ACs (no interactive prompt)
      console.log(`Generated ${acs.groups.length} groups, ${acs.skipped.length} skipped`);
      return acs;
    },
    onLog: (msg) => console.log(msg),
    onError: (msg) => console.error(msg),
    onProgress: (evt) => {
      process.stdout.write(`\r  ${evt.acId}: ${evt.status}${evt.detail ? ` — ${evt.detail}` : ""}   `);
    },
    onStageProgress: (evt) => {
      if (evt.event === "tool_call") {
        process.stdout.write(`\r  ${evt.stage}: ${evt.detail ?? ""}   `);
      }
    },
  });

  if (!result.verdicts) {
    console.error("Pipeline failed. Check logs in:", result.runDir);
    process.exit(1);
  }

  const verdicts = result.verdicts.verdicts;
  const passCount = verdicts.filter(v => v.verdict === "pass").length;
  const specUnclearCount = verdicts.filter(v => v.verdict === "spec_unclear").length;
  const failCount = verdicts.length - passCount - specUnclearCount;

  if (failCount > 0) {
    process.exit(1);     // real failures
  } else if (specUnclearCount > 0) {
    process.exit(2);     // needs human review, but code may be correct
  } else {
    process.exit(0);     // all pass
  }

} else if (command === "init") {
  // Zero-input project setup: auto-detect URL, import cookies, index app
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
    ".verify/config.json", ".verify/auth.json", ".verify/app.json",
    ".verify/seed-data.txt", ".verify/runs/", ".verify/evidence/",
    ".verify/prompts/", ".verify/report.json", ".verify/browse.json",
    ".verify/report.html", ".verify/progress.jsonl",
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
        const jsonStr = result.stdout.match(/\{[\s\S]*?\}/)?.[0];
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

  // Step 3: Ensure browse binary is available (downloads on first run)
  const { ensureBrowseBin } = await import("./lib/browse.js");
  try {
    await ensureBrowseBin();
    console.log("✓ Browse binary ready");
  } catch (err: unknown) {
    console.error(`✗ Failed to install browse binary: ${err instanceof Error ? err.message : String(err)}`);
    console.error("  Set BROWSE_BIN env var to use a custom binary.");
    process.exit(1);
  }

  // Step 4: Import cookies
  console.log("Importing browser cookies...");
  const { importCookiesToDaemon } = await import("./init.js");
  // Purpose: (a) validate Chrome cookies are available, (b) export to auth.json for Playwright MCP
  // Note: The orchestrator re-imports to per-run daemons; init's daemon state is not reused.
  const cookieResult = importCookiesToDaemon(baseUrl, {}, { interactive: true });
  if (!cookieResult.ok) {
    console.error(`✗ ${cookieResult.error}`);
    process.exit(1);
  }
  console.log("✓ Cookies imported from browser");

  // Step 5: Validate auth works (warning only — app may be public)
  const { validateCookieAuth, exportAuthState } = await import("./init.js");
  const authResult = validateCookieAuth(baseUrl);
  if (authResult.ok) {
    console.log("✓ Auth validated — cookies grant access");
  } else {
    console.warn(`⚠ ${authResult.error}`);
    console.warn("  Continuing — some verification may fail due to auth.");
  }

  // Step 6: Export cookies to .verify/auth.json for Playwright MCP
  const authJsonPath = join(verifyDir, "auth.json");
  const exportResult = exportAuthState(authJsonPath);
  if (exportResult.ok) {
    console.log(`✓ Auth state exported to ${authJsonPath}`);
  } else {
    console.warn(`⚠ ${exportResult.error}`);
  }

  // Step 7: Index routes + selectors
  console.log("Indexing app...");
  const { execFileSync } = await import("node:child_process");
  execFileSync(process.execPath, [
    ...process.execArgv,
    fileURLToPath(import.meta.url),
    "index-app",
    "--project-dir", projectDir,
  ], { stdio: "inherit" });

  console.log("\n✓ Setup complete. Run `npx @opslane/verify run --spec <spec.md>` to verify.");

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
        .replace(/OUTPUT_FILE/g, agent.outputFile);

      try {
        await runClaude({
          prompt: promptText,
          model: "sonnet",
          timeoutMs: 300_000,
          stage: `index-${agent.name}`,
          runDir,
          cwd: projectDir,
          ...STAGE_PERMISSIONS["index-agent"],
        });
        return JSON.parse(readFileSync(agent.outputFile, "utf-8")) as Record<string, unknown>;
      } catch {
        console.warn(`  Warning: ${agent.name} agent failed, using empty result`);
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
  console.log(`App index: ${routeCount} routes, ${pageCount} pages → ${outputPath}`);

} else if (command === "run-stage" && stageName) {
  const verifyDir = values["verify-dir"]!;
  const runDir = values["run-dir"] ?? join(verifyDir, "runs", `manual-${Date.now()}`);
  mkdirSync(join(runDir, "logs"), { recursive: true });

  // Derive project root from verify-dir (.verify is always a direct child of project root)
  const projectRoot = resolve(verifyDir, "..");

  // Parse --timeout with validation
  let timeoutOverrideMs: number | undefined;
  if (values.timeout) {
    const t = parseInt(values.timeout, 10);
    if (isNaN(t) || t <= 0) { console.error("--timeout must be a positive integer (seconds)"); process.exit(1); }
    timeoutOverrideMs = t * 1000;
  }

  const config = loadConfig(verifyDir);
  const permissions = { ...STAGE_PERMISSIONS[stageName] ?? {}, cwd: projectRoot };

  switch (stageName) {
    case "ac-generator": {
      const { buildACGeneratorPrompt, parseACGeneratorOutput, fanOutPureUIGroups } = await import("./stages/ac-generator.js");
      const specPath = values.spec ?? config.specPath;
      if (!specPath) { console.error("No --spec provided and no specPath in config"); process.exit(1); }
      const prompt = buildACGeneratorPrompt(specPath, verifyDir);
      const result = await runClaude({ prompt, model: "opus", timeoutMs: 90_000, stage: "ac-generator", runDir, cwd: projectRoot });
      const acs = parseACGeneratorOutput(result.stdout);
      if (!acs) { console.error("Failed to parse AC output. Check logs:", join(runDir, "logs")); process.exit(1); }
      const fanned = fanOutPureUIGroups(acs);
      writeFileSync(join(runDir, "acs.json"), JSON.stringify(fanned, null, 2));
      console.log(`Generated ${fanned.groups.length} groups, ${fanned.skipped.length} skipped`);
      break;
    }
    default:
      console.error(`Unknown stage: ${stageName}. Available: ac-generator`);
      process.exit(1);
  }
} else {
  console.error("Usage:");
  console.error("  verify run --spec <path> [--verify-dir .verify]");
  console.error("  verify init [--project-dir .] [--base-url <url>]");
  console.error("  verify index [--project-dir .] [--output .verify/app.json]");
  console.error("  verify run-stage <stage> --verify-dir .verify --run-dir /tmp/run [options]");
  console.error("");
  console.error("Commands:");
  console.error("  run            Full pipeline run (orchestrator)");
  console.error("  init           Zero-input project setup (auto-detects URL, imports cookies, indexes app)");
  console.error("  index          Build app.json index (routes, selectors)");
  console.error("  index-app      Alias for index");
  console.error("  run-stage      Run a single stage for debugging");
  console.error("");
  console.error("Stages:");
  console.error("  ac-generator   --spec <path>");
  process.exit(1);
}
