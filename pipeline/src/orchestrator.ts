// pipeline/src/orchestrator.ts — V1.1 pipeline: AC Extractor → Single-Session Executor → Report
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ACGeneratorOutput, AC, ACVerdict, ProgressEvent, StageProgressEvent, JudgeOutput,
} from "./lib/types.js";
import { STAGE_PERMISSIONS, isAuthFailure } from "./lib/types.js";
import { loadConfig } from "./lib/config.js";
import { generateRunId } from "./lib/run-id.js";
import { runClaude } from "./run-claude.js";
import { ProgressEmitter } from "./lib/progress.js";
import { runPreflight, loginOnDaemon } from "./init.js";

import { buildACGeneratorPrompt, parseACGeneratorOutput, fanOutPureUIGroups } from "./stages/ac-generator.js";
import { buildSessionPrompt, readSessionResults } from "./stages/browse-agent.js";
import { extractDiffHints } from "./lib/diff-hints.js";
import { resolveBrowseBin, startGroupDaemon, stopGroupDaemon } from "./lib/browse.js";
import { formatTerminalReport, formatTimingSummary } from "./report.js";
import { readTimeline } from "./lib/timeline.js";

const AC_EXTRACTOR_TIMEOUT_MS = 120_000;
/**
 * Session timeout is a safety net, not the primary constraint.
 * The prompt's navigation budget (8 commands per AC) is what actually bounds execution.
 * This timeout just prevents runaway sessions.
 */
const SESSION_TIMEOUT_MS = 600_000; // 10 minutes — generous, like Expect's model

export interface OrchestratorCallbacks {
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
  const projectRoot = resolve(verifyDir, "..");
  const runId = generateRunId(specPath);
  const runDir = join(verifyDir, "runs", runId);
  mkdirSync(join(runDir, "logs"), { recursive: true });

  const progress = new ProgressEmitter(callbacks.onProgress);

  const stagePerms = (stage: string) => ({
    ...STAGE_PERMISSIONS[stage] ?? {},
    cwd: projectRoot,
    onProgress: callbacks.onStageProgress,
  });

  callbacks.onLog(`Run: ${runId}`);

  // ── Preflight ──────────────────────────────────────────────────────────
  const preflight = await runPreflight(config.baseUrl, specPath, verifyDir, config);
  if (!preflight.ok) {
    for (const err of preflight.errors) callbacks.onError(err);
    return { runDir, verdicts: null };
  }

  // ── Stage 1: AC Extractor ──────────────────────────────────────────────
  callbacks.onLog("Stage 1: Extracting acceptance criteria...");
  const acPrompt = buildACGeneratorPrompt(specPath);
  let acResult = await runClaude({
    prompt: acPrompt, model: "opus", timeoutMs: AC_EXTRACTOR_TIMEOUT_MS,
    stage: "ac-generator", runDir, ...stagePerms("ac-generator"),
  });

  let rawAcs = parseACGeneratorOutput(acResult.stdout);

  // Retry once on timeout or parse failure
  if (!rawAcs) {
    callbacks.onLog("AC Extractor failed, retrying...");
    acResult = await runClaude({
      prompt: acPrompt, model: "opus", timeoutMs: AC_EXTRACTOR_TIMEOUT_MS,
      stage: "ac-generator-retry", runDir, ...stagePerms("ac-generator"),
    });
    rawAcs = parseACGeneratorOutput(acResult.stdout);
  }

  if (!rawAcs) {
    callbacks.onError("AC Extractor failed after retry. Check logs: " + join(runDir, "logs"));
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

  // Flatten all ACs from all groups
  const allAcs = acs.groups.flatMap(g => g.acs);
  for (const ac of allAcs) progress.update(ac.id, "pending");

  if (allAcs.length === 0) {
    callbacks.onLog("No verifiable ACs found.");
    return { runDir, verdicts: { verdicts: [] } };
  }

  // ── Diff hints ─────────────────────────────────────────────────────────
  const diffHints = extractDiffHints(projectRoot);
  callbacks.onLog(`Diff hints: ${diffHints.split("\n").length} lines`);

  // ── App routes (from app.json if available) ────────────────────────────
  let appRoutes: string | undefined;
  const appJsonPath = join(verifyDir, "app.json");
  if (existsSync(appJsonPath)) {
    try {
      const appIndex = JSON.parse(readFileSync(appJsonPath, "utf-8"));
      const lines: string[] = [];
      // Example URLs: resolved parameterized routes → concrete URLs
      if (appIndex.example_urls && typeof appIndex.example_urls === "object") {
        const urls = appIndex.example_urls as Record<string, string>;
        for (const [pattern, example] of Object.entries(urls)) {
          lines.push(`${pattern} → ${example}`);
        }
      }
      // Route list (unresolved) — only add routes not in example_urls
      if (appIndex.routes && typeof appIndex.routes === "object") {
        const examplePatterns = new Set(Object.keys(appIndex.example_urls ?? {}));
        const remaining = Object.keys(appIndex.routes as Record<string, unknown>)
          .filter(r => !examplePatterns.has(r));
        if (remaining.length > 0) {
          lines.push("", "Other routes (no resolved URLs):");
          for (const r of remaining) lines.push(`  ${r}`);
        }
      }
      if (lines.length > 0) {
        appRoutes = lines.join("\n");
        callbacks.onLog(`App routes: ${lines.length} entries from app.json`);
      }
    } catch {
      // app.json parse error — proceed without routes
    }
  }

  // ── Create evidence directories ────────────────────────────────────────
  const evidenceBaseDir = join(runDir, "evidence");
  for (const ac of allAcs) {
    mkdirSync(join(evidenceBaseDir, ac.id), { recursive: true });
  }

  // ── Start browser daemon ───────────────────────────────────────────────
  const browseBin = resolveBrowseBin();
  const { env: daemonEnv, stateDir } = startGroupDaemon("v1", runDir);

  const loginResult = loginOnDaemon(config, daemonEnv);
  if (!loginResult.ok) {
    callbacks.onError(`Login failed: ${loginResult.error}`);
    stopGroupDaemon(stateDir);
    return { runDir, verdicts: null };
  }

  // ── Stage 2: Single-session executor with stream supervisor ──────────
  callbacks.onLog(`Stage 2: Executing ${allAcs.length} ACs in single session...`);

  const sessionPrompt = buildSessionPrompt(allAcs, {
    baseUrl: config.baseUrl,
    browseBin,
    evidenceBaseDir,
    diffHints,
    appRoutes,
  });

  // All ACs start as pending — supervisor upgrades them as it detects activity
  const acIds = new Set(allAcs.map(ac => ac.id));
  let activeAcId: string | null = null;
  const completedAcIds = new Set<string>();
  const commandCounts = new Map<string, number>();  // acId → browse command count
  const BROWSE_CMD_RE = /browse\s+(goto|snapshot|click|fill|hover|press|wait|screenshot)/;

  // Stream supervisor: watches tool calls to track per-AC progress in real-time
  const supervisorProgress = (event: import("./lib/types.js").StageProgressEvent) => {
    callbacks.onStageProgress?.(event);

    if (event.event !== "tool_call" || !event.toolInput) return;
    const cmd = event.toolInput;

    // Detect AC transitions: executor writes "cat > evidence/{acId}/result.json"
    const resultWrite = cmd.match(/evidence\/(\w+)\/result\.json/);
    if (resultWrite) {
      const acId = resultWrite[1];
      if (acIds.has(acId) && !completedAcIds.has(acId)) {
        completedAcIds.add(acId);
        const cmds = commandCounts.get(acId) ?? 0;
        callbacks.onLog(`  ${acId}: done (${completedAcIds.size}/${allAcs.length}, ${cmds} commands)`);
        progress.update(acId, "running", "result written");

        const remaining = allAcs.filter(ac => !completedAcIds.has(ac.id));
        if (remaining.length > 0) {
          activeAcId = remaining[0].id;
          progress.update(activeAcId, "running");
        }
      }
    }

    // Track which AC is active by watching browse commands
    if (!activeAcId && BROWSE_CMD_RE.test(cmd)) {
      activeAcId = allAcs[0].id;
      progress.update(activeAcId, "running");
    }

    // Switch active AC when we see evidence dir references for a different AC
    const evidenceRef = cmd.match(/evidence\/(\w+)\//);
    if (evidenceRef) {
      const acId = evidenceRef[1];
      if (acIds.has(acId) && acId !== activeAcId && !completedAcIds.has(acId)) {
        activeAcId = acId;
        progress.update(acId, "running");
      }
    }

    // Count browse commands for the active AC
    if (activeAcId && BROWSE_CMD_RE.test(cmd)) {
      const count = (commandCounts.get(activeAcId) ?? 0) + 1;
      commandCounts.set(activeAcId, count);
      if (count === 12) {
        callbacks.onLog(`  ${activeAcId}: hit 12-command budget`);
      }
    }
  };

  let sessionTimedOut = false;
  try {
    const execResult = await runClaude({
      prompt: sessionPrompt,
      model: "sonnet",
      timeoutMs: SESSION_TIMEOUT_MS,
      stage: "executor-session",
      runDir,
      env: daemonEnv,
      ...stagePerms("executor"),
      onProgress: supervisorProgress,
    });

    sessionTimedOut = execResult.timedOut;
    if (sessionTimedOut) {
      callbacks.onLog("Executor session timed out. Collecting partial results...");
    }
  } finally {
    stopGroupDaemon(stateDir);
  }

  // ── Collect results from evidence directory ────────────────────────────
  const sessionResults = readSessionResults(allAcs, evidenceBaseDir);
  const allVerdicts: ACVerdict[] = [];

  for (const ac of allAcs) {
    const result = sessionResults.get(ac.id);

    if (!result) {
      // No result file — executor didn't get to this AC or crashed
      const reason = sessionTimedOut
        ? "Session timed out before reaching this AC"
        : "Executor did not produce a result for this AC";
      allVerdicts.push({ ac_id: ac.id, verdict: "error", confidence: "high", reasoning: reason });
      progress.update(ac.id, "error");
      continue;
    }

    // Check for auth failure pattern
    if (isAuthFailure(result.observed)) {
      allVerdicts.push({ ac_id: ac.id, verdict: "auth_expired", confidence: "high", reasoning: `Auth redirect detected: ${result.observed.slice(0, 100)}` });
      progress.update(ac.id, "error", "auth_expired");
      continue;
    }

    allVerdicts.push({
      ac_id: result.ac_id,
      verdict: result.verdict,
      confidence: result.confidence,
      reasoning: result.reasoning,
    });

    const status = result.verdict === "pass" ? "pass" : result.verdict === "fail" ? "fail" : "error";
    progress.update(ac.id, status);
  }

  // ── All-unclear detection ──────────────────────────────────────────────
  const unclearCount = allVerdicts.filter(v => v.verdict === "unclear").length;
  if (unclearCount > allVerdicts.length * 0.5 && allVerdicts.length > 0) {
    callbacks.onLog(`WARNING: ${unclearCount}/${allVerdicts.length} ACs are 'unclear'. Executor prompt may be too conservative.`);
  }

  // ── Report ─────────────────────────────────────────────────────────────
  const finalVerdicts: JudgeOutput = { verdicts: allVerdicts };
  writeFileSync(join(runDir, "verdicts.json"), JSON.stringify(finalVerdicts, null, 2));

  const timeline = readTimeline(runDir);
  callbacks.onLog(formatTerminalReport(finalVerdicts.verdicts));
  callbacks.onLog(formatTimingSummary(timeline));

  // HTML report
  try {
    const { generateHTMLReport } = await import("./lib/html-report.js");
    const htmlPath = generateHTMLReport(runDir, finalVerdicts.verdicts);
    callbacks.onLog(`\nEvidence report: ${htmlPath}`);
  } catch {
    // HTML report is best-effort
  }

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
