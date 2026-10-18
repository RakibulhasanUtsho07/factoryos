BEGIN;

CREATE TABLE finance_file_import_validation_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  external_batch_ref varchar(200) NOT NULL,
  idempotency_key varchar(200) NOT NULL,
  request_hash varchar(64) NOT NULL,
  source_file_name varchar(200),
  source_format varchar(8),
  source_payload_sha256 varchar(64) NOT NULL,
  status varchar(8) NOT NULL,
  row_count integer NOT NULL,
  valid_row_count integer NOT NULL,
  invalid_row_count integer NOT NULL,
  validation_report jsonb NOT NULL,
  actor_user_id uuid NOT NULL,
  request_id uuid,
  trace_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_finance_file_validation_scope UNIQUE(id,tenant_id,factory_id,connector_id),
  CONSTRAINT uq_finance_file_validation_idempotency UNIQUE(tenant_id,factory_id,connector_id,idempotency_key),
  CONSTRAINT fk_finance_file_validation_connector
    FOREIGN KEY(connector_id,tenant_id,factory_id)
    REFERENCES finance_connectors(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_file_validation_actor FOREIGN KEY(actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_finance_file_validation_request_hash CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_finance_file_validation_payload_hash CHECK(source_payload_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_finance_file_validation_status CHECK(status IN ('VALID','INVALID')),
  CONSTRAINT chk_finance_file_validation_counts CHECK(
    row_count BETWEEN 0 AND 500 AND valid_row_count BETWEEN 0 AND row_count
    AND invalid_row_count BETWEEN 0 AND 500
    AND (status='VALID' AND invalid_row_count=0 OR status='INVALID' AND invalid_row_count>=1)
  ),
  CONSTRAINT chk_finance_file_validation_file_name CHECK(
    source_file_name IS NULL OR (
      length(btrim(source_file_name)) BETWEEN 1 AND 200
      AND position('/' in source_file_name)=0
      AND position(chr(92) in source_file_name)=0
      AND source_file_name !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT chk_finance_file_validation_format CHECK(source_format IS NULL OR source_format IN ('CSV','JSON')),
  CONSTRAINT chk_finance_file_validation_report CHECK(
    jsonb_typeof(validation_report)='object'
    AND octet_length(validation_report::text)<=65536
    AND jsonb_typeof(validation_report->'errors')='array'
  )
);

CREATE INDEX idx_finance_file_validation_recent
  ON finance_file_import_validation_reports(tenant_id,factory_id,connector_id,created_at DESC);

CREATE OR REPLACE FUNCTION factoryos_guard_finance_file_validation_report()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.actor_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
      RAISE EXCEPTION 'File validation report actor must match authenticated user' USING ERRCODE='42501';
    END IF;
    IF NOT EXISTS(
      SELECT 1 FROM finance_connectors c
      WHERE c.id=NEW.connector_id AND c.tenant_id=NEW.tenant_id AND c.factory_id=NEW.factory_id
        AND c.status='ACTIVE' AND c.integration_mode IN ('FILE_IMPORT','SFTP_IMPORT')
    ) THEN
      RAISE EXCEPTION 'File validation report requires an active file-import connector' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Finance file validation reports are immutable' USING ERRCODE='55000';
END $$;

CREATE TRIGGER trg_finance_file_validation_report_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON finance_file_import_validation_reports
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_finance_file_validation_report();

ALTER TABLE finance_file_import_validation_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_file_import_validation_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY finance_file_validation_tenant_isolation
  ON finance_file_import_validation_reports
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

INSERT INTO schema_migrations(version,checksum)
VALUES('124_finance_file_import_validation_reports',NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
