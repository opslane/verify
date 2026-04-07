import type { ProgressEvent, ProgressStatus } from "./types.js";

export class ProgressEmitter {
  private handler: (event: ProgressEvent) => void;

  constructor(handler: (event: ProgressEvent) => void) {
    this.handler = handler;
  }

  update(acId: string, status: ProgressStatus, detail?: string): void {
    this.handler({ acId, status, detail });
  }
}
