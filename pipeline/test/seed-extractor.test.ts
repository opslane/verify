import { describe, it, expect } from "vitest";
import { extractSeedIds, groupSeedIdsByContext } from "../src/lib/seed-extractor.js";

describe("extractSeedIds", () => {
  it("finds CUID-like IDs (cl prefix + alphanumeric)", () => {
    const content = `
      const orgId = "clseedorg0000000000000";
      const envId = "clseedenvprod000000000";
    `;
    const ids = extractSeedIds(content);
    expect(ids).toContain("clseedorg0000000000000");
    expect(ids).toContain("clseedenvprod000000000");
  });

  it("finds UUIDs", () => {
    const content = `const id = "a0b1c2d3-e4f5-6789-abcd-ef0123456789";`;
    const ids = extractSeedIds(content);
    expect(ids).toContain("a0b1c2d3-e4f5-6789-abcd-ef0123456789");
  });

  it("deduplicates", () => {
    const content = `
      const a = "clseedorg0000000000000";
      const b = "clseedorg0000000000000";
    `;
    const ids = extractSeedIds(content);
    expect(ids.filter(id => id === "clseedorg0000000000000")).toHaveLength(1);
  });

  it("ignores short strings and non-ID patterns", () => {
    const content = `
      const name = "hello";
      const email = "user@example.com";
      const count = "12345";
    `;
    const ids = extractSeedIds(content);
    expect(ids).toHaveLength(0);
  });
});

describe("groupSeedIdsByContext", () => {
  it("groups IDs by nearby model/table references", () => {
    const content = `
      // Seed Organization
      const orgId = "clseedorg0000000000000";
      await prisma.organization.create({ data: { id: orgId }});

      // Seed Environment
      const envId = "clseedenvprod000000000";
      await prisma.environment.create({ data: { id: envId }});
    `;
    const grouped = groupSeedIdsByContext(content);
    expect(grouped.Organization ?? grouped.organization).toContain("clseedorg0000000000000");
    expect(grouped.Environment ?? grouped.environment).toContain("clseedenvprod000000000");
  });

  it("groups IDs by constant-style keys (ORGANIZATION, USER, ENV)", () => {
    const content = `
export const SEED_IDS = {
  USER_ADMIN: "clseedadmin000000000000",
  USER_MANAGER: "clseedmanager0000000000",
  ORGANIZATION: "clseedorg0000000000000",
  PROJECT: "clseedproject000000000",
  ENV_DEV: "clseedenvdev0000000000",
  ENV_PROD: "clseedenvprod000000000",
  SURVEY_KITCHEN_SINK: "clseedsurveykitchen00",
} as const;`;
    const grouped = groupSeedIdsByContext(content);
    expect(grouped.User).toContain("clseedadmin000000000000");
    expect(grouped.User).toContain("clseedmanager0000000000");
    expect(grouped.Organization).toContain("clseedorg0000000000000");
    expect(grouped.Project).toContain("clseedproject000000000");
    expect(grouped.Environment).toContain("clseedenvdev0000000000");
    expect(grouped.Environment).toContain("clseedenvprod000000000");
    expect(grouped.Survey).toContain("clseedsurveykitchen00");
  });

  it("returns ungrouped IDs under '_unknown'", () => {
    const content = `const id = "clsomerandoid000000000";`;
    const grouped = groupSeedIdsByContext(content);
    expect(grouped._unknown).toContain("clsomerandoid000000000");
  });
});
