import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendTimelineEvent, readTimeline } from "../src/lib/timeline.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("timeline", () => {
  let runDir: string;

  beforeEach(() => {
    runDir = join(tmpdir(), `verify-run-${Date.now()}`);
    mkdirSync(join(runDir, "logs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true });
  });

  it("appends event to timeline.jsonl", () => {
    appendTimelineEvent(runDir, { stage: "planner", event: "start" });
    const events = readTimeline(runDir);
    expect(events).toHaveLength(1);
    expect(events[0].stage).toBe("planner");
    expect(events[0].event).toBe("start");
    expect(events[0].ts).toBeDefined();
  });

  it("appends multiple events", () => {
    appendTimelineEvent(runDir, { stage: "planner", event: "start" });
    appendTimelineEvent(runDir, { stage: "planner", event: "end", durationMs: 5000 });
    const events = readTimeline(runDir);
    expect(events).toHaveLength(2);
    expect(events[1].durationMs).toBe(5000);
  });

  it("returns empty array when no timeline exists", () => {
    const emptyDir = join(tmpdir(), `empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    expect(readTimeline(emptyDir)).toEqual([]);
    rmSync(emptyDir, { recursive: true, force: true });
  });
});
