BEGIN;

-- Crash-safe application-side operation intents and erasure fences for a dedicated
-- tenant/category backup prefix. Unknown outcomes remain ACTIVE; no lease timeout
-- can silently allow a sealed erasure to be overtaken by an upload.
CREATE TABLE IF NOT EXISTS saas_tenant_backup_writer_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL,
  category_code varchar(64) NOT NULL,
  producer_id varchar(100) NOT NULL,
  writer_epoch bigint NOT NULL DEFAULT 1,
  status varchar(16) NOT NULL DEFAULT 'ACTIVE',
  provider_operation_reference varchar(200),
  failure_code varchar(64),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT uq_saas_backup_writer_operation_tenant_operation UNIQUE (tenant_id,operation_id),
  CONSTRAINT chk_saas_backup_writer_operation_category CHECK (category_code IN (
    'BUSINESS_DATA','AUDIT_LOG','EVIDENCE','APPROVALS','EFFECTIVE_DATED_MASTER_DATA',
    'AI_CONTEXT','LEARNING_EVALUATION','INTEGRATION_METADATA','FILE_REFERENCES','IAM_ACCESS'
  )),
  CONSTRAINT chk_saas_backup_writer_operation_producer CHECK (producer_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
  CONSTRAINT chk_saas_backup_writer_operation_epoch CHECK (writer_epoch BETWEEN 1 AND 9007199254740991),
  CONSTRAINT chk_saas_backup_writer_operation_status CHECK (status IN ('ACTIVE','COMPLETED','FAILED')),
  CONSTRAINT chk_saas_backup_writer_operation_receipt CHECK (
    (status='ACTIVE' AND completed_at IS NULL AND provider_operation_reference IS NULL AND failure_code IS NULL)
    OR (status='COMPLETED' AND completed_at IS NOT NULL
      AND provider_operation_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
      AND provider_operation_reference !~* '://' AND provider_operation_reference !~* '(secret|password|credential|access[-_]?key|token)'
      AND failure_code IS NULL)
    OR (status='FAILED' AND completed_at IS NOT NULL
      AND provider_operation_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
      AND provider_operation_reference !~* '://' AND provider_operation_reference !~* '(secret|password|credential|access[-_]?key|token)'
      AND failure_code ~ '^[A-Z0-9_]{1,64}$')
  )
);
CREATE INDEX IF NOT EXISTS idx_saas_backup_writer_operations_active
  ON saas_tenant_backup_writer_operations(tenant_id,category_code,started_at) WHERE status='ACTIVE';

CREATE TABLE IF NOT EXISTS saas_tenant_backup_writer_fences (
  fence_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  category_code varchar(64) NOT NULL,
  request_id uuid NOT NULL,
  request_version bigint NOT NULL,
  run_id uuid NOT NULL,
  source_export_digest varchar(64) NOT NULL,
  state varchar(24) NOT NULL DEFAULT 'DRAINING',
  writer_epoch bigint NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider_fence_reference varchar(200),
  provider_policy_digest varchar(64),
  writer_inventory_digest varchar(64),
  fenced_writer_count integer,
  erasure_manifest_digest varchar(64),
  verification_reference varchar(200),
  verified_residual_count bigint,
  tombstone_replay_reference varchar(200),
  release_policy_digest varchar(64),
  release_reference varchar(200),
  release_writer_inventory_digest varchar(64),
  release_writer_count integer,
  next_writer_epoch bigint,
  reviewed_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  recovery_from_state varchar(24),
  recovery_reason varchar(64),
  recovery_attestation_reference varchar(200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz,
  CONSTRAINT uq_saas_backup_writer_fence_scope_run UNIQUE (tenant_id,category_code,request_id,request_version,run_id),
  CONSTRAINT fk_saas_backup_writer_fence_run FOREIGN KEY (tenant_id,request_id,request_version,run_id)
    REFERENCES saas_tenant_external_propagation_runs(tenant_id,request_id,request_version,run_id) ON DELETE RESTRICT,
  CONSTRAINT chk_saas_backup_writer_fence_category CHECK (category_code IN (
    'BUSINESS_DATA','AUDIT_LOG','EVIDENCE','APPROVALS','EFFECTIVE_DATED_MASTER_DATA',
    'AI_CONTEXT','LEARNING_EVALUATION','INTEGRATION_METADATA','FILE_REFERENCES','IAM_ACCESS'
  )),
  CONSTRAINT chk_saas_backup_writer_fence_request_version CHECK (request_version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT chk_saas_backup_writer_fence_digests CHECK (
    source_export_digest ~ '^[a-f0-9]{64}$'
    AND (provider_policy_digest IS NULL OR provider_policy_digest ~ '^[a-f0-9]{64}$')
    AND (writer_inventory_digest IS NULL OR writer_inventory_digest ~ '^[a-f0-9]{64}$')
    AND (erasure_manifest_digest IS NULL OR erasure_manifest_digest ~ '^[a-f0-9]{64}$')
    AND (release_policy_digest IS NULL OR release_policy_digest ~ '^[a-f0-9]{64}$')
    AND (release_writer_inventory_digest IS NULL OR release_writer_inventory_digest ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT chk_saas_backup_writer_fence_state CHECK (state IN (
    'DRAINING','FENCING','FENCED','ERASING','ERASURE_VERIFIED','RECOVERY_REQUIRED','RELEASED'
  )),
  CONSTRAINT chk_saas_backup_writer_fence_epoch CHECK (
    writer_epoch BETWEEN 1 AND 9007199254740991
    AND (next_writer_epoch IS NULL OR next_writer_epoch BETWEEN 2 AND 9007199254740991)
    AND (next_writer_epoch IS NULL OR next_writer_epoch > writer_epoch)
  ),
  CONSTRAINT chk_saas_backup_writer_fence_provider_evidence CHECK (
    (provider_fence_reference IS NULL AND provider_policy_digest IS NULL
      AND writer_inventory_digest IS NULL AND fenced_writer_count IS NULL)
    OR (provider_fence_reference IS NOT NULL
      AND provider_fence_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
      AND provider_fence_reference !~* '://' AND provider_fence_reference !~* '(secret|password|credential|access[-_]?key|token)'
      AND provider_policy_digest IS NOT NULL AND provider_policy_digest ~ '^[a-f0-9]{64}$'
      AND writer_inventory_digest IS NOT NULL AND writer_inventory_digest ~ '^[a-f0-9]{64}$'
      AND fenced_writer_count IS NOT NULL AND fenced_writer_count BETWEEN 1 AND 100000)
  ),
  CONSTRAINT chk_saas_backup_writer_fence_verification CHECK (
    (erasure_manifest_digest IS NULL AND verification_reference IS NULL AND verified_residual_count IS NULL)
    OR (erasure_manifest_digest IS NOT NULL AND erasure_manifest_digest ~ '^[a-f0-9]{64}$'
      AND verification_reference IS NOT NULL
      AND verification_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
      AND verification_reference !~* '://' AND verification_reference !~* '(secret|password|credential|access[-_]?key|token)'
      AND verified_residual_count IS NOT NULL AND verified_residual_count >= 0)
  ),
  CONSTRAINT chk_saas_backup_writer_fence_release CHECK (
    (state<>'RELEASED' AND tombstone_replay_reference IS NULL AND release_policy_digest IS NULL
      AND release_reference IS NULL AND release_writer_inventory_digest IS NULL
      AND release_writer_count IS NULL AND next_writer_epoch IS NULL AND reviewed_by_user_id IS NULL AND released_at IS NULL)
    OR (state='RELEASED' AND erasure_manifest_digest IS NOT NULL AND verified_residual_count=0
      AND tombstone_replay_reference IS NOT NULL
      AND tombstone_replay_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
      AND tombstone_replay_reference !~* '://' AND tombstone_replay_reference !~* '(secret|password|credential|access[-_]?key|token)'
      AND release_policy_digest IS NOT NULL AND release_policy_digest ~ '^[a-f0-9]{64}$'
      AND release_reference IS NOT NULL AND release_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
      AND release_reference !~* '://' AND release_reference !~* '(secret|password|credential|access[-_]?key|token)'
      AND release_writer_inventory_digest IS NOT NULL AND release_writer_inventory_digest ~ '^[a-f0-9]{64}$'
      AND release_writer_count IS NOT NULL AND release_writer_count BETWEEN 1 AND 100000
      AND next_writer_epoch IS NOT NULL AND next_writer_epoch > writer_epoch
      AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>created_by_user_id AND released_at IS NOT NULL)
  ),
  CONSTRAINT chk_saas_backup_writer_fence_recovery CHECK (
    (state='RECOVERY_REQUIRED' AND recovery_from_state IS NOT NULL
      AND recovery_from_state IN ('DRAINING','FENCING','FENCED','ERASING','ERASURE_VERIFIED')
      AND recovery_reason ~ '^[A-Z0-9_]{1,64}
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_backup_writer_fence_active_scope
  ON saas_tenant_backup_writer_fences(tenant_id,category_code) WHERE state<>'RELEASED';
CREATE INDEX IF NOT EXISTS idx_saas_backup_writer_fence_recovery
  ON saas_tenant_backup_writer_fences(tenant_id,updated_at) WHERE state='RECOVERY_REQUIRED';

ALTER TABLE saas_tenant_backup_writer_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_backup_writer_operations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_backup_writer_operations_tenant_allow ON saas_tenant_backup_writer_operations;
DROP POLICY IF EXISTS saas_tenant_backup_writer_operations_tenant_enforce ON saas_tenant_backup_writer_operations;
CREATE POLICY saas_tenant_backup_writer_operations_tenant_allow ON saas_tenant_backup_writer_operations AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_backup_writer_operations_tenant_enforce ON saas_tenant_backup_writer_operations AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

ALTER TABLE saas_tenant_backup_writer_fences ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_backup_writer_fences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_backup_writer_fences_tenant_allow ON saas_tenant_backup_writer_fences;
DROP POLICY IF EXISTS saas_tenant_backup_writer_fences_tenant_enforce ON saas_tenant_backup_writer_fences;
CREATE POLICY saas_tenant_backup_writer_fences_tenant_allow ON saas_tenant_backup_writer_fences AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_backup_writer_fences_tenant_enforce ON saas_tenant_backup_writer_fences AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_saas_backup_writer_operation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE expected_epoch bigint;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'backup writer operations are retained as lifecycle evidence' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'ACTIVE' OR NEW.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'backup writer operation must start ACTIVE' USING ERRCODE='55000';
    END IF;
    PERFORM 1 FROM public.tenants t WHERE t.id=NEW.tenant_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'backup writer operation requires an existing tenant' USING ERRCODE='23503'; END IF;
    IF EXISTS (SELECT 1 FROM public.saas_tenant_backup_writer_fences f
      WHERE f.tenant_id=NEW.tenant_id AND f.category_code=NEW.category_code AND f.state<>'RELEASED') THEN
      RAISE EXCEPTION 'backup writer operation rejected by tenant/category fence' USING ERRCODE='55000';
    END IF;
    SELECT f.next_writer_epoch INTO expected_epoch FROM public.saas_tenant_backup_writer_fences f
      WHERE f.tenant_id=NEW.tenant_id AND f.category_code=NEW.category_code AND f.state='RELEASED'
      ORDER BY f.released_at DESC,f.fence_id DESC LIMIT 1;
    expected_epoch:=COALESCE(expected_epoch,1);
    IF NEW.writer_epoch<>expected_epoch THEN
      RAISE EXCEPTION 'backup writer operation uses a stale writer epoch' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.tenants t WHERE t.id=OLD.tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'backup writer operation requires an existing tenant' USING ERRCODE='23503'; END IF;
  IF (NEW.tenant_id,NEW.operation_id,NEW.category_code,NEW.producer_id,NEW.writer_epoch,NEW.started_at)
     IS DISTINCT FROM (OLD.tenant_id,OLD.operation_id,OLD.category_code,OLD.producer_id,OLD.writer_epoch,OLD.started_at) THEN
    RAISE EXCEPTION 'backup writer operation identity is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status<>'ACTIVE' OR NEW.status NOT IN ('COMPLETED','FAILED') OR NEW.completed_at IS NULL
     OR NEW.provider_operation_reference IS NULL THEN
    RAISE EXCEPTION 'only an active writer operation may receive one confirmed provider outcome' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_backup_writer_operation_guard ON saas_tenant_backup_writer_operations;
CREATE TRIGGER saas_tenant_backup_writer_operation_guard BEFORE INSERT OR UPDATE OR DELETE
  ON saas_tenant_backup_writer_operations FOR EACH ROW EXECUTE FUNCTION public.factoryos_guard_saas_backup_writer_operation();

CREATE OR REPLACE FUNCTION factoryos_guard_saas_backup_writer_fence()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE run_row public.saas_tenant_external_propagation_runs%ROWTYPE; active_count bigint; expected_epoch bigint;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'backup writer fences are retained as lifecycle evidence' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'DRAINING' OR NEW.provider_fence_reference IS NOT NULL OR NEW.erasure_manifest_digest IS NOT NULL OR NEW.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'backup writer fence must start in DRAINING without provider or erasure evidence' USING ERRCODE='55000';
    END IF;
    PERFORM 1 FROM public.tenants t WHERE t.id=NEW.tenant_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'backup writer fence requires an existing tenant' USING ERRCODE='23503'; END IF;
    SELECT * INTO run_row FROM public.saas_tenant_external_propagation_runs r
      WHERE r.tenant_id=NEW.tenant_id AND r.request_id=NEW.request_id AND r.request_version=NEW.request_version AND r.run_id=NEW.run_id
      FOR KEY SHARE;
    IF NOT FOUND OR run_row.status<>'RUNNING' OR run_row.source_export_digest<>NEW.source_export_digest
      OR NOT (run_row.categories ? NEW.category_code) THEN
      RAISE EXCEPTION 'backup writer fence must bind to the exact RUNNING erasure run/category' USING ERRCODE='55000';
    END IF;
    SELECT f.next_writer_epoch INTO expected_epoch FROM public.saas_tenant_backup_writer_fences f
      WHERE f.tenant_id=NEW.tenant_id AND f.category_code=NEW.category_code AND f.state='RELEASED'
      ORDER BY f.released_at DESC,f.fence_id DESC LIMIT 1;
    expected_epoch:=COALESCE(expected_epoch,1);
    IF NEW.writer_epoch<>expected_epoch THEN
      RAISE EXCEPTION 'backup writer fence uses a stale writer epoch' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.tenants t WHERE t.id=OLD.tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'backup writer fence requires an existing tenant' USING ERRCODE='23503'; END IF;
  IF (NEW.fence_id,NEW.tenant_id,NEW.category_code,NEW.request_id,NEW.request_version,NEW.run_id,
      NEW.source_export_digest,NEW.writer_epoch,NEW.created_by_user_id,NEW.created_at)
     IS DISTINCT FROM (OLD.fence_id,OLD.tenant_id,OLD.category_code,OLD.request_id,OLD.request_version,OLD.run_id,
      OLD.source_export_digest,OLD.writer_epoch,OLD.created_by_user_id,OLD.created_at) THEN
    RAISE EXCEPTION 'backup writer fence identity is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.state=OLD.state THEN
    IF (NEW.provider_fence_reference,NEW.provider_policy_digest,NEW.writer_inventory_digest,NEW.fenced_writer_count,
       NEW.erasure_manifest_digest,NEW.verification_reference,NEW.verified_residual_count,NEW.tombstone_replay_reference,
       NEW.release_policy_digest,NEW.release_reference,NEW.release_writer_inventory_digest,NEW.release_writer_count,
       NEW.next_writer_epoch,NEW.reviewed_by_user_id,NEW.released_at,NEW.recovery_from_state,NEW.recovery_reason,
       NEW.recovery_attestation_reference)
       IS DISTINCT FROM (OLD.provider_fence_reference,OLD.provider_policy_digest,OLD.writer_inventory_digest,OLD.fenced_writer_count,
       OLD.erasure_manifest_digest,OLD.verification_reference,OLD.verified_residual_count,OLD.tombstone_replay_reference,
       OLD.release_policy_digest,OLD.release_reference,OLD.release_writer_inventory_digest,OLD.release_writer_count,
       OLD.next_writer_epoch,OLD.reviewed_by_user_id,OLD.released_at,OLD.recovery_from_state,OLD.recovery_reason,
       OLD.recovery_attestation_reference) THEN
      RAISE EXCEPTION 'evidence changes require a writer-fence lifecycle transition' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT (OLD.state='DRAINING' AND NEW.state='FENCING'
    OR OLD.state='FENCING' AND NEW.state='FENCED'
    OR OLD.state='FENCED' AND NEW.state='ERASING'
    OR OLD.state='ERASING' AND NEW.state='ERASURE_VERIFIED'
    OR OLD.state IN ('DRAINING','FENCING','FENCED','ERASING','ERASURE_VERIFIED') AND NEW.state='RECOVERY_REQUIRED'
    OR OLD.state='RECOVERY_REQUIRED' AND NEW.state IN ('FENCED','ERASURE_VERIFIED')
    OR OLD.state='ERASURE_VERIFIED' AND NEW.state='RELEASED') THEN
    RAISE EXCEPTION 'invalid backup writer-fence lifecycle transition: % -> %',OLD.state,NEW.state USING ERRCODE='40001';
  END IF;
  SELECT count(*) INTO active_count FROM public.saas_tenant_backup_writer_operations o
    WHERE o.tenant_id=NEW.tenant_id AND o.category_code=NEW.category_code AND o.status='ACTIVE';
  IF NEW.state='FENCING' AND active_count<>0 THEN
    RAISE EXCEPTION 'cannot begin provider fencing while a write is unresolved' USING ERRCODE='55000';
  ELSIF NEW.state='FENCED' THEN
    IF active_count<>0 OR NEW.provider_fence_reference IS NULL OR NEW.provider_policy_digest IS NULL
      OR NEW.writer_inventory_digest IS NULL OR COALESCE(NEW.fenced_writer_count,0)<1 THEN
      RAISE EXCEPTION 'FENCED requires provider policy/inventory evidence and zero active writes' USING ERRCODE='55000';
    END IF;
    IF OLD.state='RECOVERY_REQUIRED' AND NEW.recovery_attestation_reference IS NULL THEN
      RAISE EXCEPTION 'recovery requires independent provider-backed attestation' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.state='ERASING' THEN
    IF NEW.provider_fence_reference IS NULL OR active_count<>0 THEN RAISE EXCEPTION 'ERASING requires active provider fence and no active writes' USING ERRCODE='55000'; END IF;
  ELSIF NEW.state='ERASURE_VERIFIED' THEN
    IF active_count<>0 OR NEW.erasure_manifest_digest IS NULL OR NEW.verification_reference IS NULL OR NEW.verified_residual_count<>0 THEN
      RAISE EXCEPTION 'ERASURE_VERIFIED requires a durable zero-residual proof' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.state='RECOVERY_REQUIRED' THEN
    IF NEW.recovery_reason IS NULL OR NEW.recovery_from_state<>OLD.state THEN
      RAISE EXCEPTION 'recovery must preserve the prior state and a stable reason' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.state='RELEASED' THEN
    IF active_count<>0 OR NEW.erasure_manifest_digest IS NULL OR NEW.verified_residual_count<>0
      OR NEW.tombstone_replay_reference IS NULL OR NEW.release_policy_digest IS NULL OR NEW.release_reference IS NULL
      OR NEW.release_writer_inventory_digest IS NULL OR COALESCE(NEW.release_writer_count,0)<1 OR NEW.next_writer_epoch IS NULL
      OR NEW.next_writer_epoch<=NEW.writer_epoch OR NEW.reviewed_by_user_id IS NULL
      OR NEW.reviewed_by_user_id=NEW.created_by_user_id OR NEW.released_at IS NULL THEN
      RAISE EXCEPTION 'RELEASED requires zero-residual erasure, tombstone replay and independent provider release evidence' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_backup_writer_fence_guard ON saas_tenant_backup_writer_fences;
CREATE TRIGGER saas_tenant_backup_writer_fence_guard BEFORE INSERT OR UPDATE OR DELETE
  ON saas_tenant_backup_writer_fences FOR EACH ROW EXECUTE FUNCTION public.factoryos_guard_saas_backup_writer_fence();

INSERT INTO factoryos_governance.tenant_relation_inventory
  (schema_name,relation_name,scope_model,data_category,export_disposition,erasure_disposition,audit_requirement,rationale)
VALUES
  ('public','saas_tenant_backup_writer_operations','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Durable provider-write intents and confirmed outcomes required to drain backup writers safely.'),
  ('public','saas_tenant_backup_writer_fences','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Crash-recoverable tenant/category backup fences and provider policy/tombstone evidence.')
ON CONFLICT(schema_name,relation_name) DO UPDATE SET
  scope_model=EXCLUDED.scope_model,data_category=EXCLUDED.data_category,
  export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
  audit_requirement=EXCLUDED.audit_requirement,rationale=EXCLUDED.rationale,classified_at=clock_timestamp();

INSERT INTO schema_migrations(version,checksum)
VALUES ('222_saas_tenant_backup_writer_fence_ledger',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
)
    OR (state<>'RECOVERY_REQUIRED' AND recovery_reason IS NULL AND recovery_from_state IS NULL)
  ),
  CONSTRAINT chk_saas_backup_writer_fence_recovery_attestation CHECK (
    recovery_attestation_reference IS NULL
    OR (recovery_attestation_reference IS NOT NULL
      AND recovery_attestation_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_backup_writer_fence_active_scope
  ON saas_tenant_backup_writer_fences(tenant_id,category_code) WHERE state<>'RELEASED';
CREATE INDEX IF NOT EXISTS idx_saas_backup_writer_fence_recovery
  ON saas_tenant_backup_writer_fences(tenant_id,updated_at) WHERE state='RECOVERY_REQUIRED';

ALTER TABLE saas_tenant_backup_writer_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_backup_writer_operations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_backup_writer_operations_tenant_allow ON saas_tenant_backup_writer_operations;
DROP POLICY IF EXISTS saas_tenant_backup_writer_operations_tenant_enforce ON saas_tenant_backup_writer_operations;
CREATE POLICY saas_tenant_backup_writer_operations_tenant_allow ON saas_tenant_backup_writer_operations AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_backup_writer_operations_tenant_enforce ON saas_tenant_backup_writer_operations AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

ALTER TABLE saas_tenant_backup_writer_fences ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_backup_writer_fences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_backup_writer_fences_tenant_allow ON saas_tenant_backup_writer_fences;
DROP POLICY IF EXISTS saas_tenant_backup_writer_fences_tenant_enforce ON saas_tenant_backup_writer_fences;
CREATE POLICY saas_tenant_backup_writer_fences_tenant_allow ON saas_tenant_backup_writer_fences AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_backup_writer_fences_tenant_enforce ON saas_tenant_backup_writer_fences AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_saas_backup_writer_operation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE expected_epoch bigint;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'backup writer operations are retained as lifecycle evidence' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'ACTIVE' OR NEW.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'backup writer operation must start ACTIVE' USING ERRCODE='55000';
    END IF;
    PERFORM 1 FROM public.tenants t WHERE t.id=NEW.tenant_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'backup writer operation requires an existing tenant' USING ERRCODE='23503'; END IF;
    IF EXISTS (SELECT 1 FROM public.saas_tenant_backup_writer_fences f
      WHERE f.tenant_id=NEW.tenant_id AND f.category_code=NEW.category_code AND f.state<>'RELEASED') THEN
      RAISE EXCEPTION 'backup writer operation rejected by tenant/category fence' USING ERRCODE='55000';
    END IF;
    SELECT f.next_writer_epoch INTO expected_epoch FROM public.saas_tenant_backup_writer_fences f
      WHERE f.tenant_id=NEW.tenant_id AND f.category_code=NEW.category_code AND f.state='RELEASED'
      ORDER BY f.released_at DESC,f.fence_id DESC LIMIT 1;
    expected_epoch:=COALESCE(expected_epoch,1);
    IF NEW.writer_epoch<>expected_epoch THEN
      RAISE EXCEPTION 'backup writer operation uses a stale writer epoch' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.tenants t WHERE t.id=OLD.tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'backup writer operation requires an existing tenant' USING ERRCODE='23503'; END IF;
  IF (NEW.tenant_id,NEW.operation_id,NEW.category_code,NEW.producer_id,NEW.writer_epoch,NEW.started_at)
     IS DISTINCT FROM (OLD.tenant_id,OLD.operation_id,OLD.category_code,OLD.producer_id,OLD.writer_epoch,OLD.started_at) THEN
    RAISE EXCEPTION 'backup writer operation identity is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status<>'ACTIVE' OR NEW.status NOT IN ('COMPLETED','FAILED') OR NEW.completed_at IS NULL
     OR NEW.provider_operation_reference IS NULL THEN
    RAISE EXCEPTION 'only an active writer operation may receive one confirmed provider outcome' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_backup_writer_operation_guard ON saas_tenant_backup_writer_operations;
CREATE TRIGGER saas_tenant_backup_writer_operation_guard BEFORE INSERT OR UPDATE OR DELETE
  ON saas_tenant_backup_writer_operations FOR EACH ROW EXECUTE FUNCTION public.factoryos_guard_saas_backup_writer_operation();

CREATE OR REPLACE FUNCTION factoryos_guard_saas_backup_writer_fence()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE run_row public.saas_tenant_external_propagation_runs%ROWTYPE; active_count bigint; expected_epoch bigint;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'backup writer fences are retained as lifecycle evidence' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'DRAINING' OR NEW.provider_fence_reference IS NOT NULL OR NEW.erasure_manifest_digest IS NOT NULL OR NEW.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'backup writer fence must start in DRAINING without provider or erasure evidence' USING ERRCODE='55000';
    END IF;
    PERFORM 1 FROM public.tenants t WHERE t.id=NEW.tenant_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'backup writer fence requires an existing tenant' USING ERRCODE='23503'; END IF;
    SELECT * INTO run_row FROM public.saas_tenant_external_propagation_runs r
      WHERE r.tenant_id=NEW.tenant_id AND r.request_id=NEW.request_id AND r.request_version=NEW.request_version AND r.run_id=NEW.run_id
      FOR KEY SHARE;
    IF NOT FOUND OR run_row.status<>'RUNNING' OR run_row.source_export_digest<>NEW.source_export_digest
      OR NOT (run_row.categories ? NEW.category_code) THEN
      RAISE EXCEPTION 'backup writer fence must bind to the exact RUNNING erasure run/category' USING ERRCODE='55000';
    END IF;
    SELECT f.next_writer_epoch INTO expected_epoch FROM public.saas_tenant_backup_writer_fences f
      WHERE f.tenant_id=NEW.tenant_id AND f.category_code=NEW.category_code AND f.state='RELEASED'
      ORDER BY f.released_at DESC,f.fence_id DESC LIMIT 1;
    expected_epoch:=COALESCE(expected_epoch,1);
    IF NEW.writer_epoch<>expected_epoch THEN
      RAISE EXCEPTION 'backup writer fence uses a stale writer epoch' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.tenants t WHERE t.id=OLD.tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'backup writer fence requires an existing tenant' USING ERRCODE='23503'; END IF;
  IF (NEW.fence_id,NEW.tenant_id,NEW.category_code,NEW.request_id,NEW.request_version,NEW.run_id,
      NEW.source_export_digest,NEW.writer_epoch,NEW.created_by_user_id,NEW.created_at)
     IS DISTINCT FROM (OLD.fence_id,OLD.tenant_id,OLD.category_code,OLD.request_id,OLD.request_version,OLD.run_id,
      OLD.source_export_digest,OLD.writer_epoch,OLD.created_by_user_id,OLD.created_at) THEN
    RAISE EXCEPTION 'backup writer fence identity is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.state=OLD.state THEN
    IF (NEW.provider_fence_reference,NEW.provider_policy_digest,NEW.writer_inventory_digest,NEW.fenced_writer_count,
       NEW.erasure_manifest_digest,NEW.verification_reference,NEW.verified_residual_count,NEW.tombstone_replay_reference,
       NEW.release_policy_digest,NEW.release_reference,NEW.release_writer_inventory_digest,NEW.release_writer_count,
       NEW.next_writer_epoch,NEW.reviewed_by_user_id,NEW.released_at,NEW.recovery_from_state,NEW.recovery_reason,
       NEW.recovery_attestation_reference)
       IS DISTINCT FROM (OLD.provider_fence_reference,OLD.provider_policy_digest,OLD.writer_inventory_digest,OLD.fenced_writer_count,
       OLD.erasure_manifest_digest,OLD.verification_reference,OLD.verified_residual_count,OLD.tombstone_replay_reference,
       OLD.release_policy_digest,OLD.release_reference,OLD.release_writer_inventory_digest,OLD.release_writer_count,
       OLD.next_writer_epoch,OLD.reviewed_by_user_id,OLD.released_at,OLD.recovery_from_state,OLD.recovery_reason,
       OLD.recovery_attestation_reference) THEN
      RAISE EXCEPTION 'evidence changes require a writer-fence lifecycle transition' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT (OLD.state='DRAINING' AND NEW.state='FENCING'
    OR OLD.state='FENCING' AND NEW.state='FENCED'
    OR OLD.state='FENCED' AND NEW.state='ERASING'
    OR OLD.state='ERASING' AND NEW.state='ERASURE_VERIFIED'
    OR OLD.state IN ('DRAINING','FENCING','FENCED','ERASING','ERASURE_VERIFIED') AND NEW.state='RECOVERY_REQUIRED'
    OR OLD.state='RECOVERY_REQUIRED' AND NEW.state IN ('FENCED','ERASURE_VERIFIED')
    OR OLD.state='ERASURE_VERIFIED' AND NEW.state='RELEASED') THEN
    RAISE EXCEPTION 'invalid backup writer-fence lifecycle transition: % -> %',OLD.state,NEW.state USING ERRCODE='40001';
  END IF;
  SELECT count(*) INTO active_count FROM public.saas_tenant_backup_writer_operations o
    WHERE o.tenant_id=NEW.tenant_id AND o.category_code=NEW.category_code AND o.status='ACTIVE';
  IF NEW.state='FENCING' AND active_count<>0 THEN
    RAISE EXCEPTION 'cannot begin provider fencing while a write is unresolved' USING ERRCODE='55000';
  ELSIF NEW.state='FENCED' THEN
    IF active_count<>0 OR NEW.provider_fence_reference IS NULL OR NEW.provider_policy_digest IS NULL
      OR NEW.writer_inventory_digest IS NULL OR COALESCE(NEW.fenced_writer_count,0)<1 THEN
      RAISE EXCEPTION 'FENCED requires provider policy/inventory evidence and zero active writes' USING ERRCODE='55000';
    END IF;
    IF OLD.state='RECOVERY_REQUIRED' AND NEW.recovery_attestation_reference IS NULL THEN
      RAISE EXCEPTION 'recovery requires independent provider-backed attestation' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.state='ERASING' THEN
    IF NEW.provider_fence_reference IS NULL OR active_count<>0 THEN RAISE EXCEPTION 'ERASING requires active provider fence and no active writes' USING ERRCODE='55000'; END IF;
  ELSIF NEW.state='ERASURE_VERIFIED' THEN
    IF active_count<>0 OR NEW.erasure_manifest_digest IS NULL OR NEW.verification_reference IS NULL OR NEW.verified_residual_count<>0 THEN
      RAISE EXCEPTION 'ERASURE_VERIFIED requires a durable zero-residual proof' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.state='RECOVERY_REQUIRED' THEN
    IF NEW.recovery_reason IS NULL OR NEW.recovery_from_state<>OLD.state THEN
      RAISE EXCEPTION 'recovery must preserve the prior state and a stable reason' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.state='RELEASED' THEN
    IF active_count<>0 OR NEW.erasure_manifest_digest IS NULL OR NEW.verified_residual_count<>0
      OR NEW.tombstone_replay_reference IS NULL OR NEW.release_policy_digest IS NULL OR NEW.release_reference IS NULL
      OR NEW.release_writer_inventory_digest IS NULL OR COALESCE(NEW.release_writer_count,0)<1 OR NEW.next_writer_epoch IS NULL
      OR NEW.next_writer_epoch<=NEW.writer_epoch OR NEW.reviewed_by_user_id IS NULL
      OR NEW.reviewed_by_user_id=NEW.created_by_user_id OR NEW.released_at IS NULL THEN
      RAISE EXCEPTION 'RELEASED requires zero-residual erasure, tombstone replay and independent provider release evidence' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_backup_writer_fence_guard ON saas_tenant_backup_writer_fences;
CREATE TRIGGER saas_tenant_backup_writer_fence_guard BEFORE INSERT OR UPDATE OR DELETE
  ON saas_tenant_backup_writer_fences FOR EACH ROW EXECUTE FUNCTION public.factoryos_guard_saas_backup_writer_fence();

INSERT INTO factoryos_governance.tenant_relation_inventory
  (schema_name,relation_name,scope_model,data_category,export_disposition,erasure_disposition,audit_requirement,rationale)
VALUES
  ('public','saas_tenant_backup_writer_operations','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Durable provider-write intents and confirmed outcomes required to drain backup writers safely.'),
  ('public','saas_tenant_backup_writer_fences','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Crash-recoverable tenant/category backup fences and provider policy/tombstone evidence.')
ON CONFLICT(schema_name,relation_name) DO UPDATE SET
  scope_model=EXCLUDED.scope_model,data_category=EXCLUDED.data_category,
  export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
  audit_requirement=EXCLUDED.audit_requirement,rationale=EXCLUDED.rationale,classified_at=clock_timestamp();

INSERT INTO schema_migrations(version,checksum)
VALUES ('222_saas_tenant_backup_writer_fence_ledger',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;

      AND recovery_attestation_reference !~* '://'
      AND recovery_attestation_reference !~* '(secret|password|credential|access[-_]?key|token)')
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_backup_writer_fence_active_scope
  ON saas_tenant_backup_writer_fences(tenant_id,category_code) WHERE state<>'RELEASED';
CREATE INDEX IF NOT EXISTS idx_saas_backup_writer_fence_recovery
  ON saas_tenant_backup_writer_fences(tenant_id,updated_at) WHERE state='RECOVERY_REQUIRED';

ALTER TABLE saas_tenant_backup_writer_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_backup_writer_operations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_backup_writer_operations_tenant_allow ON saas_tenant_backup_writer_operations;
DROP POLICY IF EXISTS saas_tenant_backup_writer_operations_tenant_enforce ON saas_tenant_backup_writer_operations;
CREATE POLICY saas_tenant_backup_writer_operations_tenant_allow ON saas_tenant_backup_writer_operations AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_backup_writer_operations_tenant_enforce ON saas_tenant_backup_writer_operations AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

ALTER TABLE saas_tenant_backup_writer_fences ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_backup_writer_fences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_backup_writer_fences_tenant_allow ON saas_tenant_backup_writer_fences;
DROP POLICY IF EXISTS saas_tenant_backup_writer_fences_tenant_enforce ON saas_tenant_backup_writer_fences;
CREATE POLICY saas_tenant_backup_writer_fences_tenant_allow ON saas_tenant_backup_writer_fences AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_backup_writer_fences_tenant_enforce ON saas_tenant_backup_writer_fences AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_saas_backup_writer_operation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE expected_epoch bigint;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'backup writer operations are retained as lifecycle evidence' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'ACTIVE' OR NEW.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'backup writer operation must start ACTIVE' USING ERRCODE='55000';
    END IF;
    PERFORM 1 FROM public.tenants t WHERE t.id=NEW.tenant_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'backup writer operation requires an existing tenant' USING ERRCODE='23503'; END IF;
    IF EXISTS (SELECT 1 FROM public.saas_tenant_backup_writer_fences f
      WHERE f.tenant_id=NEW.tenant_id AND f.category_code=NEW.category_code AND f.state<>'RELEASED') THEN
      RAISE EXCEPTION 'backup writer operation rejected by tenant/category fence' USING ERRCODE='55000';
    END IF;
    SELECT f.next_writer_epoch INTO expected_epoch FROM public.saas_tenant_backup_writer_fences f
      WHERE f.tenant_id=NEW.tenant_id AND f.category_code=NEW.category_code AND f.state='RELEASED'
      ORDER BY f.released_at DESC,f.fence_id DESC LIMIT 1;
    expected_epoch:=COALESCE(expected_epoch,1);
    IF NEW.writer_epoch<>expected_epoch THEN
      RAISE EXCEPTION 'backup writer operation uses a stale writer epoch' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.tenants t WHERE t.id=OLD.tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'backup writer operation requires an existing tenant' USING ERRCODE='23503'; END IF;
  IF (NEW.tenant_id,NEW.operation_id,NEW.category_code,NEW.producer_id,NEW.writer_epoch,NEW.started_at)
     IS DISTINCT FROM (OLD.tenant_id,OLD.operation_id,OLD.category_code,OLD.producer_id,OLD.writer_epoch,OLD.started_at) THEN
    RAISE EXCEPTION 'backup writer operation identity is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status<>'ACTIVE' OR NEW.status NOT IN ('COMPLETED','FAILED') OR NEW.completed_at IS NULL
     OR NEW.provider_operation_reference IS NULL THEN
    RAISE EXCEPTION 'only an active writer operation may receive one confirmed provider outcome' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_backup_writer_operation_guard ON saas_tenant_backup_writer_operations;
CREATE TRIGGER saas_tenant_backup_writer_operation_guard BEFORE INSERT OR UPDATE OR DELETE
  ON saas_tenant_backup_writer_operations FOR EACH ROW EXECUTE FUNCTION public.factoryos_guard_saas_backup_writer_operation();

CREATE OR REPLACE FUNCTION factoryos_guard_saas_backup_writer_fence()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE run_row public.saas_tenant_external_propagation_runs%ROWTYPE; active_count bigint; expected_epoch bigint;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'backup writer fences are retained as lifecycle evidence' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'DRAINING' OR NEW.provider_fence_reference IS NOT NULL OR NEW.erasure_manifest_digest IS NOT NULL OR NEW.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'backup writer fence must start in DRAINING without provider or erasure evidence' USING ERRCODE='55000';
    END IF;
    PERFORM 1 FROM public.tenants t WHERE t.id=NEW.tenant_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'backup writer fence requires an existing tenant' USING ERRCODE='23503'; END IF;
    SELECT * INTO run_row FROM public.saas_tenant_external_propagation_runs r
      WHERE r.tenant_id=NEW.tenant_id AND r.request_id=NEW.request_id AND r.request_version=NEW.request_version AND r.run_id=NEW.run_id
      FOR KEY SHARE;
    IF NOT FOUND OR run_row.status<>'RUNNING' OR run_row.source_export_digest<>NEW.source_export_digest
      OR NOT (run_row.categories ? NEW.category_code) THEN
      RAISE EXCEPTION 'backup writer fence must bind to the exact RUNNING erasure run/category' USING ERRCODE='55000';
    END IF;
    SELECT f.next_writer_epoch INTO expected_epoch FROM public.saas_tenant_backup_writer_fences f
      WHERE f.tenant_id=NEW.tenant_id AND f.category_code=NEW.category_code AND f.state='RELEASED'
      ORDER BY f.released_at DESC,f.fence_id DESC LIMIT 1;
    expected_epoch:=COALESCE(expected_epoch,1);
    IF NEW.writer_epoch<>expected_epoch THEN
      RAISE EXCEPTION 'backup writer fence uses a stale writer epoch' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.tenants t WHERE t.id=OLD.tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'backup writer fence requires an existing tenant' USING ERRCODE='23503'; END IF;
  IF (NEW.fence_id,NEW.tenant_id,NEW.category_code,NEW.request_id,NEW.request_version,NEW.run_id,
      NEW.source_export_digest,NEW.writer_epoch,NEW.created_by_user_id,NEW.created_at)
     IS DISTINCT FROM (OLD.fence_id,OLD.tenant_id,OLD.category_code,OLD.request_id,OLD.request_version,OLD.run_id,
      OLD.source_export_digest,OLD.writer_epoch,OLD.created_by_user_id,OLD.created_at) THEN
    RAISE EXCEPTION 'backup writer fence identity is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.state=OLD.state THEN
    IF (NEW.provider_fence_reference,NEW.provider_policy_digest,NEW.writer_inventory_digest,NEW.fenced_writer_count,
       NEW.erasure_manifest_digest,NEW.verification_reference,NEW.verified_residual_count,NEW.tombstone_replay_reference,
       NEW.release_policy_digest,NEW.release_reference,NEW.release_writer_inventory_digest,NEW.release_writer_count,
       NEW.next_writer_epoch,NEW.reviewed_by_user_id,NEW.released_at,NEW.recovery_from_state,NEW.recovery_reason,
       NEW.recovery_attestation_reference)
       IS DISTINCT FROM (OLD.provider_fence_reference,OLD.provider_policy_digest,OLD.writer_inventory_digest,OLD.fenced_writer_count,
       OLD.erasure_manifest_digest,OLD.verification_reference,OLD.verified_residual_count,OLD.tombstone_replay_reference,
       OLD.release_policy_digest,OLD.release_reference,OLD.release_writer_inventory_digest,OLD.release_writer_count,
       OLD.next_writer_epoch,OLD.reviewed_by_user_id,OLD.released_at,OLD.recovery_from_state,OLD.recovery_reason,
       OLD.recovery_attestation_reference) THEN
      RAISE EXCEPTION 'evidence changes require a writer-fence lifecycle transition' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT (OLD.state='DRAINING' AND NEW.state='FENCING'
    OR OLD.state='FENCING' AND NEW.state='FENCED'
    OR OLD.state='FENCED' AND NEW.state='ERASING'
    OR OLD.state='ERASING' AND NEW.state='ERASURE_VERIFIED'
    OR OLD.state IN ('DRAINING','FENCING','FENCED','ERASING','ERASURE_VERIFIED') AND NEW.state='RECOVERY_REQUIRED'
    OR OLD.state='RECOVERY_REQUIRED' AND NEW.state IN ('FENCED','ERASURE_VERIFIED')
    OR OLD.state='ERASURE_VERIFIED' AND NEW.state='RELEASED') THEN
    RAISE EXCEPTION 'invalid backup writer-fence lifecycle transition: % -> %',OLD.state,NEW.state USING ERRCODE='40001';
  END IF;
  SELECT count(*) INTO active_count FROM public.saas_tenant_backup_writer_operations o
    WHERE o.tenant_id=NEW.tenant_id AND o.category_code=NEW.category_code AND o.status='ACTIVE';
  IF NEW.state='FENCING' AND active_count<>0 THEN
    RAISE EXCEPTION 'cannot begin provider fencing while a write is unresolved' USING ERRCODE='55000';
  ELSIF NEW.state='FENCED' THEN
    IF active_count<>0 OR NEW.provider_fence_reference IS NULL OR NEW.provider_policy_digest IS NULL
      OR NEW.writer_inventory_digest IS NULL OR COALESCE(NEW.fenced_writer_count,0)<1 THEN
      RAISE EXCEPTION 'FENCED requires provider policy/inventory evidence and zero active writes' USING ERRCODE='55000';
    END IF;
    IF OLD.state='RECOVERY_REQUIRED' AND NEW.recovery_attestation_reference IS NULL THEN
      RAISE EXCEPTION 'recovery requires independent provider-backed attestation' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.state='ERASING' THEN
    IF NEW.provider_fence_reference IS NULL OR active_count<>0 THEN RAISE EXCEPTION 'ERASING requires active provider fence and no active writes' USING ERRCODE='55000'; END IF;
  ELSIF NEW.state='ERASURE_VERIFIED' THEN
    IF active_count<>0 OR NEW.erasure_manifest_digest IS NULL OR NEW.verification_reference IS NULL OR NEW.verified_residual_count<>0 THEN
      RAISE EXCEPTION 'ERASURE_VERIFIED requires a durable zero-residual proof' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.state='RECOVERY_REQUIRED' THEN
    IF NEW.recovery_reason IS NULL OR NEW.recovery_from_state<>OLD.state THEN
      RAISE EXCEPTION 'recovery must preserve the prior state and a stable reason' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.state='RELEASED' THEN
    IF active_count<>0 OR NEW.erasure_manifest_digest IS NULL OR NEW.verified_residual_count<>0
      OR NEW.tombstone_replay_reference IS NULL OR NEW.release_policy_digest IS NULL OR NEW.release_reference IS NULL
      OR NEW.release_writer_inventory_digest IS NULL OR COALESCE(NEW.release_writer_count,0)<1 OR NEW.next_writer_epoch IS NULL
      OR NEW.next_writer_epoch<=NEW.writer_epoch OR NEW.reviewed_by_user_id IS NULL
      OR NEW.reviewed_by_user_id=NEW.created_by_user_id OR NEW.released_at IS NULL THEN
      RAISE EXCEPTION 'RELEASED requires zero-residual erasure, tombstone replay and independent provider release evidence' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_backup_writer_fence_guard ON saas_tenant_backup_writer_fences;
CREATE TRIGGER saas_tenant_backup_writer_fence_guard BEFORE INSERT OR UPDATE OR DELETE
  ON saas_tenant_backup_writer_fences FOR EACH ROW EXECUTE FUNCTION public.factoryos_guard_saas_backup_writer_fence();

INSERT INTO factoryos_governance.tenant_relation_inventory
  (schema_name,relation_name,scope_model,data_category,export_disposition,erasure_disposition,audit_requirement,rationale)
VALUES
  ('public','saas_tenant_backup_writer_operations','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Durable provider-write intents and confirmed outcomes required to drain backup writers safely.'),
  ('public','saas_tenant_backup_writer_fences','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Crash-recoverable tenant/category backup fences and provider policy/tombstone evidence.')
ON CONFLICT(schema_name,relation_name) DO UPDATE SET
  scope_model=EXCLUDED.scope_model,data_category=EXCLUDED.data_category,
  export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
  audit_requirement=EXCLUDED.audit_requirement,rationale=EXCLUDED.rationale,classified_at=clock_timestamp();

INSERT INTO schema_migrations(version,checksum)
VALUES ('222_saas_tenant_backup_writer_fence_ledger',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
