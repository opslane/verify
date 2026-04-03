// pipeline/src/lib/html-report.ts — Generate HTML evidence report
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ACVerdict } from "./types.js";

function statusColor(verdict: string): string {
  switch (verdict) {
    case "pass": return "#16a34a";
    case "fail": return "#dc2626";
    case "blocked": return "#d97706";
    case "unclear": return "#6b7280";
    case "timeout": return "#9333ea";
    default: return "#ef4444";
  }
}

function statusIcon(verdict: string): string {
  switch (verdict) {
    case "pass": return "\u2713";
    case "fail": return "\u2717";
    case "blocked": return "\u26d4";
    case "unclear": return "?";
    case "timeout": return "\u231b";
    default: return "!";
  }
}

function loadScreenshots(evidenceDir: string): string[] {
  if (!existsSync(evidenceDir)) return [];
  return readdirSync(evidenceDir)
    .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
    .sort();
}

function embedImage(filePath: string): string {
  try {
    const data = readFileSync(filePath);
    const ext = filePath.endsWith(".png") ? "png" : filePath.endsWith(".webp") ? "webp" : "jpeg";
    return `data:image/${ext};base64,${data.toString("base64")}`;
  } catch {
    return "";
  }
}

function loadResult(evidenceDir: string): Record<string, unknown> | null {
  const resultPath = join(evidenceDir, "result.json");
  if (!existsSync(resultPath)) return null;
  try {
    return JSON.parse(readFileSync(resultPath, "utf-8"));
  } catch {
    return null;
  }
}

export function generateHTMLReport(runDir: string, verdicts: ACVerdict[]): string {
  const passCount = verdicts.filter(v => v.verdict === "pass").length;
  const failCount = verdicts.filter(v => v.verdict === "fail").length;
  const blockedCount = verdicts.filter(v => v.verdict === "blocked").length;
  const otherCount = verdicts.length - passCount - failCount - blockedCount;

  const acCards = verdicts.map(v => {
    const evidenceDir = join(runDir, "evidence", v.ac_id);
    const screenshots = loadScreenshots(evidenceDir);
    const result = loadResult(evidenceDir);
    const stepsHtml = result && Array.isArray(result.steps_taken)
      ? (result.steps_taken as string[]).map(s => `<li><code>${escapeHtml(s)}</code></li>`).join("")
      : "<li>No steps recorded</li>";
    const screenshotHtml = screenshots.length > 0
      ? screenshots.map(s => {
          const src = embedImage(join(evidenceDir, s));
          return src ? `<div class="screenshot"><img src="${src}" alt="${escapeHtml(s)}"><p>${escapeHtml(s)}</p></div>` : "";
        }).join("")
      : "<p class=\"no-evidence\">No screenshots captured</p>";

    return `
    <div class="ac-card">
      <div class="ac-header">
        <span class="status-badge" style="background:${statusColor(v.verdict)}">${statusIcon(v.verdict)} ${v.verdict.toUpperCase()}</span>
        <span class="ac-id">${escapeHtml(v.ac_id)}</span>
        <span class="confidence">${v.confidence} confidence</span>
      </div>
      <div class="reasoning">${escapeHtml(v.reasoning)}</div>
      <details>
        <summary>Evidence</summary>
        <div class="screenshots">${screenshotHtml}</div>
        <div class="steps"><h4>Steps</h4><ol>${stepsHtml}</ol></div>
      </details>
    </div>`;
  }).join("\n");

  const blockerSection = blockedCount > 0
    ? `<div class="blocker-section">
        <h2>Blockers</h2>
        ${verdicts.filter(v => v.verdict === "blocked").map(v =>
          `<div class="blocker-item"><strong>${escapeHtml(v.ac_id)}:</strong> ${escapeHtml(v.reasoning)}</div>`
        ).join("")}
      </div>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verify Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #1e293b; padding: 24px; max-width: 960px; margin: 0 auto; }
  h1 { font-size: 24px; margin-bottom: 16px; }
  .summary-bar { display: flex; gap: 16px; margin-bottom: 24px; padding: 16px; background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .summary-item { text-align: center; }
  .summary-count { font-size: 32px; font-weight: 700; }
  .summary-label { font-size: 12px; color: #64748b; text-transform: uppercase; }
  .ac-card { background: white; border-radius: 8px; padding: 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .ac-header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  .status-badge { color: white; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; }
  .ac-id { font-weight: 600; font-size: 14px; }
  .confidence { font-size: 12px; color: #94a3b8; }
  .reasoning { font-size: 14px; color: #475569; margin-bottom: 8px; }
  details { margin-top: 8px; }
  summary { cursor: pointer; font-size: 13px; color: #3b82f6; }
  .screenshots { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .screenshot { flex: 0 0 auto; }
  .screenshot img { max-width: 400px; max-height: 300px; border: 1px solid #e2e8f0; border-radius: 4px; }
  .screenshot p { font-size: 11px; color: #94a3b8; text-align: center; }
  .no-evidence { font-size: 13px; color: #94a3b8; font-style: italic; }
  .steps ol { font-size: 13px; padding-left: 20px; margin-top: 4px; }
  .steps code { font-size: 12px; background: #f1f5f9; padding: 1px 4px; border-radius: 3px; }
  .blocker-section { background: #fffbeb; border: 1px solid #fbbf24; border-radius: 8px; padding: 16px; margin-top: 24px; }
  .blocker-section h2 { font-size: 16px; color: #92400e; margin-bottom: 8px; }
  .blocker-item { font-size: 14px; margin-bottom: 4px; }
</style>
</head>
<body>
<h1>Verify Report</h1>
<div class="summary-bar">
  <div class="summary-item"><div class="summary-count" style="color:#16a34a">${passCount}</div><div class="summary-label">Pass</div></div>
  <div class="summary-item"><div class="summary-count" style="color:#dc2626">${failCount}</div><div class="summary-label">Fail</div></div>
  <div class="summary-item"><div class="summary-count" style="color:#d97706">${blockedCount}</div><div class="summary-label">Blocked</div></div>
  ${otherCount > 0 ? `<div class="summary-item"><div class="summary-count" style="color:#6b7280">${otherCount}</div><div class="summary-label">Other</div></div>` : ""}
</div>
${acCards}
${blockerSection}
<p style="margin-top:24px;font-size:12px;color:#94a3b8">Generated by /verify</p>
</body>
</html>`;

  const outputPath = join(runDir, "report.html");
  writeFileSync(outputPath, html);
  return outputPath;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
