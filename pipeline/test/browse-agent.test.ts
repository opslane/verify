// pipeline/test/browse-agent.test.ts
import { describe, it, expect } from "vitest";
import { parseExecutorResult } from "../src/stages/browse-agent.js";

describe("parseExecutorResult", () => {
  it("parses valid JSON with all fields", () => {
    const input = JSON.stringify({
      ac_id: "ac1",
      verdict: "pass",
      confidence: "high",
      reasoning: "All tabs visible",
      observed: "Tabs: Inbox, Pending, Completed, Draft, All",
      steps_taken: ["goto http://localhost:3003", "snapshot"],
      screenshots: ["result.png"],
    });
    const result = parseExecutorResult(input);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("pass");
    expect(result!.confidence).toBe("high");
    expect(result!.screenshots).toEqual(["result.png"]);
  });

  it("parses JSON with missing optional fields and fills defaults", () => {
    const input = JSON.stringify({
      ac_id: "ac2",
      verdict: "fail",
      reasoning: "Button not found",
      observed: "Page shows empty state",
    });
    const result = parseExecutorResult(input);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("medium");
    expect(result!.screenshots).toEqual([]);
    expect(result!.steps_taken).toEqual([]);
  });

  it("parses blocked verdict with blocker field", () => {
    const input = JSON.stringify({
      ac_id: "ac3",
      verdict: "blocked",
      confidence: "high",
      reasoning: "No documents exist",
      observed: "Empty state page",
      blocker: "needs a document in Pending state",
      steps_taken: [],
      screenshots: [],
    });
    const result = parseExecutorResult(input);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("blocked");
    expect(result!.blocker).toBe("needs a document in Pending state");
  });

  it("handles markdown-wrapped JSON", () => {
    const input = '```json\n{"ac_id":"ac1","verdict":"pass","reasoning":"OK","observed":"OK"}\n```';
    const result = parseExecutorResult(input);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("pass");
  });

  it("returns null for empty string", () => {
    expect(parseExecutorResult("")).toBeNull();
  });

  it("returns null for non-JSON output", () => {
    expect(parseExecutorResult("I could not verify the AC because...")).toBeNull();
  });

  it("returns null for invalid verdict value", () => {
    const input = JSON.stringify({
      ac_id: "ac1",
      verdict: "maybe",
      reasoning: "not sure",
      observed: "something",
    });
    expect(parseExecutorResult(input)).toBeNull();
  });

  it("returns null for missing verdict field", () => {
    const input = JSON.stringify({
      ac_id: "ac1",
      reasoning: "no verdict",
      observed: "page loaded",
    });
    expect(parseExecutorResult(input)).toBeNull();
  });
});
