#!/usr/bin/env tsx
/**
 * Spike 7c: Hybrid route resolver
 *
 * Phase 1 — deterministic resolution via naming conventions + psql queries
 * Phase 2 — LLM fallback (claude -p) for routes that Phase 1 couldn't fully resolve
 *
 * Goal: resolve all 65 parameterized routes to concrete URLs.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Config ──────────────────────────────────────────────────────────────────
const DB_URL = "postgresql://documenso:password@localhost:54320/documenso";
const APP_JSON = "/tmp/documenso-verify/app.json";
const AUTH = {
  userId: 9,
  teamId: 7,
  teamUrl: "personal_mwiasvikdmkwinfh",
  email: "ac1-test@test.documenso.com",
};

// ── Helpers ─────────────────────────────────────────────────────────────────
function psql(query: string): string | null {
  try {
    const result = execSync(
      `PGPASSWORD=password psql -h localhost -p 54320 -U documenso -d documenso -t -A -c ${JSON.stringify(query)}`,
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    // -t -A gives tuples-only, unaligned. First non-empty line is the value.
    const first = result.split("\n").filter((l) => l.length > 0)[0];
    return first && first !== "" ? first : null;
  } catch {
    return null;
  }
}

interface AppJson {
  routes: Record<string, { component: string; example_url?: string }>;
  data_model: Record<
    string,
    { columns: Record<string, string>; table_name: string }
  >;
}

// ── Load app.json ───────────────────────────────────────────────────────────
const app: AppJson = JSON.parse(readFileSync(APP_JSON, "utf-8"));
const allRoutes = Object.keys(app.routes);
const paramRoutes = allRoutes.filter((r) => r.includes(":"));

console.log(`Total routes: ${allRoutes.length}`);
console.log(`Parameterized routes: ${paramRoutes.length}`);
console.log();

// ── Phase 1: Deterministic Resolution ───────────────────────────────────────
interface Resolution {
  route: string;
  resolvedUrl: string | null;
  params: Record<string, string | null>;
  phase: 1 | 2 | null;
}

function resolveParamDeterministic(
  route: string,
  paramName: string,
  pathSegments: string[],
): string | null {
  // :teamUrl → hardcoded
  if (paramName === "teamUrl") return AUTH.teamUrl;

  // :orgUrl → query DB
  if (paramName === "orgUrl") {
    // Try non-personal first
    const nonPersonal = psql(
      `SELECT o.url FROM "Organisation" o JOIN "OrganisationMember" om ON om."organisationId" = o.id WHERE om."userId" = ${AUTH.userId} AND o.type = 'ORGANISATION' LIMIT 1`,
    );
    if (nonPersonal) return nonPersonal;
    // Fall back to any org
    const anyOrg = psql(
      `SELECT o.url FROM "Organisation" o JOIN "OrganisationMember" om ON om."organisationId" = o.id WHERE om."userId" = ${AUTH.userId} LIMIT 1`,
    );
    return anyOrg;
  }

  // :id — infer table from path context
  if (paramName === "id") {
    // Find the segment before :id
    const idxParam = pathSegments.indexOf(":id");
    const prevSegment = idxParam > 0 ? pathSegments[idxParam - 1] : null;

    // Special path context mappings
    const contextMap: Record<string, { table: string; teamFilter: boolean }> = {
      documents: { table: "Envelope", teamFilter: true },
      templates: { table: "Envelope", teamFilter: true }, // templates are envelopes with type=TEMPLATE
      users: { table: "User", teamFilter: false },
      organisations: { table: "Organisation", teamFilter: false },
      "email-domains": { table: "EmailDomain", teamFilter: false },
      groups: { table: "OrganisationGroup", teamFilter: false },
      webhooks: { table: "Webhook", teamFilter: true },
      "organisation-insights": {
        table: "Organisation",
        teamFilter: false,
      },
      "unsealed-documents": { table: "Envelope", teamFilter: false },
    };

    // Check for embed paths — document/template/envelope edit by id
    if (route.includes("/embed/")) {
      if (route.includes("/document/edit/")) {
        return psql(
          `SELECT id FROM "Envelope" WHERE "teamId" = ${AUTH.teamId} LIMIT 1`,
        );
      }
      if (route.includes("/template/edit/")) {
        return psql(
          `SELECT id FROM "Envelope" WHERE "teamId" = ${AUTH.teamId} AND type = 'TEMPLATE' LIMIT 1`,
        );
      }
      if (route.includes("/envelope/edit/")) {
        return psql(
          `SELECT id FROM "Envelope" WHERE "teamId" = ${AUTH.teamId} LIMIT 1`,
        );
      }
    }

    // /o/:orgUrl/settings/email-domains/:id or /o/:orgUrl/settings/groups/:id
    // The prevSegment check handles these
    if (prevSegment && contextMap[prevSegment]) {
      const { table, teamFilter } = contextMap[prevSegment];
      let query: string;
      if (prevSegment === "templates") {
        query = `SELECT id FROM "Envelope" WHERE "teamId" = ${AUTH.teamId} AND type = 'TEMPLATE' LIMIT 1`;
      } else if (prevSegment === "groups" && route.includes("/o/")) {
        // org groups
        query = `SELECT id FROM "OrganisationGroup" LIMIT 1`;
      } else if (prevSegment === "webhooks") {
        // Try team-scoped first, then user-scoped, then any
        const teamVal = psql(`SELECT id FROM "${table}" WHERE "teamId" = ${AUTH.teamId} LIMIT 1`);
        if (teamVal) return teamVal;
        const userVal = psql(`SELECT id FROM "${table}" WHERE "userId" = ${AUTH.userId} LIMIT 1`);
        if (userVal) return userVal;
        return psql(`SELECT id FROM "${table}" LIMIT 1`);
      } else if (teamFilter) {
        query = `SELECT id FROM "${table}" WHERE "teamId" = ${AUTH.teamId} LIMIT 1`;
      } else {
        query = `SELECT id FROM "${table}" LIMIT 1`;
      }
      return psql(query);
    }

    // admin paths — no team filter
    if (route.startsWith("/admin/")) {
      if (prevSegment === "documents" || prevSegment === "unsealed-documents") {
        return psql(`SELECT id FROM "Envelope" LIMIT 1`);
      }
      if (prevSegment === "users") {
        return psql(`SELECT id FROM "User" LIMIT 1`);
      }
      if (prevSegment === "organisations" || prevSegment === "organisation-insights") {
        return psql(`SELECT id FROM "Organisation" LIMIT 1`);
      }
      if (prevSegment === "email-domains") {
        return psql(`SELECT id FROM "EmailDomain" LIMIT 1`);
      }
    }

    return null;
  }

  // :token — context-dependent
  if (paramName === "token") {
    // /sign/:token, /d/:token, /embed/v0/direct/:token, /embed/v0/sign/:token
    if (
      route.startsWith("/sign/") ||
      route.startsWith("/d/") ||
      route.includes("/direct/") ||
      route.includes("/embed/v0/sign/")
    ) {
      return psql(
        `SELECT token FROM "Recipient" WHERE "documentDeletedAt" IS NULL LIMIT 1`,
      );
    }
    // /organisation/decline/:token, /organisation/invite/:token
    if (route.includes("/organisation/decline/") || route.includes("/organisation/invite/")) {
      return psql(`SELECT token FROM "OrganisationMemberInvite" LIMIT 1`);
    }
    // /organisation/sso/confirmation/:token
    if (route.includes("/organisation/sso/confirmation/")) {
      // This is likely a one-time token; try anyway
      return psql(
        `SELECT token FROM "OrganisationMemberInvite" LIMIT 1`,
      );
    }
    // /reset-password/:token
    if (route.includes("/reset-password/")) {
      return psql(`SELECT token FROM "PasswordResetToken" LIMIT 1`);
    }
    // /verify-email/:token
    if (route.includes("/verify-email/")) {
      return psql(
        `SELECT token FROM "VerificationToken" LIMIT 1`,
      );
    }
    // /team/verify-email/:token
    if (route.includes("/team/verify")) {
      return psql(
        `SELECT token FROM "TeamEmailVerification" LIMIT 1`,
      );
    }
    return null;
  }

  // :folderId
  if (paramName === "folderId") {
    return psql(
      `SELECT id FROM "Folder" WHERE "teamId" = ${AUTH.teamId} LIMIT 1`,
    );
  }

  // :slug — DocumentShareLink
  if (paramName === "slug") {
    return psql(`SELECT slug FROM "DocumentShareLink" LIMIT 1`);
  }

  // :url — public profile (Team.url where TeamProfile is enabled)
  if (paramName === "url" && route.startsWith("/p/")) {
    return psql(
      `SELECT t.url FROM "Team" t JOIN "TeamProfile" tp ON tp."teamId" = t.id WHERE tp.enabled = true LIMIT 1`,
    );
  }

  return null;
}

function extractParams(route: string): string[] {
  const matches = route.match(/:(\w+)/g);
  return matches ? matches.map((m) => m.slice(1)) : [];
}

const phase1Start = Date.now();
const resolutions: Resolution[] = [];

for (const route of paramRoutes) {
  const params = extractParams(route);
  const segments = route.split("/").filter(Boolean);
  const resolved: Record<string, string | null> = {};
  let allResolved = true;

  for (const param of params) {
    const value = resolveParamDeterministic(route, param, segments);
    resolved[param] = value;
    if (value === null) allResolved = false;
  }

  let resolvedUrl: string | null = null;
  if (allResolved) {
    resolvedUrl = route;
    for (const [param, value] of Object.entries(resolved)) {
      resolvedUrl = resolvedUrl.replace(`:${param}`, value!);
    }
  }

  resolutions.push({
    route,
    resolvedUrl,
    params: resolved,
    phase: allResolved ? 1 : null,
  });
}

const phase1End = Date.now();
const phase1Time = phase1End - phase1Start;

const phase1Resolved = resolutions.filter((r) => r.phase === 1);
const phase1Unresolved = resolutions.filter((r) => r.phase === null);

console.log("═══════════════════════════════════════════════════════════════");
console.log("  PHASE 1: Deterministic Resolution");
console.log("═══════════════════════════════════════════════════════════════");
console.log(`  Resolved: ${phase1Resolved.length}/${paramRoutes.length}`);
console.log(`  Unresolved: ${phase1Unresolved.length}/${paramRoutes.length}`);
console.log(`  Time: ${phase1Time}ms`);
console.log();

if (phase1Resolved.length > 0) {
  console.log("  Resolved routes:");
  for (const r of phase1Resolved) {
    console.log(`    ${r.route}`);
    console.log(`      → ${r.resolvedUrl}`);
  }
  console.log();
}

if (phase1Unresolved.length > 0) {
  console.log("  Unresolved routes (need LLM):");
  for (const r of phase1Unresolved) {
    const unresolvedParams = Object.entries(r.params)
      .filter(([, v]) => v === null)
      .map(([k]) => `:${k}`);
    console.log(`    ${r.route}  [missing: ${unresolvedParams.join(", ")}]`);
  }
  console.log();
}

// ── Phase 2: LLM Fallback ──────────────────────────────────────────────────
const phase2Start = Date.now();

if (phase1Unresolved.length > 0) {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  PHASE 2: LLM Fallback");
  console.log("═══════════════════════════════════════════════════════════════");

  // Build prompt with unresolved routes and their partially resolved params
  const unresolvedInfo = phase1Unresolved.map((r) => {
    const missing = Object.entries(r.params)
      .filter(([, v]) => v === null)
      .map(([k]) => k);
    const known = Object.entries(r.params)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => `${k}=${v}`);
    return {
      route: r.route,
      missingParams: missing,
      knownParams: known,
    };
  });

  // Build a compact schema summary for the LLM
  const schemaLines: string[] = [];
  for (const [model, info] of Object.entries(app.data_model)) {
    const cols = Object.keys(info.columns).join(", ");
    schemaLines.push(`${model} (table: ${info.table_name}): ${cols}`);
  }

  const llmPrompt = `You are resolving URL route parameters for a Documenso app.

DB connection: postgresql://documenso:password@localhost:54320/documenso
Auth context: userId=9, teamId=7

Schema summary:
${schemaLines.join("\n")}

Routes that need parameter resolution:
${JSON.stringify(unresolvedInfo, null, 2)}

For each route, query the database to find valid values for the missing parameters.

Rules:
- Use psql with: PGPASSWORD=password psql -h localhost -p 54320 -U documenso -d documenso -t -A -c "QUERY"
- For :token params, check context: /sign/:token uses Recipient.token, /reset-password/:token uses PasswordResetToken.token, etc.
- For :id params, look at the path context to determine the table
- For :slug, check DocumentShareLink.slug
- For :url in /p/:url, check TeamProfile
- If a value truly doesn't exist in the DB, say so

Output ONLY a JSON object mapping route patterns to resolved URLs. Example:
{"routes": {"/sign/:token": "/sign/abc123", "/p/:url": null}}

No explanation, just the JSON.`;

  // Write prompt to temp file for LLM
  const promptFile = join(tmpdir(), `spike-7c-prompt-${Date.now()}.txt`);
  writeFileSync(promptFile, llmPrompt, "utf-8");

  // Try LLM via claude -p. In some environments (e.g., nested Claude Code),
  // claude -p is redirected to background tasks and returns empty stdout.
  // In that case, fall back to diagnosing why the tables are empty.
  let llmWorked = false;
  try {
    const llmResult = execSync(
      `cat "${promptFile}" | claude -p --allowedTools Bash --max-turns 15`,
      {
        encoding: "utf-8",
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    // Parse LLM output — find JSON in the response
    const jsonMatch = llmResult.match(/\{[\s\S]*"routes"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as {
        routes: Record<string, string | null>;
      };
      let phase2Count = 0;

      for (const r of phase1Unresolved) {
        const resolved = parsed.routes[r.route];
        if (resolved) {
          r.resolvedUrl = resolved;
          r.phase = 2;
          phase2Count++;
        }
      }

      if (phase2Count > 0) llmWorked = true;
      console.log(`  LLM resolved: ${phase2Count} additional routes`);
      console.log();

      if (phase2Count > 0) {
        console.log("  LLM-resolved routes:");
        for (const r of phase1Unresolved.filter((x) => x.phase === 2)) {
          console.log(`    ${r.route}`);
          console.log(`      → ${r.resolvedUrl}`);
        }
        console.log();
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  LLM phase error: ${msg.slice(0, 200)}`);
  } finally {
    try { unlinkSync(promptFile); } catch { /* ignore */ }
  }

  // If LLM didn't resolve anything, diagnose why each route is stuck
  if (!llmWorked) {
    console.log("  LLM phase returned no results (claude -p may not work in nested env).");
    console.log("  Diagnosing unresolved routes via direct DB queries:");
    console.log();

    // Diagnostic queries for each unresolved pattern
    const diagnostics: Record<string, string> = {
      "email-domains/:id": `SELECT count(*) FROM "EmailDomain"`,
      "webhooks/:id": `SELECT count(*) FROM "Webhook"`,
      "share/:slug": `SELECT count(*) FROM "DocumentShareLink"`,
      "reset-password/:token": `SELECT count(*) FROM "PasswordResetToken"`,
    };

    for (const r of phase1Unresolved) {
      // Find matching diagnostic
      for (const [pattern, query] of Object.entries(diagnostics)) {
        if (r.route.includes(pattern)) {
          const count = psql(query);
          console.log(`    ${r.route}`);
          console.log(`      Table query: ${query}`);
          console.log(`      Row count: ${count ?? "error"}`);
          if (count === "0") {
            console.log(`      Reason: TABLE IS EMPTY — no seed data exists`);
          }
          console.log();
          break;
        }
      }
    }
  }
}

const phase2End = Date.now();
const phase2Time = phase2End - phase2Start;

// ── Final Report ────────────────────────────────────────────────────────────
const totalResolved = resolutions.filter((r) => r.phase !== null);
const stillUnresolved = resolutions.filter((r) => r.phase === null);

console.log("═══════════════════════════════════════════════════════════════");
console.log("  FINAL REPORT");
console.log("═══════════════════════════════════════════════════════════════");
console.log(`  Phase 1 (deterministic): ${phase1Resolved.length}/${paramRoutes.length} resolved in ${phase1Time}ms`);
console.log(`  Phase 2 (LLM fallback):  ${totalResolved.length - phase1Resolved.length} additional in ${phase2Time}ms`);
console.log(`  Total coverage:          ${totalResolved.length}/${paramRoutes.length}`);
console.log(`  Total time:              ${phase1Time + phase2Time}ms`);
console.log();

if (stillUnresolved.length > 0) {
  console.log("  Still unresolved:");
  for (const r of stillUnresolved) {
    const missing = Object.entries(r.params)
      .filter(([, v]) => v === null)
      .map(([k]) => `:${k}`);
    console.log(`    ${r.route}  [missing: ${missing.join(", ")}]`);
  }
} else {
  console.log("  All routes resolved!");
}

console.log();
console.log("═══════════════════════════════════════════════════════════════");
console.log("  ALL RESOLVED URLs");
console.log("═══════════════════════════════════════════════════════════════");
for (const r of resolutions) {
  const status = r.phase === 1 ? "P1" : r.phase === 2 ? "P2" : "??";
  console.log(`  [${status}] ${r.route}`);
  console.log(`       → ${r.resolvedUrl ?? "(unresolved)"}`);
}
