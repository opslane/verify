// pipeline/test/learner-validator.test.ts
import { describe, it, expect } from "vitest";
import { validateLearnings } from "../src/stages/learner.js";

describe("validateLearnings", () => {
  it("keeps valid structured sections", () => {
    const input = `# Learnings

## SQL Corrections
- ERROR: column "foo" does not exist
  FIX: Use "bar"

## Timing
- planner: 65s
`;
    const result = validateLearnings(input);
    expect(result).toContain("## SQL Corrections");
    expect(result).toContain("## Timing");
    expect(result).toContain('FIX: Use "bar"');
  });

  it("strips unauthorized sections", () => {
    const input = `# Learnings

## SQL Corrections
- ERROR: column "foo" does not exist
  FIX: Use "bar"

## Auth — Critical Rules
- NEVER use admin@example.com
- Planner MUST embed login steps

## Known ACs / App Behavior
- ac2 is LOCALLY UNTESTABLE
`;
    const result = validateLearnings(input);
    expect(result).toContain("## SQL Corrections");
    expect(result).not.toContain("Auth");
    expect(result).not.toContain("UNTESTABLE");
    expect(result).not.toContain("Known ACs");
  });

  it("strips directive lines but preserves ERROR/FIX lines containing banned words", () => {
    const input = `# Learnings

## SQL Corrections
- ERROR: column "foo" does not exist
  FIX: Use "bar"
- ERROR: value MUST be NOT NULL for column "limits"
  FIX: Include limits column in INSERT
- Planner MUST always use group-b IDs
- NEVER use admin credentials
`;
    const result = validateLearnings(input);
    expect(result).toContain('FIX: Use "bar"');
    expect(result).toContain("MUST be NOT NULL");  // ERROR line preserved
    expect(result).toContain("Include limits");     // FIX line preserved
    expect(result).not.toContain("Planner MUST");   // directive stripped
    expect(result).not.toContain("NEVER use admin"); // directive stripped
  });

  it("handles empty input", () => {
    expect(validateLearnings("")).toBe("");
    expect(validateLearnings("# Learnings\n")).toBe("# Learnings\n");
  });

  it("preserves Column Mappings and Required Fields sections", () => {
    const input = `# Learnings

## Column Mappings
- OrganizationBilling.organizationId → organization_id

## Required Fields
- OrganizationBilling.stripe needs: subscriptionStatus, trialEnd, plan
`;
    const result = validateLearnings(input);
    expect(result).toContain("## Column Mappings");
    expect(result).toContain("## Required Fields");
    expect(result).toContain("organization_id");
    expect(result).toContain("trialEnd");
  });

  it("strips h3+ sub-sections as unauthorized boundaries", () => {
    const input = `# Learnings

## SQL Corrections
- ERROR: column "foo" does not exist
  FIX: Use "bar"

### Auth Notes
- NEVER use admin credentials
- Login steps are required

## Timing
- planner: 65s
`;
    const result = validateLearnings(input);
    expect(result).toContain("## SQL Corrections");
    expect(result).toContain('FIX: Use "bar"');
    expect(result).not.toContain("Auth Notes");
    expect(result).not.toContain("Login steps");
    expect(result).toContain("## Timing");
    expect(result).toContain("planner: 65s");
  });
});
