BEGIN;

-- A durable RELEASED intent is not enough to permit a new writer generation:
-- S3 policy removal must also succeed and be independently read back. Until that
-- confirmation is recorded, both application and direct-SQL writers remain gated.
ALTER TABLE saas_tenant_backup_writer_fences
  ADD COLUMN IF NOT EXISTS provider_release_confirmed_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='chk_saas_backup_writer_fence_release_confirmation'
      AND conrelid='saas_tenant_backup_writer_fences'::regclass
  ) THEN
    ALTER TABLE saas_tenant_backup_writer_fences
      ADD CONSTRAINT chk_saas_backup_writer_fence_release_confirmation CHECK (
        provider_release_confirmed_at IS NULL
        OR (state='RELEASED' AND release_reference IS NOT NULL
          AND release_policy_digest IS NOT NULL AND released_at IS NOT NULL
          AND next_writer_epoch IS NOT NULL)
      ) NOT VALID;
  END IF;
END $$;
ALTER TABLE saas_tenant_backup_writer_fences
  VALIDATE CONSTRAINT chk_saas_backup_writer_fence_release_confirmation;

CREATE OR REPLACE FUNCTION public.factoryos_guard_saas_backup_writer_release_confirmation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.provider_release_confirmed_at IS NOT NULL THEN
      RAISE EXCEPTION 'provider release confirmation cannot be supplied when a fence is inserted' USING ERRCODE='55000';
    END IF;
  ELSIF TG_OP='UPDATE' AND NEW.provider_release_confirmed_at IS DISTINCT FROM OLD.provider_release_confirmed_at THEN
    IF OLD.state<>'RELEASED' OR OLD.provider_release_confirmed_at IS NOT NULL
       OR NEW.provider_release_confirmed_at IS NULL
       OR NEW.release_reference IS NULL OR NEW.release_policy_digest IS NULL
       OR NEW.released_at IS NULL OR NEW.next_writer_epoch IS NULL THEN
      RAISE EXCEPTION 'provider release confirmation is a one-way fact for a durably released fence' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_backup_writer_release_confirmation_guard ON saas_tenant_backup_writer_fences;
CREATE TRIGGER saas_tenant_backup_writer_release_confirmation_guard
  BEFORE INSERT OR UPDATE ON saas_tenant_backup_writer_fences
  FOR EACH ROW EXECUTE FUNCTION public.factoryos_guard_saas_backup_writer_release_confirmation();

CREATE OR REPLACE FUNCTION public.factoryos_guard_saas_backup_writer_release_gate()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM 1 FROM public.tenants t WHERE t.id=NEW.tenant_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'backup writer operation requires an existing tenant' USING ERRCODE='23503';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.saas_tenant_backup_writer_fences f
      WHERE f.tenant_id=NEW.tenant_id AND f.category_code=NEW.category_code
        AND f.state<>'RELEASED'
    ) OR EXISTS (
      SELECT 1 FROM public.saas_tenant_backup_writer_fences f
      WHERE f.tenant_id=NEW.tenant_id AND f.category_code=NEW.category_code
        AND f.state='RELEASED'
        AND f.fence_id=(
          SELECT latest.fence_id FROM public.saas_tenant_backup_writer_fences latest
          WHERE latest.tenant_id=NEW.tenant_id AND latest.category_code=NEW.category_code
            AND latest.state='RELEASED'
          ORDER BY latest.released_at DESC,latest.fence_id DESC LIMIT 1
        )
        AND f.provider_release_confirmed_at IS NULL
    ) THEN
      RAISE EXCEPTION 'backup writer permit is blocked until provider fence removal is confirmed' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_backup_writer_release_gate_guard ON saas_tenant_backup_writer_operations;
CREATE TRIGGER saas_tenant_backup_writer_release_gate_guard
  BEFORE INSERT ON saas_tenant_backup_writer_operations
  FOR EACH ROW EXECUTE FUNCTION public.factoryos_guard_saas_backup_writer_release_gate();

CREATE OR REPLACE FUNCTION public.factoryos_guard_saas_backup_writer_fence_release_gate()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM 1 FROM public.tenants t WHERE t.id=NEW.tenant_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'backup writer fence requires an existing tenant' USING ERRCODE='23503';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.saas_tenant_backup_writer_fences f
      WHERE f.tenant_id=NEW.tenant_id AND f.category_code=NEW.category_code
        AND f.state<>'RELEASED'
    ) OR EXISTS (
      SELECT 1 FROM public.saas_tenant_backup_writer_fences f
      WHERE f.tenant_id=NEW.tenant_id AND f.category_code=NEW.category_code
        AND f.state='RELEASED'
        AND f.fence_id=(
          SELECT latest.fence_id FROM public.saas_tenant_backup_writer_fences latest
          WHERE latest.tenant_id=NEW.tenant_id AND latest.category_code=NEW.category_code
            AND latest.state='RELEASED'
          ORDER BY latest.released_at DESC,latest.fence_id DESC LIMIT 1
        )
        AND f.provider_release_confirmed_at IS NULL
    ) THEN
      RAISE EXCEPTION 'a new backup writer fence is blocked until previous provider release is confirmed' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_backup_writer_fence_release_gate_guard ON saas_tenant_backup_writer_fences;
CREATE TRIGGER saas_tenant_backup_writer_fence_release_gate_guard
  BEFORE INSERT ON saas_tenant_backup_writer_fences
  FOR EACH ROW EXECUTE FUNCTION public.factoryos_guard_saas_backup_writer_fence_release_gate();

INSERT INTO schema_migrations(version,checksum)
VALUES ('225_saas_backup_writer_release_confirmation',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
