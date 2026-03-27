// pipeline/test/browse-agent.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { buildBrowseAgentPrompt, writeInstructionsFile, parseBrowseResult, buildReplanPrompt, parseReplanOutput } from "../src/stages/browse-agent.js";
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

  it("documents hover, press, and wait commands explicitly", () => {
    const prompt = buildBrowseAgentPrompt(mockAC, {
      baseUrl: "http://localhost:3002", browseBin: "/usr/local/bin/browse", evidenceDir,
    });
    expect(prompt).toContain("/usr/local/bin/browse hover <selector>");
    expect(prompt).toContain("/usr/local/bin/browse press <key>");
    expect(prompt).toContain("/usr/local/bin/browse wait <selector|--networkidle|--load>");
  });

  it("tells the agent to quote CSS selectors in Bash commands", () => {
    const prompt = buildBrowseAgentPrompt(mockAC, {
      baseUrl: "http://localhost:3002", browseBin: "/usr/local/bin/browse", evidenceDir,
    });
    expect(prompt).toContain("wrap it in double quotes");
    expect(prompt).toContain('/usr/local/bin/browse click "#more-actions-button"');
    expect(prompt).toContain('/usr/local/bin/browse hover "#trial-badge"');
  });

  it("requires fail-fast for hover and press failures and forbids selector invention", () => {
    const prompt = buildBrowseAgentPrompt(mockAC, {
      baseUrl: "http://localhost:3002", browseBin: "/usr/local/bin/browse", evidenceDir,
    });
    expect(prompt).toContain("If any `browse click`, `browse fill`, `browse upload`, `browse hover`, `browse press`, or `browse wait` command returns");
    expect(prompt).toContain("Do NOT try alternative selectors");
    expect(prompt).toContain("Do NOT invent selectors");
    expect(prompt).toContain("Do NOT search the codebase");
  });

  it("requires observed auth redirects to be labeled clearly", () => {
    const prompt = buildBrowseAgentPrompt(mockAC, {
      baseUrl: "http://localhost:3002", browseBin: "/usr/local/bin/browse", evidenceDir,
    });
    expect(prompt).toContain("start the observed text with `Auth redirect:`");
  });

  it("treats generic page-load waits as snapshot checks unless content is still loading", () => {
    const prompt = buildBrowseAgentPrompt(mockAC, {
      baseUrl: "http://localhost:3002", browseBin: "/usr/local/bin/browse", evidenceDir,
    });
    expect(prompt).toContain("After `goto`, the first `snapshot` is usually enough for a generic \"Wait for page load\" step.");
    expect(prompt).toContain("Only run `wait` when the page still shows loading state");
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

  it("parses nav_failure result", () => {
    const output = JSON.stringify({
      ac_id: "ac1",
      nav_failure: {
        failed_step: "click [data-testid=event-type-options-1159]",
        error: "Operation timed out: click: Timeout 5000ms exceeded.",
        page_snapshot: "Tabs: [Personal] [Seeded Team]\nEvent types: 30 min meeting",
      },
      screenshots: ["nav-failure.png"],
      commands_run: ["goto http://localhost:3000/event-types", "click [data-testid=event-type-options-1159]"],
    });
    const result = parseBrowseResult(output);
    expect(result).not.toBeNull();
    expect(result!.ac_id).toBe("ac1");
    expect(result!.nav_failure).toBeDefined();
    expect(result!.nav_failure!.failed_step).toBe("click [data-testid=event-type-options-1159]");
    expect(result!.nav_failure!.page_snapshot).toContain("Seeded Team");
    expect((result!.nav_failure as any).kind).toBe("navigation");
    expect(result!.observed).toContain("click [data-testid=event-type-options-1159]");
    expect(result!.observed).toContain("Operation timed out");
  });

  it("synthesizes useful observed text for hover nav failures", () => {
    const output = JSON.stringify({
      ac_id: "ac1",
      nav_failure: {
        failed_step: "hover @e1",
        error: "Operation timed out: hover: Timeout 5000ms exceeded.",
        page_snapshot: "@e1 [button] \"Trial\"",
      },
      screenshots: ["nav-failure.png"],
      commands_run: ["goto http://localhost:3000/settings/billing", "hover @e1"],
    });
    const result = parseBrowseResult(output);
    expect(result).not.toBeNull();
    expect(result!.observed).toContain("hover @e1");
    expect(result!.observed).toContain("Operation timed out");
  });

  it("preserves explicit interaction failure kind", () => {
    const output = JSON.stringify({
      ac_id: "ac1",
      nav_failure: {
        kind: "interaction",
        failed_step: "hover @e1",
        error: "Operation timed out: hover: Timeout 5000ms exceeded.",
        page_snapshot: "@e1 [button] \"Trial\"",
      },
      screenshots: ["nav-failure.png"],
      commands_run: ["goto http://localhost:3000/settings/billing", "hover @e1"],
    });
    const result = parseBrowseResult(output);
    expect(result).not.toBeNull();
    expect((result!.nav_failure as any).kind).toBe("interaction");
  });

  it("parses normal result without nav_failure", () => {
    const output = JSON.stringify({
      ac_id: "ac1", observed: "Banner visible",
      screenshots: ["s.png"], commands_run: ["goto ..."],
    });
    const result = parseBrowseResult(output);
    expect(result).not.toBeNull();
    expect(result!.nav_failure).toBeUndefined();
  });
});

describe("buildReplanPrompt", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = join(tmpdir(), `verify-replan-${Date.now()}`); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("substitutes replan input path into template", () => {
    mkdirSync(tmpDir, { recursive: true });
    const inputPath = join(tmpDir, "replan-input.json");
    writeFileSync(inputPath, JSON.stringify({
      ac_id: "ac2",
      description: "Duplicate dialog for managed event type",
      original_steps: ["Navigate to /event-types", "Click [data-testid=event-type-options-1159]"],
      failed_step: "Click [data-testid=event-type-options-1159]",
      error: "Operation timed out: click: Timeout 5000ms exceeded.",
      page_snapshot: "Tabs: [Personal] [Seeded Team]",
    }));
    const prompt = buildReplanPrompt(inputPath);
    expect(prompt).toContain(inputPath);
    expect(prompt).not.toContain("{{");
  });
});

describe("parseReplanOutput", () => {
  it("parses revised steps", () => {
    const output = JSON.stringify({
      revised_steps: [
        "Click the 'Seeded Team' tab",
        "Wait for page load",
        "Click [data-testid=event-type-options-1159]",
      ],
    });
    const result = parseReplanOutput(output);
    expect(result).not.toBeNull();
    expect(result!.revised_steps).toHaveLength(3);
    expect(result!.revised_steps![0]).toContain("Seeded Team");
  });

  it("parses null revised_steps (element genuinely missing)", () => {
    const output = JSON.stringify({ revised_steps: null });
    const result = parseReplanOutput(output);
    expect(result).not.toBeNull();
    expect(result!.revised_steps).toBeNull();
  });

  it("treats empty revised_steps array as null", () => {
    const output = JSON.stringify({ revised_steps: [] });
    const result = parseReplanOutput(output);
    expect(result).not.toBeNull();
    expect(result!.revised_steps).toBeNull();
  });

  it("returns null for unparseable output", () => {
    expect(parseReplanOutput("garbage")).toBeNull();
  });

  it("returns null for empty output", () => {
    expect(parseReplanOutput("")).toBeNull();
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
