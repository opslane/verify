import { describe, it, expect } from "vitest";
import { validatePlan } from "../src/stages/plan-validator.js";
import type { PlannerOutput, AppIndex } from "../src/lib/types.js";
import validPlan from "./fixtures/plan.json" with { type: "json" };
import invalidPlan from "./fixtures/plan-invalid.json" with { type: "json" };

const mockAppIndex: AppIndex = {
  indexed_at: "2026-03-18T00:00:00Z",
  routes: { "/settings": { component: "settings.tsx" }, "/billing": { component: "billing.tsx" } },
  pages: {},
  data_model: {},
  fixtures: {},
  db_url_env: null,
  feature_flags: [],
  seed_ids: {},
  json_type_annotations: {},
  example_urls: {},
};

describe("validatePlan", () => {
  it("passes for a valid plan", () => {
    const result = validatePlan(validPlan as PlannerOutput, mockAppIndex);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("catches template variables in URLs", () => {
    const result = validatePlan(invalidPlan as PlannerOutput, mockAppIndex);
    const templateErr = result.errors.find(e => e.acId === "ac1" && e.field === "url");
    expect(templateErr).toBeDefined();
    expect(templateErr!.message).toMatch(/template variable/i);
  });

  it("catches absolute URLs", () => {
    const result = validatePlan(invalidPlan as PlannerOutput, mockAppIndex);
    const absErr = result.errors.find(e => e.acId === "ac2" && e.field === "url");
    expect(absErr).toBeDefined();
    expect(absErr!.message).toMatch(/absolute/i);
  });

  it("catches empty steps", () => {
    const result = validatePlan(invalidPlan as PlannerOutput, mockAppIndex);
    const stepsErr = result.errors.find(e => e.acId === "ac1" && e.field === "steps");
    expect(stepsErr).toBeDefined();
  });

  it("catches timeout out of bounds (too low)", () => {
    const result = validatePlan(invalidPlan as PlannerOutput, mockAppIndex);
    const timeoutErr = result.errors.find(e => e.acId === "ac1" && e.field === "timeout_seconds");
    expect(timeoutErr).toBeDefined();
  });

  it("catches timeout out of bounds (too high)", () => {
    const result = validatePlan(invalidPlan as PlannerOutput, mockAppIndex);
    const timeoutErr = result.errors.find(e => e.acId === "ac2" && e.field === "timeout_seconds");
    expect(timeoutErr).toBeDefined();
  });

  it("catches URLs not in app index routes", () => {
    const plan: PlannerOutput = {
      criteria: [{
        id: "ac1", group: "g1", description: "test",
        url: "/nonexistent-page",
        steps: ["do something"], screenshot_at: [], timeout_seconds: 90,
      }],
    };
    const result = validatePlan(plan, mockAppIndex);
    const routeErr = result.errors.find(e => e.field === "url" && e.message.match(/not found in app/i));
    expect(routeErr).toBeDefined();
  });

  it("skips route check when no app index provided", () => {
    const plan: PlannerOutput = {
      criteria: [{
        id: "ac1", group: "g1", description: "test",
        url: "/anything", steps: ["do something"], screenshot_at: [], timeout_seconds: 90,
      }],
    };
    const result = validatePlan(plan, null);
    expect(result.valid).toBe(true);
  });

  it("handles empty criteria array", () => {
    const result = validatePlan({ criteria: [] }, mockAppIndex);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("passes when URL matches a parameterized route", () => {
    const appIndex: AppIndex = {
      ...mockAppIndex,
      routes: { "/t/:teamUrl/settings": { component: "settings.tsx" } },
    };
    const plan: PlannerOutput = {
      criteria: [{
        id: "ac1", group: "group-a",
        description: "test",
        url: "/t/bxeevwkyrmcdctic/settings",
        steps: ["Navigate to settings"],
        screenshot_at: [],
        timeout_seconds: 90,
      }],
    };
    const result = validatePlan(plan, appIndex);
    expect(result.valid).toBe(true);
  });

  it("catches __PLACEHOLDER__ style template variables", () => {
    const plan: PlannerOutput = {
      criteria: [{
        id: "ac1", group: "group-a",
        description: "test",
        url: "/t/__TEAM_URL__/settings",
        steps: ["Navigate"],
        screenshot_at: [],
        timeout_seconds: 90,
      }],
    };
    const result = validatePlan(plan, mockAppIndex);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain("template variable");
  });

  it("matches multi-segment parameterized routes", () => {
    const appIndex: AppIndex = {
      ...mockAppIndex,
      routes: { "/t/:teamUrl/documents/:id": { component: "document.tsx" } },
    };
    const plan: PlannerOutput = {
      criteria: [{
        id: "ac1", group: "group-a",
        description: "test",
        url: "/t/abc/documents/42",
        steps: ["Navigate to document"],
        screenshot_at: [],
        timeout_seconds: 90,
      }],
    };
    const result = validatePlan(plan, appIndex);
    expect(result.valid).toBe(true);
  });

  it("catches invented parameter values when example_urls are available", () => {
    const appIndex: AppIndex = {
      ...mockAppIndex,
      routes: { "/o/:orgUrl/settings/members": { component: "members.tsx" } },
      example_urls: { "/o/:orgUrl/settings/members": "/o/org_real123/settings/members" },
    };
    const plan: PlannerOutput = {
      criteria: [{
        id: "ac1", group: "group-a",
        description: "test",
        url: "/o/test-org/settings/members",
        steps: ["Navigate to members"],
        screenshot_at: [],
        timeout_seconds: 90,
      }],
    };
    const result = validatePlan(plan, appIndex);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain("org_real123");
    expect(result.errors[0].message).toContain("test-org");
  });

  it("passes when URL uses correct example_urls values", () => {
    const appIndex: AppIndex = {
      ...mockAppIndex,
      routes: { "/o/:orgUrl/settings/members": { component: "members.tsx" } },
      example_urls: { "/o/:orgUrl/settings/members": "/o/org_real123/settings/members" },
    };
    const plan: PlannerOutput = {
      criteria: [{
        id: "ac1", group: "group-a",
        description: "test",
        url: "/o/org_real123/settings/members",
        steps: ["Navigate to members"],
        screenshot_at: [],
        timeout_seconds: 90,
      }],
    };
    const result = validatePlan(plan, appIndex);
    expect(result.valid).toBe(true);
  });

  it("allows different param values for routes without example_urls", () => {
    const appIndex: AppIndex = {
      ...mockAppIndex,
      routes: { "/t/:teamUrl/settings": { component: "settings.tsx" } },
      example_urls: {},
    };
    const plan: PlannerOutput = {
      criteria: [{
        id: "ac1", group: "group-a",
        description: "test",
        url: "/t/any_team_url/settings",
        steps: ["Navigate"],
        screenshot_at: [],
        timeout_seconds: 90,
      }],
    };
    const result = validatePlan(plan, appIndex);
    expect(result.valid).toBe(true);
  });

  it("catches invented ID in multi-param route", () => {
    const appIndex: AppIndex = {
      ...mockAppIndex,
      routes: { "/t/:teamUrl/documents/:id/edit": { component: "edit.tsx" } },
      example_urls: { "/t/:teamUrl/documents/:id/edit": "/t/personal_abc/documents/real-doc-42/edit" },
    };
    const plan: PlannerOutput = {
      criteria: [{
        id: "ac1", group: "group-a",
        description: "test",
        url: "/t/personal_abc/documents/1/edit",
        steps: ["Navigate to editor"],
        screenshot_at: [],
        timeout_seconds: 90,
      }],
    };
    const result = validatePlan(plan, appIndex);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain("real-doc-42");
  });

  it("skips param validation for static routes", () => {
    const appIndex: AppIndex = {
      ...mockAppIndex,
      routes: { "/settings": { component: "settings.tsx" } },
      example_urls: {},
    };
    const plan: PlannerOutput = {
      criteria: [{
        id: "ac1", group: "group-a",
        description: "test",
        url: "/settings",
        steps: ["Navigate"],
        screenshot_at: [],
        timeout_seconds: 90,
      }],
    };
    const result = validatePlan(plan, appIndex);
    expect(result.valid).toBe(true);
  });
});
