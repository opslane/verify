// pipeline/test/browse-agent.test.ts
import { describe, it, expect } from "vitest";
import { buildBrowseAgentPrompt, parseBrowseResult } from "../src/stages/browse-agent.js";
import type { PlannedAC } from "../src/lib/types.js";

const mockAC: PlannedAC = {
  id: "ac1", group: "group-a", description: "Trial banner appears",
  url: "/settings", steps: ["Navigate to settings", "Look for trial banner"],
  screenshot_at: ["trial_banner"], timeout_seconds: 90,
};

describe("buildBrowseAgentPrompt", () => {
  it("substitutes all placeholders", () => {
    const prompt = buildBrowseAgentPrompt(mockAC, {
      baseUrl: "http://localhost:3000", browseBin: "/usr/local/bin/browse",
      evidenceDir: "/tmp/evidence/ac1",
    });
    expect(prompt).toContain("Trial banner appears");
    expect(prompt).toContain("http://localhost:3000/settings");
    expect(prompt).toContain("/usr/local/bin/browse");
    expect(prompt).toContain("/tmp/evidence/ac1");
    expect(prompt).not.toContain("{{");
  });
});

describe("parseBrowseResult", () => {
  it("parses valid result", () => {
    const output = JSON.stringify({
      ac_id: "ac1", observed: "Trial banner visible",
      screenshots: ["screenshot-banner.png"], commands_run: ["goto ..."],
    });
    const result = parseBrowseResult(output);
    expect(result).not.toBeNull();
    expect(result!.ac_id).toBe("ac1");
  });

  it("returns null for invalid output", () => {
    expect(parseBrowseResult("garbage")).toBeNull();
  });

  it("returns null when observed is missing", () => {
    expect(parseBrowseResult('{"ac_id": "ac1"}')).toBeNull();
  });
});
