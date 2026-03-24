// pipeline/src/orchestrator.ts — Wires all stages together into a single pipeline run
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ACGeneratorOutput, PlannerOutput, JudgeOutput,
  ACVerdict, ProgressEvent, StageProgressEvent,
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
import { buildSetupWriterPrompt, buildSetupWriterRetryPrompt, parseSetupWriterOutput, executeSetupCommands, executeTeardownCommands, loadProjectEnv } from "./stages/setup-writer.js";
import type { SetupRetryContext } from "./stages/setup-writer.js";
import { buildBrowseAgentPrompt, parseBrowseResult, buildReplanPrompt, parseReplanOutput } from "./stages/browse-agent.js";
import { collectEvidencePaths, buildJudgePrompt, parseJudgeOutput } from "./stages/judge.js";
import { buildLearnerPrompt, backupAndRestore, validateLearnings } from "./stages/learner.js";
import { resolveBrowseBin, resetPage, startGroupDaemon, stopGroupDaemon, stopAllGroupDaemons } from "./lib/browse.js";
import { loginOnDaemon } from "./init.js";
import { extractTableNames, snapshotTables, restoreSnapshot } from "./lib/db-snapshot.js";
import { findAndRenameVideo } from "./lib/video.js";
import { formatTerminalReport, formatTimingSummary } from "./report.js";

const SECONDS_PER_STEP = 20;
const MIN_TIMEOUT_S = 90;
const MAX_TIMEOUT_S = 300;

export function computeTimeoutMs(steps: string[]): number {
  const seconds = Math.min(Math.max(steps.length * SECONDS_PER_STEP, MIN_TIMEOUT_S), MAX_TIMEOUT_S);
  return seconds * 1000;
}

export interface OrchestratorCallbacks {
  /** Called after AC generation — return modified ACs or null to abort */
  onACCheckpoint: (acs: ACGeneratorOutput) => Promise<ACGeneratorOutput | null>;
  onLog: (message: string) => void;
  onError: (message: string) => void;
  onProgress: (event: ProgressEvent) => void;
  onStageProgress?: (event: StageProgressEvent) => void;
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

  /** Merge stage permissions with cwd + progress callback — every runClaude call uses this */
  function perms(stage: string) {
    return { ...STAGE_PERMISSIONS[stage] ?? {}, cwd: projectRoot, onProgress: callbacks.onStageProgress };
  }

  callbacks.onLog(`Run: ${runId}`);

  // ── Init (preflight) ──────────────────────────────────────────────────
  const preflight = await runPreflight(config.baseUrl, specPath, verifyDir, config);
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
  const projectEnv = loadProjectEnv(projectRoot);

  // Collect seed IDs from app.json to protect from destructive setup/teardown
  const seedIds: string[] = [];
  if (appIndex) {
    // Primary source: seed_ids from app indexer
    if (appIndex.seed_ids) {
      for (const ids of Object.values(appIndex.seed_ids)) {
        seedIds.push(...ids);
      }
    }
    // Secondary: route URLs contain environment IDs
    for (const route of Object.keys(appIndex.routes)) {
      const match = route.match(/\/environments\/([^/]+)/);
      if (match && !seedIds.includes(match[1])) seedIds.push(match[1]);
    }
  }
  // Also protect well-known seed prefixes
  seedIds.push("clseed");
  callbacks.onLog(`  Protected seed IDs: ${seedIds.length}`);

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

  async function executeGroup(groupId: string, sharedDaemonEnv?: Record<string, string>): Promise<void> {
    const groupAcs = groupMap.get(groupId)!;
    const condition = groupConditions.get(groupId);

    // Per-group browse daemon isolation
    const ownsDaemon = !sharedDaemonEnv;
    const { env: groupEnv, stateDir: groupStateDir } = sharedDaemonEnv
      ? { env: sharedDaemonEnv, stateDir: "" }
      : startGroupDaemon(groupId, runDir);
    const groupAbort = new AbortController();

    if (ownsDaemon) {
      const loginResult = loginOnDaemon(config, groupEnv);
      if (!loginResult.ok) {
        callbacks.onLog(`  ${groupId}: login failed — ${loginResult.error}`);
        for (const ac of groupAcs) {
          allVerdicts.push({ ac_id: ac.id, verdict: "login_failed", confidence: "high", reasoning: loginResult.error ?? "Login failed" });
          progress.update(ac.id, "error", "login_failed");
        }
        stopGroupDaemon(groupStateDir);
        return;
      }
    }

    try {
      // Setup (if group has a condition requiring data state)
      let snapshotPath: string | null = null;
      let snapshotTableList: string[] = [];

      if (condition) {
        const MAX_SETUP_ATTEMPTS = 3;
        let setupSuccess = false;
        let lastRetryContext: SetupRetryContext | null = null;

        for (let attempt = 1; attempt <= MAX_SETUP_ATTEMPTS; attempt++) {
          // Build prompt — original on first attempt, retry with error context after
          const setupPrompt = attempt === 1
            ? buildSetupWriterPrompt(groupId, condition, projectRoot)
            : buildSetupWriterRetryPrompt(groupId, condition, projectRoot, lastRetryContext!);
          const stageName = attempt === 1
            ? `setup-${groupId}`
            : `setup-${groupId}-retry${attempt - 1}`;
          const timeoutMs = attempt === 1 ? 120_000 : 90_000;

          const setupResult = await runClaude({
            prompt: setupPrompt, model: "sonnet", timeoutMs,
            stage: stageName, runDir, ...perms("setup-writer"),
          });
          const commands = parseSetupWriterOutput(setupResult.stdout);
          if (!commands) {
            lastRetryContext = { type: "parse_error" };
            callbacks.onLog(`  Setup attempt ${attempt}/${MAX_SETUP_ATTEMPTS} for ${groupId}: parse error, ${attempt < MAX_SETUP_ATTEMPTS ? "retrying..." : "giving up"}`);
            continue;
          }

          // Restore snapshot if this is a retry (clean slate before re-executing)
          if (attempt > 1 && snapshotPath) {
            const restoreResult = restoreSnapshot(snapshotPath, snapshotTableList, projectEnv);
            if (!restoreResult.success) {
              callbacks.onLog(`  Snapshot restore failed for ${groupId} — aborting retries: ${restoreResult.error}`);
              break;  // DB in unknown state, don't retry
            }
          }

          // Snapshot affected tables (first attempt or re-snapshot on retry)
          snapshotTableList = extractTableNames(commands.setup_commands);
          const snapshotDir = join(runDir, "setup", groupId);
          mkdirSync(snapshotDir, { recursive: true });
          snapshotPath = snapshotTables(snapshotTableList, snapshotDir, projectEnv);
          if (attempt === 1 && snapshotPath) {
            callbacks.onLog(`  Snapshotted ${snapshotTableList.length} tables for ${groupId}`);
          }

          // Execute setup SQL
          const setupExec = executeSetupCommands(commands.setup_commands, projectEnv, projectRoot, seedIds);
          if (setupExec.success) {
            setupSuccess = true;
            writeFileSync(join(runDir, "setup", groupId, "commands.json"), JSON.stringify(commands, null, 2));
            break;
          }

          lastRetryContext = {
            type: "exec_error",
            failedCommands: commands.setup_commands,
            error: setupExec.error ?? "Unknown error",
          };
          callbacks.onLog(`  Setup attempt ${attempt}/${MAX_SETUP_ATTEMPTS} for ${groupId}: ${setupExec.error}${attempt < MAX_SETUP_ATTEMPTS ? " — retrying..." : ""}`);
        }

        if (!setupSuccess) {
          // Restore snapshot after all attempts failed
          if (snapshotPath) restoreSnapshot(snapshotPath, snapshotTableList, projectEnv);
          const reason = lastRetryContext?.type === "exec_error"
            ? `Setup failed after ${MAX_SETUP_ATTEMPTS} attempts: ${lastRetryContext.error}`
            : `Setup failed after ${MAX_SETUP_ATTEMPTS} attempts: could not produce valid output`;
          for (const ac of groupAcs) {
            allVerdicts.push({ ac_id: ac.id, verdict: "setup_failed", confidence: "high", reasoning: reason });
            progress.update(ac.id, "error", "setup_failed");
          }
          return;
        }
      }

      // Nav hints: accumulated from successful replans, applied to subsequent ACs
      const navHints: NavHint[] = [];

      // Run browse agents sequentially within group
      for (const ac of groupAcs) {
        if (groupAbort.signal.aborted) {
          allVerdicts.push({ ac_id: ac.id, verdict: "auth_expired", confidence: "high", reasoning: "Aborted: auth session expired in group" });
          progress.update(ac.id, "skipped", "auth_expired");
          continue;
        }

        progress.update(ac.id, "running");
        const evidenceDir = join(runDir, "evidence", ac.id);
        mkdirSync(evidenceDir, { recursive: true });

        // Apply nav hints from earlier ACs in this group
        const enrichedAc = navHints.length > 0
          ? { ...ac, steps: spliceNavHints(ac.steps, ac.url, navHints) }
          : ac;

        const agentPrompt = buildBrowseAgentPrompt(enrichedAc, {
          baseUrl: config.baseUrl, browseBin, evidenceDir,
        });
        const agentResult = await runClaude({
          prompt: agentPrompt, model: "sonnet", timeoutMs: computeTimeoutMs(enrichedAc.steps),
          stage: `browse-agent-${ac.id}`, runDir, env: groupEnv, ...perms("browse-agent"),
        });

        // Collect video evidence if present
        findAndRenameVideo(evidenceDir);

        if (agentResult.timedOut) {
          allVerdicts.push({ ac_id: ac.id, verdict: "timeout", confidence: "high", reasoning: `Timed out after ${computeTimeoutMs(enrichedAc.steps) / 1000}s` });
          progress.update(ac.id, "timeout");
          resetPage();
          continue;
        }

        let browseResult = parseBrowseResult(agentResult.stdout);

        // Navigation failure → replan → retry (max 1 attempt)
        if (browseResult?.nav_failure && browseResult.nav_failure.kind !== "interaction") {
          const failedStep = browseResult.nav_failure.failed_step;
          callbacks.onLog(`  ${ac.id}: nav_failure — replanning...`);
          progress.update(ac.id, "running", "replanning");

          // Write replan input
          const replanInputPath = join(evidenceDir, "replan-input.json");
          writeFileSync(replanInputPath, JSON.stringify({
            ac_id: ac.id,
            description: ac.description,
            original_steps: ac.steps,
            failed_step: failedStep,
            error: browseResult.nav_failure.error,
            page_snapshot: browseResult.nav_failure.page_snapshot,
          }));

          // Call replan prompt (lightweight, 45s timeout, minimal permissions)
          const replanResult = await runClaude({
            prompt: buildReplanPrompt(replanInputPath),
            model: "sonnet", timeoutMs: 45_000, effort: "low",
            stage: `replan-${ac.id}`, runDir, ...perms("browse-replan"),
          });
          const replanOutput = parseReplanOutput(replanResult.stdout);

          if (replanOutput?.revised_steps) {
            // Retry browse agent with revised steps — reuse same evidenceDir
            // so judge sees one clean result per AC (no ghost dirs)
            callbacks.onLog(`  ${ac.id}: retrying with ${replanOutput.revised_steps.length} revised steps`);
            resetPage();
            const retryAc = { ...ac, steps: replanOutput.revised_steps };
            const retryPrompt = buildBrowseAgentPrompt(retryAc, {
              baseUrl: config.baseUrl, browseBin, evidenceDir,
            });
            const retryResult = await runClaude({
              prompt: retryPrompt, model: "sonnet",
              timeoutMs: computeTimeoutMs(retryAc.steps),
              stage: `browse-agent-${ac.id}-retry`, runDir, env: groupEnv, ...perms("browse-agent"),
            });

            findAndRenameVideo(evidenceDir);

            if (retryResult.timedOut) {
              allVerdicts.push({ ac_id: ac.id, verdict: "timeout", confidence: "high", reasoning: `Timed out after replan retry (${computeTimeoutMs(retryAc.steps) / 1000}s)` });
              progress.update(ac.id, "timeout");
              resetPage();
              continue;
            }

            const retryBrowse = parseBrowseResult(retryResult.stdout);
            if (retryBrowse) {
              browseResult = retryBrowse;

              // Save nav hint ONLY if retry succeeded (no nav_failure on retry)
              if (!retryBrowse.nav_failure) {
                // Extract nav steps: everything in revised_steps before the first
                // step that also appears in the original ac.steps
                const origSet = new Set(ac.steps.map(s => s.toLowerCase()));
                const firstOrigIdx = replanOutput.revised_steps.findIndex(
                  s => origSet.has(s.toLowerCase())
                );
                const navSteps = firstOrigIdx > 0
                  ? replanOutput.revised_steps.slice(0, firstOrigIdx)
                  : [];

                if (navSteps.length > 0) {
                  navHints.push({ url: ac.url, steps: navSteps });
                  callbacks.onLog(`  ${ac.id}: saved nav hint with ${navSteps.length} step(s) for ${ac.url}`);
                }
              }
            }
          }
        }

        if (browseResult) {
          writeFileSync(join(evidenceDir, "result.json"), JSON.stringify(browseResult, null, 2));

          // Circuit breaker: auth failure kills this group's remaining agents
          if (isAuthFailure(browseResult.observed, ac.url)) {
            callbacks.onError(`Auth session expired in group ${groupId}.`);
            groupAbort.abort();
            allVerdicts.push({ ac_id: ac.id, verdict: "auth_expired", confidence: "high", reasoning: "Auth redirect detected" });
            progress.update(ac.id, "error", "auth_expired");
            resetPage();
            continue;
          }
        } else {
          allVerdicts.push({ ac_id: ac.id, verdict: "error", confidence: "high", reasoning: "Browse agent produced no parseable output" });
          progress.update(ac.id, "error");
        }

        // Reset page between agents in same group
        resetPage();
      }

      // Teardown: restore DB snapshot (replaces LLM-generated teardown commands)
      if (snapshotPath && snapshotTableList.length > 0) {
        callbacks.onLog(`  Restoring DB snapshot for ${groupId}...`);
        const restoreResult = restoreSnapshot(snapshotPath, snapshotTableList, projectEnv);
        if (!restoreResult.success) {
          callbacks.onLog(`  ⚠ Snapshot restore failed: ${restoreResult.error}`);
        }
      }
    } finally {
      if (ownsDaemon) stopGroupDaemon(groupStateDir);
    }
  }

  // Split groups into setup (needs DB mutation) and pure-UI (no setup)
  const setupGroupIds: string[] = [];
  const pureUIGroupIds: string[] = [];
  for (const groupId of groupMap.keys()) {
    const condition = groupConditions.get(groupId);
    if (condition) {
      setupGroupIds.push(groupId);
    } else {
      pureUIGroupIds.push(groupId);
    }
  }

  callbacks.onLog(`  Execution: ${setupGroupIds.length} setup (serial) + ${pureUIGroupIds.length} pure-UI (parallel)`);

  // Execute setup groups SEQUENTIALLY (they share the same DB and one daemon)
  // and pure-UI groups IN PARALLEL (each gets its own daemon)
  const setupChainPromise = (async () => {
    if (setupGroupIds.length === 0) return;
    // Setup groups share one daemon (they run serially — no contention)
    const { env: setupEnv, stateDir: setupStateDir } = startGroupDaemon("setup-shared", runDir);
    const loginResult = loginOnDaemon(config, setupEnv);
    if (!loginResult.ok) {
      callbacks.onLog(`  setup-shared: login failed — ${loginResult.error}`);
      for (const groupId of setupGroupIds) {
        for (const ac of groupMap.get(groupId)!) {
          allVerdicts.push({ ac_id: ac.id, verdict: "login_failed", confidence: "high", reasoning: loginResult.error ?? "Login failed" });
          progress.update(ac.id, "error", "login_failed");
        }
      }
      stopGroupDaemon(setupStateDir);
      return;
    }
    try {
      for (const groupId of setupGroupIds) {
        await executeGroup(groupId, setupEnv);
      }
    } finally {
      stopGroupDaemon(setupStateDir);
    }
  })();

  const pureUIPromises = pureUIGroupIds.map((groupId) => executeGroup(groupId));

  await Promise.all([setupChainPromise, ...pureUIPromises]);

  // Safety net: kill any group daemons that survived (crash, exception)
  stopAllGroupDaemons(runDir);

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
    prompt: learnerPrompt, model: "sonnet", timeoutMs: 180_000,
    stage: "learner", runDir, ...perms("learner"),
  });
  restore(); // Safety: restore backup if learner corrupted the file

  // Validate learnings — strip unauthorized content
  if (existsSync(learningsPath)) {
    const raw = readFileSync(learningsPath, "utf-8");
    const validated = validateLearnings(raw);
    if (validated !== raw) {
      writeFileSync(learningsPath, validated);
      callbacks.onLog("  Validated learnings.md — stripped unauthorized content");
    }
  }

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

// ── Nav hints (cross-AC navigation context within a group) ──────────────────

interface NavHint {
  url: string;
  steps: string[];
}

function spliceNavHints(acSteps: string[], url: string, hints: NavHint[]): string[] {
  const matching = hints.filter(h => h.url === url);
  if (matching.length === 0) return acSteps;

  // Collect all nav steps from matching hints
  const allNavSteps = matching.flatMap(h => h.steps);
  if (allNavSteps.length === 0) return acSteps;

  // Find the first "Wait for page load" step (case-insensitive)
  const waitIdx = acSteps.findIndex(s => /wait\s+for\s+page\s+load/i.test(s));
  const insertAfter = waitIdx >= 0 ? waitIdx : 0;

  const result = [...acSteps];
  result.splice(insertAfter + 1, 0, ...allNavSteps);
  return result;
}
