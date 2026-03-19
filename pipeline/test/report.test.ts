// pipeline/test/report.test.ts
import { describe, it, expect } from "vitest";
import { formatTerminalReport, formatTimingSummary } from "../src/report.js";
import type { ACVerdict, TimelineEvent } from "../src/lib/types.js";

describe("formatTerminalReport", () => {
  it("formats pass verdicts with checkmark", () => {
    const verdicts: ACVerdict[] = [
      { ac_id: "ac1", verdict: "pass", confidence: "high", reasoning: "Banner visible" },
    ];
    const output = formatTerminalReport(verdicts);
    expect(output).toContain("\u2713");
    expect(output).toContain("ac1");
    expect(output).toContain("1 pass");
  });

  it("formats fail verdicts with X", () => {
    const verdicts: ACVerdict[] = [
      { ac_id: "ac1", verdict: "fail", confidence: "medium", reasoning: "Not found" },
    ];
    const output = formatTerminalReport(verdicts);
    expect(output).toContain("\u2717");
    expect(output).toContain("medium confidence");
  });

  it("highlights low-confidence passes", () => {
    const verdicts: ACVerdict[] = [
      { ac_id: "ac1", verdict: "pass", confidence: "low", reasoning: "Ambiguous" },
    ];
    const output = formatTerminalReport(verdicts);
    expect(output).toContain("low confidence");
  });

  it("formats mixed verdicts with correct counts", () => {
    const verdicts: ACVerdict[] = [
      { ac_id: "ac1", verdict: "pass", confidence: "high", reasoning: "OK" },
      { ac_id: "ac2", verdict: "fail", confidence: "high", reasoning: "Missing" },
      { ac_id: "ac3", verdict: "timeout", confidence: "high", reasoning: "Slow" },
    ];
    const output = formatTerminalReport(verdicts);
    expect(output).toContain("1 pass");
    expect(output).toContain("1 fail");
    expect(output).toContain("1 other");
    expect(output).toContain("3 total");
  });

  it("returns message for empty verdicts", () => {
    const output = formatTerminalReport([]);
    expect(output).toContain("No verdicts");
  });

  it("highlights spec_unclear verdicts separately", () => {
    const verdicts: ACVerdict[] = [
      { ac_id: "ac1", verdict: "pass", confidence: "high", reasoning: "OK" },
      { ac_id: "ac2", verdict: "spec_unclear", confidence: "medium", reasoning: "Component found in onboarding, not billing" },
    ];
    const output = formatTerminalReport(verdicts);
    expect(output).toContain("NEEDS HUMAN REVIEW");
    expect(output).toContain("ac2");
    expect(output).toContain("onboarding");
    expect(output).toContain("1 spec_unclear");
    expect(output).toContain("? ac2");
  });
});

describe("formatTimingSummary", () => {
  it("computes total and per-stage durations", () => {
    const events: TimelineEvent[] = [
      { ts: "2026-03-18T14:00:00Z", stage: "planner", event: "start" },
      { ts: "2026-03-18T14:00:30Z", stage: "planner", event: "end", durationMs: 30000 },
      { ts: "2026-03-18T14:00:31Z", stage: "judge", event: "start" },
      { ts: "2026-03-18T14:01:01Z", stage: "judge", event: "end", durationMs: 30000 },
    ];
    const summary = formatTimingSummary(events);
    expect(summary).toContain("planner: 30s");
    expect(summary).toContain("judge: 30s");
    expect(summary).toContain("total: 61s");
  });

  it("marks timed out stages", () => {
    const events: TimelineEvent[] = [
      { ts: "2026-03-18T14:00:00Z", stage: "browse-agent-ac1", event: "start" },
      { ts: "2026-03-18T14:02:00Z", stage: "browse-agent-ac1", event: "timeout", durationMs: 120000 },
    ];
    const summary = formatTimingSummary(events);
    expect(summary).toContain("120s");
    expect(summary).toContain("timed out");
  });

  it("returns empty string for no completed events", () => {
    const summary = formatTimingSummary([]);
    expect(summary).toBe("");
  });
});
