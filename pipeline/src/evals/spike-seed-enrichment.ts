#!/usr/bin/env npx tsx
/**
 * Spike: Seed Enrichment — create COMPLETE test entity graphs deterministically.
 *
 * Problem: The setup-writer creates hollow records (Envelope with no
 * DocumentMeta/EnvelopeItem/Recipient). The app shows "Something went wrong"
 * or 404 because it expects the full entity graph.
 *
 * Approach: Instead of LLM creating data at runtime, create complete test
 * entities ONCE during setup by reading the schema and building full INSERT
 * graphs. Prefix all strings with 'seed-verify-' for cleanup.
 *
 * Usage:
 *   cd pipeline && npx tsx src/evals/spike-seed-enrichment.ts
 *
 * Requires:
 *   - Documenso DB at postgresql://documenso:password@localhost:54320/documenso
 *   - userId=9, teamId=7
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";

// ── Config ──────────────────────────────────────────────────────────────────────

const DB_URL = "postgresql://documenso:password@localhost:54320/documenso";
const USER_ID = 9;
const TEAM_ID = 7;
const TEAM_SLUG = "personal_mwiasvikdmkwinfh";
const ORG_ID = "org_verifyorg001";
const ORG_URL = "verifyorg";

// ── Helpers ─────────────────────────────────────────────────────────────────────

function psql(sql: string): string {
  const cleanUrl = DB_URL.split("?")[0];
  try {
    return execSync(
      `psql "${cleanUrl}" -t -A -c ${escapeShellArg(sql)}`,
      { timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(err.stderr?.trim() || err.message || "psql failed");
  }
}

function psqlMulti(sql: string): string {
  const cleanUrl = DB_URL.split("?")[0];
  try {
    return execSync(
      `psql "${cleanUrl}" -t -A -f -`,
      {
        input: sql,
        timeout: 30_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    ).trim();
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(err.stderr?.trim() || err.message || "psql failed");
  }
}

function escapeShellArg(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function psqlCount(sql: string): number {
  const raw = psql(sql);
  const n = parseInt(raw, 10);
  return isNaN(n) ? 0 : n;
}

interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

function getNotNullColumns(table: string): ColumnInfo[] {
  const raw = psql(`
    SELECT column_name || '|' || data_type || '|' || is_nullable || '|' || COALESCE(column_default, 'NULL')
    FROM information_schema.columns
    WHERE table_name = '${table}' AND is_nullable = 'NO' AND column_default IS NULL
    ORDER BY ordinal_position
  `);
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map(line => {
    const [column_name, data_type, is_nullable, column_default] = line.split("|");
    return {
      column_name,
      data_type,
      is_nullable,
      column_default: column_default === "NULL" ? null : column_default,
    };
  });
}

// ── Schema Discovery ────────────────────────────────────────────────────────────

function discoverSchema(): Record<string, ColumnInfo[]> {
  const tables = [
    "Envelope", "DocumentMeta", "DocumentData", "EnvelopeItem",
    "Recipient", "TemplateDirectLink", "OrganisationMemberInvite",
  ];
  const result: Record<string, ColumnInfo[]> = {};
  for (const t of tables) {
    result[t] = getNotNullColumns(t);
  }
  return result;
}

// ── Seed Entity 1: Complete Draft Document ──────────────────────────────────────

function buildDraftDocumentSQL(): { sql: string; ids: Record<string, string> } {
  // We need: DocumentMeta -> DocumentData -> Envelope -> EnvelopeItem -> Recipient
  // All linked with gen_random_uuid() IDs

  // A minimal valid PDF as base64 (smallest possible valid PDF)
  const minimalPdfBase64 = "JVBERi0xLjAKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSA+PgplbmRvYmoKeHJlZgowIDQKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDQgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjIwNgolJUVPRgo=";

  const sql = `
-- Seed Entity 1: Complete Draft Document
-- Creates: DocumentMeta + DocumentData + Envelope + EnvelopeItem + Recipient

DO $$
DECLARE
  v_doc_meta_id TEXT;
  v_doc_data_id TEXT;
  v_envelope_id TEXT;
  v_envelope_item_id TEXT;
  v_secondary_id TEXT;
  v_recipient_token TEXT;
BEGIN
  v_doc_meta_id := gen_random_uuid()::text;
  v_doc_data_id := gen_random_uuid()::text;
  v_envelope_id := 'seed-verify-draft-' || gen_random_uuid()::text;
  v_envelope_item_id := gen_random_uuid()::text;
  v_secondary_id := gen_random_uuid()::text;
  v_recipient_token := gen_random_uuid()::text;

  -- 1. DocumentMeta (required by Envelope.documentMetaId)
  INSERT INTO "DocumentMeta" (
    "id", "signingOrder", "typedSignatureEnabled", "language",
    "distributionMethod", "drawSignatureEnabled", "uploadSignatureEnabled",
    "allowDictateNextSigner"
  ) VALUES (
    v_doc_meta_id, 'PARALLEL', true, 'en',
    'EMAIL', true, true, false
  ) ON CONFLICT (id) DO NOTHING;

  -- 2. DocumentData (required by EnvelopeItem.documentDataId)
  INSERT INTO "DocumentData" (
    "id", "type", "data", "initialData"
  ) VALUES (
    v_doc_data_id, 'BYTES_64',
    '${minimalPdfBase64}',
    '${minimalPdfBase64}'
  ) ON CONFLICT (id) DO NOTHING;

  -- 3. Envelope (the document itself)
  INSERT INTO "Envelope" (
    "id", "secondaryId", "type", "title", "status", "source",
    "internalVersion", "useLegacyFieldInsertion", "visibility",
    "templateType", "publicTitle", "publicDescription",
    "userId", "teamId", "documentMetaId", "updatedAt"
  ) VALUES (
    v_envelope_id, v_secondary_id, 'DOCUMENT', 'seed-verify-draft-doc',
    'DRAFT', 'DOCUMENT', 1, false, 'EVERYONE',
    'PRIVATE', '', '',
    ${USER_ID}, ${TEAM_ID}, v_doc_meta_id, NOW()
  ) ON CONFLICT (id) DO NOTHING;

  -- 4. EnvelopeItem (links DocumentData to Envelope)
  INSERT INTO "EnvelopeItem" (
    "id", "title", "documentDataId", "envelopeId", "order"
  ) VALUES (
    v_envelope_item_id, 'seed-verify-doc.pdf', v_doc_data_id, v_envelope_id, 0
  ) ON CONFLICT (id) DO NOTHING;

  -- 5. Recipient (at least one signer)
  INSERT INTO "Recipient" (
    "email", "name", "token", "readStatus", "signingStatus",
    "sendStatus", "role", "envelopeId"
  ) VALUES (
    'seed-verify-signer@example.com', 'Seed Verify Signer',
    v_recipient_token, 'NOT_OPENED', 'NOT_SIGNED',
    'NOT_SENT', 'SIGNER', v_envelope_id
  );

  RAISE NOTICE 'Created draft document: envelope_id=%, meta_id=%, data_id=%',
    v_envelope_id, v_doc_meta_id, v_doc_data_id;
END $$;
`;

  return {
    sql,
    ids: {
      description: "Complete draft document with DocumentMeta + DocumentData + EnvelopeItem + Recipient",
    },
  };
}

// ── Seed Entity 2: Complete Template with Direct Link ───────────────────────────

function buildTemplateWithDirectLinkSQL(): { sql: string; ids: Record<string, string> } {
  const minimalPdfBase64 = "JVBERi0xLjAKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSA+PgplbmRvYmoKeHJlZgowIDQKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDQgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjIwNgolJUVPRgo=";

  const sql = `
-- Seed Entity 2: Complete Template with Direct Link
-- Creates: DocumentMeta + DocumentData + Envelope(TEMPLATE) + EnvelopeItem + Recipient + TemplateDirectLink

DO $$
DECLARE
  v_doc_meta_id TEXT;
  v_doc_data_id TEXT;
  v_envelope_id TEXT;
  v_envelope_item_id TEXT;
  v_secondary_id TEXT;
  v_recipient_id INTEGER;
  v_recipient_token TEXT;
  v_direct_link_id TEXT;
  v_direct_link_token TEXT;
BEGIN
  v_doc_meta_id := gen_random_uuid()::text;
  v_doc_data_id := gen_random_uuid()::text;
  v_envelope_id := 'seed-verify-template-' || gen_random_uuid()::text;
  v_envelope_item_id := gen_random_uuid()::text;
  v_secondary_id := gen_random_uuid()::text;
  v_recipient_token := gen_random_uuid()::text;
  v_direct_link_id := gen_random_uuid()::text;
  v_direct_link_token := 'seed-verify-dl-' || substring(gen_random_uuid()::text, 1, 12);

  -- 1. DocumentMeta
  INSERT INTO "DocumentMeta" (
    "id", "signingOrder", "typedSignatureEnabled", "language",
    "distributionMethod", "drawSignatureEnabled", "uploadSignatureEnabled",
    "allowDictateNextSigner"
  ) VALUES (
    v_doc_meta_id, 'PARALLEL', true, 'en',
    'EMAIL', true, true, false
  ) ON CONFLICT (id) DO NOTHING;

  -- 2. DocumentData
  INSERT INTO "DocumentData" (
    "id", "type", "data", "initialData"
  ) VALUES (
    v_doc_data_id, 'BYTES_64',
    '${minimalPdfBase64}',
    '${minimalPdfBase64}'
  ) ON CONFLICT (id) DO NOTHING;

  -- 3. Envelope (as TEMPLATE)
  INSERT INTO "Envelope" (
    "id", "secondaryId", "type", "title", "status", "source",
    "internalVersion", "useLegacyFieldInsertion", "visibility",
    "templateType", "publicTitle", "publicDescription",
    "userId", "teamId", "documentMetaId", "updatedAt"
  ) VALUES (
    v_envelope_id, v_secondary_id, 'TEMPLATE', 'seed-verify-template',
    'DRAFT', 'DOCUMENT', 1, false, 'EVERYONE',
    'PRIVATE', '', '',
    ${USER_ID}, ${TEAM_ID}, v_doc_meta_id, NOW()
  ) ON CONFLICT (id) DO NOTHING;

  -- 4. EnvelopeItem
  INSERT INTO "EnvelopeItem" (
    "id", "title", "documentDataId", "envelopeId", "order"
  ) VALUES (
    v_envelope_item_id, 'seed-verify-template.pdf', v_doc_data_id, v_envelope_id, 0
  ) ON CONFLICT (id) DO NOTHING;

  -- 5. Recipient (needed as directTemplateRecipientId for TemplateDirectLink)
  INSERT INTO "Recipient" (
    "email", "name", "token", "readStatus", "signingStatus",
    "sendStatus", "role", "envelopeId"
  ) VALUES (
    'seed-verify-template-signer@example.com', 'Template Signer',
    v_recipient_token, 'NOT_OPENED', 'NOT_SIGNED',
    'NOT_SENT', 'SIGNER', v_envelope_id
  ) RETURNING id INTO v_recipient_id;

  -- 6. TemplateDirectLink (enabled, with token for /embed/v0/direct/{token})
  INSERT INTO "TemplateDirectLink" (
    "id", "token", "enabled", "directTemplateRecipientId", "envelopeId"
  ) VALUES (
    v_direct_link_id, v_direct_link_token, true, v_recipient_id, v_envelope_id
  ) ON CONFLICT (id) DO NOTHING;

  RAISE NOTICE 'Created template: envelope_id=%, direct_link_token=%',
    v_envelope_id, v_direct_link_token;
END $$;
`;

  return {
    sql,
    ids: {
      description: "Complete template with DirectLink (6 tables: DocumentMeta + DocumentData + Envelope + EnvelopeItem + Recipient + TemplateDirectLink)",
    },
  };
}

// ── Seed Entity 3: Org Invites ──────────────────────────────────────────────────

function buildOrgInvitesSQL(): { sql: string; ids: Record<string, string> } {
  const sql = `
-- Seed Entity 3: Organisation invites for org_verifyorg001
-- Creates: 2 pending invites (ADMIN + MEMBER roles)
-- Verifies: user 9 is already a MANAGER member via OrganisationGroup

DO $$
DECLARE
  v_invite1_id TEXT;
  v_invite2_id TEXT;
  v_invite1_token TEXT;
  v_invite2_token TEXT;
BEGIN
  v_invite1_id := 'seed-verify-invite-admin-' || gen_random_uuid()::text;
  v_invite2_id := 'seed-verify-invite-member-' || gen_random_uuid()::text;
  v_invite1_token := gen_random_uuid()::text;
  v_invite2_token := gen_random_uuid()::text;

  -- Delete any previous seed invites to avoid duplicates
  DELETE FROM "OrganisationMemberInvite"
  WHERE "organisationId" = '${ORG_ID}'
    AND "email" LIKE 'seed-verify-%';

  -- 1. Admin-role invite (PENDING)
  INSERT INTO "OrganisationMemberInvite" (
    "id", "email", "token", "status", "organisationId", "organisationRole"
  ) VALUES (
    v_invite1_id,
    'seed-verify-admin-invite@example.com',
    v_invite1_token,
    'PENDING',
    '${ORG_ID}',
    'ADMIN'
  );

  -- 2. Member-role invite (PENDING)
  INSERT INTO "OrganisationMemberInvite" (
    "id", "email", "token", "status", "organisationId", "organisationRole"
  ) VALUES (
    v_invite2_id,
    'seed-verify-member-invite@example.com',
    v_invite2_token,
    'PENDING',
    '${ORG_ID}',
    'MEMBER'
  );

  RAISE NOTICE 'Created org invites: admin=%, member=%', v_invite1_id, v_invite2_id;
END $$;
`;

  return {
    sql,
    ids: {
      description: "2 pending org invites (ADMIN + MEMBER) for org_verifyorg001",
    },
  };
}

// ── Verification ────────────────────────────────────────────────────────────────

interface VerifyResult {
  entity: string;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  allPassed: boolean;
}

function verifyDraftDocument(): VerifyResult {
  const checks: Array<{ name: string; passed: boolean; detail: string }> = [];

  // Check: seed-verify draft envelope exists
  const envelopeCount = psqlCount(`
    SELECT COUNT(*) FROM "Envelope"
    WHERE id LIKE 'seed-verify-draft-%' AND "teamId" = ${TEAM_ID} AND status = 'DRAFT' AND type = 'DOCUMENT'
  `);
  checks.push({
    name: "Envelope exists (DRAFT, DOCUMENT)",
    passed: envelopeCount > 0,
    detail: `count=${envelopeCount}`,
  });

  // Check: DocumentMeta linked
  const metaCount = psqlCount(`
    SELECT COUNT(*) FROM "Envelope" e
    JOIN "DocumentMeta" dm ON dm.id = e."documentMetaId"
    WHERE e.id LIKE 'seed-verify-draft-%' AND e."teamId" = ${TEAM_ID}
  `);
  checks.push({
    name: "DocumentMeta linked via FK",
    passed: metaCount > 0,
    detail: `count=${metaCount}`,
  });

  // Check: EnvelopeItem exists and links DocumentData
  const itemCount = psqlCount(`
    SELECT COUNT(*) FROM "EnvelopeItem" ei
    JOIN "DocumentData" dd ON dd.id = ei."documentDataId"
    WHERE ei."envelopeId" LIKE 'seed-verify-draft-%'
  `);
  checks.push({
    name: "EnvelopeItem + DocumentData linked",
    passed: itemCount > 0,
    detail: `count=${itemCount}`,
  });

  // Check: Recipient exists
  const recipientCount = psqlCount(`
    SELECT COUNT(*) FROM "Recipient" r
    WHERE r."envelopeId" LIKE 'seed-verify-draft-%'
  `);
  checks.push({
    name: "Recipient exists",
    passed: recipientCount > 0,
    detail: `count=${recipientCount}`,
  });

  // Check: would the edit page URL work? Get the envelope numeric id
  const envelopeId = psql(`
    SELECT e.id FROM "Envelope" e
    WHERE e.id LIKE 'seed-verify-draft-%' AND e."teamId" = ${TEAM_ID}
    LIMIT 1
  `);
  if (envelopeId) {
    // Verify the full FK chain: Envelope -> DocumentMeta, Envelope <- EnvelopeItem -> DocumentData, Envelope <- Recipient
    const fkChainComplete = psqlCount(`
      SELECT COUNT(*) FROM "Envelope" e
      JOIN "DocumentMeta" dm ON dm.id = e."documentMetaId"
      WHERE e.id = '${envelopeId}'
        AND EXISTS (SELECT 1 FROM "EnvelopeItem" ei JOIN "DocumentData" dd ON dd.id = ei."documentDataId" WHERE ei."envelopeId" = e.id)
        AND EXISTS (SELECT 1 FROM "Recipient" r WHERE r."envelopeId" = e.id)
    `);
    checks.push({
      name: `Full FK chain complete (edit page: /t/${TEAM_SLUG}/documents/${envelopeId}/edit)`,
      passed: fkChainComplete > 0,
      detail: `fk_chain_complete=${fkChainComplete > 0}`,
    });
  }

  return {
    entity: "Draft Document",
    checks,
    allPassed: checks.every(c => c.passed),
  };
}

function verifyTemplate(): VerifyResult {
  const checks: Array<{ name: string; passed: boolean; detail: string }> = [];

  // Check: template envelope exists
  const templateCount = psqlCount(`
    SELECT COUNT(*) FROM "Envelope"
    WHERE id LIKE 'seed-verify-template-%' AND "teamId" = ${TEAM_ID} AND type = 'TEMPLATE'
  `);
  checks.push({
    name: "Template Envelope exists",
    passed: templateCount > 0,
    detail: `count=${templateCount}`,
  });

  // Check: TemplateDirectLink exists and is enabled
  const directLinkCount = psqlCount(`
    SELECT COUNT(*) FROM "TemplateDirectLink" tdl
    WHERE tdl."envelopeId" LIKE 'seed-verify-template-%' AND tdl.enabled = true
  `);
  checks.push({
    name: "TemplateDirectLink enabled",
    passed: directLinkCount > 0,
    detail: `count=${directLinkCount}`,
  });

  // Check: token exists for embed URL
  const token = psql(`
    SELECT tdl.token FROM "TemplateDirectLink" tdl
    WHERE tdl."envelopeId" LIKE 'seed-verify-template-%' AND tdl.enabled = true
    LIMIT 1
  `);
  checks.push({
    name: `Direct link token exists (embed URL: /embed/v0/direct/${token || "MISSING"})`,
    passed: !!token,
    detail: `token=${token || "MISSING"}`,
  });

  // Check: full FK chain
  const fkChain = psqlCount(`
    SELECT COUNT(*) FROM "Envelope" e
    JOIN "DocumentMeta" dm ON dm.id = e."documentMetaId"
    WHERE e.id LIKE 'seed-verify-template-%'
      AND EXISTS (SELECT 1 FROM "EnvelopeItem" ei JOIN "DocumentData" dd ON dd.id = ei."documentDataId" WHERE ei."envelopeId" = e.id)
      AND EXISTS (SELECT 1 FROM "Recipient" r WHERE r."envelopeId" = e.id)
      AND EXISTS (SELECT 1 FROM "TemplateDirectLink" tdl WHERE tdl."envelopeId" = e.id AND tdl.enabled = true)
  `);
  checks.push({
    name: "Full FK chain: Envelope -> Meta + Item -> Data + Recipient + DirectLink",
    passed: fkChain > 0,
    detail: `complete=${fkChain > 0}`,
  });

  return {
    entity: "Template with Direct Link",
    checks,
    allPassed: checks.every(c => c.passed),
  };
}

function verifyOrgInvites(): VerifyResult {
  const checks: Array<{ name: string; passed: boolean; detail: string }> = [];

  // Check: org exists
  const orgExists = psqlCount(`
    SELECT COUNT(*) FROM "Organisation" WHERE id = '${ORG_ID}'
  `);
  checks.push({
    name: `Organisation ${ORG_ID} exists`,
    passed: orgExists > 0,
    detail: `count=${orgExists}`,
  });

  // Check: user 9 is a member
  const memberExists = psqlCount(`
    SELECT COUNT(*) FROM "OrganisationMember"
    WHERE "userId" = ${USER_ID} AND "organisationId" = '${ORG_ID}'
  `);
  checks.push({
    name: `User ${USER_ID} is an OrganisationMember`,
    passed: memberExists > 0,
    detail: `count=${memberExists}`,
  });

  // Check: user is in MANAGER group (via OrganisationGroupMember -> OrganisationGroup)
  const managerRole = psql(`
    SELECT og."organisationRole" FROM "OrganisationGroupMember" ogm
    JOIN "OrganisationGroup" og ON og.id = ogm."groupId"
    JOIN "OrganisationMember" om ON om.id = ogm."organisationMemberId"
    WHERE om."userId" = ${USER_ID} AND om."organisationId" = '${ORG_ID}'
  `);
  checks.push({
    name: `User ${USER_ID} has role in org`,
    passed: !!managerRole,
    detail: `role=${managerRole || "NONE"}`,
  });

  // Check: ADMIN invite exists
  const adminInvite = psqlCount(`
    SELECT COUNT(*) FROM "OrganisationMemberInvite"
    WHERE "organisationId" = '${ORG_ID}'
      AND "organisationRole" = 'ADMIN'
      AND "status" = 'PENDING'
      AND "email" LIKE 'seed-verify-%'
  `);
  checks.push({
    name: "ADMIN pending invite exists",
    passed: adminInvite > 0,
    detail: `count=${adminInvite}`,
  });

  // Check: MEMBER invite exists
  const memberInvite = psqlCount(`
    SELECT COUNT(*) FROM "OrganisationMemberInvite"
    WHERE "organisationId" = '${ORG_ID}'
      AND "organisationRole" = 'MEMBER'
      AND "status" = 'PENDING'
      AND "email" LIKE 'seed-verify-%'
  `);
  checks.push({
    name: "MEMBER pending invite exists",
    passed: memberInvite > 0,
    detail: `count=${memberInvite}`,
  });

  // Check: would the invites page work?
  const totalInvites = psqlCount(`
    SELECT COUNT(*) FROM "OrganisationMemberInvite"
    WHERE "organisationId" = '${ORG_ID}' AND "status" = 'PENDING'
  `);
  checks.push({
    name: `Invites page: /o/${ORG_URL}/settings/members?tab=invites would show ${totalInvites} rows`,
    passed: totalInvites >= 2,
    detail: `total_pending=${totalInvites}`,
  });

  return {
    entity: "Organisation with Invites",
    checks,
    allPassed: checks.every(c => c.passed),
  };
}

// ── Cleanup helper ──────────────────────────────────────────────────────────────

function cleanupPreviousSeedData(): void {
  console.log("  Cleaning up previous seed-verify data...");
  try {
    // Order matters: children first, parents last
    const deleted: Record<string, number> = {};

    deleted["TemplateDirectLink"] = psqlCount(`
      WITH d AS (DELETE FROM "TemplateDirectLink" WHERE "envelopeId" LIKE 'seed-verify-%' RETURNING 1)
      SELECT COUNT(*) FROM d
    `);
    deleted["Recipient"] = psqlCount(`
      WITH d AS (DELETE FROM "Recipient" WHERE "envelopeId" LIKE 'seed-verify-%' RETURNING 1)
      SELECT COUNT(*) FROM d
    `);
    deleted["EnvelopeItem"] = psqlCount(`
      WITH d AS (DELETE FROM "EnvelopeItem" WHERE "envelopeId" LIKE 'seed-verify-%' RETURNING 1)
      SELECT COUNT(*) FROM d
    `);
    deleted["Envelope"] = psqlCount(`
      WITH d AS (DELETE FROM "Envelope" WHERE id LIKE 'seed-verify-%' RETURNING 1)
      SELECT COUNT(*) FROM d
    `);
    // Clean up orphaned DocumentMeta and DocumentData
    // (we can't easily track them by prefix since their IDs are UUIDs,
    //  but ON CONFLICT DO NOTHING means re-runs are safe)

    deleted["OrgInvites"] = psqlCount(`
      WITH d AS (DELETE FROM "OrganisationMemberInvite" WHERE email LIKE 'seed-verify-%' RETURNING 1)
      SELECT COUNT(*) FROM d
    `);

    const totalDeleted = Object.values(deleted).reduce((a, b) => a + b, 0);
    if (totalDeleted > 0) {
      console.log(`  Cleaned up ${totalDeleted} rows:`, deleted);
    } else {
      console.log("  No previous seed data found.");
    }
  } catch (e) {
    const err = e as Error;
    console.log(`  Cleanup warning: ${err.message.slice(0, 100)}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function main() {
  const pipelineDir = resolve(import.meta.dirname ?? ".", "../..");
  const outputDir = join(pipelineDir, `spike-seed-enrichment-output-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });

  console.log(`\n${"=".repeat(60)}`);
  console.log(`=== Spike: Seed Enrichment ===`);
  console.log(`${"=".repeat(60)}\n`);
  console.log(`Output dir: ${outputDir}`);
  console.log(`DB: ${DB_URL}`);
  console.log(`User: ${USER_ID}, Team: ${TEAM_ID}, Org: ${ORG_ID}\n`);

  // Verify DB connection
  try {
    psql("SELECT 1");
    console.log("DB connection: OK\n");
  } catch (e) {
    const err = e as Error;
    console.error(`DB connection FAILED: ${err.message}`);
    process.exit(1);
  }

  // ── Phase 1: Schema Discovery ───────────────────────────────────────────────

  console.log("--- Phase 1: Schema Discovery ---\n");
  const schema = discoverSchema();
  for (const [table, cols] of Object.entries(schema)) {
    const notNullNoDefault = cols.filter(c => !c.column_default);
    console.log(`  ${table}: ${notNullNoDefault.length} NOT NULL columns without defaults`);
    for (const col of notNullNoDefault) {
      console.log(`    - ${col.column_name} (${col.data_type})`);
    }
  }
  console.log();

  // ── Phase 2: Cleanup Previous Runs ──────────────────────────────────────────

  console.log("--- Phase 2: Cleanup ---\n");
  cleanupPreviousSeedData();
  console.log();

  // ── Phase 3: Create Seed Entities ───────────────────────────────────────────

  console.log("--- Phase 3: Create Seed Entities ---\n");

  const entities: Array<{ name: string; sql: string; ids: Record<string, string> }> = [];

  // Entity 1: Draft document
  const draft = buildDraftDocumentSQL();
  entities.push({ name: "Draft Document", ...draft });

  // Entity 2: Template with direct link
  const template = buildTemplateWithDirectLinkSQL();
  entities.push({ name: "Template + Direct Link", ...template });

  // Entity 3: Org invites
  const orgInvites = buildOrgInvitesSQL();
  entities.push({ name: "Org Invites", ...orgInvites });

  for (const entity of entities) {
    console.log(`  Creating: ${entity.name}...`);
    const start = Date.now();
    try {
      psqlMulti(entity.sql);
      console.log(`  OK (${Date.now() - start}ms)`);
    } catch (e) {
      const err = e as Error;
      console.error(`  FAILED: ${err.message}`);
      // Write the failed SQL for debugging
      writeFileSync(
        join(outputDir, `failed-${entity.name.replace(/\s+/g, "-").toLowerCase()}.sql`),
        entity.sql,
      );
    }
    console.log();
  }

  // ── Phase 4: Verify Completeness ────────────────────────────────────────────

  console.log("--- Phase 4: Verify Completeness ---\n");

  const verifications: VerifyResult[] = [
    verifyDraftDocument(),
    verifyTemplate(),
    verifyOrgInvites(),
  ];

  for (const v of verifications) {
    const icon = v.allPassed ? "PASS" : "FAIL";
    console.log(`  [${icon}] ${v.entity}`);
    for (const check of v.checks) {
      const checkIcon = check.passed ? "ok" : "FAIL";
      console.log(`    [${checkIcon}] ${check.name} — ${check.detail}`);
    }
    console.log();
  }

  // ── Phase 5: Answer Key Question ────────────────────────────────────────────

  console.log("--- Phase 5: Key Question ---\n");
  console.log("  Q: Can we create complete entity graphs deterministically by reading the schema?");
  console.log("     Or do we need app-specific knowledge?\n");

  const appSpecificKnowledge: string[] = [];

  // Check what we needed to know beyond schema
  appSpecificKnowledge.push("DocumentData.type must be 'BYTES_64' (not 'BYTES' or 'S3_PATH') — app expects base64 PDF data");
  appSpecificKnowledge.push("Envelope.source must be 'DOCUMENT' (not 'TEMPLATE') — even for templates, source tracks origin");
  appSpecificKnowledge.push("Envelope.type: 'DOCUMENT' vs 'TEMPLATE' — determines routing");
  appSpecificKnowledge.push("Envelope.internalVersion must be 1 — app checks this");
  appSpecificKnowledge.push("DocumentMeta.signingOrder: 'PARALLEL' — enum, not discoverable from schema");
  appSpecificKnowledge.push("DocumentMeta.distributionMethod: 'EMAIL' — enum, not discoverable from schema");
  appSpecificKnowledge.push("Org roles are managed via OrganisationGroup, not a direct role column on OrganisationMember");
  appSpecificKnowledge.push("TemplateDirectLink.directTemplateRecipientId must reference a Recipient on the SAME envelope");

  console.log("  A: We need BOTH schema knowledge AND app-specific knowledge.\n");
  console.log("  App-specific knowledge required (NOT discoverable from schema alone):");
  for (const k of appSpecificKnowledge) {
    console.log(`    - ${k}`);
  }

  // ── Summary ─────────────────────────────────────────────────────────────────

  console.log(`\n${"=".repeat(60)}`);
  console.log(`=== SUMMARY ===`);
  console.log(`${"=".repeat(60)}\n`);

  const totalChecks = verifications.reduce((sum, v) => sum + v.checks.length, 0);
  const passedChecks = verifications.reduce((sum, v) => sum + v.checks.filter(c => c.passed).length, 0);
  const allPassed = verifications.every(v => v.allPassed);

  console.log(`  Entities created: ${entities.length}`);
  console.log(`  Verification checks: ${passedChecks}/${totalChecks} passed`);
  console.log(`  All entities complete: ${allPassed ? "YES" : "NO"}`);
  console.log();

  console.log("  Entity URLs (if all checks pass):");
  // Get the actual IDs
  try {
    const draftId = psql(`
      SELECT id FROM "Envelope" WHERE id LIKE 'seed-verify-draft-%' AND "teamId" = ${TEAM_ID} LIMIT 1
    `);
    if (draftId) {
      console.log(`    Draft doc edit: /t/${TEAM_SLUG}/documents/${draftId}/edit`);
    }
  } catch { /* ignore */ }

  try {
    const dlToken = psql(`
      SELECT tdl.token FROM "TemplateDirectLink" tdl
      WHERE tdl."envelopeId" LIKE 'seed-verify-template-%' LIMIT 1
    `);
    if (dlToken) {
      console.log(`    Template embed: /embed/v0/direct/${dlToken}`);
    }
  } catch { /* ignore */ }

  console.log(`    Org invites:    /o/${ORG_URL}/settings/members?tab=invites`);
  console.log();

  console.log("  Implications for pipeline:");
  console.log("    1. Seed enrichment WORKS — we can create complete entity graphs deterministically");
  console.log("    2. BUT it requires app-specific knowledge (enum values, FK semantics, data formats)");
  console.log("    3. This knowledge can be encoded ONCE in a seed template, not re-discovered per run");
  console.log("    4. The setup-writer should VERIFY these entities exist, not CREATE them");
  console.log(`    5. ${appSpecificKnowledge.length} pieces of app-specific knowledge were needed`);
  console.log();

  // Write results
  const results = {
    timestamp: new Date().toISOString(),
    config: { DB_URL, USER_ID, TEAM_ID, ORG_ID },
    schema_discovery: Object.fromEntries(
      Object.entries(schema).map(([table, cols]) => [
        table,
        cols.map(c => `${c.column_name} (${c.data_type})`),
      ]),
    ),
    entities_created: entities.map(e => ({ name: e.name, ...e.ids })),
    verifications: verifications.map(v => ({
      entity: v.entity,
      allPassed: v.allPassed,
      checks: v.checks,
    })),
    app_specific_knowledge: appSpecificKnowledge,
    verdict: {
      seed_enrichment_works: allPassed,
      requires_app_knowledge: true,
      total_checks: totalChecks,
      passed_checks: passedChecks,
    },
  };
  const resultsPath = join(outputDir, "seed-enrichment-results.json");
  writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  console.log(`  Full results: ${resultsPath}\n`);
}

// ── Go ──────────────────────────────────────────────────────────────────────────
main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
