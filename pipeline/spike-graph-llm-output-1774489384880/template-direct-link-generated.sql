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
  VALUES (gen_random_uuid(), gen_random_uuid(), 'TEMPLATE'::"EnvelopeType", NOW(), NOW(), 'Consulting Agreement Template', 'DRAFT'::"DocumentStatus", 'DOCUMENT'::"DocumentSource", 1, false, 'EVERYONE'::"DocumentVisibility", 'PUBLIC'::"TemplateType", 'Consulting Agreement', 'Standard consulting agreement template', 9, 7, v_documentmeta_id)
  RETURNING "id" INTO v_envelope_id;
  RAISE NOTICE 'Envelope.id = %', v_envelope_id;
  -- TemplateDirectLink
  INSERT INTO "TemplateDirectLink" ("id", "token", "createdAt", "enabled", "directTemplateRecipientId", "envelopeId")
  VALUES (gen_random_uuid(), gen_random_uuid(), NOW(), true, 1, v_envelope_id)
  RETURNING "id" INTO v_templatedirectlink_id;
  RAISE NOTICE 'TemplateDirectLink.id = %', v_templatedirectlink_id;
END $$;
ROLLBACK;