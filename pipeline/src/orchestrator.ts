// pipeline/src/orchestrator.ts — Wires all stages together into a single pipeline run
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ACGeneratorOutput, PlannerOutput, JudgeOutput,
  ACVerdict, ProgressEvent,
} from "./lib/types.js";
import { STAGE_PERMISSIONS, isAuthFailure } from "./lib/types.js";
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
import { buildSetupWriterPrompt, parseSetupWriterOutput, executeSetupCommands, executeTeardownCommands, loadProjectEnv } from "./stages/setup-writer.js";
import { buildBrowseAgentPrompt, parseBrowseResult } from "./stages/browse-agent.js";
import { collectEvidencePaths, buildJudgePrompt, parseJudgeOutput } from "./stages/judge.js";
import { buildLearnerPrompt, backupAndRestore } from "./stages/learner.js";
import { resolveBrowseBin, resetPage } from "./lib/browse.js";
import { findAndRenameVideo } from "./lib/video.js";
import { formatTerminalReport, formatTimingSummary } from "./report.js";

export interface OrchestratorCallbacks {
  /** Called after AC generation — return modified ACs or null to abort */
  onACCheckpoint: (acs: ACGeneratorOutput) => Promise<ACGeneratorOutput | null>;
  onLog: (message: string) => void;
  onError: (message: string) => void;
  onProgress: (event: ProgressEvent) => void;
}

export interface PipelineResult {
  runDir: string;
  verdicts: JudgeOutput | null;
}

export async function runPipeline(
  specPath: string,
  verifyDir: string,
  callbacks: OrchestratorCallbacks,
): Promise<PipelineResult> {
  const config = loadConfig(verifyDir);
  const appIndex = loadAppIndex(verifyDir);
  const projectRoot = resolve(verifyDir, "..");
  const runId = generateRunId(specPath);
  const runDir = join(verifyDir, "runs", runId);
  mkdirSync(join(runDir, "logs"), { recursive: true });

  const progress = new ProgressEmitter(callbacks.onProgress);
  // Note: allVerdicts is mutated from concurrent executeGroup promises.
  // Safe because Node.js is single-threaded and all pushes are synchronous between awaits.
  const allVerdicts: ACVerdict[] = [];

  /** Merge stage permissions with cwd — every runClaude call uses this */
  function perms(stage: string) {
    return { ...STAGE_PERMISSIONS[stage] ?? {}, cwd: projectRoot };
  }

  callbacks.onLog(`Run: ${runId}`);

  // ── Init (preflight) ──────────────────────────────────────────────────
  const preflight = await runPreflight(config.baseUrl, specPath, verifyDir);
  if (!preflight.ok) {
    for (const err of preflight.errors) callbacks.onError(err);
    return { runDir, verdicts: null };
  }

  // ── Stage 1: AC Generator ────────────────────────────────────────────
  callbacks.onLog("Stage 1: Generating acceptance criteria...");
  const acPrompt = buildACGeneratorPrompt(specPath);
  const acResult = await runClaude({
    prompt: acPrompt, model: "opus", timeoutMs: 120_000,
    stage: "ac-generator", runDir, ...perms("ac-generator"),
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

  // ── Stage 2: Planner + Validator ──────────────────────────────────────
  callbacks.onLog("Stage 2: Planning browser steps...");
  const planPrompt = buildPlannerPrompt(join(runDir, "acs.json"));
  const planResult = await runClaude({
    prompt: planPrompt, model: "opus", timeoutMs: 240_000,
    stage: "planner", runDir, ...perms("planner"),
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
      prompt: retryPrompt, model: "opus", timeoutMs: 240_000,
      stage: "planner-retry", runDir, ...perms("planner"),
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

  // ── Stage 3 + 4: Setup + Browse Agents ────────────────────────────────
  callbacks.onLog("Stage 3-4: Executing browser agents...");
  const browseBin = resolveBrowseBin();
  const abortController = new AbortController();
  const projectEnv = loadProjectEnv(projectRoot);

  // Collect seed IDs from app.json to protect from destructive teardown
  const seedIds: string[] = [];
  if (appIndex) {
    // Route URLs contain environment IDs
    for (const route of Object.keys(appIndex.routes)) {
      const match = route.match(/\/environments\/([^/]+)/);
      if (match) seedIds.push(match[1]);
    }
    // Fixture IDs
    for (const [name, fixture] of Object.entries(appIndex.fixtures)) {
      if (fixture.source) seedIds.push(name);
    }
  }
  // Also protect well-known seed prefixes
  seedIds.push("clseed");

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

  const maxParallel = config.maxParallelGroups ?? 5;

  async function executeGroup(groupId: string): Promise<void> {
    const groupAcs = groupMap.get(groupId)!;
    const condition = groupConditions.get(groupId);

    // Setup (if group has a condition requiring data state)
    if (condition) {
      const setupPrompt = buildSetupWriterPrompt(groupId, condition);
      const setupResult = await runClaude({
        prompt: setupPrompt, model: "sonnet", timeoutMs: 240_000,
        stage: `setup-${groupId}`, runDir, ...perms("setup-writer"),
      });
      const commands = parseSetupWriterOutput(setupResult.stdout);
      if (!commands) {
        for (const ac of groupAcs) {
          allVerdicts.push({ ac_id: ac.id, verdict: "setup_failed", confidence: "high", reasoning: "Setup writer failed to produce commands" });
          progress.update(ac.id, "error", "setup_failed");
        }
        return;
      }

      const setupExec = executeSetupCommands(commands.setup_commands, projectEnv, projectRoot);
      if (!setupExec.success) {
        for (const ac of groupAcs) {
          allVerdicts.push({ ac_id: ac.id, verdict: "setup_failed", confidence: "high", reasoning: `Setup failed: ${setupExec.error}` });
          progress.update(ac.id, "error", "setup_failed");
        }
        return;
      }

      // Save teardown commands for later
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
      const evidenceDir = join(runDir, "evidence", ac.id);
      mkdirSync(evidenceDir, { recursive: true });

      const agentPrompt = buildBrowseAgentPrompt(ac, {
        baseUrl: config.baseUrl, browseBin, evidenceDir,
      });
      const agentResult = await runClaude({
        prompt: agentPrompt, model: "sonnet", timeoutMs: ac.timeout_seconds * 1000,
        stage: `browse-agent-${ac.id}`, runDir, ...perms("browse-agent"),
      });

      // Collect video evidence if present
      findAndRenameVideo(evidenceDir);

      if (agentResult.timedOut) {
        allVerdicts.push({ ac_id: ac.id, verdict: "timeout", confidence: "high", reasoning: `Timed out after ${ac.timeout_seconds}s` });
        progress.update(ac.id, "timeout");
        continue;
      }

      const browseResult = parseBrowseResult(agentResult.stdout);
      if (browseResult) {
        writeFileSync(join(evidenceDir, "result.json"), JSON.stringify(browseResult, null, 2));

        // Circuit breaker: auth failure kills all agents
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
      resetPage();
    }

    // Teardown (best effort)
    if (condition) {
      const commandsPath = join(runDir, "setup", groupId, "commands.json");
      if (existsSync(commandsPath)) {
        const commands = JSON.parse(readFileSync(commandsPath, "utf-8"));
        const teardownErrors = executeTeardownCommands(commands.teardown_commands ?? [], projectEnv, projectRoot, seedIds);
        for (const err of teardownErrors) callbacks.onLog(`  ⚠ ${err}`);
      }
    }
  }

  // Run groups with concurrency cap
  const queue = [...groupMap.keys()];
  const active: Promise<void>[] = [];

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

  // ── Stage 5: Judge ────────────────────────────────────────────────────
  const evidenceRefs = collectEvidencePaths(runDir);

  if (evidenceRefs.length > 0) {
    callbacks.onLog("Stage 5: Judging evidence...");
    const judgePrompt = buildJudgePrompt(evidenceRefs);
    const judgeResult = await runClaude({
      prompt: judgePrompt, model: "opus", timeoutMs: 120_000,
      stage: "judge", runDir, ...perms("judge"),
    });
    const judgeOutput = parseJudgeOutput(judgeResult.stdout);
    if (judgeOutput) {
      allVerdicts.push(...judgeOutput.verdicts);
    }

    // Reconciliation: any AC with evidence but no verdict gets an error fallback
    const verdictIds = new Set(allVerdicts.map(v => v.ac_id));
    for (const ref of evidenceRefs) {
      if (!verdictIds.has(ref.acId)) {
        allVerdicts.push({ ac_id: ref.acId, verdict: "error", confidence: "high", reasoning: "Judge did not produce a verdict for this AC" });
        progress.update(ref.acId, "error", "judge_missing");
      }
    }
  } else {
    callbacks.onLog("No evidence collected — skipping Judge.");
  }

  // Merge all verdicts
  const finalVerdicts: JudgeOutput = { verdicts: allVerdicts };
  writeFileSync(join(runDir, "verdicts.json"), JSON.stringify(finalVerdicts, null, 2));

  // ── Stage 6: Learner (always runs) ────────────────────────────────────
  callbacks.onLog("Stage 6: Updating learnings...");
  const learningsPath = join(verifyDir, "learnings.md");
  const { restore } = backupAndRestore(learningsPath);
  const learnerPrompt = buildLearnerPrompt({
    verdictsPath: join(runDir, "verdicts.json"),
    timelinePath: join(runDir, "logs", "timeline.jsonl"),
    learningsPath,
  });
  await runClaude({
    prompt: learnerPrompt, model: "sonnet", timeoutMs: 120_000,
    stage: "learner", runDir, ...perms("learner"),
  });
  restore(); // Safety: restore backup if learner corrupted the file

  // ── Report ────────────────────────────────────────────────────────────
  const timeline = readTimeline(runDir);
  const reportOutput = formatTerminalReport(finalVerdicts.verdicts);
  const timingSummary = formatTimingSummary(timeline);
  callbacks.onLog(reportOutput);
  callbacks.onLog(timingSummary);

  // Write report.json
  const totalDurationMs = timeline.length >= 2
    ? new Date(timeline[timeline.length - 1].ts).getTime() - new Date(timeline[0].ts).getTime()
    : 0;
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
