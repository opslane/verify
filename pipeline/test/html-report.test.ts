import { describe, it, expect, beforeEach } from "vitest";
import { generateHTMLReport } from "../src/lib/html-report.js";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ACVerdict } from "../src/lib/types.js";

describe("generateHTMLReport", () => {
  let runDir: string;

  beforeEach(() => {
    runDir = join(tmpdir(), `verify-test-${Date.now()}`);
    mkdirSync(join(runDir, "evidence", "ac1"), { recursive: true });
    mkdirSync(join(runDir, "evidence", "ac2"), { recursive: true });
  });

  it("generates valid HTML with correct verdict counts", () => {
    const verdicts: ACVerdict[] = [
      { ac_id: "ac1", verdict: "pass", confidence: "high", reasoning: "All good" },
      { ac_id: "ac2", verdict: "fail", confidence: "high", reasoning: "Missing button" },
    ];

    const path = generateHTMLReport(runDir, verdicts);
    expect(path).toContain("report.html");

    const html = readFileSync(path, "utf-8");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("1</div><div class=\"summary-label\">Pass");
    expect(html).toContain("1</div><div class=\"summary-label\">Fail");
    expect(html).toContain("ac1");
    expect(html).toContain("ac2");
    expect(html).toContain("All good");
    expect(html).toContain("Missing button");
  });

  it("handles empty verdicts", () => {
    const path = generateHTMLReport(runDir, []);
    const html = readFileSync(path, "utf-8");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("0</div><div class=\"summary-label\">Pass");
  });

  it("shows blocker section for blocked verdicts", () => {
    const verdicts: ACVerdict[] = [
      { ac_id: "ac1", verdict: "blocked", confidence: "high", reasoning: "Needs admin role" },
    ];

    const path = generateHTMLReport(runDir, verdicts);
    const html = readFileSync(path, "utf-8");
    expect(html).toContain("Blockers");
    expect(html).toContain("Needs admin role");
  });

  it("embeds screenshots as base64", () => {
    // Create a tiny 1x1 PNG
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    writeFileSync(join(runDir, "evidence", "ac1", "result.png"), png);

    // Also write a result.json so step trace appears
    writeFileSync(join(runDir, "evidence", "ac1", "result.json"), JSON.stringify({
      ac_id: "ac1",
      steps_taken: ["goto http://localhost:3000", "snapshot"],
    }));

    const verdicts: ACVerdict[] = [
      { ac_id: "ac1", verdict: "pass", confidence: "high", reasoning: "OK" },
    ];

    const path = generateHTMLReport(runDir, verdicts);
    const html = readFileSync(path, "utf-8");
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("goto http://localhost:3000");
  });

  it("shows placeholder when no screenshots exist", () => {
    // Use ac3 which has an empty evidence dir (no screenshots written by beforeEach or other tests)
    mkdirSync(join(runDir, "evidence", "ac3"), { recursive: true });
    const verdicts: ACVerdict[] = [
      { ac_id: "ac3", verdict: "pass", confidence: "high", reasoning: "OK" },
    ];

    const path = generateHTMLReport(runDir, verdicts);
    const html = readFileSync(path, "utf-8");
    expect(html).toContain("No screenshots captured");
  });

  it("escapes HTML in reasoning", () => {
    const verdicts: ACVerdict[] = [
      { ac_id: "ac1", verdict: "fail", confidence: "high", reasoning: 'Expected <button> to be "visible"' },
    ];

    const path = generateHTMLReport(runDir, verdicts);
    const html = readFileSync(path, "utf-8");
    expect(html).toContain("&lt;button&gt;");
    expect(html).not.toContain("<button>");
  });
});
