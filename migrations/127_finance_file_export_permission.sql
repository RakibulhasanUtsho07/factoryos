BEGIN;
INSERT INTO permissions(code,description) VALUES('finance.facts.export','Export governed financial facts to approved external file destinations') ON CONFLICT(code) DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code='ORG_ADMIN' AND r.is_system=true AND p.code='finance.facts.export' ON CONFLICT(role_id,permission_id) DO NOTHING;
INSERT INTO schema_migrations(version,checksum) VALUES('127_finance_file_export_permission',NULL) ON CONFLICT(version) DO NOTHING;
COMMIT;
