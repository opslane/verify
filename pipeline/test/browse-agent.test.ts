// pipeline/test/browse-agent.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBrowseAgentPrompt, parseBrowseResult } from "../src/stages/browse-agent.js";
import { isAuthFailure } from "../src/lib/types.js";
import type { PlannedAC } from "../src/lib/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

describe("auth failure fixture integration", () => {
  it("parseBrowseResult + isAuthFailure detects auth failure from fixture", () => {
    const raw = readFileSync(join(__dirname, "fixtures", "result-auth-failure.json"), "utf-8");
    const result = parseBrowseResult(raw);
    expect(result).not.toBeNull();
    expect(result!.ac_id).toBe("ac1");
    expect(isAuthFailure(result!.observed)).toBe(true);
  });

  it("isAuthFailure detects auth redirect URL", () => {
    const result = parseBrowseResult(JSON.stringify({
      ac_id: "ac2", observed: "Page loaded",
      screenshots: [], commands_run: ["goto http://localhost:3000/login"],
    }));
    expect(result).not.toBeNull();
    expect(isAuthFailure(result!.observed, "http://localhost:3000/login")).toBe(true);
  });
});
