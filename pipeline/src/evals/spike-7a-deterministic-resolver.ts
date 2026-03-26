/**
 * Spike 7a: Deterministic route param resolver
 *
 * Resolves parameterized routes to concrete URLs by:
 *   1. Parsing :paramName segments from each route
 *   2. Matching each param to a DB column using naming conventions
 *   3. Querying the DB for a real value scoped to the test user's team
 *   4. Substituting and building the concrete URL
 *
 * No LLM involved — pure heuristic + psql queries.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// ── Config ──────────────────────────────────────────────────────────────────

const DB_URL = "postgresql://documenso:password@localhost:54320/documenso";
const APP_JSON_PATH = "/tmp/documenso-verify/app.json";
const USER_ID = 9;
const TEAM_ID = 7;
const TEAM_URL = "personal_mwiasvikdmkwinfh";

// ── Helpers ─────────────────────────────────────────────────────────────────

function psql(query: string): string {
  try {
    const result = execSync(
      `psql "${DB_URL}" -t -A -c ${JSON.stringify(query)}`,
      { timeout: 5000, encoding: "utf-8" },
    );
    return result.trim();
  } catch {
    return "";
  }
}

interface AppIndex {
  routes: Record<string, unknown>;
  data_model: Record<
    string,
    {
      table_name: string;
      columns: Record<string, string>; // prismaField → pgColumn
    }
  >;
  example_urls: Record<string, string>;
}

// ── Load app.json ───────────────────────────────────────────────────────────

const appIndex: AppIndex = JSON.parse(readFileSync(APP_JSON_PATH, "utf-8"));

const allRoutes = Object.keys(appIndex.routes);
const paramRoutes = allRoutes.filter((r) => r.includes(":"));

console.log(`Total routes: ${allRoutes.length}`);
console.log(`Parameterized routes: ${paramRoutes.length}`);
console.log(`Existing example_urls: ${Object.keys(appIndex.example_urls).length}`);
console.log();

// ── Route context detection ─────────────────────────────────────────────────
// Given a route like /t/:teamUrl/documents/:id, figure out which "entity"
// context the :id refers to based on surrounding path segments.

function getRouteContext(route: string): string {
  // Return the path segment just before the param, or the dominant segment
  const parts = route.split("/").filter(Boolean);
  // Find meaningful segments (not params)
  const segments = parts.filter((p) => !p.startsWith(":"));
  return segments.join("/");
}

function getParentSegment(route: string, paramName: string): string | null {
  const parts = route.split("/");
  const idx = parts.indexOf(`:${paramName}`);
  if (idx <= 0) return null;
  const prev = parts[idx - 1];
  return prev.startsWith(":") ? null : prev;
}

// ── Param resolvers ─────────────────────────────────────────────────────────

// Cache resolved values to avoid repeat queries
const cache = new Map<string, string>();

function resolveParam(
  paramName: string,
  route: string,
): string | null {
  const cacheKey = `${paramName}:${route}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;

  const value = resolveParamInner(paramName, route);
  if (value) cache.set(cacheKey, value);
  return value;
}

function resolveParamInner(
  paramName: string,
  route: string,
): string | null {
  // ── Hard-coded known params ──

  if (paramName === "teamUrl") return TEAM_URL;

  if (paramName === "orgUrl") {
    const val = psql(
      `SELECT o.url FROM "Organisation" o ` +
        `JOIN "OrganisationMember" om ON om."organisationId" = o.id ` +
        `WHERE om."userId" = ${USER_ID} LIMIT 1`,
    );
    return val || null;
  }

  // ── Context-dependent :id ──
  if (paramName === "id") {
    return resolveId(route);
  }

  // ── :token — depends on route context ──
  if (paramName === "token") {
    return resolveToken(route);
  }

  // ── :folderId ──
  if (paramName === "folderId") {
    // Check folder type based on route context
    const isTemplateFolder = route.includes("/templates/");
    const folderType = isTemplateFolder ? "TEMPLATE" : "DOCUMENT";
    const val = psql(
      `SELECT id FROM "Folder" WHERE "teamId" = ${TEAM_ID} AND type = '${folderType}' LIMIT 1`,
    );
    if (val) return val;
    // Fallback: any folder for this team
    const fallback = psql(
      `SELECT id FROM "Folder" WHERE "teamId" = ${TEAM_ID} LIMIT 1`,
    );
    return fallback || null;
  }

  // ── :slug (DocumentShareLink) ──
  if (paramName === "slug") {
    const val = psql(
      `SELECT dsl.slug FROM "DocumentShareLink" dsl ` +
        `JOIN "Envelope" e ON e.id = dsl."envelopeId" ` +
        `WHERE e."teamId" = ${TEAM_ID} LIMIT 1`,
    );
    return val || null;
  }

  // ── :url (public profile: /p/:url) ──
  if (paramName === "url") {
    // /p/:url is a public profile page — use team URL
    if (route.startsWith("/p/")) {
      const val = psql(
        `SELECT t.url FROM "Team" t ` +
          `JOIN "TeamProfile" tp ON tp."teamId" = t.id ` +
          `WHERE tp.enabled = true LIMIT 1`,
      );
      return val || TEAM_URL;
    }
    return null;
  }

  // ── Generic fallback: search for a column matching paramName ──
  return resolveGeneric(paramName, route);
}

function resolveId(route: string): string | null {
  const parent = getParentSegment(route, "id");
  const ctx = getRouteContext(route);

  // /admin/documents/:id
  if (ctx.startsWith("admin/documents")) {
    const val = psql(`SELECT id FROM "Envelope" WHERE type = 'DOCUMENT' LIMIT 1`);
    return val || null;
  }

  // /admin/users/:id
  if (ctx.startsWith("admin/users")) {
    const val = psql(`SELECT id FROM "User" LIMIT 1`);
    return val || null;
  }

  // /admin/organisations/:id
  if (ctx.startsWith("admin/organisations") || ctx.startsWith("admin/organisation-insights")) {
    const val = psql(`SELECT id FROM "Organisation" LIMIT 1`);
    return val || null;
  }

  // /admin/email-domains/:id
  if (ctx.startsWith("admin/email-domains")) {
    const val = psql(`SELECT id FROM "EmailDomain" LIMIT 1`);
    return val || null;
  }

  // /embed/v1/authoring/document/edit/:id or /embed/v2/authoring/envelope/edit/:id
  if (ctx.includes("authoring/document") || ctx.includes("authoring/envelope")) {
    const val = psql(
      `SELECT id FROM "Envelope" WHERE "teamId" = ${TEAM_ID} AND type = 'DOCUMENT' LIMIT 1`,
    );
    return val || null;
  }

  // /embed/v1/authoring/template/edit/:id
  if (ctx.includes("authoring/template")) {
    const val = psql(
      `SELECT id FROM "Envelope" WHERE "teamId" = ${TEAM_ID} AND type = 'TEMPLATE' LIMIT 1`,
    );
    return val || null;
  }

  // /t/:teamUrl/documents/:id (and /edit, /logs, /legacy_editor)
  if (parent === "documents" || ctx.includes("documents")) {
    const val = psql(
      `SELECT id FROM "Envelope" WHERE "teamId" = ${TEAM_ID} AND type = 'DOCUMENT' LIMIT 1`,
    );
    return val || null;
  }

  // /t/:teamUrl/templates/:id (and /edit, /legacy_editor)
  if (parent === "templates" || ctx.includes("templates")) {
    const val = psql(
      `SELECT id FROM "Envelope" WHERE "teamId" = ${TEAM_ID} AND type = 'TEMPLATE' LIMIT 1`,
    );
    return val || null;
  }

  // /settings/webhooks/:id or /t/:teamUrl/settings/webhooks/:id
  if (parent === "webhooks" || ctx.includes("webhooks")) {
    const val = psql(
      `SELECT id FROM "Webhook" WHERE "teamId" = ${TEAM_ID} LIMIT 1`,
    );
    if (val) return val;
    // Fallback: any webhook for this user
    const fallback = psql(
      `SELECT id FROM "Webhook" WHERE "userId" = ${USER_ID} LIMIT 1`,
    );
    return fallback || null;
  }

  // /o/:orgUrl/settings/email-domains/:id
  if (ctx.includes("email-domains")) {
    const val = psql(
      `SELECT ed.id FROM "EmailDomain" ed ` +
        `JOIN "Organisation" o ON o.id = ed."organisationId" ` +
        `JOIN "OrganisationMember" om ON om."organisationId" = o.id ` +
        `WHERE om."userId" = ${USER_ID} LIMIT 1`,
    );
    return val || null;
  }

  // /o/:orgUrl/settings/groups/:id
  if (ctx.includes("o") && ctx.includes("groups")) {
    const val = psql(
      `SELECT og.id FROM "OrganisationGroup" og ` +
        `JOIN "Organisation" o ON o.id = og."organisationId" ` +
        `JOIN "OrganisationMember" om ON om."organisationId" = o.id ` +
        `WHERE om."userId" = ${USER_ID} LIMIT 1`,
    );
    return val || null;
  }

  // Fallback: try Envelope for the team
  const fallback = psql(
    `SELECT id FROM "Envelope" WHERE "teamId" = ${TEAM_ID} LIMIT 1`,
  );
  return fallback || null;
}

function resolveToken(route: string): string | null {
  const ctx = getRouteContext(route);

  // /d/:token or /sign/:token — recipient token
  if (
    route.startsWith("/d/") ||
    route.startsWith("/sign/") ||
    route.startsWith("/embed/v0/sign/")
  ) {
    const val = psql(
      `SELECT r.token FROM "Recipient" r ` +
        `JOIN "Envelope" e ON e.id = r."envelopeId" ` +
        `WHERE e."teamId" = ${TEAM_ID} AND e.type = 'DOCUMENT' LIMIT 1`,
    );
    return val || null;
  }

  // /embed/v0/direct/:token — TemplateDirectLink token
  if (route.includes("direct")) {
    const val = psql(
      `SELECT tdl.token FROM "TemplateDirectLink" tdl ` +
        `JOIN "Envelope" e ON e.id = tdl."envelopeId" ` +
        `WHERE e."teamId" = ${TEAM_ID} LIMIT 1`,
    );
    return val || null;
  }

  // /reset-password/:token
  if (route.includes("reset-password")) {
    const val = psql(
      `SELECT token FROM "PasswordResetToken" WHERE "userId" = ${USER_ID} LIMIT 1`,
    );
    return val || null;
  }

  // /organisation/decline/:token or /organisation/invite/:token
  if (route.includes("organisation/decline") || route.includes("organisation/invite")) {
    const val = psql(
      `SELECT omi.token FROM "OrganisationMemberInvite" omi ` +
        `JOIN "Organisation" o ON o.id = omi."organisationId" ` +
        `JOIN "OrganisationMember" om ON om."organisationId" = o.id ` +
        `WHERE om."userId" = ${USER_ID} LIMIT 1`,
    );
    return val || null;
  }

  // /organisation/sso/confirmation/:token — SSO confirmation
  if (route.includes("sso/confirmation")) {
    // Unlikely to have data, but try
    return null;
  }

  // /verify-email/:token
  if (route.includes("verify-email") && !route.includes("team")) {
    const val = psql(
      `SELECT token FROM "VerificationToken" WHERE "userId" = ${USER_ID} LIMIT 1`,
    );
    return val || null;
  }

  // /team/verify-email/:token
  if (route.includes("team/verify-email")) {
    const val = psql(
      `SELECT token FROM "TeamEmailVerification" WHERE "teamId" = ${TEAM_ID} LIMIT 1`,
    );
    return val || null;
  }

  return null;
}

function resolveGeneric(paramName: string, _route: string): string | null {
  // Search all tables in the data model for a column matching paramName
  const dm = appIndex.data_model;
  for (const [_modelName, info] of Object.entries(dm)) {
    const cols = info.columns;
    // Check if any prisma field name matches paramName
    if (paramName in cols) {
      const pgCol = cols[paramName];
      const table = info.table_name;
      const val = psql(
        `SELECT "${pgCol}" FROM "${table}" LIMIT 1`,
      );
      if (val) return val;
    }
  }
  return null;
}

// ── Main resolver loop ──────────────────────────────────────────────────────

const startTime = Date.now();

const resolved: Record<string, string> = {};
const unresolved: string[] = [];
const unresolvedDetails: Array<{ route: string; failedParams: string[] }> = [];

for (const route of paramRoutes) {
  // Extract all :paramName from the route
  const params = route.match(/:([a-zA-Z]+)/g)?.map((p) => p.slice(1)) ?? [];

  let resolvedRoute = route;
  const failedParams: string[] = [];

  for (const param of params) {
    const value = resolveParam(param, route);
    if (value) {
      resolvedRoute = resolvedRoute.replace(`:${param}`, value);
    } else {
      failedParams.push(param);
    }
  }

  if (failedParams.length === 0) {
    resolved[route] = resolvedRoute;
  } else {
    unresolved.push(route);
    unresolvedDetails.push({ route, failedParams });
  }
}

const elapsed = Date.now() - startTime;

// ── Report ──────────────────────────────────────────────────────────────────

console.log("═══════════════════════════════════════════════════════════════");
console.log("RESOLVED ROUTES");
console.log("═══════════════════════════════════════════════════════════════");
for (const [pattern, url] of Object.entries(resolved)) {
  console.log(`  ${pattern}`);
  console.log(`    → ${url}`);
}

console.log();
console.log("═══════════════════════════════════════════════════════════════");
console.log("UNRESOLVED ROUTES");
console.log("═══════════════════════════════════════════════════════════════");
for (const { route, failedParams } of unresolvedDetails) {
  console.log(`  ${route}`);
  console.log(`    ✗ missing: ${failedParams.join(", ")}`);
}

console.log();
console.log("═══════════════════════════════════════════════════════════════");
console.log("STATS");
console.log("═══════════════════════════════════════════════════════════════");
console.log(`  Total parameterized routes: ${paramRoutes.length}`);
console.log(`  Resolved:   ${Object.keys(resolved).length} (${Math.round((Object.keys(resolved).length / paramRoutes.length) * 100)}%)`);
console.log(`  Unresolved: ${unresolved.length} (${Math.round((unresolved.length / paramRoutes.length) * 100)}%)`);
console.log(`  Previous example_urls: ${Object.keys(appIndex.example_urls).length}`);
console.log(`  Improvement: ${Object.keys(resolved).length - Object.keys(appIndex.example_urls).length} additional routes`);
console.log(`  Elapsed: ${elapsed}ms`);

// ── JSON output ─────────────────────────────────────────────────────────────

const output = {
  resolved,
  unresolved,
  stats: {
    total: paramRoutes.length,
    resolved: Object.keys(resolved).length,
    unresolved: unresolved.length,
    previousExampleUrls: Object.keys(appIndex.example_urls).length,
    elapsedMs: elapsed,
  },
};

console.log();
console.log("═══════════════════════════════════════════════════════════════");
console.log("JSON OUTPUT");
console.log("═══════════════════════════════════════════════════════════════");
console.log(JSON.stringify(output, null, 2));
