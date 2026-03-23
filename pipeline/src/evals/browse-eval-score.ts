import { existsSync, readFileSync } from "node:fs";
import type { BrowseEvalExpectation, BrowseTraceEntry } from "./browse-eval-types.js";
import { parseBrowseResult } from "../stages/browse-agent.js";

export interface BrowseEvalResult {
  caseId: string;
  passed: boolean;
  failures: string[];
  durationMs: number;
  commandCount: number;
}

export interface BrowseEvalArtifacts {
  caseId: string;
  expected: BrowseEvalExpectation;
  resultRaw: string;
  traceEntries: BrowseTraceEntry[];
  streamLog: string;
}

export interface BrowseEvalArtifactPaths {
  caseId: string;
  expectedPath: string;
  resultPath: string;
  tracePath: string;
  streamPath: string;
}

function matchesRequiredCommand(command: string, required: string): boolean {
  return command === required || command.startsWith(`${required} `);
}

function computeDurationMs(traceEntries: BrowseTraceEntry[]): number {
  if (traceEntries.length < 2) return 0;
  const startMs = Date.parse(traceEntries[0].ts);
  const endMs = Date.parse(traceEntries[traceEntries.length - 1].ts);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return 0;
  return Math.max(0, endMs - startMs);
}

function readOptional(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

function parseTrace(traceRaw: string): BrowseTraceEntry[] {
  if (!traceRaw.trim()) return [];
  return traceRaw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BrowseTraceEntry);
}

function extractBashCommands(streamLog: string): string[] {
  if (!streamLog.trim()) return [];

  const commands: string[] = [];
  for (const line of streamLog.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as {
        message?: { content?: Array<{ type?: string; name?: string; input?: { command?: string } }> };
      };
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      for (const item of content) {
        if (item?.type === "tool_use" && item.name === "Bash" && typeof item.input?.command === "string") {
          commands.push(item.input.command);
        }
      }
    } catch {
      // Ignore non-JSON lines in the stream log.
    }
  }
  return commands;
}

function extractReadPaths(streamLog: string): string[] {
  if (!streamLog.trim()) return [];

  const commands: string[] = [];
  for (const line of streamLog.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as {
        message?: { content?: Array<{ type?: string; name?: string; input?: { file_path?: string } }> };
      };
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      for (const item of content) {
        if (item?.type === "tool_use" && item.name === "Read" && typeof item.input?.file_path === "string") {
          commands.push(item.input.file_path);
        }
      }
    } catch {
      // Ignore non-JSON lines in the stream log.
    }
  }
  return commands;
}

export function scoreBrowseEvalCase(input: BrowseEvalArtifacts): BrowseEvalResult {
  const failures: string[] = [];
  const parsed = input.resultRaw.trim() ? parseBrowseResult(input.resultRaw) : null;
  const durationMs = computeDurationMs(input.traceEntries);
  const commandCount = input.traceEntries.length;
  const bashCommands = extractBashCommands(input.streamLog);
  const readPaths = extractReadPaths(input.streamLog);
  const evidenceText = [
    ...input.traceEntries.map((entry) => entry.stdout),
    ...input.traceEntries.map((entry) => entry.stderr),
    parsed?.nav_failure?.page_snapshot ?? "",
    parsed?.nav_failure?.error ?? "",
  ].join("\n").toLowerCase();
  const requiredEvidenceSubstrings = input.expected.required_evidence_substrings ?? [];
  const allowedReadPathSuffixes = input.expected.allowed_read_path_suffixes ?? ["instructions.json"];

  if (input.expected.expect_parseable_result) {
    if (!parsed) failures.push("result was not parseable");
  } else if (parsed) {
    failures.push("result was parseable when it should not be");
  }

  if (parsed) {
    const resultKind = parsed.nav_failure ? "nav_failure" : "normal";
    if (resultKind !== input.expected.expect_result_kind) {
      failures.push(`expected result kind ${input.expected.expect_result_kind}, got ${resultKind}`);
    }

    if (parsed.nav_failure && input.expected.expect_nav_failure_kind) {
      const actualKind = parsed.nav_failure.kind ?? "navigation";
      if (actualKind !== input.expected.expect_nav_failure_kind) {
        failures.push(`expected nav_failure kind ${input.expected.expect_nav_failure_kind}, got ${actualKind}`);
      }
    }

    const observed = parsed.observed ?? "";
    const observedLower = observed.toLowerCase();
    for (const required of input.expected.required_observed_substrings) {
      if (!observedLower.includes(required.toLowerCase())) {
        failures.push(`observed missing required substring: ${required}`);
      }
    }

    for (const forbidden of input.expected.forbidden_observed_substrings) {
      if (observedLower.includes(forbidden.toLowerCase())) {
        failures.push(`observed contains forbidden substring: ${forbidden}`);
      }
    }

    for (const required of requiredEvidenceSubstrings) {
      if (!evidenceText.includes(required.toLowerCase())) {
        failures.push(`evidence missing required substring: ${required}`);
      }
    }
  }

  for (const required of input.expected.required_commands) {
    const matched = input.traceEntries.some((entry) => matchesRequiredCommand(entry.command, required));
    if (!matched) {
      failures.push(`missing required command: ${required}`);
    }
  }

  for (const forbidden of input.expected.forbidden_shell_patterns) {
    if (bashCommands.some((command) => command.includes(forbidden))) {
      failures.push(`stream log contains forbidden shell pattern: ${forbidden}`);
    }
  }

  for (const path of readPaths) {
    const allowed = allowedReadPathSuffixes.some((suffix) => path.endsWith(suffix));
    if (!allowed) {
      failures.push(`unexpected read path: ${path}`);
    }
  }

  if (commandCount > input.expected.max_command_count) {
    failures.push(`command count ${commandCount} exceeded max ${input.expected.max_command_count}`);
  }

  if (durationMs > input.expected.max_duration_ms) {
    failures.push(`duration ${durationMs}ms exceeded max ${input.expected.max_duration_ms}ms`);
  }

  return {
    caseId: input.caseId,
    passed: failures.length === 0,
    failures,
    durationMs,
    commandCount,
  };
}

export function scoreBrowseEvalArtifacts(paths: BrowseEvalArtifactPaths): BrowseEvalResult {
  const expected = JSON.parse(readFileSync(paths.expectedPath, "utf-8")) as BrowseEvalExpectation;
  const resultRaw = readOptional(paths.resultPath);
  const traceEntries = parseTrace(readOptional(paths.tracePath));
  const streamLog = readOptional(paths.streamPath);
  return scoreBrowseEvalCase({
    caseId: paths.caseId,
    expected,
    resultRaw,
    traceEntries,
    streamLog,
  });
}
