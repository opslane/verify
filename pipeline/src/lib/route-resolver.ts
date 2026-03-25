// pipeline/src/lib/route-resolver.ts — Deterministic route param resolver
import { execSync } from "node:child_process";
import type { AppIndex } from "./types.js";

export interface RouteResolverContext {
  userId: string;
  teamId: string;
  teamUrl: string;
}

/**
 * Query the DB via psql. Returns trimmed result or empty string on failure.
 * Uses execSync with shell (matches dumpSeedData pattern in index-app.ts).
 */
export function psqlQuery(psqlCmd: string, query: string): string {
  try {
    return (execSync(
      `${psqlCmd} -t -A -c ${JSON.stringify(query)}`,
      { timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ) as string).trim();
  } catch {
    return "";
  }
}

/** Get the path segment immediately before a :param */
function parentSegment(route: string, paramName: string): string | null {
  const parts = route.split("/");
  const idx = parts.indexOf(`:${paramName}`);
  if (idx <= 0) return null;
  const prev = parts[idx - 1];
  return prev.startsWith(":") ? null : prev;
}

/**
 * Resolve a single :paramName to a concrete value.
 * Uses naming conventions + DB queries scoped to the auth user's team.
 */
export function resolveParam(
  paramName: string,
  route: string,
  psqlCmd: string,
  ctx: RouteResolverContext,
  dataModel: AppIndex["data_model"],
): string | null {
  // Guard against SQL injection — userId and teamId must be numeric
  if (!/^\d+$/.test(ctx.userId) || !/^\d+$/.test(ctx.teamId)) return null;

  // ── Known params from context ──
  if (paramName === "teamUrl") return ctx.teamUrl;

  if (paramName === "orgUrl") {
    const val = psqlQuery(psqlCmd,
      `SELECT o.url FROM "Organisation" o JOIN "OrganisationMember" om ON om."organisationId" = o.id WHERE om."userId" = ${ctx.userId} LIMIT 1`);
    return val || null;
  }

  // ── :id — context-dependent ──
  if (paramName === "id") return resolveId(route, psqlCmd, ctx);

  // ── :token — context-dependent ──
  if (paramName === "token") return resolveToken(route, psqlCmd, ctx);

  // ── :folderId — folder type depends on route context ──
  if (paramName === "folderId") {
    const folderType = route.includes("/templates/") ? "TEMPLATE" : "DOCUMENT";
    const val = psqlQuery(psqlCmd, `SELECT id FROM "Folder" WHERE "teamId" = ${ctx.teamId} AND type = '${folderType}' LIMIT 1`);
    if (val) return val;
    // Fallback: any folder for this team
    return psqlQuery(psqlCmd, `SELECT id FROM "Folder" WHERE "teamId" = ${ctx.teamId} LIMIT 1`) || null;
  }

  // ── :slug ──
  if (paramName === "slug") {
    return psqlQuery(psqlCmd,
      `SELECT dsl.slug FROM "DocumentShareLink" dsl JOIN "Envelope" e ON e.id = dsl."envelopeId" WHERE e."teamId" = ${ctx.teamId} LIMIT 1`) || null;
  }

  // ── :url (public profile /p/:url) ──
  if (paramName === "url" && route.startsWith("/p/")) {
    return psqlQuery(psqlCmd,
      `SELECT t.url FROM "Team" t JOIN "TeamProfile" tp ON tp."teamId" = t.id WHERE tp.enabled = true LIMIT 1`) || ctx.teamUrl;
  }

  // ── Generic fallback: search schema for matching column ──
  for (const [_modelName, info] of Object.entries(dataModel)) {
    if (paramName in info.columns) {
      const val = psqlQuery(psqlCmd, `SELECT "${info.columns[paramName]}" FROM "${info.table_name}" LIMIT 1`);
      if (val) return val;
    }
  }

  return null;
}

function resolveId(route: string, psqlCmd: string, ctx: RouteResolverContext): string | null {
  const parent = parentSegment(route, "id");
  const segments = route.split("/").filter(p => p && !p.startsWith(":")).join("/");

  // Map parent path segments to tables + scoping
  const segmentToTable: Record<string, { table: string; scope: string }> = {
    documents:               { table: "Envelope", scope: `"teamId" = ${ctx.teamId} AND type = 'DOCUMENT'` },
    templates:               { table: "Envelope", scope: `"teamId" = ${ctx.teamId} AND type = 'TEMPLATE'` },
    webhooks:                { table: "Webhook", scope: `"teamId" = ${ctx.teamId}` },
    "email-domains":         { table: "EmailDomain", scope: `1=1` },
    groups:                  { table: "OrganisationGroup", scope: `1=1` },
    users:                   { table: "User", scope: `1=1` },
    organisations:           { table: "Organisation", scope: `1=1` },
    "organisation-insights": { table: "Organisation", scope: `1=1` },
    "unsealed-documents":    { table: "Envelope", scope: `1=1` },
  };

  // Try parent segment first
  if (parent && segmentToTable[parent]) {
    const { table, scope } = segmentToTable[parent];
    const val = psqlQuery(psqlCmd, `SELECT id FROM "${table}" WHERE ${scope} LIMIT 1`);
    if (val) return val;
  }

  // Try context-based matching (for nested routes like /admin/documents/:id)
  for (const [seg, { table, scope }] of Object.entries(segmentToTable)) {
    if (segments.includes(seg)) {
      const val = psqlQuery(psqlCmd, `SELECT id FROM "${table}" WHERE ${scope} LIMIT 1`);
      if (val) return val;
    }
  }

  // Embed routes
  if (segments.includes("authoring/document") || segments.includes("authoring/envelope")) {
    const val = psqlQuery(psqlCmd, `SELECT id FROM "Envelope" WHERE "teamId" = ${ctx.teamId} LIMIT 1`);
    if (val) return val;
  }
  if (segments.includes("authoring/template")) {
    const val = psqlQuery(psqlCmd, `SELECT id FROM "Envelope" WHERE "teamId" = ${ctx.teamId} AND type = 'TEMPLATE' LIMIT 1`);
    if (val) return val;
  }

  // Ultimate fallback: any envelope for the team
  return psqlQuery(psqlCmd, `SELECT id FROM "Envelope" WHERE "teamId" = ${ctx.teamId} LIMIT 1`) || null;
}

function resolveToken(route: string, psqlCmd: string, ctx: RouteResolverContext): string | null {
  // /d/:token or /sign/:token — recipient token
  if (route.startsWith("/d/") || route.startsWith("/sign/") || route.includes("/sign/")) {
    return psqlQuery(psqlCmd,
      `SELECT r.token FROM "Recipient" r JOIN "Envelope" e ON e.id = r."envelopeId" WHERE e."teamId" = ${ctx.teamId} LIMIT 1`) || null;
  }

  // /embed/v0/direct/:token
  if (route.includes("direct")) {
    return psqlQuery(psqlCmd,
      `SELECT tdl.token FROM "TemplateDirectLink" tdl JOIN "Envelope" e ON e.id = tdl."envelopeId" WHERE e."teamId" = ${ctx.teamId} LIMIT 1`) || null;
  }

  // /reset-password/:token
  if (route.includes("reset-password")) {
    return psqlQuery(psqlCmd, `SELECT token FROM "PasswordResetToken" WHERE "userId" = ${ctx.userId} LIMIT 1`) || null;
  }

  // /organisation/invite/:token or /organisation/decline/:token
  if (route.includes("organisation/invite") || route.includes("organisation/decline")) {
    return psqlQuery(psqlCmd,
      `SELECT omi.token FROM "OrganisationMemberInvite" omi JOIN "Organisation" o ON o.id = omi."organisationId" JOIN "OrganisationMember" om ON om."organisationId" = o.id WHERE om."userId" = ${ctx.userId} LIMIT 1`) || null;
  }

  // /verify-email/:token
  if (route.includes("verify-email") && !route.includes("team")) {
    return psqlQuery(psqlCmd, `SELECT token FROM "VerificationToken" WHERE "userId" = ${ctx.userId} LIMIT 1`) || null;
  }

  // /team/verify-email/:token
  if (route.includes("team/verify-email")) {
    return psqlQuery(psqlCmd, `SELECT token FROM "TeamEmailVerification" WHERE "teamId" = ${ctx.teamId} LIMIT 1`) || null;
  }

  return null;
}

/**
 * Resolve all parameterized routes to concrete example URLs.
 * Returns a map of route pattern → concrete URL for successfully resolved routes.
 */
export function resolveExampleUrls(
  routes: AppIndex["routes"],
  dataModel: AppIndex["data_model"],
  psqlCmd: string,
  ctx: RouteResolverContext,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const route of Object.keys(routes)) {
    const params = route.match(/:([a-zA-Z]+)/g)?.map(p => p.slice(1));
    if (!params || params.length === 0) continue;

    let resolved = route;
    let allResolved = true;

    for (const param of params) {
      const value = resolveParam(param, route, psqlCmd, ctx, dataModel);
      if (value) {
        resolved = resolved.replace(`:${param}`, value);
      } else {
        allResolved = false;
        break;
      }
    }

    if (allResolved) {
      result[route] = resolved;
    }
  }

  return result;
}
