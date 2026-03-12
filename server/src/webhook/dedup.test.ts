import { describe, it, expect } from "vitest";
import { DeduplicationSet } from "./dedup.js";

describe("DeduplicationSet", () => {
  it("returns false for a new delivery ID", () => {
    const set = new DeduplicationSet();
    expect(set.isDuplicate("abc-123")).toBe(false);
  });

  it("returns true for a seen delivery ID", () => {
    const set = new DeduplicationSet();
    set.markSeen("abc-123");
    expect(set.isDuplicate("abc-123")).toBe(true);
  });

  it("returns false for a different delivery ID", () => {
    const set = new DeduplicationSet();
    set.markSeen("abc-123");
    expect(set.isDuplicate("def-456")).toBe(false);
  });
});
