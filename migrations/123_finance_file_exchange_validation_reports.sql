BEGIN;

-- Extend the governed read-side connector registry with explicit file/SFTP modes.
ALTER TABLE finance_connectors
  DROP CONSTRAINT IF EXISTS chk_finance_connector_mode;

ALTER TABLE finance_connectors
  ADD CONSTRAINT chk_finance_connector_mode CHECK(integration_mode IN (
    'MANUAL','REST_API','WEBHOOK','FILE_IMPORT','FILE_EXPORT','SFTP_IMPORT','SFTP_EXPORT'
  ));

ALTER TABLE finance_connectors
  ADD CONSTRAINT chk_finance_sftp_configuration CHECK(
    integration_mode NOT IN ('SFTP_IMPORT','SFTP_EXPORT')
    OR (
      endpoint_url IS NULL
      AND secret_reference IS NOT NULL
      AND configuration ?& ARRAY['host','port','username','remote_directory','file_format','host_key_sha256']
      AND configuration->>'host' ~ '^[A-Za-z0-9][A-Za-z0-9.-]{0,251}[A-Za-z0-9]$'
      AND configuration->>'host' !~ '\.\.'
      AND configuration->>'host' !~* '^localhost$'
      AND configuration->>'port' ~ '^[0-9]{1,5}$'
      AND CASE WHEN configuration->>'port' ~ '^[0-9]{1,5}$'
        THEN (configuration->>'port')::integer BETWEEN 1 AND 65535 ELSE false END
      AND configuration->>'username' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
      AND left(configuration->>'remote_directory',1)='/'
      AND length(configuration->>'remote_directory') BETWEEN 1 AND 512
      AND configuration->>'remote_directory' !~ '(^|/)\.\.?(/|$)'
      AND configuration->>'remote_directory' !~ '[[:cntrl:]\\]'
      AND configuration->>'file_format' IN ('CSV','JSON')
      AND (
        configuration->>'host_key_sha256' ~ '^SHA256:[A-Za-z0-9+/]{43}$'
        OR configuration->>'host_key_sha256' ~ '^[a-f0-9]{64}$'
      )
      AND (
        NOT (configuration ? 'file_pattern')
        OR configuration->>'file_pattern' ~ '^[A-Za-z0-9][A-Za-z0-9._*-]{0,119}$'
      )
    )
  );

INSERT INTO schema_migrations(version,checksum)
VALUES('123_finance_file_exchange_validation_reports',NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
