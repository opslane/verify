// pipeline/src/cli.ts — CLI entry point for running pipeline stages
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { loadConfig } from "./lib/config.js";
import { runClaude } from "./run-claude.js";
import { STAGE_PERMISSIONS } from "./lib/types.js";
import { resolveExampleUrls, psqlQuery } from "./lib/route-resolver.js";
import type { RouteResolverContext } from "./lib/route-resolver.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "verify-dir": { type: "string", default: ".verify" },
    "run-dir": { type: "string" },
    "project-dir": { type: "string" },
    output: { type: "string" },
    spec: { type: "string" },
    group: { type: "string" },
    condition: { type: "string" },
    ac: { type: "string" },
    timeout: { type: "string" },
    "base-url": { type: "string" },
    email: { type: "string" },
    password: { type: "string" },
    "browse-bin": { type: "string" },
    legacy: { type: "boolean", default: false },
    case: { type: "string" },
  },
});

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

} else if (command === "index-app") {
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
  const { loadProjectEnv } = await import("./stages/setup-writer.js");
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

  // Step 3.5: Route resolver — map parameterized routes to concrete URLs deterministically
  let psqlCmd = "";
  const paramRoutes = Object.keys(appIndex.routes).filter(r => r.includes(":"));
  if (paramRoutes.length > 0) {
    console.log(`  Resolving ${paramRoutes.length} parameterized routes...`);

    // Build psql connection string (reuse projectEnvForDump already computed above)
    const dbUrlEnv = appIndex.db_url_env ?? "DATABASE_URL";
    const dbUrl = (projectEnvForDump[dbUrlEnv] ?? projectEnvForDump.DATABASE_URL ?? "") as string;
    const cleanDbUrl = dbUrl.split("?")[0];
    psqlCmd = cleanDbUrl ? `psql "${cleanDbUrl}"` : "";

    // Resolve auth user context for scoping
    let resolverCtx: RouteResolverContext | null = null;
    if (psqlCmd) {
      const config = loadConfig(join(projectDir, ".verify"));
      if (config.auth?.email) {
        // Postgres single-quote escaping for email
        const escapedEmail = config.auth.email.replace(/'/g, "''");
        const userId = psqlQuery(psqlCmd, `SELECT id FROM "User" WHERE email = '${escapedEmail}' LIMIT 1`);

        if (userId) {
          const teamRow = psqlQuery(psqlCmd,
            `SELECT t.id || '|' || t.url FROM "Team" t JOIN "Organisation" o ON o.id = t."organisationId" JOIN "OrganisationMember" om ON om."organisationId" = o.id WHERE om."userId" = ${userId} AND t.url LIKE 'personal_%' LIMIT 1`);

          if (teamRow) {
            const [teamId, teamUrl] = teamRow.split("|");
            resolverCtx = { userId, teamId, teamUrl };
          }
        }
      }
    }

    if (resolverCtx) {
      const exampleUrls = resolveExampleUrls(appIndex.routes, appIndex.data_model, psqlCmd, resolverCtx);
      appIndex.example_urls = exampleUrls;
      console.log(`  Resolved ${Object.keys(exampleUrls).length}/${paramRoutes.length} example URLs (deterministic)`);
    } else {
      console.log("  Warning: could not resolve auth user context — skipping route resolution");
    }
  }

  // Ensure psqlCmd is available for entity graph discovery
  if (!psqlCmd) {
    const dbUrlEnv = appIndex.db_url_env ?? "DATABASE_URL";
    const dbUrl = (projectEnvForDump[dbUrlEnv] ?? projectEnvForDump.DATABASE_URL ?? "") as string;
    const cleanDbUrl = dbUrl.split("?")[0];
    psqlCmd = cleanDbUrl ? `psql "${cleanDbUrl}"` : "";
  }

  // Step 4: Entity graph discovery — walk FK relationships for setup-writer
  if (psqlCmd) {
    console.log("  Discovering entity graphs...");
    const { buildEntityGraphs } = await import("./lib/entity-graph.js");
    const entityGraphs = buildEntityGraphs(psqlCmd, appIndex.data_model);
    appIndex.entity_graphs = entityGraphs;
    const rootTables = Object.keys(entityGraphs);
    console.log(`  Entity graphs: ${rootTables.length} root tables`);
  }

  writeFileSync(outputPath, JSON.stringify(appIndex, null, 2));
  console.log(`\nApp index written to: ${outputPath}`);
  console.log(`  Routes: ${Object.keys(appIndex.routes).length}`);
  console.log(`  Pages: ${Object.keys(appIndex.pages).length}`);
  console.log(`  Models: ${Object.keys(appIndex.data_model).length}`);
  console.log(`  Seed IDs: ${Object.values(appIndex.seed_ids).flat().length}`);
  console.log(`  DB URL env: ${appIndex.db_url_env ?? "(not found)"}`);

} else if (command === "eval-setup") {
  // Setup-writer eval: runs realistic A/B comparison (CLI vs SDK) through actual code path
  const projectDir = values["project-dir"];
  if (!projectDir) { console.error("--project-dir required"); process.exit(1); }

  const { loadProjectEnv } = await import("./stages/setup-writer.js");
  const projectEnv = loadProjectEnv(projectDir);
  const dbUrlEnv = "DATABASE_URL";
  const dbUrl = projectEnv[dbUrlEnv] ?? projectEnv.NEXT_PRIVATE_DATABASE_URL ?? "";
  if (!dbUrl) { console.error(`No DATABASE_URL or NEXT_PRIVATE_DATABASE_URL found in ${projectDir}/.env`); process.exit(1); }

  // Set EVAL_DB_URL for the eval runner
  process.env.EVAL_DB_URL = dbUrl;
  process.env.EVAL_PROJECT_DIR = projectDir;

  const { main: runEval } = await import("./evals/setup-writer/realistic-eval.js");
  await runEval();

} else if (command === "eval-judge") {
  const { runJudgeEvals, discoverCaseDirs, formatJudgeEvalSummary } = await import("./evals/run-judge-evals.js");
  const caseFilter = values["case"] as string | undefined;
  const caseDirs = discoverCaseDirs();
  if (caseDirs.length === 0) { console.error("No judge eval cases found"); process.exit(1); }

  const results = await runJudgeEvals(caseDirs, caseFilter);
  for (const result of results) {
    if (result.passed) {
      console.log(`PASS ${result.caseId}  ${(result.durationMs / 1000).toFixed(1)}s  accuracy=${(result.verdictAccuracy * 100).toFixed(0)}%`);
      continue;
    }
    console.log(`FAIL ${result.caseId}  ${result.failures.join("; ")}`);
  }
  console.log(formatJudgeEvalSummary(results));

  const failCount = results.filter(r => !r.passed).length;
  process.exit(failCount > 0 ? 1 : 0);

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
      const prompt = buildACGeneratorPrompt(specPath);
      const result = await runClaude({ prompt, model: "opus", timeoutMs: 120_000, stage: "ac-generator", runDir, settingSources: "", ...permissions });
      const acs = parseACGeneratorOutput(result.stdout);
      if (!acs) { console.error("Failed to parse AC output. Check logs:", join(runDir, "logs")); process.exit(1); }
      const fanned = fanOutPureUIGroups(acs);
      writeFileSync(join(runDir, "acs.json"), JSON.stringify(fanned, null, 2));
      console.log(`Generated ${fanned.groups.length} groups, ${fanned.skipped.length} skipped`);
      break;
    }
    case "planner": {
      const { buildPlannerPrompt, parsePlannerOutput } = await import("./stages/planner.js");
      const acsPath = join(runDir, "acs.json");
      const prompt = buildPlannerPrompt(acsPath);
      const result = await runClaude({ prompt, model: "opus", timeoutMs: timeoutOverrideMs ?? 240_000, stage: "planner", runDir, settingSources: "", ...permissions });
      const plan = parsePlannerOutput(result.stdout);
      if (!plan) { console.error("Failed to parse plan output. Check logs:", join(runDir, "logs")); process.exit(1); }
      writeFileSync(join(runDir, "plan.json"), JSON.stringify(plan, null, 2));
      console.log(`Planned ${plan.criteria.length} ACs`);
      break;
    }
    case "plan-validator": {
      const { validatePlan } = await import("./stages/plan-validator.js");
      const { loadAppIndex } = await import("./lib/app-index.js");
      const plan = JSON.parse(readFileSync(join(runDir, "plan.json"), "utf-8"));
      const appIndex = loadAppIndex(verifyDir);
      const result = validatePlan(plan, appIndex);
      if (result.valid) {
        console.log("Plan is valid");
      } else {
        console.error("Plan has errors:");
        for (const err of result.errors) console.error(`  - ${err.acId}: ${err.message}`);
        process.exit(1);
      }
      break;
    }
    case "setup-writer": {
      const groupId = values.group ?? "default";
      const condition = values.condition ?? "";

      if (values.legacy) {
        // Old monolithic path only
        const { buildSetupWriterPrompt, parseSetupWriterOutput } = await import("./stages/setup-writer.js");
        const prompt = buildSetupWriterPrompt(groupId, condition, projectRoot, config.auth?.email);
        const result = await runClaude({ prompt, model: "sonnet", timeoutMs: 90_000, stage: stageName, runDir, ...permissions });
        const parsed = parseSetupWriterOutput(result.stdout);
        if (parsed) {
          console.log(`Setup writer (legacy): ${parsed.setup_commands.length} setup commands`);
          writeFileSync(join(runDir, "setup.json"), JSON.stringify(parsed, null, 2));
        } else {
          console.error("Failed to parse setup writer output");
          process.exitCode = 1;
        }
      } else {
        // Graph-informed + fallback via shared function (review fix #7)
        const { runSetupWriter } = await import("./stages/run-setup-writer.js");
        const { loadAppIndex } = await import("./lib/app-index.js");
        const appIndex = loadAppIndex(join(projectRoot, ".verify"));
        if (!appIndex) {
          console.error("No app.json found — run index-app first");
          process.exitCode = 1;
          break;
        }
        const { loadProjectEnv } = await import("./stages/setup-writer.js");
        const projectEnv = loadProjectEnv(projectRoot);
        const setupResult = await runSetupWriter({
          groupId, condition, appIndex, projectEnv, projectRoot,
          authEmail: config.auth?.email, retryContext: null,
          runDir, stageName, runClaudeFn: runClaude,
          permissions, timeoutMs: 90_000,
        });
        if (setupResult) {
          console.log(`Setup writer: ${setupResult.commands.setup_commands.length} setup commands${setupResult.sqlExecuted ? " (SDK — already executed)" : ""}`);
          writeFileSync(join(runDir, "setup.json"), JSON.stringify(setupResult.commands, null, 2));
        } else {
          console.error("Failed to produce setup commands");
          process.exitCode = 1;
        }
      }
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
    case "judge": {
      const { collectEvidencePaths, buildJudgePrompt, parseJudgeOutput } = await import("./stages/judge.js");
      const evidenceRefs = collectEvidencePaths(runDir);
      if (evidenceRefs.length === 0) {
        console.log('{"verdicts":[]}');
        break;
      }
      const prompt = buildJudgePrompt(evidenceRefs);
      const result = await runClaude({ prompt, model: "opus", timeoutMs: 120_000, stage: "judge", runDir, settingSources: "", ...permissions });
      const verdicts = parseJudgeOutput(result.stdout);
      if (verdicts) {
        writeFileSync(join(runDir, "verdicts.json"), JSON.stringify(verdicts, null, 2));
        console.log(JSON.stringify(verdicts, null, 2));
      } else {
        console.error("Judge failed to produce valid output. Check logs:", join(runDir, "logs"));
        process.exit(1);
      }
      break;
    }
    case "learner": {
      const { buildLearnerPrompt, backupAndRestore } = await import("./stages/learner.js");
      const learningsPath = join(verifyDir, "learnings.md");
      const { restore } = backupAndRestore(learningsPath);
      const prompt = buildLearnerPrompt({
        verdictsPath: join(runDir, "verdicts.json"),
        timelinePath: join(runDir, "logs", "timeline.jsonl"),
        learningsPath,
      });
      await runClaude({ prompt, model: "sonnet", timeoutMs: 60_000, stage: "learner", runDir, settingSources: "", ...permissions });
      restore();
      console.log("Learner complete. Learnings at:", learningsPath);
      break;
    }
    case "login-agent": {
      const baseUrl = values["base-url"];
      const email = values.email;
      const password = values.password;
      const browseBin = values["browse-bin"];
      if (!baseUrl || !email || !password || !browseBin) {
        console.error("login-agent requires --base-url, --email, --password, --browse-bin");
        process.exit(1);
      }
      const { buildLoginAgentPrompt, parseLoginAgentOutput } = await import("./stages/login-agent.js");
      const prompt = buildLoginAgentPrompt({ baseUrl, email, password, browseBin });
      const result = await runClaude({
        prompt, model: "sonnet", timeoutMs: 60_000,
        stage: "login-agent", runDir, settingSources: "", ...permissions,
      });
      const parsed = parseLoginAgentOutput(result.stdout);
      if (!parsed) {
        console.error("Failed to parse login agent output. Check logs:", join(runDir, "logs"));
        process.exit(1);
      }
      if (!parsed.success) {
        console.error(`Login agent failed: ${parsed.error}`);
        process.exit(1);
      }
      // Save discovered loginSteps to config.json
      const updatedConfig = loadConfig(verifyDir);
      updatedConfig.auth = {
        email,
        password,
        loginSteps: parsed.loginSteps,
      };
      writeFileSync(join(verifyDir, "config.json"), JSON.stringify(updatedConfig, null, 2));
      console.log(`Login recipe saved: ${parsed.loginSteps.length} steps`);
      break;
    }
    case "verify-login": {
      const { loginWithCredentials } = await import("./init.js");
      if (!config.auth?.loginSteps?.length) {
        console.error("No auth config — run /verify-setup to configure login");
        process.exit(1);
      }
      // No startDaemon needed — the first goto in login steps starts the daemon implicitly.
      // Calling startDaemon/healthCheck/goto about:blank before login breaks cookie persistence.
      const loginResult = loginWithCredentials(config);
      if (loginResult.ok) {
        console.log("Login recipe verified — authentication succeeded.");
      } else {
        console.error(loginResult.error);
        process.exit(1);
      }
      break;
    }
    default:
      console.error(`Unknown stage: ${stageName}. Available: ac-generator, planner, plan-validator, setup-writer, browse-agent, judge, learner, login-agent, verify-login`);
      process.exit(1);
  }
} else if (command === "eval-planner") {
  const runDir = values["run-dir"];
  const args = ["tsx", "src/evals/planner-eval.ts"];
  if (runDir) args.push("--run-dir", runDir);
  const { execFileSync } = await import("node:child_process");
  execFileSync("npx", args, { stdio: "inherit", cwd: process.cwd() });

} else {
  console.error("Usage:");
  console.error("  npx tsx src/cli.ts run --spec <path> [--verify-dir .verify]");
  console.error("  npx tsx src/cli.ts index-app [--project-dir .] [--output .verify/app.json]");
  console.error("  npx tsx src/cli.ts run-stage <stage> --verify-dir .verify --run-dir /tmp/run [options]");
  console.error("  npx tsx src/cli.ts eval-planner [--run-dir <path>]");
  console.error("");
  console.error("Commands:");
  console.error("  run            Full pipeline run (orchestrator)");
  console.error("  index-app      Build app.json index (routes, selectors, schema, seed IDs)");
  console.error("  run-stage      Run a single stage for debugging");
  console.error("  eval-planner   Score planner output against baseline");
  console.error("");
  console.error("Eval:");
  console.error("  eval-setup     --project-dir <path>  [EVAL_CASES_SET=calcom]");
  console.error("  eval-judge     [--case <caseId>]  Run judge eval cases");
  console.error("");
  console.error("Stages:");
  console.error("  ac-generator   --spec <path>");
  console.error("  planner");
  console.error("  plan-validator");
  console.error("  setup-writer   --group <id> [--condition <text>]");
  console.error("  browse-agent   --ac <id>");
  console.error("  judge");
  console.error("  learner");
  console.error("  login-agent    --base-url <url> --email <e> --password <p> --browse-bin <path>");
  console.error("  verify-login");
  process.exit(1);
}
