import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildLearnerPrompt, backupAndRestore } from "../src/stages/learner.js";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("buildLearnerPrompt", () => {
  it("substitutes all paths", () => {
    const prompt = buildLearnerPrompt({
      verdictsPath: "/tmp/run/verdicts.json",
      timelinePath: "/tmp/run/logs/timeline.jsonl",
      learningsPath: "/project/.verify/learnings.md",
    });
    expect(prompt).toContain("/tmp/run/verdicts.json");
    expect(prompt).toContain("/tmp/run/logs/timeline.jsonl");
    expect(prompt).toContain("/project/.verify/learnings.md");
    expect(prompt).not.toContain("{{");
  });
});

describe("backupAndRestore", () => {
  let verifyDir: string;

  beforeEach(() => { verifyDir = join(tmpdir(), `verify-learner-${Date.now()}`); mkdirSync(verifyDir, { recursive: true }); });
  afterEach(() => { rmSync(verifyDir, { recursive: true, force: true }); });

  it("creates backup of existing learnings", () => {
    const path = join(verifyDir, "learnings.md");
    writeFileSync(path, "# Existing learnings\n\nSome content here that matters.");
    const { backup } = backupAndRestore(path);
    expect(existsSync(backup)).toBe(true);
  });

  it("restores backup when file becomes empty", () => {
    const path = join(verifyDir, "learnings.md");
    writeFileSync(path, "# Existing learnings\n\nSome content here that matters.");
    const { restore } = backupAndRestore(path);
    writeFileSync(path, ""); // Simulate corruption
    restore();
    expect(readFileSync(path, "utf-8")).toContain("Existing learnings");
  });

  it("restores backup when file becomes too small", () => {
    const path = join(verifyDir, "learnings.md");
    writeFileSync(path, "# Existing learnings\n\nSome content here that matters.");
    const { restore } = backupAndRestore(path);
    writeFileSync(path, "tiny"); // Under 10 bytes
    restore();
    expect(readFileSync(path, "utf-8")).toContain("Existing learnings");
  });

  it("does NOT restore when file is valid", () => {
    const path = join(verifyDir, "learnings.md");
    writeFileSync(path, "# Old content that is fine");
    const { restore } = backupAndRestore(path);
    writeFileSync(path, "# New content from learner that is perfectly valid and long enough");
    restore();
    expect(readFileSync(path, "utf-8")).toContain("New content");
  });

  it("restore is no-op when no backup exists", () => {
    const path = join(verifyDir, "learnings.md");
    const { restore } = backupAndRestore(path);
    restore(); // Should not throw
    expect(existsSync(path)).toBe(false);
  });
});
