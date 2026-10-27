BEGIN;

-- Add the bounded GS1 Data Matrix profile to both the reusable template and
-- immutable issue contracts. Existing symbology values and history are unchanged.
ALTER TABLE traceability_label_templates
  DROP CONSTRAINT IF EXISTS chk_traceability_label_template_symbology;
ALTER TABLE traceability_label_templates
  ADD CONSTRAINT chk_traceability_label_template_symbology
  CHECK (symbology IN ('QR', 'CODE128', 'DATAMATRIX', 'GS1_128', 'GS1_DATAMATRIX'));

ALTER TABLE traceability_label_issues
  DROP CONSTRAINT IF EXISTS chk_traceability_label_issue_symbology;
ALTER TABLE traceability_label_issues
  ADD CONSTRAINT chk_traceability_label_issue_symbology
  CHECK (symbology IN ('QR', 'CODE128', 'DATAMATRIX', 'GS1_128', 'GS1_DATAMATRIX'));

INSERT INTO schema_migrations(version, checksum)
VALUES ('213_traceability_gs1_datamatrix_symbology', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
