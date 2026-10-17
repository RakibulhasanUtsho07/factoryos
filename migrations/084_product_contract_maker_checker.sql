BEGIN;
-- Blueprint control: released engineering data must be reviewed by a different actor
-- from the person who created the draft, preventing self-approval at the database boundary.
ALTER TABLE product_versions
  ADD CONSTRAINT chk_product_version_independent_approval
  CHECK (approved_by_user_id IS NULL OR approved_by_user_id <> created_by_user_id);

ALTER TABLE product_bom_alternates
  ADD CONSTRAINT chk_product_bom_alternate_independent_approval
  CHECK (approved_by_user_id IS NULL OR approved_by_user_id <> created_by_user_id);

INSERT INTO schema_migrations(version,checksum)
VALUES('084_product_contract_maker_checker',NULL)
ON CONFLICT(version) DO NOTHING;
COMMIT;
