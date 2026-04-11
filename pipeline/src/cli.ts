#!/usr/bin/env node
// pipeline/src/cli.ts — CLI entry point for @opslane/verify
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runClaude } from "./run-claude.js";
import { STAGE_PERMISSIONS } from "./lib/types.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "verify-dir": { type: "string", default: ".verify" },
    "project-dir": { type: "string" },
    output: { type: "string" },
    "base-url": { type: "string" },
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

const [command] = positionals;

if (command === "init") {
  // Zero-input project setup: auto-detect URL, index app
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
    ".verify/report.json", ".verify/report.html",
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

  // Step 3: Index routes + selectors
  console.log("Indexing app...");
  const { execFileSync } = await import("node:child_process");
  execFileSync(process.execPath, [
    ...process.execArgv,
    fileURLToPath(import.meta.url),
    "index-app",
    "--project-dir", projectDir,
  ], { stdio: "inherit" });

  console.log("\n✓ Setup complete. Run `/verify` in Claude Code to verify.");

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

} else {
  console.error("Usage:");
  console.error("  verify init [--project-dir .] [--base-url <url>]");
  console.error("  verify index [--project-dir .] [--output .verify/app.json]");
  console.error("");
  console.error("Commands:");
  console.error("  init           Zero-input project setup (auto-detects URL, indexes app)");
  console.error("  index          Build app.json index (routes, selectors)");
  console.error("  index-app      Alias for index");
  process.exit(1);
}
