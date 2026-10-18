BEGIN;

ALTER TABLE finance_connector_runs
  ADD COLUMN validation_report_id uuid;

ALTER TABLE finance_connector_runs
  ADD CONSTRAINT fk_finance_run_validation_report
  FOREIGN KEY(validation_report_id,tenant_id,factory_id,connector_id)
  REFERENCES finance_file_import_validation_reports(id,tenant_id,factory_id,connector_id)
  ON DELETE RESTRICT;

ALTER TABLE finance_connector_runs
  ADD CONSTRAINT chk_finance_run_validation_report_mode CHECK(
    validation_report_id IS NULL OR source_file_name IS NOT NULL
  );

CREATE UNIQUE INDEX uq_finance_run_validation_report
  ON finance_connector_runs(tenant_id,validation_report_id)
  WHERE validation_report_id IS NOT NULL;

ALTER TABLE finance_connectors
  ADD CONSTRAINT chk_finance_outbound_not_reporting
  CHECK(integration_mode NOT IN ('FILE_EXPORT','SFTP_EXPORT') OR NOT is_reporting_source);

INSERT INTO schema_migrations(version,checksum)
VALUES('125_finance_file_import_report_commit',NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
