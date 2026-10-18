BEGIN;

ALTER TABLE finance_connector_runs
  ADD COLUMN IF NOT EXISTS source_file_name varchar(200),
  ADD COLUMN IF NOT EXISTS source_format varchar(8),
  ADD COLUMN IF NOT EXISTS source_payload_sha256 varchar(64);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='finance_connector_runs'::regclass
      AND conname='chk_finance_run_file_import_metadata'
  ) THEN
    ALTER TABLE finance_connector_runs
      ADD CONSTRAINT chk_finance_run_file_import_metadata CHECK (
        (source_file_name IS NULL AND source_format IS NULL AND source_payload_sha256 IS NULL)
        OR (
          length(btrim(source_file_name)) BETWEEN 1 AND 200
          AND position('/' in source_file_name)=0 AND position(chr(92) in source_file_name)=0
          AND source_file_name !~ '[[:cntrl:]]'
          AND source_format IN ('CSV','JSON')
          AND source_payload_sha256 ~ '^[0-9a-f]{64}$'
        )
      );
  END IF;
END $$;

INSERT INTO schema_migrations(version,checksum)
VALUES('115_finance_file_import_metadata',NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
