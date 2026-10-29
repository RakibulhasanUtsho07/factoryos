BEGIN;

CREATE TABLE IF NOT EXISTS saas_tenant_backup_writer_inventory_snapshots (
  snapshot_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  category_code varchar(64) NOT NULL,
  revision bigint NOT NULL,
  inventory_reference varchar(200) NOT NULL,
  manifest_digest varchar(64) NOT NULL,
  entry_count integer NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'PENDING',
  idempotency_key varchar(100) NOT NULL,
  request_hash varchar(64) NOT NULL,
  registered_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  review_reason varchar(1000),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_saas_backup_writer_inventory_tenant_snapshot UNIQUE (tenant_id,snapshot_id),
  CONSTRAINT uq_saas_backup_writer_inventory_revision UNIQUE (tenant_id,category_code,revision),
  CONSTRAINT uq_saas_backup_writer_inventory_idempotency UNIQUE (tenant_id,category_code,idempotency_key),
  CONSTRAINT chk_saas_backup_writer_inventory_category CHECK (category_code IN (
    'BUSINESS_DATA','AUDIT_LOG','EVIDENCE','APPROVALS','EFFECTIVE_DATED_MASTER_DATA',
    'AI_CONTEXT','LEARNING_EVALUATION','INTEGRATION_METADATA','FILE_REFERENCES','IAM_ACCESS'
  )),
  CONSTRAINT chk_saas_backup_writer_inventory_revision CHECK (revision BETWEEN 1 AND 9007199254740991),
  CONSTRAINT chk_saas_backup_writer_inventory_reference CHECK (
    inventory_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND inventory_reference !~* '://'
    AND inventory_reference !~* '(secret|password|credential|access[-_]?key|token)'
  ),
  CONSTRAINT chk_saas_backup_writer_inventory_digest CHECK (
    manifest_digest ~ '^[a-f0-9]{64}$' AND request_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT chk_saas_backup_writer_inventory_count CHECK (entry_count BETWEEN 1 AND 10000),
  CONSTRAINT chk_saas_backup_writer_inventory_idempotency_key CHECK (
    idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
  ),
  CONSTRAINT chk_saas_backup_writer_inventory_status CHECK (status IN ('PENDING','ACCEPTED','REJECTED')),
  CONSTRAINT chk_saas_backup_writer_inventory_review CHECK (
    (status='PENDING' AND reviewed_by_user_id IS NULL AND review_reason IS NULL AND reviewed_at IS NULL)
    OR (status IN ('ACCEPTED','REJECTED')
      AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>registered_by_user_id
      AND review_reason IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND reviewed_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_saas_backup_writer_inventory_latest
  ON saas_tenant_backup_writer_inventory_snapshots(tenant_id,category_code,revision DESC);

CREATE TABLE IF NOT EXISTS saas_tenant_backup_writer_inventory_entries (
  tenant_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  entry_ordinal integer NOT NULL,
  producer_id varchar(100) NOT NULL,
  provider_principal_reference varchar(200) NOT NULL,
  access_path_code varchar(32) NOT NULL,
  permission_scope_digest varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,snapshot_id,entry_ordinal),
  CONSTRAINT fk_saas_backup_writer_inventory_entry_snapshot
    FOREIGN KEY (tenant_id,snapshot_id)
    REFERENCES saas_tenant_backup_writer_inventory_snapshots(tenant_id,snapshot_id) ON DELETE RESTRICT,
  CONSTRAINT uq_saas_backup_writer_inventory_entry_identity
    UNIQUE (tenant_id,snapshot_id,producer_id,provider_principal_reference,access_path_code),
  CONSTRAINT chk_saas_backup_writer_inventory_entry_ordinal CHECK (entry_ordinal BETWEEN 1 AND 10000),
  CONSTRAINT chk_saas_backup_writer_inventory_entry_producer CHECK (
    producer_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
  ),
  CONSTRAINT chk_saas_backup_writer_inventory_entry_principal CHECK (
    provider_principal_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND provider_principal_reference !~* '://'
    AND provider_principal_reference !~* '(secret|password|credential|access[-_]?key|token)'
  ),
  CONSTRAINT chk_saas_backup_writer_inventory_entry_access_path CHECK (access_path_code IN (
    'APP_WORKER','SCHEDULED_JOB','RESTORE_DR','REPLICATION','ACCESS_POINT',
    'MULTIPART_COMPLETION','LEGACY_WRITER','VENDOR','OTHER'
  )),
  CONSTRAINT chk_saas_backup_writer_inventory_entry_scope_digest CHECK (
    permission_scope_digest ~ '^[a-f0-9]{64}$'
  )
);

ALTER TABLE saas_tenant_backup_writer_fences
  ADD COLUMN IF NOT EXISTS writer_inventory_snapshot_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='fk_saas_backup_writer_fence_inventory_snapshot'
      AND conrelid='public.saas_tenant_backup_writer_fences'::regclass
  ) THEN
    ALTER TABLE saas_tenant_backup_writer_fences
      ADD CONSTRAINT fk_saas_backup_writer_fence_inventory_snapshot
      FOREIGN KEY (tenant_id,writer_inventory_snapshot_id)
      REFERENCES saas_tenant_backup_writer_inventory_snapshots(tenant_id,snapshot_id) ON DELETE RESTRICT;
  END IF;
END $$;

ALTER TABLE saas_tenant_backup_writer_inventory_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_backup_writer_inventory_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_backup_writer_inventory_snapshots_tenant_allow
  ON saas_tenant_backup_writer_inventory_snapshots;
DROP POLICY IF EXISTS saas_tenant_backup_writer_inventory_snapshots_tenant_enforce
  ON saas_tenant_backup_writer_inventory_snapshots;
CREATE POLICY saas_tenant_backup_writer_inventory_snapshots_tenant_allow
  ON saas_tenant_backup_writer_inventory_snapshots AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_backup_writer_inventory_snapshots_tenant_enforce
  ON saas_tenant_backup_writer_inventory_snapshots AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

ALTER TABLE saas_tenant_backup_writer_inventory_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_backup_writer_inventory_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_backup_writer_inventory_entries_tenant_allow
  ON saas_tenant_backup_writer_inventory_entries;
DROP POLICY IF EXISTS saas_tenant_backup_writer_inventory_entries_tenant_enforce
  ON saas_tenant_backup_writer_inventory_entries;
CREATE POLICY saas_tenant_backup_writer_inventory_entries_tenant_allow
  ON saas_tenant_backup_writer_inventory_entries AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_backup_writer_inventory_entries_tenant_enforce
  ON saas_tenant_backup_writer_inventory_entries AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_saas_backup_writer_inventory_snapshot()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'backup writer inventory snapshots are retained as governance evidence' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'PENDING' OR NEW.reviewed_by_user_id IS NOT NULL
      OR NEW.review_reason IS NOT NULL OR NEW.reviewed_at IS NOT NULL THEN
      RAISE EXCEPTION 'writer inventory must be submitted pending independent review' USING ERRCODE='55000';
    END IF;
    PERFORM 1 FROM public.tenants t WHERE t.id=NEW.tenant_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'writer inventory requires an existing tenant' USING ERRCODE='23503'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.snapshot_id,NEW.tenant_id,NEW.category_code,NEW.revision,NEW.inventory_reference,
      NEW.manifest_digest,NEW.entry_count,NEW.idempotency_key,NEW.request_hash,
      NEW.registered_by_user_id,NEW.created_at)
     IS DISTINCT FROM
     (OLD.snapshot_id,OLD.tenant_id,OLD.category_code,OLD.revision,OLD.inventory_reference,
      OLD.manifest_digest,OLD.entry_count,OLD.idempotency_key,OLD.request_hash,
      OLD.registered_by_user_id,OLD.created_at) THEN
    RAISE EXCEPTION 'writer inventory snapshot identity and digest are immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status<>'PENDING' OR NEW.status NOT IN ('ACCEPTED','REJECTED')
    OR NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_by_user_id=OLD.registered_by_user_id
    OR NEW.reviewed_at IS NULL OR length(btrim(COALESCE(NEW.review_reason,'')))<3 THEN
    RAISE EXCEPTION 'only a pending writer inventory may receive one independent review' USING ERRCODE='55000';
  END IF;
  PERFORM 1 FROM public.tenants t WHERE t.id=OLD.tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'writer inventory requires an existing tenant' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_backup_writer_inventory_snapshot_guard
  ON saas_tenant_backup_writer_inventory_snapshots;
CREATE TRIGGER saas_tenant_backup_writer_inventory_snapshot_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_backup_writer_inventory_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.factoryos_guard_saas_backup_writer_inventory_snapshot();

CREATE OR REPLACE FUNCTION factoryos_guard_saas_backup_writer_inventory_entry()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE snapshot_status text;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'writer inventory entries are immutable and retained as governance evidence' USING ERRCODE='55000';
  END IF;
  SELECT s.status INTO snapshot_status
    FROM public.saas_tenant_backup_writer_inventory_snapshots s
    WHERE s.tenant_id=NEW.tenant_id AND s.snapshot_id=NEW.snapshot_id
    FOR SHARE;
  IF NOT FOUND OR snapshot_status<>'PENDING' THEN
    RAISE EXCEPTION 'writer inventory entries may be added only to a pending snapshot' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $;
DROP TRIGGER IF EXISTS saas_tenant_backup_writer_inventory_entry_guard
  ON saas_tenant_backup_writer_inventory_entries;
CREATE TRIGGER saas_tenant_backup_writer_inventory_entry_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_backup_writer_inventory_entries
  FOR EACH ROW EXECUTE FUNCTION public.factoryos_guard_saas_backup_writer_inventory_entry();

CREATE OR REPLACE FUNCTION factoryos_guard_saas_backup_writer_fence_inventory_binding()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE snapshot_status text; snapshot_category text; snapshot_revision bigint;
        snapshot_count integer; actual_count integer;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.writer_inventory_snapshot_id IS NOT NULL THEN
      RAISE EXCEPTION 'writer inventory snapshot binds only when provider fencing is confirmed' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.writer_inventory_snapshot_id IS NOT NULL
     AND NEW.writer_inventory_snapshot_id IS DISTINCT FROM OLD.writer_inventory_snapshot_id THEN
    RAISE EXCEPTION 'writer inventory snapshot binding is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.state='FENCED' THEN
    IF NEW.writer_inventory_snapshot_id IS NULL THEN
      RAISE EXCEPTION 'FENCED requires an independently reviewed writer inventory snapshot' USING ERRCODE='55000';
    END IF;
    SELECT s.status,s.category_code,s.revision,s.entry_count
      INTO snapshot_status,snapshot_category,snapshot_revision,snapshot_count
      FROM public.saas_tenant_backup_writer_inventory_snapshots s
      WHERE s.tenant_id=NEW.tenant_id AND s.snapshot_id=NEW.writer_inventory_snapshot_id;
    IF NOT FOUND OR snapshot_status<>'ACCEPTED' OR snapshot_category<>NEW.category_code THEN
      RAISE EXCEPTION 'FENCED requires an accepted inventory snapshot for the same tenant/category' USING ERRCODE='55000';
    END IF;
    SELECT count(*)::integer INTO actual_count
      FROM public.saas_tenant_backup_writer_inventory_entries e
      WHERE e.tenant_id=NEW.tenant_id AND e.snapshot_id=NEW.writer_inventory_snapshot_id;
    IF actual_count<>snapshot_count THEN
      RAISE EXCEPTION 'accepted writer inventory entry count does not match its sealed snapshot' USING ERRCODE='55000';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.saas_tenant_backup_writer_inventory_snapshots newer
      WHERE newer.tenant_id=NEW.tenant_id AND newer.category_code=NEW.category_code
        AND newer.revision>snapshot_revision
    ) THEN
      RAISE EXCEPTION 'a newer writer inventory snapshot supersedes the reviewed inventory' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_backup_writer_fence_inventory_binding_guard
  ON saas_tenant_backup_writer_fences;
CREATE TRIGGER saas_tenant_backup_writer_fence_inventory_binding_guard
  BEFORE INSERT OR UPDATE ON saas_tenant_backup_writer_fences
  FOR EACH ROW EXECUTE FUNCTION public.factoryos_guard_saas_backup_writer_fence_inventory_binding();

INSERT INTO factoryos_governance.tenant_relation_inventory
  (schema_name,relation_name,scope_model,data_category,export_disposition,erasure_disposition,audit_requirement,rationale)
VALUES
  ('public','saas_tenant_backup_writer_inventory_snapshots','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Versioned and independently reviewed provider writer-principal inventory used to bind backup erasure fences to a complete identity set.'),
  ('public','saas_tenant_backup_writer_inventory_entries','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Immutable tenant-scoped provider principal and access-path inventory entries.')
ON CONFLICT(schema_name,relation_name) DO UPDATE SET
  scope_model=EXCLUDED.scope_model,data_category=EXCLUDED.data_category,
  export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
  audit_requirement=EXCLUDED.audit_requirement,rationale=EXCLUDED.rationale,classified_at=clock_timestamp();

INSERT INTO factoryos_governance.tenant_relation_ownership_reviews
  (schema_name,relation_name,ownership_class,evidence_type,evidence_detail,scope_predicate,
   export_disposition,erasure_disposition,review_status)
VALUES
  ('public','saas_tenant_backup_writer_inventory_snapshots','DIRECT_TENANT','DIRECT_TENANT_COLUMN_AND_RLS',
   'Inventory snapshots are tenant-scoped, immutable after submission, and require an independent reviewer before fence binding.',
   'tenant_id = public.factoryos_current_tenant_id()','EXCLUDED','PROTECTED','VERIFIED'),
  ('public','saas_tenant_backup_writer_inventory_entries','DIRECT_TENANT','DIRECT_TENANT_COLUMN_AND_RLS',
   'Provider principal/access-path entries are immutable and visible only to their tenant.',
   'tenant_id = public.factoryos_current_tenant_id()','EXCLUDED','PROTECTED','VERIFIED')
ON CONFLICT (schema_name,relation_name) DO UPDATE SET
  ownership_class=EXCLUDED.ownership_class,evidence_type=EXCLUDED.evidence_type,
  evidence_detail=EXCLUDED.evidence_detail,scope_predicate=EXCLUDED.scope_predicate,
  export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
  review_status=EXCLUDED.review_status,reviewed_at=clock_timestamp();

INSERT INTO schema_migrations(version,checksum)
VALUES ('223_saas_backup_writer_principal_inventory',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
