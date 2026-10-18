BEGIN;

CREATE OR REPLACE FUNCTION factoryos_guard_finance_file_export_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.actor_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
      RAISE EXCEPTION 'Finance export receipt actor must match authenticated user' USING ERRCODE='42501';
    END IF;
    IF NOT EXISTS(
      SELECT 1 FROM finance_connectors c
      WHERE c.id=NEW.connector_id AND c.tenant_id=NEW.tenant_id AND c.factory_id=NEW.factory_id
        AND c.status='ACTIVE' AND c.integration_mode IN ('FILE_EXPORT','ERP_EXPORT','SFTP_EXPORT')
        AND NOT c.is_reporting_source
    ) THEN
      RAISE EXCEPTION 'Finance export receipt requires an active non-reporting export connector' USING ERRCODE='55000';
    END IF;
    IF (NEW.remote_reference IS NULL AND octet_length(NEW.content)<>NEW.payload_bytes)
       OR (NEW.remote_reference IS NOT NULL AND (length(btrim(NEW.remote_reference))=0 OR NEW.content IS NOT NULL)) THEN
      RAISE EXCEPTION 'Finance export receipt artifact does not match its delivery mode' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Finance export receipts are immutable' USING ERRCODE='55000';
END $$;

INSERT INTO schema_migrations(version,checksum)
VALUES('129_finance_erp_export_receipt_guard',NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
