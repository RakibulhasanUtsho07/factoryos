BEGIN;

ALTER TABLE finance_connector_runs
  DROP CONSTRAINT IF EXISTS chk_finance_run_file_import_metadata;

ALTER TABLE finance_connector_runs
  ADD CONSTRAINT chk_finance_run_file_import_metadata CHECK (
    (
      source_file_name IS NULL
      AND source_format IS NULL
      AND source_payload_sha256 IS NULL
    )
    OR (
      source_file_name IS NOT NULL
      AND source_format IS NOT NULL
      AND source_payload_sha256 IS NOT NULL
      AND length(btrim(source_file_name)) BETWEEN 1 AND 200
      AND position('/' in source_file_name)=0
      AND position(chr(92) in source_file_name)=0
      AND source_file_name !~ '[[:cntrl:]]'
      AND source_format IN ('CSV','JSON')
      AND source_payload_sha256 ~ '^[0-9a-f]{64}$'
    )
  );

INSERT INTO schema_migrations(version,checksum)
VALUES('116_finance_file_import_metadata_integrity',NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
