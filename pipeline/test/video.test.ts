// pipeline/test/video.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { findAndRenameVideo } from "../src/lib/video.js";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("findAndRenameVideo", () => {
  let tempDir: string;

  beforeEach(() => { tempDir = join(tmpdir(), `video-test-${Date.now()}`); mkdirSync(tempDir, { recursive: true }); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("renames newest .webm to session.webm", () => {
    writeFileSync(join(tempDir, "old.webm"), "old");
    // Ensure different mtime
    const newerPath = join(tempDir, "newer.webm");
    writeFileSync(newerPath, "newer-content");

    const result = findAndRenameVideo(tempDir);
    expect(result).toBe(join(tempDir, "session.webm"));
    expect(existsSync(join(tempDir, "session.webm"))).toBe(true);
  });

  it("returns null when no .webm files exist", () => {
    writeFileSync(join(tempDir, "not-a-video.txt"), "text");
    expect(findAndRenameVideo(tempDir)).toBeNull();
  });

  it("returns null when directory does not exist", () => {
    expect(findAndRenameVideo(join(tempDir, "nonexistent"))).toBeNull();
  });
});
