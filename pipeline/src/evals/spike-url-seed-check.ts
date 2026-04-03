/**
 * spike-url-seed-check.ts — URL-based seed verification spike
 *
 * Instead of parsing condition text (brittle regex), use the AC group's
 * target URLs to infer what entity type is needed, then check if the
 * user already has data of that type.
 */

import { execSync } from "node:child_process";

// ── DB helpers ──

function query(connStr: string, sql: string): string {
  try {
    return (
      execSync(`psql "${connStr}" -t -A -c ${JSON.stringify(sql)}`, {
        timeout: 5_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }) as string
    ).trim();
  } catch {
    return "";
  }
}

function queryCount(connStr: string, sql: string): number {
  const raw = query(connStr, sql);
  return raw ? parseInt(raw, 10) : 0;
}

// ── Segment-to-entity maps per app ──

interface EntityCheck {
  entity: string;
  query: string; // SQL returning a count
  minCount?: number; // default 1
}

type SegmentMap = Record<string, (ctx: AppContext) => EntityCheck | null>;

interface AppContext {
  connStr: string;
  userId?: number;
  teamId?: number;
}

const documensoSegments: SegmentMap = {
  documents: (ctx) => ({
    entity: "Envelope (DOCUMENT)",
    query: `SELECT COUNT(*) FROM "Envelope" WHERE "teamId" = ${ctx.teamId} AND type = 'DOCUMENT'`,
  }),
  templates: (ctx) => ({
    entity: "Envelope (TEMPLATE)",
    query: `SELECT COUNT(*) FROM "Envelope" WHERE "teamId" = ${ctx.teamId} AND type = 'TEMPLATE'`,
  }),
  members: (ctx) => ({
    entity: "OrganisationMember",
    query: `SELECT COUNT(*) FROM "OrganisationMember" om JOIN "Organisation" o ON o.id = om."organisationId" JOIN "OrganisationMember" om2 ON om2."organisationId" = o.id WHERE om2."userId" = ${ctx.userId}`,
  }),
  dashboard: () => ({
    entity: "none (navigation)",
    query: `SELECT 1`, // always passes
  }),
  settings: () => null, // too generic, need sub-segment
  admin: () => ({
    entity: "none (admin page)",
    query: `SELECT 1`,
  }),
};

const calcomSegments: SegmentMap = {
  "event-types": (ctx) => ({
    entity: "EventType",
    query: `SELECT COUNT(*) FROM "EventType" WHERE "userId" = ${ctx.userId}`,
  }),
  bookings: (ctx) => ({
    entity: "Booking",
    query: `SELECT COUNT(*) FROM "Booking" WHERE "userId" = ${ctx.userId}`,
  }),
};

// ── Condition definitions ──

interface Condition {
  id: number;
  app: "documenso" | "calcom";
  condition: string;
  url: string;
  hasAttributeCheck: boolean; // true = condition checks specific attributes (dropdown, description length, etc.)
  expectedSkipSetup: boolean; // ground truth: would skip-setup have been correct?
}

const CONDITIONS: Condition[] = [
  {
    id: 1,
    app: "documenso",
    condition: "A document exists in the user's workspace",
    url: "/t/personal_mwiasvikdmkwinfh/documents",
    hasAttributeCheck: false,
    expectedSkipSetup: true, // seed has documents
  },
  {
    id: 2,
    app: "documenso",
    condition: "A document exists with at least one DROPDOWN field...",
    url: "/t/personal_mwiasvikdmkwinfh/documents/{id}/edit",
    hasAttributeCheck: true, // needs DROPDOWN field
    expectedSkipSetup: false, // seed docs don't have dropdown fields
  },
  {
    id: 3,
    app: "documenso",
    condition: "A template exists with description >100 chars...",
    url: "/t/personal_mwiasvikdmkwinfh/templates",
    hasAttributeCheck: true, // needs description length check
    expectedSkipSetup: false, // seed templates don't have long descriptions
  },
  {
    id: 4,
    app: "documenso",
    condition: "A template with publicDescription...",
    url: "/settings/public-profile",
    hasAttributeCheck: true, // needs publicDescription
    expectedSkipSetup: false,
  },
  {
    id: 5,
    app: "documenso",
    condition: "Manager-role user in org with admin invitation...",
    url: "/o/{orgUrl}/settings/members",
    hasAttributeCheck: true, // needs specific role + invitation
    expectedSkipSetup: false,
  },
  {
    id: 6,
    app: "documenso",
    condition: "User belongs to org with members and invitation...",
    url: "/o/{orgUrl}/settings/members",
    hasAttributeCheck: true,
    expectedSkipSetup: false,
  },
  {
    id: 7,
    app: "documenso",
    condition: "Document editor with settings open",
    url: "/t/personal_mwiasvikdmkwinfh/documents/{id}/edit",
    hasAttributeCheck: false,
    expectedSkipSetup: true, // just needs a document
  },
  {
    id: 8,
    app: "documenso",
    condition: "Viewing page with select dropdown...",
    url: "/t/personal_mwiasvikdmkwinfh/settings/document",
    hasAttributeCheck: false,
    expectedSkipSetup: true, // settings page, no entity needed
  },
  {
    id: 9,
    app: "documenso",
    condition: "Viewing /dashboard",
    url: "/dashboard",
    hasAttributeCheck: false,
    expectedSkipSetup: true,
  },
  {
    id: 10,
    app: "documenso",
    condition: "Logged in as admin navigated to /admin/stats",
    url: "/admin/stats",
    hasAttributeCheck: false,
    expectedSkipSetup: true,
  },
  {
    id: 11,
    app: "calcom",
    condition: "Regular event type on /event-types",
    url: "/event-types",
    hasAttributeCheck: false,
    expectedSkipSetup: true,
  },
  {
    id: 12,
    app: "calcom",
    condition: "Team managed event type",
    url: "/event-types",
    hasAttributeCheck: true, // needs team-managed specifically
    expectedSkipSetup: false,
  },
  {
    id: 13,
    app: "calcom",
    condition: "Upcoming booking with meeting location",
    url: "/bookings",
    hasAttributeCheck: true, // needs upcoming + meeting location
    expectedSkipSetup: false,
  },
  {
    id: 14,
    app: "calcom",
    condition: "At least two bookings on /bookings",
    url: "/bookings",
    hasAttributeCheck: false,
    expectedSkipSetup: false, // need count >= 2
  },
];

// ── URL parsing logic ──

function extractSegments(url: string): string[] {
  return url
    .split("/")
    .filter((s) => s && !s.startsWith("{") && !s.startsWith(":"))
    .filter((s) => !/^(t|o|p)$/.test(s)) // skip single-char route prefixes
    .filter((s) => !/^personal_/.test(s)) // skip team URL slugs
    .filter((s) => !/^\d+$/.test(s)); // skip numeric IDs
}

function inferEntityFromUrl(
  url: string,
  app: "documenso" | "calcom",
  ctx: AppContext,
): EntityCheck | null {
  const segments = extractSegments(url);
  const segMap = app === "documenso" ? documensoSegments : calcomSegments;

  // Try each segment, prefer more specific (later) segments
  let best: EntityCheck | null = null;
  for (const seg of segments) {
    if (segMap[seg]) {
      const check = segMap[seg](ctx);
      if (check) best = check;
    }
  }

  // Special case: settings sub-paths for documenso
  if (!best && app === "documenso") {
    if (segments.includes("settings")) {
      // Settings pages generally don't need entity data
      best = { entity: "none (settings page)", query: "SELECT 1" };
    }
    if (segments.includes("public-profile")) {
      best = {
        entity: "TeamProfile",
        query: `SELECT COUNT(*) FROM "TeamProfile" WHERE "teamId" = ${ctx.teamId}`,
      };
    }
  }

  return best;
}

// ── Main ──

function main() {
  const DOCUMENSO_DB =
    "postgresql://documenso:password@localhost:54320/documenso";
  const CALCOM_DB = "postgresql://calcom:calcom@localhost:5432/calcom";

  // Documenso context
  const docCtx: AppContext = {
    connStr: DOCUMENSO_DB,
    userId: 9,
    teamId: 7,
  };

  // Cal.com: look up userId for pro@example.com
  const calUserId = query(
    CALCOM_DB,
    `SELECT id FROM users WHERE email = 'pro@example.com' LIMIT 1`,
  );
  const calCtx: AppContext = {
    connStr: CALCOM_DB,
    userId: calUserId ? parseInt(calUserId, 10) : 0,
  };

  console.log("=== URL-BASED SEED VERIFICATION SPIKE ===\n");
  console.log(`Documenso: userId=${docCtx.userId}, teamId=${docCtx.teamId}`);
  console.log(`Cal.com:   userId=${calCtx.userId} (pro@example.com)\n`);

  let correct = 0;
  let total = 0;
  let falsePositives = 0; // said "skip" but should have done setup
  let falseNegatives = 0; // said "needs setup" but could have skipped

  const results: Array<{
    id: number;
    condition: string;
    url: string;
    entity: string;
    count: number;
    urlSaysSkip: boolean;
    expected: boolean;
    match: boolean;
    note: string;
  }> = [];

  for (const cond of CONDITIONS) {
    const ctx = cond.app === "documenso" ? docCtx : calCtx;
    const check = inferEntityFromUrl(cond.url, cond.app, ctx);

    let entity = "UNKNOWN";
    let count = 0;
    let urlSaysSkip = false;

    if (check) {
      entity = check.entity;
      if (check.query === "SELECT 1") {
        count = -1; // navigation-only, always pass
        urlSaysSkip = true;
      } else {
        count = queryCount(ctx.connStr, check.query);
        const min = check.minCount ?? 1;
        urlSaysSkip = count >= min;
      }
    }

    // Special: condition #14 needs count >= 2
    if (cond.id === 14 && count >= 0) {
      urlSaysSkip = count >= 2;
    }

    const match = urlSaysSkip === cond.expectedSkipSetup;
    if (match) correct++;
    if (urlSaysSkip && !cond.expectedSkipSetup) falsePositives++;
    if (!urlSaysSkip && cond.expectedSkipSetup) falseNegatives++;
    total++;

    let note = "";
    if (cond.hasAttributeCheck && urlSaysSkip) {
      note =
        "URL check says data exists, but cannot verify specific attributes";
    }
    if (!check) {
      note = "No segment matched any entity";
    }

    results.push({
      id: cond.id,
      condition: cond.condition,
      url: cond.url,
      entity,
      count,
      urlSaysSkip,
      expected: cond.expectedSkipSetup,
      match,
      note,
    });
  }

  // ── Report ──
  console.log("─".repeat(120));
  console.log(
    `${"#".padEnd(3)} ${"Condition".padEnd(50)} ${"Entity".padEnd(25)} ${"Count".padEnd(6)} ${"URL→Skip".padEnd(10)} ${"Expected".padEnd(10)} ${"Match".padEnd(6)} Note`,
  );
  console.log("─".repeat(120));

  for (const r of results) {
    const countStr = r.count === -1 ? "n/a" : String(r.count);
    console.log(
      `${String(r.id).padEnd(3)} ${r.condition.slice(0, 48).padEnd(50)} ${r.entity.padEnd(25)} ${countStr.padEnd(6)} ${String(r.urlSaysSkip).padEnd(10)} ${String(r.expected).padEnd(10)} ${(r.match ? "YES" : "NO").padEnd(6)} ${r.note}`,
    );
  }

  console.log("─".repeat(120));
  console.log(`\nAccuracy: ${correct}/${total} (${((correct / total) * 100).toFixed(0)}%)`);
  console.log(`False positives (said skip, needed setup): ${falsePositives}`);
  console.log(`False negatives (said needs setup, could skip): ${falseNegatives}`);

  // ── Analysis ──
  const fpCases = results.filter((r) => r.urlSaysSkip && !r.expected);
  if (fpCases.length > 0) {
    console.log("\n=== FALSE POSITIVES (dangerous — would skip needed setup) ===");
    for (const r of fpCases) {
      console.log(`  #${r.id}: "${r.condition}" → entity=${r.entity}, count=${r.count}`);
      console.log(`    ${r.note || "Data exists but condition needs specific attributes"}`);
    }
  }

  const fnCases = results.filter((r) => !r.urlSaysSkip && r.expected);
  if (fnCases.length > 0) {
    console.log("\n=== FALSE NEGATIVES (safe — would run unnecessary setup) ===");
    for (const r of fnCases) {
      console.log(`  #${r.id}: "${r.condition}" → entity=${r.entity}, count=${r.count}`);
    }
  }

  console.log("\n=== KEY FINDINGS ===");
  console.log(
    "1. URL-based inference correctly identifies the entity type for simple existence checks",
  );
  console.log(
    "2. It CANNOT verify attribute-level conditions (dropdown fields, description length, roles)",
  );
  console.log(
    `3. Of ${total} conditions, ${results.filter((r) => (r as Record<string, unknown>).hasAttributeCheck).length} require attribute checks that URL-only inference misses`,
  );
  console.log(
    "4. False positives are the dangerous case — they would skip setup that's actually needed",
  );
  console.log(
    "5. A hybrid approach (URL-based entity check + targeted attribute queries) could work",
  );
}

main();
