BEGIN;

CREATE TABLE finance_file_export_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  idempotency_key varchar(200) NOT NULL,
  request_hash varchar(64) NOT NULL,
  format varchar(8) NOT NULL,
  file_name varchar(200) NOT NULL,
  payload_sha256 varchar(64) NOT NULL,
  payload_bytes integer NOT NULL,
  record_count integer NOT NULL,
  status varchar(16) NOT NULL,
  remote_reference varchar(768),
  content bytea,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_id uuid,
  trace_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_finance_export_receipt_idempotency UNIQUE(tenant_id,factory_id,connector_id,idempotency_key),
  CONSTRAINT uq_finance_export_receipt_scope UNIQUE(id,tenant_id,factory_id,connector_id),
  CONSTRAINT fk_finance_export_receipt_connector
    FOREIGN KEY(connector_id,tenant_id,factory_id)
    REFERENCES finance_connectors(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_finance_export_receipt_hashes
    CHECK(request_hash ~ '^[a-f0-9]{64}$' AND payload_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_finance_export_receipt_format CHECK(format IN ('CSV','JSON')),
  CONSTRAINT chk_finance_export_receipt_status CHECK(status='COMPLETED'),
  CONSTRAINT chk_finance_export_receipt_counts
    CHECK(payload_bytes BETWEEN 1 AND 2097152 AND record_count BETWEEN 0 AND 500),
  CONSTRAINT chk_finance_export_receipt_filename
    CHECK(length(btrim(file_name)) BETWEEN 1 AND 200
      AND position('/' in file_name)=0 AND position(chr(92) in file_name)=0
      AND file_name !~ '[[:cntrl:]]'),
  CONSTRAINT chk_finance_export_receipt_delivery
    CHECK((remote_reference IS NULL AND content IS NOT NULL)
       OR (remote_reference IS NOT NULL AND content IS NULL))
);

CREATE INDEX idx_finance_export_receipts_recent
  ON finance_file_export_receipts(tenant_id,factory_id,connector_id,created_at DESC);

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
        AND c.status='ACTIVE' AND c.integration_mode IN ('FILE_EXPORT','SFTP_EXPORT')
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

CREATE TRIGGER trg_finance_export_receipt_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON finance_file_export_receipts
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_finance_file_export_receipt();

ALTER TABLE finance_file_export_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_file_export_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY finance_file_export_receipts_tenant_isolation
  ON finance_file_export_receipts
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

INSERT INTO schema_migrations(version,checksum)
VALUES('126_finance_file_export_receipts',NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
