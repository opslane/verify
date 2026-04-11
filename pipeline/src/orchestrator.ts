// pipeline/src/orchestrator.ts — V1.1 pipeline: AC Extractor → Single-Session Executor → Report
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ACGeneratorOutput, AC, ACVerdict, ProgressEvent, StageProgressEvent, JudgeOutput,
} from "./lib/types.js";
import { STAGE_PERMISSIONS, isAuthFailure } from "./lib/types.js";
import { loadConfig } from "./lib/config.js";
import { generateRunId } from "./lib/run-id.js";
import { runClaude } from "./run-claude.js";
import { ProgressEmitter } from "./lib/progress.js";
import { runPreflight, importCookiesToDaemon } from "./init.js";

import { buildACGeneratorPrompt, parseACGeneratorOutput, fanOutPureUIGroups } from "./stages/ac-generator.js";
import { buildSessionPrompt, readSessionResults } from "./stages/browse-agent.js";
import { extractDiffHints } from "./lib/diff-hints.js";
import { resolveBrowseBin, startGroupDaemon, stopGroupDaemon } from "./lib/browse.js";
import { formatTerminalReport, formatTimingSummary } from "./report.js";
import { readTimeline } from "./lib/timeline.js";

export interface SessionState {
  specPath: string;
  completedAcIds: string[];
  remainingAcIds: string[];
  learnings: SessionLearning[];
  timestamp: string;
}

export interface SessionLearning {
  acId: string;
  url: string;
  selectorsUsed: string[];
  pageNotes: string;
}

/**
 * Extract learnings from completed AC results — selectors that worked, URLs visited, page structure.
 * These get injected into the resume session prompt so the agent doesn't re-discover everything.
 */
function extractLearnings(
  completedAcIds: string[],
  evidenceBaseDir: string,
): SessionLearning[] {
  const learnings: SessionLearning[] = [];
  for (const acId of completedAcIds) {
    const resultPath = join(evidenceBaseDir, acId, "result.json");
    try {
      const raw: Record<string, unknown> = JSON.parse(readFileSync(resultPath, "utf-8"));
      const steps = Array.isArray(raw.steps_taken)
        ? (raw.steps_taken as unknown[]).filter((s): s is string => typeof s === "string")
        : [];
      const gotoStep = steps.find(s => s.startsWith("goto "));
      const url = gotoStep ? gotoStep.replace("goto ", "") : "";
      const selectors = steps
        .filter(s => /^(click|fill|hover)\s/.test(s))
        .map(s => s.replace(/^(click|fill|hover)\s+/, "").split(/\s/)[0]);
      learnings.push({
        acId,
        url,
        selectorsUsed: selectors,
        pageNotes: (typeof raw.observed === "string" ? raw.observed : "").slice(0, 200),
      });
    } catch {
      // No result file or parse error — skip
    }
  }
  return learnings;
}

/**
 * Find the most recent incomplete run for a given spec.
 * Scans run directories for session-state.json where specPath matches
 * and remainingAcIds is non-empty.
 */
export function findLastIncompleteRun(verifyDir: string, specPath: string): string | null {
  const runsDir = join(verifyDir, "runs");
  try {
    const dirs = readdirSync(runsDir).sort().reverse();
    for (const dir of dirs) {
      const statePath = join(runsDir, dir, "session-state.json");
      try {
        const raw: Record<string, unknown> = JSON.parse(readFileSync(statePath, "utf-8"));
        // Match by exact specPath, not slug — avoids substring collisions
        if (raw.specPath !== specPath) continue;
        const remaining = Array.isArray(raw.remainingAcIds) ? raw.remainingAcIds : [];
        if (remaining.length > 0) {
          return join(runsDir, dir);
        }
      } catch {
        continue;
      }
    }
  } catch {
    // runs dir doesn't exist
  }
  return null;
}

function formatLearningsForPrompt(learnings: SessionLearning[]): string {
  if (learnings.length === 0) return "";
  const lines = ["LEARNINGS FROM PREVIOUS SESSION (use these to navigate faster):"];
  for (const l of learnings) {
    lines.push(`- ${l.acId}: URL=${l.url}`);
    if (l.selectorsUsed.length > 0) {
      lines.push(`  Selectors that worked: ${l.selectorsUsed.join(", ")}`);
    }
    if (l.pageNotes) {
      lines.push(`  Page state: ${l.pageNotes}`);
    }
  }
  return lines.join("\n");
}

const AC_EXTRACTOR_TIMEOUT_MS = 90_000; // No tool access — all content inlined in prompt
/**
 * Session timeout is the primary safety net.
 * The supervisor detects stalls (repeated failed selectors) and has a hard
 * backstop at 30 commands per AC. This timeout prevents runaway sessions
 * when neither mechanism triggers.
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
  hasRemaining: boolean;
}

export async function runPipeline(
  specPath: string,
  verifyDir: string,
  callbacks: OrchestratorCallbacks,
  resumeRunDir?: string,
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
  const preflight = await runPreflight(config.baseUrl, specPath);
  if (!preflight.ok) {
    for (const err of preflight.errors) callbacks.onError(err);
    return { runDir, verdicts: null, hasRemaining: false };
  }

  // ── Stage 1: AC Extractor ──────────────────────────────────────────────
  // All content inlined in prompt — no tool access needed (prevents codebase wandering)
  callbacks.onLog("Stage 1: Extracting acceptance criteria...");
  const acPrompt = buildACGeneratorPrompt(specPath, verifyDir);
  let acResult = await runClaude({
    prompt: acPrompt, model: "opus", timeoutMs: AC_EXTRACTOR_TIMEOUT_MS,
    stage: "ac-generator", runDir, cwd: projectRoot, tools: [],
  });

  let rawAcs = parseACGeneratorOutput(acResult.stdout);

  // Retry once on timeout or parse failure
  if (!rawAcs) {
    callbacks.onLog("AC Extractor failed, retrying...");
    acResult = await runClaude({
      prompt: acPrompt, model: "opus", timeoutMs: AC_EXTRACTOR_TIMEOUT_MS,
      stage: "ac-generator-retry", runDir, cwd: projectRoot, tools: [],
    });
    rawAcs = parseACGeneratorOutput(acResult.stdout);
  }

  if (!rawAcs) {
    callbacks.onError("AC Extractor failed after retry. Check logs: " + join(runDir, "logs"));
    return { runDir, verdicts: null, hasRemaining: false };
  }

  // User checkpoint
  const confirmedAcs = await callbacks.onACCheckpoint(rawAcs);
  if (!confirmedAcs) {
    callbacks.onLog("User aborted after AC review.");
    return { runDir, verdicts: null, hasRemaining: false };
  }
  const acs = fanOutPureUIGroups(confirmedAcs);
  writeFileSync(join(runDir, "acs.json"), JSON.stringify(acs, null, 2));

  // Flatten all ACs from all groups
  let allAcs = acs.groups.flatMap(g => g.acs);

  // ── Resume: load prior state, filter to remaining ACs, inject learnings ──
  let priorLearnings = "";
  let priorVerdicts: ACVerdict[] = [];
  if (resumeRunDir) {
    const statePath = join(resumeRunDir, "session-state.json");
    try {
      const priorState: SessionState = JSON.parse(readFileSync(statePath, "utf-8"));
      const completedSet = new Set(priorState.completedAcIds);

      // Validate: all completed AC IDs must exist in current spec
      const currentAcIds = new Set(allAcs.map(ac => ac.id));
      const staleIds = priorState.completedAcIds.filter(id => !currentAcIds.has(id));
      if (staleIds.length > 0) {
        callbacks.onLog(`Warning: prior run has ${staleIds.length} AC ID(s) not in current spec (${staleIds.join(", ")}). Running all ACs fresh.`);
        // Fall through without filtering — run everything
      } else {
        const remainingAcs = allAcs.filter(ac => !completedSet.has(ac.id));
        const skippedCount = allAcs.length - remainingAcs.length;
        callbacks.onLog(`Resuming: ${skippedCount} ACs already completed, ${remainingAcs.length} remaining`);

        // Carry forward verdicts from prior run
        const priorVerdictsPath = join(resumeRunDir, "verdicts.json");
        try {
          const pv: JudgeOutput = JSON.parse(readFileSync(priorVerdictsPath, "utf-8"));
          priorVerdicts = pv.verdicts.filter(v => completedSet.has(v.ac_id) && v.verdict !== "error");
        } catch { /* no prior verdicts */ }

        priorLearnings = formatLearningsForPrompt(priorState.learnings);
        allAcs = remainingAcs;
      }
    } catch {
      callbacks.onLog("Warning: could not load session state from prior run, running all ACs");
    }
  }

  for (const ac of allAcs) progress.update(ac.id, "pending");

  if (allAcs.length === 0) {
    callbacks.onLog("No verifiable ACs found.");
    return { runDir, verdicts: { verdicts: [] }, hasRemaining: false };
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
      if (appIndex.routes && typeof appIndex.routes === "object") {
        const routes = Object.keys(appIndex.routes as Record<string, unknown>);
        if (routes.length > 0) {
          appRoutes = routes.join("\n");
          callbacks.onLog(`App routes: ${routes.length} entries from app.json`);
        }
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

  const cookieResult = importCookiesToDaemon(config.baseUrl, daemonEnv);
  if (!cookieResult.ok) {
    callbacks.onError(`Cookie auth failed: ${cookieResult.error}`);
    stopGroupDaemon(stateDir);
    return { runDir, verdicts: null, hasRemaining: false };
  }

  // ── Stage 2: Single-session executor with stream supervisor ──────────
  callbacks.onLog(`Stage 2: Executing ${allAcs.length} ACs in single session...`);

  const sessionPrompt = buildSessionPrompt(allAcs, {
    baseUrl: config.baseUrl,
    browseBin,
    evidenceBaseDir,
    diffHints,
    appRoutes,
    learnings: priorLearnings || undefined,
  });

  // ── Stream supervisor: marker-based AC tracking ──────────────────────
  // The executor emits VERIFY_START|acId and VERIFY_DONE|acId markers.
  // The supervisor uses these to track which AC is active and enforce budgets.
  // If the executor exceeds the command budget, the supervisor writes a
  // blocked verdict itself — the executor doesn't have to cooperate.

  const acIds = new Set(allAcs.map(ac => ac.id));
  let activeAcId: string | null = null;
  const completedAcIds = new Set<string>();
  const commandCounts = new Map<string, number>();
  const recentCommands = new Map<string, string[]>(); // Track recent commands per AC for stall detection
  const BROWSE_CMD_RE = /browse\s+(goto|snapshot|click|fill|hover|press|wait|screenshot)/;
  const STALL_WINDOW = 6;      // Look at last N interaction commands
  const STALL_THRESHOLD = 3;   // Same selector N times in window = stall
  const MAX_COMMANDS_PER_AC = 30; // Hard backstop — catches cases stall detection misses (e.g., @ref cycling)

  const supervisorWriteBlocked = (acId: string, reason: string) => {
    if (completedAcIds.has(acId)) return;
    const blockedResult = {
      ac_id: acId,
      verdict: "blocked",
      confidence: "high" as const,
      reasoning: reason,
      observed: `Supervisor intervened: ${reason}`,
      steps_taken: [] as string[],
      screenshots: [] as string[],
    };
    try {
      writeFileSync(
        join(evidenceBaseDir, acId, "result.json"),
        JSON.stringify(blockedResult, null, 2),
      );
      completedAcIds.add(acId);
      callbacks.onLog(`  ${acId}: supervisor wrote blocked verdict`);
    } catch {
      // best effort
    }
  };

  const supervisorProgress = (event: import("./lib/types.js").StageProgressEvent) => {
    callbacks.onStageProgress?.(event);
    if (event.event !== "tool_call" || !event.toolInput) return;
    const cmd = event.toolInput;

    // ── Marker detection: VERIFY_START|acId|description ────────────
    const startMarker = cmd.match(/VERIFY_START\|(\w+)/);
    if (startMarker) {
      const acId = startMarker[1];
      if (acIds.has(acId)) {
        // If previous AC was started but never completed, supervisor writes blocked
        if (activeAcId && !completedAcIds.has(activeAcId)) {
          const cmds = commandCounts.get(activeAcId) ?? 0;
          supervisorWriteBlocked(activeAcId, `Executor moved to next AC without writing a verdict (${cmds} commands used)`);
        }
        activeAcId = acId;
        commandCounts.set(acId, 0);
        recentCommands.delete(acId);
        progress.update(acId, "running");
        callbacks.onLog(`  ${acId}: started`);
      }
    }

    // ── Marker detection: VERIFY_DONE|acId|verdict ─────────────────
    const doneMarker = cmd.match(/VERIFY_DONE\|(\w+)/);
    if (doneMarker) {
      const acId = doneMarker[1];
      if (acIds.has(acId) && !completedAcIds.has(acId)) {
        completedAcIds.add(acId);
        const cmds = commandCounts.get(acId) ?? 0;
        callbacks.onLog(`  ${acId}: done (${completedAcIds.size}/${allAcs.length}, ${cmds} commands)`);
        progress.update(acId, "running", "result written");
      }
    }

    // ── Fallback: detect result.json writes even without markers ───
    const resultWrite = cmd.match(/evidence\/(\w+)\/result\.json/);
    if (resultWrite) {
      const acId = resultWrite[1];
      if (acIds.has(acId) && !completedAcIds.has(acId)) {
        completedAcIds.add(acId);
        const cmds = commandCounts.get(acId) ?? 0;
        callbacks.onLog(`  ${acId}: done (${completedAcIds.size}/${allAcs.length}, ${cmds} commands)`);
        progress.update(acId, "running", "result written");
      }
    }

    // ── Stall detection + hard backstop ───────────────────────────
    if (activeAcId && !completedAcIds.has(activeAcId) && BROWSE_CMD_RE.test(cmd)) {
      const count = (commandCounts.get(activeAcId) ?? 0) + 1;
      commandCounts.set(activeAcId, count);

      // Hard backstop — catches @ref cycling where stall detection doesn't fire
      if (count >= MAX_COMMANDS_PER_AC) {
        supervisorWriteBlocked(
          activeAcId,
          `Exceeded ${MAX_COMMANDS_PER_AC}-command hard limit. Agent may be stuck with changing selectors.`,
        );
      }

      // Stall detection: same selector repeated in sliding window
      const interactionMatch = cmd.match(/browse\s+(click|fill|hover)\s+(\S+)/);
      if (interactionMatch) {
        const selector = interactionMatch[2];
        const recent = recentCommands.get(activeAcId) ?? [];
        recent.push(selector);
        if (recent.length > STALL_WINDOW) recent.shift();
        recentCommands.set(activeAcId, recent);

        const selectorCounts = new Map<string, number>();
        for (const s of recent) selectorCounts.set(s, (selectorCounts.get(s) ?? 0) + 1);
        for (const [sel, n] of selectorCounts) {
          if (n >= STALL_THRESHOLD) {
            supervisorWriteBlocked(
              activeAcId,
              `Stall detected: selector "${sel}" attempted ${n} times in last ${recent.length} interactions. Agent is stuck.`,
            );
            break;
          }
        }
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

  // ── Session state: write for resume capability ─────────────────────────
  const completedIds = allVerdicts
    .filter(v => v.verdict !== "error")
    .map(v => v.ac_id);
  const allOriginalAcIds = acs.groups.flatMap(g => g.acs).map(ac => ac.id);
  const allCompletedIds = [...priorVerdicts.map(v => v.ac_id), ...completedIds];
  const remainingIds = allOriginalAcIds.filter(id => !allCompletedIds.includes(id));

  const sessionState: SessionState = {
    specPath,
    completedAcIds: allCompletedIds,
    remainingAcIds: remainingIds,
    learnings: extractLearnings(completedIds, evidenceBaseDir),
    timestamp: new Date().toISOString(),
  };
  writeFileSync(join(runDir, "session-state.json"), JSON.stringify(sessionState, null, 2));

  if (remainingIds.length > 0) {
    callbacks.onLog(`\n${remainingIds.length} AC(s) remaining: ${remainingIds.join(", ")}. Use --resume to continue.`);
  }

  // ── Merge prior verdicts with current ─────────────────────────────────
  const mergedVerdicts = [...priorVerdicts, ...allVerdicts];

  // ── All-unclear detection ──────────────────────────────────────────────
  const unclearCount = mergedVerdicts.filter(v => v.verdict === "unclear").length;
  if (unclearCount > mergedVerdicts.length * 0.5 && mergedVerdicts.length > 0) {
    callbacks.onLog(`WARNING: ${unclearCount}/${mergedVerdicts.length} ACs are 'unclear'. Executor prompt may be too conservative.`);
  }

  // ── Report ─────────────────────────────────────────────────────────────
  const finalVerdicts: JudgeOutput = { verdicts: mergedVerdicts };
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

  return { runDir, verdicts: finalVerdicts, hasRemaining: remainingIds.length > 0 };
}
