import { describe, it, expect } from "vitest";
import { buildACGeneratorPrompt, parseACGeneratorOutput, fanOutPureUIGroups } from "../src/stages/ac-generator.js";
import type { ACGeneratorOutput } from "../src/lib/types.js";

describe("buildACGeneratorPrompt", () => {
  it("substitutes specPath into template", () => {
    const prompt = buildACGeneratorPrompt("/path/to/spec.md");
    expect(prompt).toContain("/path/to/spec.md");
    expect(prompt).not.toContain("{{specPath}}");
  });
});

describe("parseACGeneratorOutput", () => {
  it("parses valid output", () => {
    const output = JSON.stringify({
      groups: [{ id: "group-a", condition: null, acs: [{ id: "ac1", description: "test" }] }],
      skipped: [],
    });
    const result = parseACGeneratorOutput(output);
    expect(result).not.toBeNull();
    expect(result!.groups).toHaveLength(1);
  });

  it("returns null for invalid output", () => {
    expect(parseACGeneratorOutput("garbage")).toBeNull();
  });

  it("returns null for missing groups field", () => {
    expect(parseACGeneratorOutput('{"skipped": []}')).toBeNull();
  });

  it("handles markdown-fenced output", () => {
    const output = '```json\n{"groups": [], "skipped": []}\n```';
    expect(parseACGeneratorOutput(output)).not.toBeNull();
  });
});

describe("fanOutPureUIGroups", () => {
  it("splits pure-UI group with multiple ACs into individual groups", () => {
    const input: ACGeneratorOutput = {
      groups: [{
        id: "group-a", condition: null,
        acs: [{ id: "ac1", description: "Page A loads" }, { id: "ac2", description: "Page B loads" }],
      }],
      skipped: [],
    };
    const result = fanOutPureUIGroups(input);
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0].acs).toHaveLength(1);
    expect(result.groups[1].acs).toHaveLength(1);
  });

  it("leaves groups with conditions intact", () => {
    const input: ACGeneratorOutput = {
      groups: [{
        id: "group-a", condition: "org in trialing state",
        acs: [{ id: "ac1", description: "Banner shows" }, { id: "ac2", description: "Days correct" }],
      }],
      skipped: [],
    };
    const result = fanOutPureUIGroups(input);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].acs).toHaveLength(2);
  });

  it("leaves single-AC pure-UI groups alone", () => {
    const input: ACGeneratorOutput = {
      groups: [{ id: "group-a", condition: null, acs: [{ id: "ac1", description: "test" }] }],
      skipped: [],
    };
    const result = fanOutPureUIGroups(input);
    expect(result.groups).toHaveLength(1);
  });

  it("preserves skipped array", () => {
    const input: ACGeneratorOutput = {
      groups: [],
      skipped: [{ id: "ac4", reason: "Needs Stripe" }],
    };
    const result = fanOutPureUIGroups(input);
    expect(result.skipped).toHaveLength(1);
  });
});
