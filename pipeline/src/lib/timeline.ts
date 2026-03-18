import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TimelineEvent } from "./types.js";

export function appendTimelineEvent(
  runDir: string,
  event: Omit<TimelineEvent, "ts">
): void {
  const entry: TimelineEvent = { ts: new Date().toISOString(), ...event };
  const logsDir = join(runDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  appendFileSync(join(logsDir, "timeline.jsonl"), JSON.stringify(entry) + "\n");
}

export function readTimeline(runDir: string): TimelineEvent[] {
  const path = join(runDir, "logs", "timeline.jsonl");
  if (!existsSync(path)) return [];
  const events: TimelineEvent[] = [];
  for (const line of readFileSync(path, "utf-8").trim().split("\n")) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line) as TimelineEvent);
    } catch {
      // Skip malformed lines
    }
  }
  return events;
}
