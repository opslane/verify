// pipeline/src/report.ts — Deterministic report formatting from verdicts + timeline
import type { ACVerdict, TimelineEvent } from "./lib/types.js";

export function formatTerminalReport(verdicts: ACVerdict[]): string {
  if (verdicts.length === 0) return "No verdicts to report.";

  const lines: string[] = [];
  const passCount = verdicts.filter(v => v.verdict === "pass").length;
  const failCount = verdicts.filter(v => v.verdict === "fail").length;
  const specUnclearCount = verdicts.filter(v => v.verdict === "spec_unclear").length;
  const otherCount = verdicts.length - passCount - failCount - specUnclearCount;

  let summary = `\nResults: ${passCount} pass, ${failCount} fail`;
  if (specUnclearCount > 0) summary += `, ${specUnclearCount} spec_unclear`;
  if (otherCount > 0) summary += `, ${otherCount} other`;
  summary += ` (${verdicts.length} total)\n`;
  lines.push(summary);

  for (const v of verdicts) {
    let icon = "!";
    if (v.verdict === "pass") icon = "\u2713";
    else if (v.verdict === "fail") icon = "\u2717";
    else if (v.verdict === "spec_unclear") icon = "?";
    const conf = v.confidence !== "high" ? ` (${v.confidence} confidence)` : "";
    lines.push(`  ${icon} ${v.ac_id}: ${v.verdict}${conf} \u2014 ${v.reasoning}`);
  }

  const specUnclear = verdicts.filter(v => v.verdict === "spec_unclear");
  if (specUnclear.length > 0) {
    lines.push("");
    lines.push("  NEEDS HUMAN REVIEW (spec may be inaccurate):");
    for (const v of specUnclear) {
      lines.push(`    ? ${v.ac_id}: ${v.reasoning}`);
    }
  }

  return lines.join("\n");
}

export function formatTimingSummary(events: TimelineEvent[]): string {
  const completed = events.filter(e => e.event === "end" || e.event === "timeout");
  if (completed.length === 0) return "";

  const lines: string[] = ["\nTiming:"];
  for (const e of completed) {
    const secs = e.durationMs ? `${Math.round(e.durationMs / 1000)}s` : "?";
    const suffix = e.event === "timeout" ? " (timed out)" : "";
    lines.push(`  ${e.stage}: ${secs}${suffix}`);
  }

  // Total wall-clock from first start to last end
  if (events.length >= 2) {
    const first = new Date(events[0].ts).getTime();
    const last = new Date(events[events.length - 1].ts).getTime();
    const totalSecs = Math.round((last - first) / 1000);
    lines.push(`  total: ${totalSecs}s`);
  }

  return lines.join("\n");
}
