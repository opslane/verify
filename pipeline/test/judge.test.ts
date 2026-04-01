import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildJudgePrompt, parseJudgeOutput, collectEvidencePaths } from "../src/stages/judge.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("collectEvidencePaths", () => {
  let runDir: string;

  beforeEach(() => {
    runDir = join(tmpdir(), `verify-judge-${Date.now()}`);
    mkdirSync(join(runDir, "evidence", "ac1"), { recursive: true });
    mkdirSync(join(runDir, "evidence", "ac2"), { recursive: true });
    writeFileSync(join(runDir, "evidence", "ac1", "result.json"), "{}");
    writeFileSync(join(runDir, "evidence", "ac2", "result.json"), "{}");
  });

  afterEach(() => { rmSync(runDir, { recursive: true, force: true }); });

  it("finds all evidence directories with result.json", () => {
    const paths = collectEvidencePaths(runDir);
    expect(paths).toHaveLength(2);
    expect(paths.map(p => p.acId).sort()).toEqual(["ac1", "ac2"]);
  });

  it("skips directories without result.json", () => {
    mkdirSync(join(runDir, "evidence", "ac3"), { recursive: true });
    // ac3 has no result.json
    const paths = collectEvidencePaths(runDir);
    expect(paths).toHaveLength(2);
  });

  it("returns empty array when no evidence directory exists", () => {
    const emptyDir = join(tmpdir(), `verify-empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    expect(collectEvidencePaths(emptyDir)).toHaveLength(0);
    rmSync(emptyDir, { recursive: true, force: true });
  });
});

describe("buildJudgePrompt", () => {
  it("includes evidence file paths", () => {
    const prompt = buildJudgePrompt([
      { acId: "ac1", resultPath: "/tmp/evidence/ac1/result.json" },
    ]);
    expect(prompt).toContain("ac1");
    expect(prompt).toContain("/tmp/evidence/ac1/result.json");
  });

  it("includes AC description when provided", () => {
    const prompt = buildJudgePrompt([
      { acId: "ac1", resultPath: "/tmp/evidence/ac1/result.json", description: "User can log in with valid credentials" },
    ]);
    expect(prompt).toContain("User can log in with valid credentials");
  });

  it("works without description (backward compatible)", () => {
    const prompt = buildJudgePrompt([
      { acId: "ac1", resultPath: "/tmp/evidence/ac1/result.json" },
    ]);
    expect(prompt).not.toContain('""');
    expect(prompt).toContain("AC ac1:");
  });
});

describe("collectEvidencePaths reads instructions.json", () => {
  let runDir: string;

  beforeEach(() => {
    runDir = join(tmpdir(), `verify-judge-instr-${Date.now()}`);
    mkdirSync(join(runDir, "evidence", "ac1"), { recursive: true });
    writeFileSync(join(runDir, "evidence", "ac1", "result.json"), "{}");
    writeFileSync(join(runDir, "evidence", "ac1", "instructions.json"), JSON.stringify({
      ac_id: "ac1",
      description: "Page loads without errors",
    }));
  });

  afterEach(() => { rmSync(runDir, { recursive: true, force: true }); });

  it("reads description from instructions.json", () => {
    const paths = collectEvidencePaths(runDir);
    expect(paths[0].description).toBe("Page loads without errors");
  });
});

describe("parseJudgeOutput", () => {
  it("parses valid verdicts with confidence", () => {
    const output = JSON.stringify({
      verdicts: [{ ac_id: "ac1", verdict: "pass", confidence: "high", reasoning: "looks good" }],
    });
    const result = parseJudgeOutput(output);
    expect(result).not.toBeNull();
    expect(result!.verdicts[0].confidence).toBe("high");
  });

  it("returns null for missing verdicts array", () => {
    expect(parseJudgeOutput('{"foo": "bar"}')).toBeNull();
  });

  it("returns null for garbage", () => {
    expect(parseJudgeOutput("nope")).toBeNull();
  });

  it("returns null for invalid verdict values", () => {
    const output = JSON.stringify({
      verdicts: [{ ac_id: "ac1", verdict: "maybe", confidence: "high", reasoning: "unsure" }],
    });
    expect(parseJudgeOutput(output)).toBeNull();
  });

  it("returns null for invalid confidence values", () => {
    const output = JSON.stringify({
      verdicts: [{ ac_id: "ac1", verdict: "pass", confidence: "very_high", reasoning: "sure" }],
    });
    expect(parseJudgeOutput(output)).toBeNull();
  });

  it("returns null for missing ac_id", () => {
    const output = JSON.stringify({
      verdicts: [{ verdict: "pass", confidence: "high", reasoning: "ok" }],
    });
    expect(parseJudgeOutput(output)).toBeNull();
  });

  it("parses markdown-fenced JSON from LLM output", () => {
    const output = '```json\n{"verdicts":[{"ac_id":"ac1","verdict":"fail","confidence":"medium","reasoning":"not found"}]}\n```';
    const result = parseJudgeOutput(output);
    expect(result).not.toBeNull();
    expect(result!.verdicts[0].verdict).toBe("fail");
  });
});
