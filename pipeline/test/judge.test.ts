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
});
