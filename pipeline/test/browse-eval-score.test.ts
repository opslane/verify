import { describe, it, expect } from "vitest";
import type { BrowseEvalExpectation, BrowseTraceEntry } from "../src/evals/browse-eval-types.js";
import { scoreBrowseEvalCase } from "../src/evals/browse-eval-score.js";

function makeExpectation(overrides: Partial<BrowseEvalExpectation> = {}): BrowseEvalExpectation {
  return {
    ac_id: "ac1",
    expect_parseable_result: true,
    expect_result_kind: "normal",
    required_commands: ["goto", "snapshot", "hover", "screenshot"],
    forbidden_shell_patterns: ["rg ", "grep "],
    required_observed_substrings: ["tooltip"],
    forbidden_observed_substrings: ["error"],
    max_command_count: 6,
    max_duration_ms: 20_000,
    ...overrides,
  };
}

function makeTrace(entries: Array<Partial<BrowseTraceEntry> & Pick<BrowseTraceEntry, "command">>): BrowseTraceEntry[] {
  return entries.map((entry, index) => ({
    ts: entry.ts ?? `2026-03-22T10:00:0${index}.000Z`,
    command: entry.command,
    exitCode: entry.exitCode ?? 0,
    stdout: entry.stdout ?? "",
    stderr: entry.stderr ?? "",
  }));
}

describe("scoreBrowseEvalCase", () => {
  it("passes when result, trace, and stream log all match expectations", () => {
    const result = scoreBrowseEvalCase({
      caseId: "tooltip-hover-success",
      expected: makeExpectation(),
      resultRaw: JSON.stringify({
        ac_id: "ac1",
        observed: "Tooltip visible with 14 days left in your trial",
        screenshots: ["tooltip.png"],
        commands_run: [],
      }),
      traceEntries: makeTrace([
        { command: "goto http://localhost:3000/settings/billing" },
        { command: "snapshot" },
        { command: "hover @e70" },
        { command: "screenshot /tmp/tooltip.png" },
      ]),
      streamLog: "",
    });

    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.commandCount).toBe(4);
    expect(result.durationMs).toBe(3000);
  });

  it("fails when a required command is missing from the trace", () => {
    const result = scoreBrowseEvalCase({
      caseId: "tooltip-hover-success",
      expected: makeExpectation(),
      resultRaw: JSON.stringify({
        ac_id: "ac1",
        observed: "Tooltip visible",
        screenshots: ["tooltip.png"],
        commands_run: [],
      }),
      traceEntries: makeTrace([
        { command: "goto http://localhost:3000/settings/billing" },
        { command: "snapshot" },
        { command: "screenshot /tmp/tooltip.png" },
      ]),
      streamLog: "",
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("missing required command: hover");
  });

  it("fails when the stream log contains forbidden shell usage", () => {
    const result = scoreBrowseEvalCase({
      caseId: "tooltip-hover-success",
      expected: makeExpectation(),
      resultRaw: JSON.stringify({
        ac_id: "ac1",
        observed: "Tooltip visible",
        screenshots: ["tooltip.png"],
        commands_run: [],
      }),
      traceEntries: makeTrace([
        { command: "goto http://localhost:3000/settings/billing" },
        { command: "snapshot" },
        { command: "hover @e70" },
        { command: "screenshot /tmp/tooltip.png" },
      ]),
      streamLog: "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Bash\",\"input\":{\"command\":\"rg src\"}}]}}",
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("stream log contains forbidden shell pattern: rg ");
  });

  it("does not flag forbidden shell patterns from non-command text", () => {
    const result = scoreBrowseEvalCase({
      caseId: "tooltip-hover-timeout",
      expected: makeExpectation({
        expect_result_kind: "nav_failure",
        forbidden_shell_patterns: ["ls "],
        required_observed_substrings: ["timed out"],
      }),
      resultRaw: JSON.stringify({
        ac_id: "ac1",
        nav_failure: {
          failed_step: "hover @e1",
          error: "Operation timed out: hover: Timeout 5000ms exceeded.",
          page_snapshot: "@e1 [button] \"Trial\"",
        },
        screenshots: ["nav-failure.png"],
        commands_run: [],
      }),
      traceEntries: makeTrace([
        { command: "goto http://localhost:3000/settings/billing" },
        { command: "snapshot" },
        { command: "hover @e1", exitCode: 1 },
        { command: "screenshot /tmp/nav-failure.png" },
      ]),
      streamLog: "{\"type\":\"user\",\"message\":{\"content\":\"The browse agent fails fast when the hover target times out.\"}}",
    });

    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("fails when nav_failure kind does not match the expectation", () => {
    const result = scoreBrowseEvalCase({
      caseId: "tooltip-hover-timeout",
      expected: {
        ...makeExpectation({
          expect_result_kind: "nav_failure",
          required_commands: ["goto", "snapshot", "hover", "snapshot", "screenshot"],
          required_observed_substrings: ["timed out"],
        }),
        expect_nav_failure_kind: "interaction",
      } as BrowseEvalExpectation & { expect_nav_failure_kind: "interaction" },
      resultRaw: JSON.stringify({
        ac_id: "ac1",
        nav_failure: {
          kind: "navigation",
          failed_step: "hover #missing-trial-badge",
          error: "Operation timed out: hover: Timeout 5000ms exceeded.",
          page_snapshot: "@e1 [button] \"Trial\"",
        },
        screenshots: ["nav-failure.png"],
        commands_run: [],
      }),
      traceEntries: makeTrace([
        { command: "goto http://localhost:3000/trial" },
        { command: "snapshot" },
        { command: "hover #missing-trial-badge", exitCode: 1 },
        { command: "snapshot" },
        { command: "screenshot /tmp/nav-failure.png" },
      ]),
      streamLog: "",
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("expected nav_failure kind interaction, got navigation");
  });

  it("fails when required evidence text is not backed by the trace or page snapshot", () => {
    const result = scoreBrowseEvalCase({
      caseId: "tooltip-hover-success",
      expected: {
        ...makeExpectation({
          required_observed_substrings: ["Tooltip visible"],
        }),
        required_evidence_substrings: ["14 days left in your trial"],
      } as BrowseEvalExpectation,
      resultRaw: JSON.stringify({
        ac_id: "ac1",
        observed: "Tooltip visible with 14 days left in your trial",
        screenshots: ["tooltip.png"],
        commands_run: [],
      }),
      traceEntries: makeTrace([
        { command: "goto http://localhost:3000/settings/billing", stdout: "Navigated." },
        { command: "snapshot", stdout: "@e1 [button] \"Trial\"" },
        { command: "hover @e70", stdout: "Tooltip opened." },
        { command: "screenshot /tmp/tooltip.png", stdout: "Screenshot saved." },
      ]),
      streamLog: "",
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("evidence missing required substring: 14 days left in your trial");
  });

  it("fails when the agent reads files outside the instructions payload", () => {
    const result = scoreBrowseEvalCase({
      caseId: "tooltip-hover-success",
      expected: {
        ...makeExpectation(),
        allowed_read_path_suffixes: ["instructions.json"],
      } as BrowseEvalExpectation,
      resultRaw: JSON.stringify({
        ac_id: "ac1",
        observed: "Tooltip visible",
        screenshots: ["tooltip.png"],
        commands_run: [],
      }),
      traceEntries: makeTrace([
        { command: "goto http://localhost:3000/settings/billing" },
        { command: "snapshot" },
        { command: "hover @e70" },
        { command: "screenshot /tmp/tooltip.png" },
      ]),
      streamLog: [
        "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Read\",\"input\":{\"file_path\":\"/tmp/run/evidence/ac1/instructions.json\"}}]}}",
        "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Read\",\"input\":{\"file_path\":\"/Users/abhishekray/Projects/opslane/verify/.worktrees/browse-evals-v1/pipeline/src/orchestrator.ts\"}}]}}",
      ].join("\n"),
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("unexpected read path: /Users/abhishekray/Projects/opslane/verify/.worktrees/browse-evals-v1/pipeline/src/orchestrator.ts");
  });

  it("fails when trace duration exceeds the expected threshold", () => {
    const result = scoreBrowseEvalCase({
      caseId: "wait-for-data",
      expected: makeExpectation({
        required_commands: ["goto", "snapshot", "wait", "screenshot"],
        max_duration_ms: 5_000,
      }),
      resultRaw: JSON.stringify({
        ac_id: "ac1",
        observed: "rows loaded",
        screenshots: ["rows.png"],
        commands_run: [],
      }),
      traceEntries: makeTrace([
        { command: "goto http://localhost:3000/reports", ts: "2026-03-22T10:00:00.000Z" },
        { command: "snapshot", ts: "2026-03-22T10:00:01.000Z" },
        { command: "wait 5000", ts: "2026-03-22T10:00:08.000Z" },
        { command: "screenshot /tmp/rows.png", ts: "2026-03-22T10:00:12.000Z" },
      ]),
      streamLog: "",
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("duration 12000ms exceeded max 5000ms");
  });
});
