// pipeline/src/evals/setup-writer/cases-calcom.ts — calcom-specific eval cases
import type { SetupEvalCase } from "./cases.js";

export const CALCOM_EVAL_CASES: SetupEvalCase[] = [
  {
    name: "existing-user",
    condition: "a user exists with email admin@example.com",
    affectedTables: ["users"],
    verificationQuery: `SELECT 1 FROM users WHERE email = 'admin@example.com'`,
    expected: { shouldGenerateSQL: false },
  },
  {
    name: "existing-event-type",
    condition: "an EventType exists that belongs to a user",
    affectedTables: ["EventType"],
    verificationQuery: `SELECT 1 FROM "EventType" WHERE "userId" IS NOT NULL LIMIT 1`,
    expected: { shouldGenerateSQL: false },
  },
  {
    name: "new-booking",
    condition: "a Booking exists with status ACCEPTED for an EventType owned by admin@example.com",
    affectedTables: ["Booking", "EventType", "users"],
    verificationQuery: `SELECT 1 FROM "Booking" b JOIN "EventType" et ON b."eventTypeId" = et.id JOIN users u ON et."userId" = u.id WHERE u.email = 'admin@example.com' AND b.status = 'accepted' LIMIT 1`,
    expected: { shouldGenerateSQL: true },
  },
  {
    name: "fk-chain-booking-attendee",
    condition: "a Booking exists with at least one Attendee whose email is test-attendee@example.com",
    affectedTables: ["Booking", "Attendee", "EventType"],
    verificationQuery: `SELECT 1 FROM "Attendee" a JOIN "Booking" b ON a."bookingId" = b.id WHERE a.email = 'test-attendee@example.com' LIMIT 1`,
    expected: { shouldGenerateSQL: true },
  },
  {
    name: "team-event-type",
    condition: "an EventType exists that belongs to a Team (not a user)",
    affectedTables: ["EventType", "Team"],
    verificationQuery: `SELECT 1 FROM "EventType" et WHERE et."teamId" IS NOT NULL LIMIT 1`,
    expected: { shouldGenerateSQL: true },
  },
];
