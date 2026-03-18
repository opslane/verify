// pipeline/test/setup-writer.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildSetupWriterPrompt, parseSetupWriterOutput, detectORM } from "../src/stages/setup-writer.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("buildSetupWriterPrompt", () => {
  it("substitutes group id and condition", () => {
    const prompt = buildSetupWriterPrompt("group-a", "org in trialing state");
    expect(prompt).toContain("group-a");
    expect(prompt).toContain("org in trialing state");
    expect(prompt).not.toContain("{{groupId}}");
    expect(prompt).not.toContain("{{condition}}");
  });
});

describe("parseSetupWriterOutput", () => {
  it("parses valid output", () => {
    const output = JSON.stringify({
      group_id: "group-a", condition: "org in trialing state",
      setup_commands: ["psql ..."], teardown_commands: ["psql ..."],
    });
    expect(parseSetupWriterOutput(output)).not.toBeNull();
  });

  it("returns null for invalid output", () => {
    expect(parseSetupWriterOutput("garbage")).toBeNull();
  });

  it("returns null when setup_commands is missing", () => {
    expect(parseSetupWriterOutput('{"group_id": "g1"}')).toBeNull();
  });
});

describe("detectORM", () => {
  let tempDir: string;

  beforeEach(() => { tempDir = join(tmpdir(), `orm-detect-${Date.now()}`); mkdirSync(tempDir, { recursive: true }); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("detects Prisma when schema.prisma exists", () => {
    mkdirSync(join(tempDir, "prisma"), { recursive: true });
    writeFileSync(join(tempDir, "prisma", "schema.prisma"), "model User {}");
    expect(detectORM(tempDir)).toBe("prisma");
  });

  it("detects Drizzle when drizzle.config.ts exists", () => {
    writeFileSync(join(tempDir, "drizzle.config.ts"), "export default {}");
    expect(detectORM(tempDir)).toBe("drizzle");
  });

  it("returns unknown when no ORM detected", () => {
    expect(detectORM(tempDir)).toBe("unknown");
  });
});
