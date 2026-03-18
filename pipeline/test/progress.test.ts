import { describe, it, expect, vi } from "vitest";
import { ProgressEmitter } from "../src/lib/progress.js";

describe("ProgressEmitter", () => {
  it("emits progress events", () => {
    const handler = vi.fn();
    const emitter = new ProgressEmitter(handler);
    emitter.update("ac1", "running", "navigating...");
    expect(handler).toHaveBeenCalledWith({
      acId: "ac1",
      status: "running",
      detail: "navigating...",
    });
  });

  it("tracks all AC statuses", () => {
    const emitter = new ProgressEmitter(vi.fn());
    emitter.update("ac1", "running");
    emitter.update("ac2", "pending");
    emitter.update("ac1", "pass");
    const snapshot = emitter.snapshot();
    expect(snapshot.get("ac1")).toBe("pass");
    expect(snapshot.get("ac2")).toBe("pending");
  });

  it("formats a terminal-friendly status line", () => {
    const emitter = new ProgressEmitter(vi.fn());
    emitter.update("ac1", "pass");
    emitter.update("ac2", "running", "navigating...");
    emitter.update("ac3", "fail");
    const line = emitter.formatStatusLine();
    expect(line).toContain("ac1");
    expect(line).toContain("ac2");
    expect(line).toContain("ac3");
  });
});
