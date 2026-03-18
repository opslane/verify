import type { ProgressEvent, ProgressStatus } from "./types.js";

const STATUS_ICONS: Record<ProgressStatus, string> = {
  pending: "○",
  running: "⏳",
  pass: "✓",
  fail: "✗",
  error: "!",
  timeout: "⏱",
  skipped: "—",
};

export class ProgressEmitter {
  private statuses = new Map<string, { status: ProgressStatus; detail?: string }>();
  private handler: (event: ProgressEvent) => void;

  constructor(handler: (event: ProgressEvent) => void) {
    this.handler = handler;
  }

  update(acId: string, status: ProgressStatus, detail?: string): void {
    this.statuses.set(acId, { status, detail });
    this.handler({ acId, status, detail });
  }

  snapshot(): Map<string, ProgressStatus> {
    const result = new Map<string, ProgressStatus>();
    for (const [id, { status }] of this.statuses) {
      result.set(id, status);
    }
    return result;
  }

  formatStatusLine(): string {
    return [...this.statuses.entries()]
      .map(([id, { status, detail }]) => {
        const icon = STATUS_ICONS[status];
        const suffix = detail ? ` ${detail}` : "";
        return `[${id} ${icon}${suffix}]`;
      })
      .join(" ");
  }
}
