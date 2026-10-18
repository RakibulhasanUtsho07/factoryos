BEGIN;

ALTER TABLE finance_connectors
  DROP CONSTRAINT IF EXISTS chk_finance_connector_mode;

ALTER TABLE finance_connectors
  ADD CONSTRAINT chk_finance_connector_mode CHECK(integration_mode IN (
    'MANUAL','REST_API','WEBHOOK','FILE_IMPORT','FILE_EXPORT',
    'ERP_IMPORT','ERP_EXPORT','SFTP_IMPORT','SFTP_EXPORT'
  ));

ALTER TABLE finance_connectors
  DROP CONSTRAINT IF EXISTS chk_finance_outbound_not_reporting;

ALTER TABLE finance_connectors
  ADD CONSTRAINT chk_finance_outbound_not_reporting
  CHECK(integration_mode NOT IN ('FILE_EXPORT','ERP_EXPORT','SFTP_EXPORT') OR NOT is_reporting_source);

ALTER TABLE finance_connectors
  ADD CONSTRAINT chk_finance_erp_transfer_configuration CHECK(
    integration_mode NOT IN ('ERP_IMPORT','ERP_EXPORT')
    OR (
      endpoint_url IS NOT NULL
      AND endpoint_url ~ '^https://'
      AND secret_reference IS NOT NULL
      AND NOT factoryos_finance_json_has_sensitive_key(configuration)
    )
  );

INSERT INTO schema_migrations(version,checksum)
VALUES('128_finance_erp_transfer_modes',NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
