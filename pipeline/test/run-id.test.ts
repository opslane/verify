// pipeline/test/run-id.test.ts
import { describe, it, expect } from "vitest";
import { generateRunId } from "../src/lib/run-id.js";

describe("generateRunId", () => {
  it("generates YYYY-MM-DD-HHMM-slug format", () => {
    const id = generateRunId("/docs/plans/trial-alerts-spec.md", new Date("2026-03-18T14:25:00Z"));
    expect(id).toBe("2026-03-18-1425-trial-alerts-spec");
  });

  it("truncates long filenames to 40 chars", () => {
    const id = generateRunId("/docs/a-very-long-spec-filename-that-goes-on-and-on-and-on-forever.md");
    const slug = id.split("-").slice(4).join("-"); // skip YYYY-MM-DD-HHMM
    expect(slug.length).toBeLessThanOrEqual(40);
  });

  it("handles special characters in filename", () => {
    const id = generateRunId("/docs/My Spec (v2) [final].md");
    expect(id).not.toMatch(/[ ()\[\]]/);
  });

  it("strips leading/trailing hyphens from slug", () => {
    const id = generateRunId("/docs/---spec---.md", new Date("2026-01-01T00:00:00Z"));
    expect(id).toBe("2026-01-01-0000-spec");
  });
});
