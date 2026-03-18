import { describe, it, expect } from "vitest";
import { buildPlannerPrompt, parsePlannerOutput, buildRetryPrompt, filterPlanErrors } from "../src/stages/planner.js";
import type { PlannerOutput, PlanValidationError } from "../src/lib/types.js";

describe("buildPlannerPrompt", () => {
  it("substitutes acsPath into template", () => {
    const prompt = buildPlannerPrompt("/tmp/run/acs.json");
    expect(prompt).toContain("/tmp/run/acs.json");
    expect(prompt).not.toContain("{{acsPath}}");
  });
});

describe("parsePlannerOutput", () => {
  it("parses valid plan", () => {
    const output = JSON.stringify({
      criteria: [{
        id: "ac1", group: "group-a", description: "test",
        url: "/settings", steps: ["Navigate"], screenshot_at: ["loaded"], timeout_seconds: 90,
      }],
    });
    const result = parsePlannerOutput(output);
    expect(result).not.toBeNull();
    expect(result!.criteria).toHaveLength(1);
  });

  it("returns null for missing criteria", () => {
    expect(parsePlannerOutput('{"foo": "bar"}')).toBeNull();
  });

  it("returns null for garbage", () => {
    expect(parsePlannerOutput("not json")).toBeNull();
  });
});

describe("buildRetryPrompt", () => {
  it("includes validation errors in the retry prompt", () => {
    const errors: PlanValidationError[] = [
      { acId: "ac1", field: "url", message: 'URL "/env/{envId}" contains a template variable' },
    ];
    const prompt = buildRetryPrompt("/tmp/acs.json", errors);
    expect(prompt).toContain("template variable");
    expect(prompt).toContain("ac1");
    expect(prompt).toContain("ERRORS");
  });
});

describe("filterPlanErrors", () => {
  it("removes ACs with persistent errors", () => {
    const plan: PlannerOutput = {
      criteria: [
        { id: "ac1", group: "g1", description: "t", url: "/{bad}", steps: ["s"], screenshot_at: [], timeout_seconds: 90 },
        { id: "ac2", group: "g1", description: "t", url: "/good", steps: ["s"], screenshot_at: [], timeout_seconds: 90 },
      ],
    };
    const errors: PlanValidationError[] = [
      { acId: "ac1", field: "url", message: "template variable" },
    ];
    const { validPlan, planErrors } = filterPlanErrors(plan, errors);
    expect(validPlan.criteria).toHaveLength(1);
    expect(validPlan.criteria[0].id).toBe("ac2");
    expect(planErrors).toHaveLength(1);
    expect(planErrors[0].ac_id).toBe("ac1");
    expect(planErrors[0].verdict).toBe("plan_error");
  });

  it("returns empty planErrors when all ACs are valid", () => {
    const plan: PlannerOutput = {
      criteria: [{ id: "ac1", group: "g1", description: "t", url: "/good", steps: ["s"], screenshot_at: [], timeout_seconds: 90 }],
    };
    const { validPlan, planErrors } = filterPlanErrors(plan, []);
    expect(validPlan.criteria).toHaveLength(1);
    expect(planErrors).toHaveLength(0);
  });
});
