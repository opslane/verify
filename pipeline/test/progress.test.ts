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

  it("calls handler for each update", () => {
    const handler = vi.fn();
    const emitter = new ProgressEmitter(handler);
    emitter.update("ac1", "running");
    emitter.update("ac2", "pending");
    emitter.update("ac1", "pass");
    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler).toHaveBeenLastCalledWith({
      acId: "ac1",
      status: "pass",
      detail: undefined,
    });
  });
});
