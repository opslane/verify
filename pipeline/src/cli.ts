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
  const config = (await import("./lib/config.js")).loadConfig(verifyDir);
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

} else if (command === "index-app" || command === "index") {
  const projectDir = values["project-dir"] ?? process.cwd();
  const outputPath = values.output ?? join(projectDir, ".verify", "app.json");
  const runDir = join(projectDir, ".verify", "runs", `index-${Date.now()}`);
  mkdirSync(join(runDir, "logs"), { recursive: true });
  mkdirSync(dirname(outputPath), { recursive: true });

  const { extractEnvVars, findPrismaSchemaPath, findSeedFiles, mergeIndexResults, dumpDatabaseSchema, dumpSeedData } = await import("./lib/index-app.js");
  const { parsePrismaSchema, extractJsonFieldAnnotations } = await import("./lib/prisma-parser.js");
  const { groupSeedIdsByContext } = await import("./lib/seed-extractor.js");
  const { readFileSync: readFs } = await import("node:fs");
  const { readFileSync: readPrompt } = await import("node:fs");

  // Step 1: Deterministic parsing (no LLM needed)
  console.log("Indexing app...");

  // Parse Prisma schema for column mappings
  let prismaMapping: ReturnType<typeof parsePrismaSchema> = {};
  const schemaPath = findPrismaSchemaPath(projectDir);
  if (schemaPath) {
    console.log(`  Found Prisma schema: ${schemaPath}`);
    prismaMapping = parsePrismaSchema(readFs(schemaPath, "utf-8"));
    console.log(`  Parsed ${Object.keys(prismaMapping).length} models with column mappings`);
  }

  // Extract JSONB type annotations from Prisma schema (Prisma-specific)
  let jsonAnnotations: Record<string, Record<string, string>> = {};
  if (schemaPath) {
    jsonAnnotations = extractJsonFieldAnnotations(readFs(schemaPath, "utf-8"));
    const annotatedFields = Object.values(jsonAnnotations).reduce((n, m) => n + Object.keys(m).length, 0);
    if (annotatedFields > 0) {
      console.log(`  Found ${annotatedFields} JSONB type annotations`);
    }
  }

  // Extract seed IDs
  let seedIds: Record<string, string[]> = {};
  const seedFiles = findSeedFiles(projectDir);
  if (seedFiles.length > 0) {
    console.log(`  Found ${seedFiles.length} seed file(s)`);
    const allContent = seedFiles.map(f => readFs(f, "utf-8")).join("\n");
    seedIds = groupSeedIdsByContext(allContent);
    const totalIds = Object.values(seedIds).flat().length;
    console.log(`  Extracted ${totalIds} seed IDs across ${Object.keys(seedIds).length} models`);
  }

  // Extract env vars
  const envVars = extractEnvVars(projectDir);

  // Dump database schema (generic — works for any Postgres project)
  const { loadProjectEnv } = await import("./lib/env.js");
  const projectEnvForDump = loadProjectEnv(projectDir);
  const schemaDdl = dumpDatabaseSchema(projectEnvForDump, envVars.db_url_env);
  if (schemaDdl) {
    writeFileSync(join(dirname(outputPath), "schema.sql"), schemaDdl);
    console.log(`  Dumped database schema: ${Math.round(schemaDdl.length / 1024)}KB`);
  } else {
    console.log("  Warning: could not dump database schema (DATABASE_URL missing or pg_dump failed)");
  }

  // Step 2: LLM-based indexing (4 parallel agents)
  console.log("  Running 4 parallel index agents...");
  const promptDir = join(dirname(new URL(import.meta.url).pathname), "prompts", "index");

  const agentConfigs = [
    { name: "routes", file: "routes.txt", outputFile: join(runDir, "routes.json") },
    { name: "selectors", file: "selectors.txt", outputFile: join(runDir, "selectors.json") },
    { name: "schema", file: "schema.txt", outputFile: join(runDir, "schema.json") },
    { name: "fixtures", file: "fixtures.txt", outputFile: join(runDir, "fixtures.json") },
  ];

  // Build schema hint for the schema agent (avoids wasting time searching)
  const schemaHint = schemaPath
    ? `The schema file is at: ${schemaPath}\nRead that file directly. Do NOT search the codebase for schema files.`
    : "No schema file was pre-detected. Search for Prisma schema, Drizzle schema, SQL migrations, or ORM definitions under packages/, prisma/, db/, src/.";

  const agentResults = await Promise.all(
    agentConfigs.map(async (agent) => {
      const promptTemplate = readPrompt(join(promptDir, agent.file), "utf-8");
      let prompt = promptTemplate.replace(/OUTPUT_FILE/g, agent.outputFile);
      if (agent.name === "schema") {
        prompt = prompt.replace(/SCHEMA_HINT/g, schemaHint);
      }
      try {
        await runClaude({
          prompt,
          model: "sonnet",
          timeoutMs: 300_000,
          stage: `index-${agent.name}`,
          runDir,
          cwd: projectDir,
                   ...STAGE_PERMISSIONS["index-agent"], // needs Read, Grep, Glob
        });
        // Read the output file the agent wrote
        const raw = readFs(agent.outputFile, "utf-8");
        return JSON.parse(raw);
      } catch {
        console.error(`  Warning: ${agent.name} agent failed, using empty result`);
        const key = agent.name === "routes" ? "routes"
          : agent.name === "selectors" ? "pages"
          : agent.name === "schema" ? "data_model"
          : "fixtures";
        return { [key]: {} };
      }
    })
  );

  const [routesResult, selectorsResult, schemaResult, fixturesResult] = agentResults;

  // Step 3: Merge all results
  const appIndex = mergeIndexResults(
    routesResult,
    selectorsResult,
    schemaResult,
    fixturesResult,
    envVars,
    prismaMapping,
    seedIds,
    jsonAnnotations,
  );

  // Dump seed data — sample actual rows from all data_model tables
  const seedDataDump = dumpSeedData(appIndex.data_model, projectEnvForDump, appIndex.db_url_env);
  if (seedDataDump) {
    writeFileSync(join(dirname(outputPath), "seed-data.txt"), seedDataDump);
    console.log(`  Dumped seed data: ${Math.round(seedDataDump.length / 1024)}KB`);
  } else {
    console.log("  Warning: could not dump seed data (no tables or DB unreachable)");
  }

  writeFileSync(outputPath, JSON.stringify(appIndex, null, 2));
  console.log(`\nApp index written to: ${outputPath}`);
  console.log(`  Routes: ${Object.keys(appIndex.routes).length}`);
  console.log(`  Pages: ${Object.keys(appIndex.pages).length}`);
  console.log(`  Models: ${Object.keys(appIndex.data_model).length}`);
  console.log(`  Seed IDs: ${Object.values(appIndex.seed_ids).flat().length}`);
  console.log(`  DB URL env: ${appIndex.db_url_env ?? "(not found)"}`);

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
    case "browse-agent": {
      const acId = values.ac;
      if (!acId) { console.error("--ac is required for browse-agent"); process.exit(1); }
      const planPath = join(runDir, "plan.json");
      const plan = JSON.parse(readFileSync(planPath, "utf-8")) as { criteria: Array<{ id: string; group: string; description: string; url: string; steps: string[]; screenshot_at: string[]; timeout_seconds?: number }> };
      const ac = plan.criteria.find(c => c.id === acId);
      if (!ac) { console.error(`AC ${acId} not found in plan.json`); process.exit(1); }
      const typedAc = { ...ac, timeout_seconds: ac.timeout_seconds ?? 120 };
      const { resolveBrowseBin } = await import("./lib/browse.js");
      const { buildBrowseAgentPrompt, parseBrowseResult } = await import("./stages/browse-agent.js");
      const evidenceDir = join(runDir, "evidence", acId);
      mkdirSync(evidenceDir, { recursive: true });
      const prompt = buildBrowseAgentPrompt(typedAc, {
        baseUrl: config.baseUrl,
        browseBin: resolveBrowseBin(),
        evidenceDir,
      });
      const browseTimeoutMs = timeoutOverrideMs
        ?? (typeof ac.timeout_seconds === "number" ? ac.timeout_seconds * 1000 : 90_000);
      const result = await runClaude({ prompt, model: "sonnet", timeoutMs: browseTimeoutMs, stage: `browse-agent-${acId}`, runDir, settingSources: "", ...permissions });
      const parsed = parseBrowseResult(result.stdout);
      if (parsed) {
        writeFileSync(join(evidenceDir, "result.json"), JSON.stringify(parsed, null, 2));
        console.log(`Browse agent ${acId}: ${parsed.observed.slice(0, 80)}`);
      } else {
        console.error(`Failed to parse browse agent output for ${acId}. Check logs:`, join(runDir, "logs"));
        process.exit(1);
      }
      break;
    }
    default:
      console.error(`Unknown stage: ${stageName}. Available: ac-generator, browse-agent`);
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
  console.error("  browse-agent   --ac <id>");
  process.exit(1);
}
