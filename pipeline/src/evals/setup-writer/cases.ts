// pipeline/src/evals/setup-writer/cases.ts — eval case definitions for A/B comparison
// Adapted to documenso schema (Envelope, User, Team, Organisation, TemplateDirectLink, Field)
import type { SetupError } from "../../sdk/errors.js";

export interface SetupEvalCase {
  name: string;
  condition: string;
  /** Tables that might be affected (for snapshot/restore) */
  affectedTables: string[];
  /** Verification SQL: should return 1+ rows if condition is satisfied */
  verificationQuery: string;
  expected: {
    shouldGenerateSQL: boolean;
    forbiddenPatterns?: RegExp[];
    errorType?: SetupError;
  };
}

// Documenso-specific eval cases — mix of existing-data checks and mutations
export const EVAL_CASES: SetupEvalCase[] = [
  {
    name: "existing-user",
    condition: "a user exists with email test1@test.documenso.com",
    affectedTables: ["User"],
    verificationQuery: `SELECT 1 FROM "User" WHERE email = 'test1@test.documenso.com'`,
    expected: { shouldGenerateSQL: false },
  },
  {
    name: "existing-team",
    condition: "a team exists that has at least one OrganisationMember",
    affectedTables: ["Team", "OrganisationMember"],
    verificationQuery: `SELECT 1 FROM "Team" t JOIN "OrganisationMember" om ON om."organisationId" = (SELECT "organisationId" FROM "Team" LIMIT 1) LIMIT 1`,
    expected: { shouldGenerateSQL: false },
  },
  {
    name: "existing-direct-link",
    condition: "an enabled TemplateDirectLink exists",
    affectedTables: ["TemplateDirectLink"],
    verificationQuery: `SELECT 1 FROM "TemplateDirectLink" WHERE enabled = true LIMIT 1`,
    expected: { shouldGenerateSQL: false },
  },
  {
    name: "new-envelope-field",
    condition: "an Envelope of type DOCUMENT exists that has at least one Field with type SIGNATURE",
    affectedTables: ["Envelope", "Field"],
    verificationQuery: `SELECT 1 FROM "Field" f JOIN "Envelope" e ON f."envelopeId" = e.id WHERE e.type = 'DOCUMENT' AND f.type = 'SIGNATURE' LIMIT 1`,
    expected: { shouldGenerateSQL: true },
  },
  {
    name: "jsonb-authOptions",
    condition: "an Envelope of type TEMPLATE exists with authOptions containing {\"actionAuth\": \"ACCOUNT\"}",
    affectedTables: ["Envelope"],
    verificationQuery: `SELECT 1 FROM "Envelope" WHERE type = 'TEMPLATE' AND "authOptions"->>'actionAuth' = 'ACCOUNT' LIMIT 1`,
    expected: { shouldGenerateSQL: true },
  },
  {
    name: "new-disabled-direct-link",
    condition: "a TemplateDirectLink exists that is disabled (enabled = false)",
    affectedTables: ["TemplateDirectLink", "Envelope"],
    verificationQuery: `SELECT 1 FROM "TemplateDirectLink" WHERE enabled = false LIMIT 1`,
    expected: { shouldGenerateSQL: true },
  },
  {
    name: "fk-chain-envelope-field",
    condition: "a Field of type FREE_SIGNATURE exists on a DOCUMENT Envelope owned by team 'Personal Team'",
    affectedTables: ["Envelope", "Field", "Team"],
    verificationQuery: `SELECT 1 FROM "Field" f JOIN "Envelope" e ON f."envelopeId" = e.id JOIN "Team" t ON e."teamId" = t.id WHERE f.type = 'FREE_SIGNATURE' AND t.name = 'Personal Team' LIMIT 1`,
    expected: { shouldGenerateSQL: true },
  },
  {
    name: "column-mapping",
    condition: "an Envelope exists with externalId set to 'eval-test-external-123'",
    affectedTables: ["Envelope"],
    verificationQuery: `SELECT 1 FROM "Envelope" WHERE "externalId" = 'eval-test-external-123' LIMIT 1`,
    expected: { shouldGenerateSQL: true, forbiddenPatterns: [/external_id/i] },
  },
];
