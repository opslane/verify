import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { TimelineEvent } from "./types.js";

export function appendTimelineEvent(
  runDir: string,
  event: Omit<TimelineEvent, "ts">
): void {
  const entry: TimelineEvent = { ts: new Date().toISOString(), ...event };
  const path = join(runDir, "logs", "timeline.jsonl");
  appendFileSync(path, JSON.stringify(entry) + "\n");
}

export function readTimeline(runDir: string): TimelineEvent[] {
  const path = join(runDir, "logs", "timeline.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
