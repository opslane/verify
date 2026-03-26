BEGIN;
DO $$
DECLARE
  v_documentmeta_id text;
  v_envelope_id text;
  v_templatedirectlink_id text;
BEGIN
  -- DocumentMeta
  INSERT INTO "DocumentMeta" ("id", "signingOrder", "typedSignatureEnabled", "language", "distributionMethod", "drawSignatureEnabled", "uploadSignatureEnabled", "allowDictateNextSigner")
  VALUES (gen_random_uuid(), 'PARALLEL'::"DocumentSigningOrder", true, 'en', 'EMAIL'::"DocumentDistributionMethod", true, true, false)
  RETURNING "id" INTO v_documentmeta_id;
  RAISE NOTICE 'DocumentMeta.id = %', v_documentmeta_id;
  -- Envelope
  INSERT INTO "Envelope" ("id", "secondaryId", "type", "createdAt", "updatedAt", "title", "status", "source", "internalVersion", "useLegacyFieldInsertion", "visibility", "templateType", "publicTitle", "publicDescription", "userId", "teamId", "documentMetaId")
  VALUES (gen_random_uuid(), gen_random_uuid(), 'TEMPLATE'::"EnvelopeType", '2026-03-25T00:00:00.000Z'::timestamptz, '2026-03-25T00:00:00.000Z'::timestamptz, 'Template with Direct Link', 'DRAFT'::"DocumentStatus", 'DOCUMENT'::"DocumentSource", 1, false, 'EVERYONE'::"DocumentVisibility", 'PUBLIC'::"TemplateType", 'Public Template', 'A public template with direct signing link', 9, 7, gen_random_uuid())
  RETURNING "id" INTO v_envelope_id;
  RAISE NOTICE 'Envelope.id = %', v_envelope_id;
  -- TemplateDirectLink
  INSERT INTO "TemplateDirectLink" ("id", "token", "createdAt", "enabled", "directTemplateRecipientId", "envelopeId")
  VALUES (gen_random_uuid(), gen_random_uuid(), '2026-03-25T00:00:00.000Z'::timestamptz, true, 1, gen_random_uuid())
  RETURNING "id" INTO v_templatedirectlink_id;
  RAISE NOTICE 'TemplateDirectLink.id = %', v_templatedirectlink_id;
END $$;
ROLLBACK;