// pipeline/test/browse-agent.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { buildBrowseAgentPrompt, writeInstructionsFile, parseBrowseResult } from "../src/stages/browse-agent.js";
import { isAuthFailure } from "../src/lib/types.js";
import type { PlannedAC } from "../src/lib/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const mockAC: PlannedAC = {
  id: "ac1", group: "group-a", description: "Trial banner appears",
  url: "/environments/clseedenvprod000000000/settings/billing",
  steps: ["Navigate to billing", "Look for trial banner"],
  screenshot_at: ["trial_banner"], timeout_seconds: 90,
};

describe("writeInstructionsFile", () => {
  let evidenceDir: string;

  beforeEach(() => { evidenceDir = join(tmpdir(), `verify-browse-${Date.now()}`); });
  afterEach(() => { rmSync(evidenceDir, { recursive: true, force: true }); });

  it("writes instructions.json with exact URL", () => {
    const path = writeInstructionsFile(mockAC, {
      baseUrl: "http://localhost:3002", browseBin: "/usr/bin/browse", evidenceDir,
    });
    expect(existsSync(path)).toBe(true);
    const instructions = JSON.parse(readFileSync(path, "utf-8"));
    expect(instructions.url).toBe("http://localhost:3002/environments/clseedenvprod000000000/settings/billing");
    expect(instructions.ac_id).toBe("ac1");
    expect(instructions.steps).toHaveLength(2);
  });

  it("preserves long IDs exactly — no truncation", () => {
    const longIdAC: PlannedAC = {
      ...mockAC,
      url: "/environments/clseedenvprod000000000/settings/billing",
    };
    const path = writeInstructionsFile(longIdAC, {
      baseUrl: "http://localhost:3002", browseBin: "/usr/bin/browse", evidenceDir,
    });
    const instructions = JSON.parse(readFileSync(path, "utf-8"));
    // The full ID has 21 chars of zeros — verify exact match, not a truncated version
    expect(instructions.url).toBe("http://localhost:3002/environments/clseedenvprod000000000/settings/billing");
  });
});

describe("buildBrowseAgentPrompt", () => {
  let evidenceDir: string;

  beforeEach(() => { evidenceDir = join(tmpdir(), `verify-browse-${Date.now()}`); });
  afterEach(() => { rmSync(evidenceDir, { recursive: true, force: true }); });

  it("references instructions file path, not inline URL", () => {
    const prompt = buildBrowseAgentPrompt(mockAC, {
      baseUrl: "http://localhost:3002", browseBin: "/usr/local/bin/browse", evidenceDir,
    });
    expect(prompt).toContain("instructions.json");
    expect(prompt).toContain("/usr/local/bin/browse");
    expect(prompt).not.toContain("{{");
  });

  it("creates instructions.json on disk", () => {
    buildBrowseAgentPrompt(mockAC, {
      baseUrl: "http://localhost:3002", browseBin: "/usr/local/bin/browse", evidenceDir,
    });
    expect(existsSync(join(evidenceDir, "instructions.json"))).toBe(true);
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
});
