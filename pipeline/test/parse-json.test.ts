import { describe, it, expect } from "vitest";
import { parseJsonOutput } from "../src/lib/parse-json.js";

describe("parseJsonOutput", () => {
  it("parses clean JSON", () => {
    const result = parseJsonOutput<{ foo: string }>('{"foo": "bar"}');
    expect(result).toEqual({ foo: "bar" });
  });

  it("strips markdown fences", () => {
    const input = '```json\n{"foo": "bar"}\n```';
    expect(parseJsonOutput(input)).toEqual({ foo: "bar" });
  });

  it("strips leading/trailing text", () => {
    const input = 'Here is the output:\n{"foo": "bar"}\nDone.';
    expect(parseJsonOutput(input)).toEqual({ foo: "bar" });
  });

  it("returns null for completely invalid input", () => {
    expect(parseJsonOutput("not json at all")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseJsonOutput("")).toBeNull();
  });

  it("handles nested JSON with fences", () => {
    const input = '```\n{"groups": [{"id": "g1", "acs": []}]}\n```';
    expect(parseJsonOutput(input)).toEqual({ groups: [{ id: "g1", acs: [] }] });
  });

  // ENG REVIEW: Test for multi-object output (greedy regex fix)
  it("extracts first valid JSON when LLM adds commentary after", () => {
    const input = 'Here is the result: {"valid": true}\nI also considered: {"alternative": false}';
    expect(parseJsonOutput(input)).toEqual({ valid: true });
  });

  it("handles JSON array output", () => {
    const input = 'Result:\n[{"id": 1}, {"id": 2}]\nDone.';
    expect(parseJsonOutput(input)).toEqual([{ id: 1 }, { id: 2 }]);
  });
});
