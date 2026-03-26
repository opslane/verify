BEGIN;
DO $$
DECLARE
  v_documentmeta_id text;
  v_documentdata_id text;
  v_envelope_id text;
  v_recipient_id integer;
  v_envelopeitem_id text;
BEGIN
  -- DocumentMeta
  INSERT INTO "DocumentMeta" ("id", "signingOrder", "typedSignatureEnabled", "language", "distributionMethod", "drawSignatureEnabled", "uploadSignatureEnabled", "allowDictateNextSigner")
  VALUES (gen_random_uuid(), 'PARALLEL'::"DocumentSigningOrder", true, 'en', 'EMAIL'::"DocumentDistributionMethod", true, true, false)
  RETURNING "id" INTO v_documentmeta_id;
  RAISE NOTICE 'DocumentMeta.id = %', v_documentmeta_id;
  -- DocumentData
  INSERT INTO "DocumentData" ("id", "type", "data", "initialData")
  VALUES (gen_random_uuid(), 'BYTES_64'::"DocumentDataType", '', '')
  RETURNING "id" INTO v_documentdata_id;
  RAISE NOTICE 'DocumentData.id = %', v_documentdata_id;
  -- Envelope
  INSERT INTO "Envelope" ("id", "secondaryId", "type", "createdAt", "updatedAt", "title", "status", "source", "internalVersion", "useLegacyFieldInsertion", "visibility", "templateType", "publicTitle", "publicDescription", "userId", "teamId", "documentMetaId", "qrToken")
  VALUES (gen_random_uuid(), gen_random_uuid(), 'DOCUMENT'::"EnvelopeType", NOW(), NOW(), 'Draft Agreement', 'DRAFT'::"DocumentStatus", 'DOCUMENT'::"DocumentSource", 1, false, 'EVERYONE'::"DocumentVisibility", 'PUBLIC'::"TemplateType", '', '', 9, 7, v_documentmeta_id, gen_random_uuid())
  RETURNING "id" INTO v_envelope_id;
  RAISE NOTICE 'Envelope.id = %', v_envelope_id;
  -- Recipient
  INSERT INTO "Recipient" ("email", "name", "token", "readStatus", "signingStatus", "sendStatus", "role", "envelopeId")
  VALUES ('recipient@example.com', 'Jane Smith', gen_random_uuid(), 'NOT_OPENED'::"ReadStatus", 'NOT_SIGNED'::"SigningStatus", 'NOT_SENT'::"SendStatus", 'SIGNER'::"RecipientRole", v_envelope_id)
  RETURNING "id" INTO v_recipient_id;
  RAISE NOTICE 'Recipient.id = %', v_recipient_id;
  -- EnvelopeItem
  INSERT INTO "EnvelopeItem" ("id", "title", "documentDataId", "envelopeId", "order")
  VALUES (gen_random_uuid(), 'Document Page 1', v_documentdata_id, v_envelope_id, 0)
  RETURNING "id" INTO v_envelopeitem_id;
  RAISE NOTICE 'EnvelopeItem.id = %', v_envelopeitem_id;
END $$;
ROLLBACK;