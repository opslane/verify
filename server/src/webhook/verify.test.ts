import { describe, it, expect } from "vitest";
import { shouldSkipVerification } from "./verify.js";

describe("shouldSkipVerification", () => {
  it("returns false by default", () => {
    expect(shouldSkipVerification("production", undefined)).toBe(false);
  });

  it("returns false in production even if env var set", () => {
    expect(shouldSkipVerification("production", "true")).toBe(false);
  });

  it("returns true only in non-production with var set", () => {
    expect(shouldSkipVerification("development", "true")).toBe(true);
  });

  it("returns false when NODE_ENV is undefined (fail-secure)", () => {
    expect(shouldSkipVerification(undefined, "true")).toBe(false);
  });
});
