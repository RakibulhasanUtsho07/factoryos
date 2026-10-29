BEGIN;

CREATE TABLE IF NOT EXISTS saas_tenant_backup_provider_acceptances (
  acceptance_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  category_code varchar(64) NOT NULL,
  revision bigint NOT NULL,
  provider_reference varchar(200) NOT NULL,
  provider_scope_reference varchar(200) NOT NULL,
  policy_ownership_review_reference varchar(200) NOT NULL,
  restore_replay_reference varchar(200) NOT NULL,
  provider_scope_digest varchar(64) NOT NULL,
  configuration_reference varchar(200) NOT NULL,
  adapter_key varchar(100) NOT NULL,
  adapter_version varchar(64) NOT NULL,
  staging_evidence_reference varchar(200) NOT NULL,
  evidence_manifest_digest varchar(64) NOT NULL,
  scenario_count integer NOT NULL DEFAULT 10,
  status varchar(16) NOT NULL DEFAULT 'PENDING',
  idempotency_key varchar(100) NOT NULL,
  request_hash varchar(64) NOT NULL,
  submitted_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  review_reason varchar(1000),
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reviewed_at timestamptz,
  valid_until timestamptz,
  CONSTRAINT uq_saas_backup_provider_acceptance_tenant_id UNIQUE (tenant_id,acceptance_id),
  CONSTRAINT uq_saas_backup_provider_acceptance_revision UNIQUE
    (tenant_id,category_code,provider_scope_digest,revision),
  CONSTRAINT uq_saas_backup_provider_acceptance_idempotency UNIQUE
    (tenant_id,category_code,provider_scope_digest,idempotency_key),
  CONSTRAINT chk_saas_backup_provider_acceptance_category CHECK (category_code IN (
    'BUSINESS_DATA','AUDIT_LOG','EVIDENCE','APPROVALS','EFFECTIVE_DATED_MASTER_DATA',
    'AI_CONTEXT','LEARNING_EVALUATION','INTEGRATION_METADATA','FILE_REFERENCES','IAM_ACCESS'
  )),
  CONSTRAINT chk_saas_backup_provider_acceptance_revision CHECK (revision BETWEEN 1 AND 9007199254740991),
  CONSTRAINT chk_saas_backup_provider_acceptance_references CHECK (
    provider_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND provider_scope_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND configuration_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}
    AND adapter_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
    AND adapter_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'
    AND provider_reference !~ '://' AND provider_scope_reference !~ '://'
    AND configuration_reference !~ '://' AND staging_evidence_reference !~ '://'
    AND policy_ownership_review_reference !~ '://' AND restore_replay_reference !~ '://'
    AND (provider_reference || provider_scope_reference || configuration_reference || policy_ownership_review_reference || restore_replay_reference || staging_evidence_reference)
      !~* '(secret|password|credential|access[-_]?key|token)'
  ),
  CONSTRAINT chk_saas_backup_provider_acceptance_digests CHECK (
    provider_scope_digest ~ '^[a-f0-9]{64}$'
    AND evidence_manifest_digest ~ '^[a-f0-9]{64}$'
    AND request_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT chk_saas_backup_provider_acceptance_scenarios CHECK (scenario_count=10),
  CONSTRAINT chk_saas_backup_provider_acceptance_status CHECK (status IN ('PENDING','ACCEPTED','REJECTED')),
  CONSTRAINT chk_saas_backup_provider_acceptance_review CHECK (
    (status='PENDING' AND reviewed_by_user_id IS NULL AND review_reason IS NULL
      AND reviewed_at IS NULL AND valid_until IS NULL)
    OR (status='REJECTED' AND reviewed_by_user_id IS NOT NULL
      AND reviewed_by_user_id<>submitted_by_user_id
      AND review_reason IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND reviewed_at IS NOT NULL AND valid_until IS NULL)
    OR (status='ACCEPTED' AND reviewed_by_user_id IS NOT NULL
      AND reviewed_by_user_id<>submitted_by_user_id
      AND review_reason IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND reviewed_at IS NOT NULL AND valid_until>reviewed_at
      AND valid_until<=reviewed_at+interval '90 days')
  )
);
CREATE INDEX IF NOT EXISTS idx_saas_backup_provider_acceptance_current
  ON saas_tenant_backup_provider_acceptances
  (tenant_id,category_code,provider_scope_digest,revision DESC);

CREATE TABLE IF NOT EXISTS saas_tenant_backup_provider_acceptance_evidence (
  tenant_id uuid NOT NULL,
  acceptance_id uuid NOT NULL,
  scenario_code varchar(48) NOT NULL,
  outcome varchar(12) NOT NULL,
  evidence_reference varchar(200) NOT NULL,
  evidence_sha256 varchar(64) NOT NULL,
  executed_at timestamptz NOT NULL,
  runner_reference varchar(200) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,acceptance_id,scenario_code),
  CONSTRAINT fk_saas_backup_provider_acceptance_evidence_parent
    FOREIGN KEY (tenant_id,acceptance_id)
    REFERENCES saas_tenant_backup_provider_acceptances(tenant_id,acceptance_id) ON DELETE RESTRICT,
  CONSTRAINT chk_saas_backup_provider_acceptance_scenario CHECK (scenario_code IN (
    'POLICY_DENY_READBACK',
    'COPY_OBJECT_DURING_FENCE',
    'MULTIPART_COMPLETION_DURING_FENCE',
    'REPLICATION_DELETE_MARKER',
    'POLICY_DRIFT_DETECTED',
    'CRASH_RECOVERY_DENY_PRESERVED',
    'DELAYED_WRITER_REJECTED',
    'TOMBSTONE_REPLAY_BEFORE_RELEASE',
    'INDEPENDENT_RESIDUAL_LISTING',
    'RESTORE_AFTER_TOMBSTONE_REPLAY'
  )),
  CONSTRAINT chk_saas_backup_provider_acceptance_outcome CHECK (outcome IN ('PASS','FAIL','NOT_RUN')),
  CONSTRAINT chk_saas_backup_provider_acceptance_evidence_reference CHECK (
    evidence_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND runner_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND evidence_reference !~ '://' AND runner_reference !~ '://'
    AND (evidence_reference || runner_reference) !~* '(secret|password|credential|access[-_]?key|token)'
  ),
  CONSTRAINT chk_saas_backup_provider_acceptance_evidence_digest CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_saas_backup_provider_acceptance_evidence_time CHECK (executed_at<=clock_timestamp())
);
CREATE INDEX IF NOT EXISTS idx_saas_backup_provider_acceptance_evidence_parent
  ON saas_tenant_backup_provider_acceptance_evidence(tenant_id,acceptance_id,scenario_code);

CREATE TABLE IF NOT EXISTS saas_tenant_backup_provider_acceptance_revocations (
  revocation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  acceptance_id uuid NOT NULL,
  revoked_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason varchar(1000) NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_saas_backup_provider_acceptance_revocation UNIQUE (tenant_id,acceptance_id),
  CONSTRAINT fk_saas_backup_provider_acceptance_revocation_parent
    FOREIGN KEY (tenant_id,acceptance_id)
    REFERENCES saas_tenant_backup_provider_acceptances(tenant_id,acceptance_id) ON DELETE RESTRICT,
  CONSTRAINT chk_saas_backup_provider_acceptance_revocation_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 1000)
);

ALTER TABLE saas_tenant_backup_provider_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_backup_provider_acceptances FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptances_tenant_allow ON saas_tenant_backup_provider_acceptances;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptances_tenant_enforce ON saas_tenant_backup_provider_acceptances;
CREATE POLICY saas_tenant_backup_provider_acceptances_tenant_allow ON saas_tenant_backup_provider_acceptances AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_backup_provider_acceptances_tenant_enforce ON saas_tenant_backup_provider_acceptances AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

ALTER TABLE saas_tenant_backup_provider_acceptance_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_backup_provider_acceptance_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptance_evidence_tenant_allow ON saas_tenant_backup_provider_acceptance_evidence;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptance_evidence_tenant_enforce ON saas_tenant_backup_provider_acceptance_evidence;
CREATE POLICY saas_tenant_backup_provider_acceptance_evidence_tenant_allow ON saas_tenant_backup_provider_acceptance_evidence AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_backup_provider_acceptance_evidence_tenant_enforce ON saas_tenant_backup_provider_acceptance_evidence AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

ALTER TABLE saas_tenant_backup_provider_acceptance_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_backup_provider_acceptance_revocations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptance_revocations_tenant_allow ON saas_tenant_backup_provider_acceptance_revocations;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptance_revocations_tenant_enforce ON saas_tenant_backup_provider_acceptance_revocations;
CREATE POLICY saas_tenant_backup_provider_acceptance_revocations_tenant_allow ON saas_tenant_backup_provider_acceptance_revocations AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_backup_provider_acceptance_revocations_tenant_enforce ON saas_tenant_backup_provider_acceptance_revocations AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_saas_backup_provider_acceptance()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE latest_id uuid; evidence_total integer; evidence_pass integer; scenario_total integer;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'backup provider acceptance records are retained as governance evidence' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'PENDING' OR NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.valid_until IS NOT NULL THEN
      RAISE EXCEPTION 'backup provider acceptance must start pending independent review' USING ERRCODE='55000';
    END IF;
    PERFORM 1 FROM public.tenants t WHERE t.id=NEW.tenant_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'backup provider acceptance requires an existing tenant' USING ERRCODE='23503'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.acceptance_id,NEW.tenant_id,NEW.category_code,NEW.revision,NEW.provider_reference,
      NEW.provider_scope_reference,NEW.policy_ownership_review_reference,NEW.restore_replay_reference,
      NEW.provider_scope_digest,NEW.configuration_reference,
      NEW.adapter_key,NEW.adapter_version,NEW.staging_evidence_reference,
      NEW.evidence_manifest_digest,NEW.scenario_count,NEW.idempotency_key,NEW.request_hash,
      NEW.submitted_by_user_id,NEW.submitted_at)
     IS DISTINCT FROM
     (OLD.acceptance_id,OLD.tenant_id,OLD.category_code,OLD.revision,OLD.provider_reference,
      OLD.provider_scope_reference,OLD.policy_ownership_review_reference,OLD.restore_replay_reference,
      OLD.provider_scope_digest,OLD.configuration_reference,
      OLD.adapter_key,OLD.adapter_version,OLD.staging_evidence_reference,
      OLD.evidence_manifest_digest,OLD.scenario_count,OLD.idempotency_key,OLD.request_hash,
      OLD.submitted_by_user_id,OLD.submitted_at) THEN
    RAISE EXCEPTION 'backup provider acceptance identity and evidence manifest are immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status<>'PENDING' OR NEW.status NOT IN ('ACCEPTED','REJECTED')
      OR NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_by_user_id=OLD.submitted_by_user_id
      OR NEW.review_reason IS NULL OR length(btrim(NEW.review_reason)) NOT BETWEEN 3 AND 1000
      OR NEW.reviewed_at IS NULL THEN
    RAISE EXCEPTION 'only pending provider acceptances may receive an independent review' USING ERRCODE='55000';
  END IF;
  SELECT a.acceptance_id INTO latest_id
    FROM public.saas_tenant_backup_provider_acceptances a
    WHERE a.tenant_id=NEW.tenant_id AND a.category_code=NEW.category_code
      AND a.provider_scope_digest=NEW.provider_scope_digest
    ORDER BY a.revision DESC LIMIT 1 FOR UPDATE;
  IF latest_id IS DISTINCT FROM NEW.acceptance_id THEN
    RAISE EXCEPTION 'only the latest provider acceptance revision may be reviewed' USING ERRCODE='55000';
  END IF;
  SELECT count(*)::integer,count(*) FILTER (WHERE e.outcome='PASS')::integer,
         count(DISTINCT e.scenario_code)::integer
    INTO evidence_total,evidence_pass,scenario_total
    FROM public.saas_tenant_backup_provider_acceptance_evidence e
    WHERE e.tenant_id=NEW.tenant_id AND e.acceptance_id=NEW.acceptance_id;
  IF evidence_total<>10 OR scenario_total<>10 THEN
    RAISE EXCEPTION 'provider acceptance requires the complete ten-scenario evidence matrix' USING ERRCODE='55000';
  END IF;
  IF NEW.status='ACCEPTED' THEN
    IF evidence_pass<>10 OR NEW.valid_until IS NULL OR NEW.valid_until<=NEW.reviewed_at
       OR NEW.valid_until>NEW.reviewed_at+interval '90 days' THEN
      RAISE EXCEPTION 'provider acceptance needs ten passing scenarios and at most 90-day validity' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.valid_until IS NOT NULL THEN
    RAISE EXCEPTION 'rejected provider acceptance cannot have a validity window' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_backup_provider_acceptance_guard ON saas_tenant_backup_provider_acceptances;
CREATE TRIGGER saas_tenant_backup_provider_acceptance_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_backup_provider_acceptances
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_backup_provider_acceptance();

CREATE OR REPLACE FUNCTION factoryos_guard_saas_backup_provider_acceptance_evidence()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE parent_status text;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'provider acceptance evidence is immutable' USING ERRCODE='55000';
  END IF;
  SELECT a.status INTO parent_status FROM public.saas_tenant_backup_provider_acceptances a
    WHERE a.tenant_id=NEW.tenant_id AND a.acceptance_id=NEW.acceptance_id FOR UPDATE;
  IF NOT FOUND OR parent_status<>'PENDING' THEN
    RAISE EXCEPTION 'provider acceptance evidence can only be added while the parent is pending' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_backup_provider_acceptance_evidence_guard ON saas_tenant_backup_provider_acceptance_evidence;
CREATE TRIGGER saas_tenant_backup_provider_acceptance_evidence_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_backup_provider_acceptance_evidence
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_backup_provider_acceptance_evidence();

CREATE OR REPLACE FUNCTION factoryos_guard_saas_backup_provider_acceptance_revocation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE submitted_by uuid; reviewed_by uuid; parent_status text;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'provider acceptance revocations are append-only' USING ERRCODE='55000';
  END IF;
  SELECT a.submitted_by_user_id,a.reviewed_by_user_id,a.status
    INTO submitted_by,reviewed_by,parent_status
    FROM public.saas_tenant_backup_provider_acceptances a
    WHERE a.tenant_id=NEW.tenant_id AND a.acceptance_id=NEW.acceptance_id FOR UPDATE;
  IF NOT FOUND OR parent_status<>'ACCEPTED' OR NEW.revoked_by_user_id IN (submitted_by,reviewed_by) THEN
    RAISE EXCEPTION 'revocation requires a currently accepted record and a third-party reviewer' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_backup_provider_acceptance_revocation_guard ON saas_tenant_backup_provider_acceptance_revocations;
CREATE TRIGGER saas_tenant_backup_provider_acceptance_revocation_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_backup_provider_acceptance_revocations
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_backup_provider_acceptance_revocation();

INSERT INTO factoryos_governance.tenant_relation_inventory
  (schema_name,relation_name,scope_model,data_category,export_disposition,erasure_disposition,audit_requirement,rationale)
VALUES
  ('public','saas_tenant_backup_provider_acceptances','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Provider acceptance records bind ten independently evidenced staging scenarios and their immutable provider scope to an independent reviewer.'),
  ('public','saas_tenant_backup_provider_acceptance_evidence','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Immutable per-scenario evidence digests supporting provider acceptance.'),
  ('public','saas_tenant_backup_provider_acceptance_revocations','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Append-only revocations immediately invalidate backup provider acceptance.')
ON CONFLICT(schema_name,relation_name) DO UPDATE SET
  scope_model=EXCLUDED.scope_model,data_category=EXCLUDED.data_category,
  export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
  audit_requirement=EXCLUDED.audit_requirement,rationale=EXCLUDED.rationale,classified_at=clock_timestamp();

INSERT INTO factoryos_governance.tenant_relation_ownership_reviews
  (schema_name,relation_name,ownership_class,evidence_type,evidence_detail,scope_predicate,
   export_disposition,erasure_disposition,review_status)
VALUES
  ('public','saas_tenant_backup_provider_acceptances','DIRECT_TENANT','DIRECT_TENANT_COLUMN_AND_RLS',
   'Provider acceptance records are tenant scoped, revisioned, immutable after independent review and scoped to a non-secret provider identity reference.',
   'tenant_id = public.factoryos_current_tenant_id()','EXCLUDED','PROTECTED','VERIFIED'),
  ('public','saas_tenant_backup_provider_acceptance_evidence','DIRECT_TENANT','DIRECT_TENANT_COLUMN_AND_RLS',
   'Each provider test scenario evidence record is immutable and tenant-scoped.',
   'tenant_id = public.factoryos_current_tenant_id()','EXCLUDED','PROTECTED','VERIFIED'),
  ('public','saas_tenant_backup_provider_acceptance_revocations','DIRECT_TENANT','DIRECT_TENANT_COLUMN_AND_RLS',
   'Revocation facts are append-only and tenant-scoped.',
   'tenant_id = public.factoryos_current_tenant_id()','EXCLUDED','PROTECTED','VERIFIED')
ON CONFLICT (schema_name,relation_name) DO UPDATE SET
  ownership_class=EXCLUDED.ownership_class,evidence_type=EXCLUDED.evidence_type,
  evidence_detail=EXCLUDED.evidence_detail,scope_predicate=EXCLUDED.scope_predicate,
  export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
  review_status=EXCLUDED.review_status,reviewed_at=clock_timestamp();

INSERT INTO schema_migrations(version,checksum)
VALUES ('224_saas_backup_provider_acceptance_registry',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;

    AND policy_ownership_review_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}
    AND adapter_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
    AND adapter_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'
    AND provider_reference !~ '://' AND provider_scope_reference !~ '://'
    AND configuration_reference !~ '://' AND staging_evidence_reference !~ '://'
    AND (provider_reference || provider_scope_reference || configuration_reference || staging_evidence_reference)
      !~* '(secret|password|credential|access[-_]?key|token)'
  ),
  CONSTRAINT chk_saas_backup_provider_acceptance_digests CHECK (
    provider_scope_digest ~ '^[a-f0-9]{64}$'
    AND evidence_manifest_digest ~ '^[a-f0-9]{64}$'
    AND request_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT chk_saas_backup_provider_acceptance_scenarios CHECK (scenario_count=10),
  CONSTRAINT chk_saas_backup_provider_acceptance_status CHECK (status IN ('PENDING','ACCEPTED','REJECTED')),
  CONSTRAINT chk_saas_backup_provider_acceptance_review CHECK (
    (status='PENDING' AND reviewed_by_user_id IS NULL AND review_reason IS NULL
      AND reviewed_at IS NULL AND valid_until IS NULL)
    OR (status='REJECTED' AND reviewed_by_user_id IS NOT NULL
      AND reviewed_by_user_id<>submitted_by_user_id
      AND review_reason IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND reviewed_at IS NOT NULL AND valid_until IS NULL)
    OR (status='ACCEPTED' AND reviewed_by_user_id IS NOT NULL
      AND reviewed_by_user_id<>submitted_by_user_id
      AND review_reason IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND reviewed_at IS NOT NULL AND valid_until>reviewed_at
      AND valid_until<=reviewed_at+interval '90 days')
  )
);
CREATE INDEX IF NOT EXISTS idx_saas_backup_provider_acceptance_current
  ON saas_tenant_backup_provider_acceptances
  (tenant_id,category_code,provider_scope_digest,revision DESC);

CREATE TABLE IF NOT EXISTS saas_tenant_backup_provider_acceptance_evidence (
  tenant_id uuid NOT NULL,
  acceptance_id uuid NOT NULL,
  scenario_code varchar(48) NOT NULL,
  outcome varchar(12) NOT NULL,
  evidence_reference varchar(200) NOT NULL,
  evidence_sha256 varchar(64) NOT NULL,
  executed_at timestamptz NOT NULL,
  runner_reference varchar(200) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,acceptance_id,scenario_code),
  CONSTRAINT fk_saas_backup_provider_acceptance_evidence_parent
    FOREIGN KEY (tenant_id,acceptance_id)
    REFERENCES saas_tenant_backup_provider_acceptances(tenant_id,acceptance_id) ON DELETE RESTRICT,
  CONSTRAINT chk_saas_backup_provider_acceptance_scenario CHECK (scenario_code IN (
    'POLICY_DENY_READBACK',
    'COPY_OBJECT_DURING_FENCE',
    'MULTIPART_COMPLETION_DURING_FENCE',
    'REPLICATION_DELETE_MARKER',
    'POLICY_DRIFT_DETECTED',
    'CRASH_RECOVERY_DENY_PRESERVED',
    'DELAYED_WRITER_REJECTED',
    'TOMBSTONE_REPLAY_BEFORE_RELEASE',
    'INDEPENDENT_RESIDUAL_LISTING',
    'RESTORE_AFTER_TOMBSTONE_REPLAY'
  )),
  CONSTRAINT chk_saas_backup_provider_acceptance_outcome CHECK (outcome IN ('PASS','FAIL','NOT_RUN')),
  CONSTRAINT chk_saas_backup_provider_acceptance_evidence_reference CHECK (
    evidence_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND runner_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND evidence_reference !~ '://' AND runner_reference !~ '://'
    AND (evidence_reference || runner_reference) !~* '(secret|password|credential|access[-_]?key|token)'
  ),
  CONSTRAINT chk_saas_backup_provider_acceptance_evidence_digest CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_saas_backup_provider_acceptance_evidence_time CHECK (executed_at<=clock_timestamp())
);
CREATE INDEX IF NOT EXISTS idx_saas_backup_provider_acceptance_evidence_parent
  ON saas_tenant_backup_provider_acceptance_evidence(tenant_id,acceptance_id,scenario_code);

CREATE TABLE IF NOT EXISTS saas_tenant_backup_provider_acceptance_revocations (
  revocation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  acceptance_id uuid NOT NULL,
  revoked_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason varchar(1000) NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_saas_backup_provider_acceptance_revocation UNIQUE (tenant_id,acceptance_id),
  CONSTRAINT fk_saas_backup_provider_acceptance_revocation_parent
    FOREIGN KEY (tenant_id,acceptance_id)
    REFERENCES saas_tenant_backup_provider_acceptances(tenant_id,acceptance_id) ON DELETE RESTRICT,
  CONSTRAINT chk_saas_backup_provider_acceptance_revocation_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 1000)
);

ALTER TABLE saas_tenant_backup_provider_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_backup_provider_acceptances FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptances_tenant_allow ON saas_tenant_backup_provider_acceptances;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptances_tenant_enforce ON saas_tenant_backup_provider_acceptances;
CREATE POLICY saas_tenant_backup_provider_acceptances_tenant_allow ON saas_tenant_backup_provider_acceptances AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_backup_provider_acceptances_tenant_enforce ON saas_tenant_backup_provider_acceptances AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

ALTER TABLE saas_tenant_backup_provider_acceptance_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_backup_provider_acceptance_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptance_evidence_tenant_allow ON saas_tenant_backup_provider_acceptance_evidence;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptance_evidence_tenant_enforce ON saas_tenant_backup_provider_acceptance_evidence;
CREATE POLICY saas_tenant_backup_provider_acceptance_evidence_tenant_allow ON saas_tenant_backup_provider_acceptance_evidence AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_backup_provider_acceptance_evidence_tenant_enforce ON saas_tenant_backup_provider_acceptance_evidence AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

ALTER TABLE saas_tenant_backup_provider_acceptance_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_backup_provider_acceptance_revocations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptance_revocations_tenant_allow ON saas_tenant_backup_provider_acceptance_revocations;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptance_revocations_tenant_enforce ON saas_tenant_backup_provider_acceptance_revocations;
CREATE POLICY saas_tenant_backup_provider_acceptance_revocations_tenant_allow ON saas_tenant_backup_provider_acceptance_revocations AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_backup_provider_acceptance_revocations_tenant_enforce ON saas_tenant_backup_provider_acceptance_revocations AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_saas_backup_provider_acceptance()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE latest_id uuid; evidence_total integer; evidence_pass integer; scenario_total integer;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'backup provider acceptance records are retained as governance evidence' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'PENDING' OR NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.valid_until IS NOT NULL THEN
      RAISE EXCEPTION 'backup provider acceptance must start pending independent review' USING ERRCODE='55000';
    END IF;
    PERFORM 1 FROM public.tenants t WHERE t.id=NEW.tenant_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'backup provider acceptance requires an existing tenant' USING ERRCODE='23503'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.acceptance_id,NEW.tenant_id,NEW.category_code,NEW.revision,NEW.provider_reference,
      NEW.provider_scope_reference,NEW.provider_scope_digest,NEW.configuration_reference,
      NEW.adapter_key,NEW.adapter_version,NEW.staging_evidence_reference,
      NEW.evidence_manifest_digest,NEW.scenario_count,NEW.idempotency_key,NEW.request_hash,
      NEW.submitted_by_user_id,NEW.submitted_at)
     IS DISTINCT FROM
     (OLD.acceptance_id,OLD.tenant_id,OLD.category_code,OLD.revision,OLD.provider_reference,
      OLD.provider_scope_reference,OLD.provider_scope_digest,OLD.configuration_reference,
      OLD.adapter_key,OLD.adapter_version,OLD.staging_evidence_reference,
      OLD.evidence_manifest_digest,OLD.scenario_count,OLD.idempotency_key,OLD.request_hash,
      OLD.submitted_by_user_id,OLD.submitted_at) THEN
    RAISE EXCEPTION 'backup provider acceptance identity and evidence manifest are immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status<>'PENDING' OR NEW.status NOT IN ('ACCEPTED','REJECTED')
      OR NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_by_user_id=OLD.submitted_by_user_id
      OR NEW.review_reason IS NULL OR length(btrim(NEW.review_reason)) NOT BETWEEN 3 AND 1000
      OR NEW.reviewed_at IS NULL THEN
    RAISE EXCEPTION 'only pending provider acceptances may receive an independent review' USING ERRCODE='55000';
  END IF;
  SELECT a.acceptance_id INTO latest_id
    FROM public.saas_tenant_backup_provider_acceptances a
    WHERE a.tenant_id=NEW.tenant_id AND a.category_code=NEW.category_code
      AND a.provider_scope_digest=NEW.provider_scope_digest
    ORDER BY a.revision DESC LIMIT 1 FOR UPDATE;
  IF latest_id IS DISTINCT FROM NEW.acceptance_id THEN
    RAISE EXCEPTION 'only the latest provider acceptance revision may be reviewed' USING ERRCODE='55000';
  END IF;
  SELECT count(*)::integer,count(*) FILTER (WHERE e.outcome='PASS')::integer,
         count(DISTINCT e.scenario_code)::integer
    INTO evidence_total,evidence_pass,scenario_total
    FROM public.saas_tenant_backup_provider_acceptance_evidence e
    WHERE e.tenant_id=NEW.tenant_id AND e.acceptance_id=NEW.acceptance_id;
  IF evidence_total<>10 OR scenario_total<>10 THEN
    RAISE EXCEPTION 'provider acceptance requires the complete ten-scenario evidence matrix' USING ERRCODE='55000';
  END IF;
  IF NEW.status='ACCEPTED' THEN
    IF evidence_pass<>10 OR NEW.valid_until IS NULL OR NEW.valid_until<=NEW.reviewed_at
       OR NEW.valid_until>NEW.reviewed_at+interval '90 days' THEN
      RAISE EXCEPTION 'provider acceptance needs ten passing scenarios and at most 90-day validity' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.valid_until IS NOT NULL THEN
    RAISE EXCEPTION 'rejected provider acceptance cannot have a validity window' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_backup_provider_acceptance_guard ON saas_tenant_backup_provider_acceptances;
CREATE TRIGGER saas_tenant_backup_provider_acceptance_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_backup_provider_acceptances
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_backup_provider_acceptance();

CREATE OR REPLACE FUNCTION factoryos_guard_saas_backup_provider_acceptance_evidence()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE parent_status text;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'provider acceptance evidence is immutable' USING ERRCODE='55000';
  END IF;
  SELECT a.status INTO parent_status FROM public.saas_tenant_backup_provider_acceptances a
    WHERE a.tenant_id=NEW.tenant_id AND a.acceptance_id=NEW.acceptance_id FOR UPDATE;
  IF NOT FOUND OR parent_status<>'PENDING' THEN
    RAISE EXCEPTION 'provider acceptance evidence can only be added while the parent is pending' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_backup_provider_acceptance_evidence_guard ON saas_tenant_backup_provider_acceptance_evidence;
CREATE TRIGGER saas_tenant_backup_provider_acceptance_evidence_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_backup_provider_acceptance_evidence
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_backup_provider_acceptance_evidence();

CREATE OR REPLACE FUNCTION factoryos_guard_saas_backup_provider_acceptance_revocation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE submitted_by uuid; reviewed_by uuid; parent_status text;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'provider acceptance revocations are append-only' USING ERRCODE='55000';
  END IF;
  SELECT a.submitted_by_user_id,a.reviewed_by_user_id,a.status
    INTO submitted_by,reviewed_by,parent_status
    FROM public.saas_tenant_backup_provider_acceptances a
    WHERE a.tenant_id=NEW.tenant_id AND a.acceptance_id=NEW.acceptance_id FOR UPDATE;
  IF NOT FOUND OR parent_status<>'ACCEPTED' OR NEW.revoked_by_user_id IN (submitted_by,reviewed_by) THEN
    RAISE EXCEPTION 'revocation requires a currently accepted record and a third-party reviewer' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_backup_provider_acceptance_revocation_guard ON saas_tenant_backup_provider_acceptance_revocations;
CREATE TRIGGER saas_tenant_backup_provider_acceptance_revocation_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_backup_provider_acceptance_revocations
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_backup_provider_acceptance_revocation();

INSERT INTO factoryos_governance.tenant_relation_inventory
  (schema_name,relation_name,scope_model,data_category,export_disposition,erasure_disposition,audit_requirement,rationale)
VALUES
  ('public','saas_tenant_backup_provider_acceptances','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Provider acceptance records bind ten independently evidenced staging scenarios and their immutable provider scope to an independent reviewer.'),
  ('public','saas_tenant_backup_provider_acceptance_evidence','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Immutable per-scenario evidence digests supporting provider acceptance.'),
  ('public','saas_tenant_backup_provider_acceptance_revocations','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Append-only revocations immediately invalidate backup provider acceptance.')
ON CONFLICT(schema_name,relation_name) DO UPDATE SET
  scope_model=EXCLUDED.scope_model,data_category=EXCLUDED.data_category,
  export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
  audit_requirement=EXCLUDED.audit_requirement,rationale=EXCLUDED.rationale,classified_at=clock_timestamp();

INSERT INTO factoryos_governance.tenant_relation_ownership_reviews
  (schema_name,relation_name,ownership_class,evidence_type,evidence_detail,scope_predicate,
   export_disposition,erasure_disposition,review_status)
VALUES
  ('public','saas_tenant_backup_provider_acceptances','DIRECT_TENANT','DIRECT_TENANT_COLUMN_AND_RLS',
   'Provider acceptance records are tenant scoped, revisioned, immutable after independent review and scoped to a non-secret provider identity reference.',
   'tenant_id = public.factoryos_current_tenant_id()','EXCLUDED','PROTECTED','VERIFIED'),
  ('public','saas_tenant_backup_provider_acceptance_evidence','DIRECT_TENANT','DIRECT_TENANT_COLUMN_AND_RLS',
   'Each provider test scenario evidence record is immutable and tenant-scoped.',
   'tenant_id = public.factoryos_current_tenant_id()','EXCLUDED','PROTECTED','VERIFIED'),
  ('public','saas_tenant_backup_provider_acceptance_revocations','DIRECT_TENANT','DIRECT_TENANT_COLUMN_AND_RLS',
   'Revocation facts are append-only and tenant-scoped.',
   'tenant_id = public.factoryos_current_tenant_id()','EXCLUDED','PROTECTED','VERIFIED')
ON CONFLICT (schema_name,relation_name) DO UPDATE SET
  ownership_class=EXCLUDED.ownership_class,evidence_type=EXCLUDED.evidence_type,
  evidence_detail=EXCLUDED.evidence_detail,scope_predicate=EXCLUDED.scope_predicate,
  export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
  review_status=EXCLUDED.review_status,reviewed_at=clock_timestamp();

INSERT INTO schema_migrations(version,checksum)
VALUES ('224_saas_backup_provider_acceptance_registry',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;

    AND restore_replay_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}
    AND adapter_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
    AND adapter_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'
    AND provider_reference !~ '://' AND provider_scope_reference !~ '://'
    AND configuration_reference !~ '://' AND staging_evidence_reference !~ '://'
    AND (provider_reference || provider_scope_reference || configuration_reference || staging_evidence_reference)
      !~* '(secret|password|credential|access[-_]?key|token)'
  ),
  CONSTRAINT chk_saas_backup_provider_acceptance_digests CHECK (
    provider_scope_digest ~ '^[a-f0-9]{64}$'
    AND evidence_manifest_digest ~ '^[a-f0-9]{64}$'
    AND request_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT chk_saas_backup_provider_acceptance_scenarios CHECK (scenario_count=10),
  CONSTRAINT chk_saas_backup_provider_acceptance_status CHECK (status IN ('PENDING','ACCEPTED','REJECTED')),
  CONSTRAINT chk_saas_backup_provider_acceptance_review CHECK (
    (status='PENDING' AND reviewed_by_user_id IS NULL AND review_reason IS NULL
      AND reviewed_at IS NULL AND valid_until IS NULL)
    OR (status='REJECTED' AND reviewed_by_user_id IS NOT NULL
      AND reviewed_by_user_id<>submitted_by_user_id
      AND review_reason IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND reviewed_at IS NOT NULL AND valid_until IS NULL)
    OR (status='ACCEPTED' AND reviewed_by_user_id IS NOT NULL
      AND reviewed_by_user_id<>submitted_by_user_id
      AND review_reason IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND reviewed_at IS NOT NULL AND valid_until>reviewed_at
      AND valid_until<=reviewed_at+interval '90 days')
  )
);
CREATE INDEX IF NOT EXISTS idx_saas_backup_provider_acceptance_current
  ON saas_tenant_backup_provider_acceptances
  (tenant_id,category_code,provider_scope_digest,revision DESC);

CREATE TABLE IF NOT EXISTS saas_tenant_backup_provider_acceptance_evidence (
  tenant_id uuid NOT NULL,
  acceptance_id uuid NOT NULL,
  scenario_code varchar(48) NOT NULL,
  outcome varchar(12) NOT NULL,
  evidence_reference varchar(200) NOT NULL,
  evidence_sha256 varchar(64) NOT NULL,
  executed_at timestamptz NOT NULL,
  runner_reference varchar(200) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,acceptance_id,scenario_code),
  CONSTRAINT fk_saas_backup_provider_acceptance_evidence_parent
    FOREIGN KEY (tenant_id,acceptance_id)
    REFERENCES saas_tenant_backup_provider_acceptances(tenant_id,acceptance_id) ON DELETE RESTRICT,
  CONSTRAINT chk_saas_backup_provider_acceptance_scenario CHECK (scenario_code IN (
    'POLICY_DENY_READBACK',
    'COPY_OBJECT_DURING_FENCE',
    'MULTIPART_COMPLETION_DURING_FENCE',
    'REPLICATION_DELETE_MARKER',
    'POLICY_DRIFT_DETECTED',
    'CRASH_RECOVERY_DENY_PRESERVED',
    'DELAYED_WRITER_REJECTED',
    'TOMBSTONE_REPLAY_BEFORE_RELEASE',
    'INDEPENDENT_RESIDUAL_LISTING',
    'RESTORE_AFTER_TOMBSTONE_REPLAY'
  )),
  CONSTRAINT chk_saas_backup_provider_acceptance_outcome CHECK (outcome IN ('PASS','FAIL','NOT_RUN')),
  CONSTRAINT chk_saas_backup_provider_acceptance_evidence_reference CHECK (
    evidence_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND runner_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND evidence_reference !~ '://' AND runner_reference !~ '://'
    AND (evidence_reference || runner_reference) !~* '(secret|password|credential|access[-_]?key|token)'
  ),
  CONSTRAINT chk_saas_backup_provider_acceptance_evidence_digest CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_saas_backup_provider_acceptance_evidence_time CHECK (executed_at<=clock_timestamp())
);
CREATE INDEX IF NOT EXISTS idx_saas_backup_provider_acceptance_evidence_parent
  ON saas_tenant_backup_provider_acceptance_evidence(tenant_id,acceptance_id,scenario_code);

CREATE TABLE IF NOT EXISTS saas_tenant_backup_provider_acceptance_revocations (
  revocation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  acceptance_id uuid NOT NULL,
  revoked_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason varchar(1000) NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_saas_backup_provider_acceptance_revocation UNIQUE (tenant_id,acceptance_id),
  CONSTRAINT fk_saas_backup_provider_acceptance_revocation_parent
    FOREIGN KEY (tenant_id,acceptance_id)
    REFERENCES saas_tenant_backup_provider_acceptances(tenant_id,acceptance_id) ON DELETE RESTRICT,
  CONSTRAINT chk_saas_backup_provider_acceptance_revocation_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 1000)
);

ALTER TABLE saas_tenant_backup_provider_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_backup_provider_acceptances FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptances_tenant_allow ON saas_tenant_backup_provider_acceptances;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptances_tenant_enforce ON saas_tenant_backup_provider_acceptances;
CREATE POLICY saas_tenant_backup_provider_acceptances_tenant_allow ON saas_tenant_backup_provider_acceptances AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_backup_provider_acceptances_tenant_enforce ON saas_tenant_backup_provider_acceptances AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

ALTER TABLE saas_tenant_backup_provider_acceptance_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_backup_provider_acceptance_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptance_evidence_tenant_allow ON saas_tenant_backup_provider_acceptance_evidence;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptance_evidence_tenant_enforce ON saas_tenant_backup_provider_acceptance_evidence;
CREATE POLICY saas_tenant_backup_provider_acceptance_evidence_tenant_allow ON saas_tenant_backup_provider_acceptance_evidence AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_backup_provider_acceptance_evidence_tenant_enforce ON saas_tenant_backup_provider_acceptance_evidence AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

ALTER TABLE saas_tenant_backup_provider_acceptance_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_backup_provider_acceptance_revocations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptance_revocations_tenant_allow ON saas_tenant_backup_provider_acceptance_revocations;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptance_revocations_tenant_enforce ON saas_tenant_backup_provider_acceptance_revocations;
CREATE POLICY saas_tenant_backup_provider_acceptance_revocations_tenant_allow ON saas_tenant_backup_provider_acceptance_revocations AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_backup_provider_acceptance_revocations_tenant_enforce ON saas_tenant_backup_provider_acceptance_revocations AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_saas_backup_provider_acceptance()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE latest_id uuid; evidence_total integer; evidence_pass integer; scenario_total integer;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'backup provider acceptance records are retained as governance evidence' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'PENDING' OR NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.valid_until IS NOT NULL THEN
      RAISE EXCEPTION 'backup provider acceptance must start pending independent review' USING ERRCODE='55000';
    END IF;
    PERFORM 1 FROM public.tenants t WHERE t.id=NEW.tenant_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'backup provider acceptance requires an existing tenant' USING ERRCODE='23503'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.acceptance_id,NEW.tenant_id,NEW.category_code,NEW.revision,NEW.provider_reference,
      NEW.provider_scope_reference,NEW.provider_scope_digest,NEW.configuration_reference,
      NEW.adapter_key,NEW.adapter_version,NEW.staging_evidence_reference,
      NEW.evidence_manifest_digest,NEW.scenario_count,NEW.idempotency_key,NEW.request_hash,
      NEW.submitted_by_user_id,NEW.submitted_at)
     IS DISTINCT FROM
     (OLD.acceptance_id,OLD.tenant_id,OLD.category_code,OLD.revision,OLD.provider_reference,
      OLD.provider_scope_reference,OLD.provider_scope_digest,OLD.configuration_reference,
      OLD.adapter_key,OLD.adapter_version,OLD.staging_evidence_reference,
      OLD.evidence_manifest_digest,OLD.scenario_count,OLD.idempotency_key,OLD.request_hash,
      OLD.submitted_by_user_id,OLD.submitted_at) THEN
    RAISE EXCEPTION 'backup provider acceptance identity and evidence manifest are immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status<>'PENDING' OR NEW.status NOT IN ('ACCEPTED','REJECTED')
      OR NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_by_user_id=OLD.submitted_by_user_id
      OR NEW.review_reason IS NULL OR length(btrim(NEW.review_reason)) NOT BETWEEN 3 AND 1000
      OR NEW.reviewed_at IS NULL THEN
    RAISE EXCEPTION 'only pending provider acceptances may receive an independent review' USING ERRCODE='55000';
  END IF;
  SELECT a.acceptance_id INTO latest_id
    FROM public.saas_tenant_backup_provider_acceptances a
    WHERE a.tenant_id=NEW.tenant_id AND a.category_code=NEW.category_code
      AND a.provider_scope_digest=NEW.provider_scope_digest
    ORDER BY a.revision DESC LIMIT 1 FOR UPDATE;
  IF latest_id IS DISTINCT FROM NEW.acceptance_id THEN
    RAISE EXCEPTION 'only the latest provider acceptance revision may be reviewed' USING ERRCODE='55000';
  END IF;
  SELECT count(*)::integer,count(*) FILTER (WHERE e.outcome='PASS')::integer,
         count(DISTINCT e.scenario_code)::integer
    INTO evidence_total,evidence_pass,scenario_total
    FROM public.saas_tenant_backup_provider_acceptance_evidence e
    WHERE e.tenant_id=NEW.tenant_id AND e.acceptance_id=NEW.acceptance_id;
  IF evidence_total<>10 OR scenario_total<>10 THEN
    RAISE EXCEPTION 'provider acceptance requires the complete ten-scenario evidence matrix' USING ERRCODE='55000';
  END IF;
  IF NEW.status='ACCEPTED' THEN
    IF evidence_pass<>10 OR NEW.valid_until IS NULL OR NEW.valid_until<=NEW.reviewed_at
       OR NEW.valid_until>NEW.reviewed_at+interval '90 days' THEN
      RAISE EXCEPTION 'provider acceptance needs ten passing scenarios and at most 90-day validity' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.valid_until IS NOT NULL THEN
    RAISE EXCEPTION 'rejected provider acceptance cannot have a validity window' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_backup_provider_acceptance_guard ON saas_tenant_backup_provider_acceptances;
CREATE TRIGGER saas_tenant_backup_provider_acceptance_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_backup_provider_acceptances
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_backup_provider_acceptance();

CREATE OR REPLACE FUNCTION factoryos_guard_saas_backup_provider_acceptance_evidence()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE parent_status text;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'provider acceptance evidence is immutable' USING ERRCODE='55000';
  END IF;
  SELECT a.status INTO parent_status FROM public.saas_tenant_backup_provider_acceptances a
    WHERE a.tenant_id=NEW.tenant_id AND a.acceptance_id=NEW.acceptance_id FOR UPDATE;
  IF NOT FOUND OR parent_status<>'PENDING' THEN
    RAISE EXCEPTION 'provider acceptance evidence can only be added while the parent is pending' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_backup_provider_acceptance_evidence_guard ON saas_tenant_backup_provider_acceptance_evidence;
CREATE TRIGGER saas_tenant_backup_provider_acceptance_evidence_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_backup_provider_acceptance_evidence
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_backup_provider_acceptance_evidence();

CREATE OR REPLACE FUNCTION factoryos_guard_saas_backup_provider_acceptance_revocation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE submitted_by uuid; reviewed_by uuid; parent_status text;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'provider acceptance revocations are append-only' USING ERRCODE='55000';
  END IF;
  SELECT a.submitted_by_user_id,a.reviewed_by_user_id,a.status
    INTO submitted_by,reviewed_by,parent_status
    FROM public.saas_tenant_backup_provider_acceptances a
    WHERE a.tenant_id=NEW.tenant_id AND a.acceptance_id=NEW.acceptance_id FOR UPDATE;
  IF NOT FOUND OR parent_status<>'ACCEPTED' OR NEW.revoked_by_user_id IN (submitted_by,reviewed_by) THEN
    RAISE EXCEPTION 'revocation requires a currently accepted record and a third-party reviewer' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_backup_provider_acceptance_revocation_guard ON saas_tenant_backup_provider_acceptance_revocations;
CREATE TRIGGER saas_tenant_backup_provider_acceptance_revocation_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_backup_provider_acceptance_revocations
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_backup_provider_acceptance_revocation();

INSERT INTO factoryos_governance.tenant_relation_inventory
  (schema_name,relation_name,scope_model,data_category,export_disposition,erasure_disposition,audit_requirement,rationale)
VALUES
  ('public','saas_tenant_backup_provider_acceptances','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Provider acceptance records bind ten independently evidenced staging scenarios and their immutable provider scope to an independent reviewer.'),
  ('public','saas_tenant_backup_provider_acceptance_evidence','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Immutable per-scenario evidence digests supporting provider acceptance.'),
  ('public','saas_tenant_backup_provider_acceptance_revocations','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Append-only revocations immediately invalidate backup provider acceptance.')
ON CONFLICT(schema_name,relation_name) DO UPDATE SET
  scope_model=EXCLUDED.scope_model,data_category=EXCLUDED.data_category,
  export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
  audit_requirement=EXCLUDED.audit_requirement,rationale=EXCLUDED.rationale,classified_at=clock_timestamp();

INSERT INTO factoryos_governance.tenant_relation_ownership_reviews
  (schema_name,relation_name,ownership_class,evidence_type,evidence_detail,scope_predicate,
   export_disposition,erasure_disposition,review_status)
VALUES
  ('public','saas_tenant_backup_provider_acceptances','DIRECT_TENANT','DIRECT_TENANT_COLUMN_AND_RLS',
   'Provider acceptance records are tenant scoped, revisioned, immutable after independent review and scoped to a non-secret provider identity reference.',
   'tenant_id = public.factoryos_current_tenant_id()','EXCLUDED','PROTECTED','VERIFIED'),
  ('public','saas_tenant_backup_provider_acceptance_evidence','DIRECT_TENANT','DIRECT_TENANT_COLUMN_AND_RLS',
   'Each provider test scenario evidence record is immutable and tenant-scoped.',
   'tenant_id = public.factoryos_current_tenant_id()','EXCLUDED','PROTECTED','VERIFIED'),
  ('public','saas_tenant_backup_provider_acceptance_revocations','DIRECT_TENANT','DIRECT_TENANT_COLUMN_AND_RLS',
   'Revocation facts are append-only and tenant-scoped.',
   'tenant_id = public.factoryos_current_tenant_id()','EXCLUDED','PROTECTED','VERIFIED')
ON CONFLICT (schema_name,relation_name) DO UPDATE SET
  ownership_class=EXCLUDED.ownership_class,evidence_type=EXCLUDED.evidence_type,
  evidence_detail=EXCLUDED.evidence_detail,scope_predicate=EXCLUDED.scope_predicate,
  export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
  review_status=EXCLUDED.review_status,reviewed_at=clock_timestamp();

INSERT INTO schema_migrations(version,checksum)
VALUES ('224_saas_backup_provider_acceptance_registry',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;

    AND staging_evidence_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}
    AND adapter_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
    AND adapter_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'
    AND provider_reference !~ '://' AND provider_scope_reference !~ '://'
    AND configuration_reference !~ '://' AND staging_evidence_reference !~ '://'
    AND (provider_reference || provider_scope_reference || configuration_reference || staging_evidence_reference)
      !~* '(secret|password|credential|access[-_]?key|token)'
  ),
  CONSTRAINT chk_saas_backup_provider_acceptance_digests CHECK (
    provider_scope_digest ~ '^[a-f0-9]{64}$'
    AND evidence_manifest_digest ~ '^[a-f0-9]{64}$'
    AND request_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT chk_saas_backup_provider_acceptance_scenarios CHECK (scenario_count=10),
  CONSTRAINT chk_saas_backup_provider_acceptance_status CHECK (status IN ('PENDING','ACCEPTED','REJECTED')),
  CONSTRAINT chk_saas_backup_provider_acceptance_review CHECK (
    (status='PENDING' AND reviewed_by_user_id IS NULL AND review_reason IS NULL
      AND reviewed_at IS NULL AND valid_until IS NULL)
    OR (status='REJECTED' AND reviewed_by_user_id IS NOT NULL
      AND reviewed_by_user_id<>submitted_by_user_id
      AND review_reason IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND reviewed_at IS NOT NULL AND valid_until IS NULL)
    OR (status='ACCEPTED' AND reviewed_by_user_id IS NOT NULL
      AND reviewed_by_user_id<>submitted_by_user_id
      AND review_reason IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND reviewed_at IS NOT NULL AND valid_until>reviewed_at
      AND valid_until<=reviewed_at+interval '90 days')
  )
);
CREATE INDEX IF NOT EXISTS idx_saas_backup_provider_acceptance_current
  ON saas_tenant_backup_provider_acceptances
  (tenant_id,category_code,provider_scope_digest,revision DESC);

CREATE TABLE IF NOT EXISTS saas_tenant_backup_provider_acceptance_evidence (
  tenant_id uuid NOT NULL,
  acceptance_id uuid NOT NULL,
  scenario_code varchar(48) NOT NULL,
  outcome varchar(12) NOT NULL,
  evidence_reference varchar(200) NOT NULL,
  evidence_sha256 varchar(64) NOT NULL,
  executed_at timestamptz NOT NULL,
  runner_reference varchar(200) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,acceptance_id,scenario_code),
  CONSTRAINT fk_saas_backup_provider_acceptance_evidence_parent
    FOREIGN KEY (tenant_id,acceptance_id)
    REFERENCES saas_tenant_backup_provider_acceptances(tenant_id,acceptance_id) ON DELETE RESTRICT,
  CONSTRAINT chk_saas_backup_provider_acceptance_scenario CHECK (scenario_code IN (
    'POLICY_DENY_READBACK',
    'COPY_OBJECT_DURING_FENCE',
    'MULTIPART_COMPLETION_DURING_FENCE',
    'REPLICATION_DELETE_MARKER',
    'POLICY_DRIFT_DETECTED',
    'CRASH_RECOVERY_DENY_PRESERVED',
    'DELAYED_WRITER_REJECTED',
    'TOMBSTONE_REPLAY_BEFORE_RELEASE',
    'INDEPENDENT_RESIDUAL_LISTING',
    'RESTORE_AFTER_TOMBSTONE_REPLAY'
  )),
  CONSTRAINT chk_saas_backup_provider_acceptance_outcome CHECK (outcome IN ('PASS','FAIL','NOT_RUN')),
  CONSTRAINT chk_saas_backup_provider_acceptance_evidence_reference CHECK (
    evidence_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND runner_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND evidence_reference !~ '://' AND runner_reference !~ '://'
    AND (evidence_reference || runner_reference) !~* '(secret|password|credential|access[-_]?key|token)'
  ),
  CONSTRAINT chk_saas_backup_provider_acceptance_evidence_digest CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_saas_backup_provider_acceptance_evidence_time CHECK (executed_at<=clock_timestamp())
);
CREATE INDEX IF NOT EXISTS idx_saas_backup_provider_acceptance_evidence_parent
  ON saas_tenant_backup_provider_acceptance_evidence(tenant_id,acceptance_id,scenario_code);

CREATE TABLE IF NOT EXISTS saas_tenant_backup_provider_acceptance_revocations (
  revocation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  acceptance_id uuid NOT NULL,
  revoked_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason varchar(1000) NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_saas_backup_provider_acceptance_revocation UNIQUE (tenant_id,acceptance_id),
  CONSTRAINT fk_saas_backup_provider_acceptance_revocation_parent
    FOREIGN KEY (tenant_id,acceptance_id)
    REFERENCES saas_tenant_backup_provider_acceptances(tenant_id,acceptance_id) ON DELETE RESTRICT,
  CONSTRAINT chk_saas_backup_provider_acceptance_revocation_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 1000)
);

ALTER TABLE saas_tenant_backup_provider_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_backup_provider_acceptances FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptances_tenant_allow ON saas_tenant_backup_provider_acceptances;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptances_tenant_enforce ON saas_tenant_backup_provider_acceptances;
CREATE POLICY saas_tenant_backup_provider_acceptances_tenant_allow ON saas_tenant_backup_provider_acceptances AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_backup_provider_acceptances_tenant_enforce ON saas_tenant_backup_provider_acceptances AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

ALTER TABLE saas_tenant_backup_provider_acceptance_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_backup_provider_acceptance_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptance_evidence_tenant_allow ON saas_tenant_backup_provider_acceptance_evidence;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptance_evidence_tenant_enforce ON saas_tenant_backup_provider_acceptance_evidence;
CREATE POLICY saas_tenant_backup_provider_acceptance_evidence_tenant_allow ON saas_tenant_backup_provider_acceptance_evidence AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_backup_provider_acceptance_evidence_tenant_enforce ON saas_tenant_backup_provider_acceptance_evidence AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

ALTER TABLE saas_tenant_backup_provider_acceptance_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_backup_provider_acceptance_revocations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptance_revocations_tenant_allow ON saas_tenant_backup_provider_acceptance_revocations;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptance_revocations_tenant_enforce ON saas_tenant_backup_provider_acceptance_revocations;
CREATE POLICY saas_tenant_backup_provider_acceptance_revocations_tenant_allow ON saas_tenant_backup_provider_acceptance_revocations AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_backup_provider_acceptance_revocations_tenant_enforce ON saas_tenant_backup_provider_acceptance_revocations AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_saas_backup_provider_acceptance()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE latest_id uuid; evidence_total integer; evidence_pass integer; scenario_total integer;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'backup provider acceptance records are retained as governance evidence' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'PENDING' OR NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.valid_until IS NOT NULL THEN
      RAISE EXCEPTION 'backup provider acceptance must start pending independent review' USING ERRCODE='55000';
    END IF;
    PERFORM 1 FROM public.tenants t WHERE t.id=NEW.tenant_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'backup provider acceptance requires an existing tenant' USING ERRCODE='23503'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.acceptance_id,NEW.tenant_id,NEW.category_code,NEW.revision,NEW.provider_reference,
      NEW.provider_scope_reference,NEW.provider_scope_digest,NEW.configuration_reference,
      NEW.adapter_key,NEW.adapter_version,NEW.staging_evidence_reference,
      NEW.evidence_manifest_digest,NEW.scenario_count,NEW.idempotency_key,NEW.request_hash,
      NEW.submitted_by_user_id,NEW.submitted_at)
     IS DISTINCT FROM
     (OLD.acceptance_id,OLD.tenant_id,OLD.category_code,OLD.revision,OLD.provider_reference,
      OLD.provider_scope_reference,OLD.provider_scope_digest,OLD.configuration_reference,
      OLD.adapter_key,OLD.adapter_version,OLD.staging_evidence_reference,
      OLD.evidence_manifest_digest,OLD.scenario_count,OLD.idempotency_key,OLD.request_hash,
      OLD.submitted_by_user_id,OLD.submitted_at) THEN
    RAISE EXCEPTION 'backup provider acceptance identity and evidence manifest are immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status<>'PENDING' OR NEW.status NOT IN ('ACCEPTED','REJECTED')
      OR NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_by_user_id=OLD.submitted_by_user_id
      OR NEW.review_reason IS NULL OR length(btrim(NEW.review_reason)) NOT BETWEEN 3 AND 1000
      OR NEW.reviewed_at IS NULL THEN
    RAISE EXCEPTION 'only pending provider acceptances may receive an independent review' USING ERRCODE='55000';
  END IF;
  SELECT a.acceptance_id INTO latest_id
    FROM public.saas_tenant_backup_provider_acceptances a
    WHERE a.tenant_id=NEW.tenant_id AND a.category_code=NEW.category_code
      AND a.provider_scope_digest=NEW.provider_scope_digest
    ORDER BY a.revision DESC LIMIT 1 FOR UPDATE;
  IF latest_id IS DISTINCT FROM NEW.acceptance_id THEN
    RAISE EXCEPTION 'only the latest provider acceptance revision may be reviewed' USING ERRCODE='55000';
  END IF;
  SELECT count(*)::integer,count(*) FILTER (WHERE e.outcome='PASS')::integer,
         count(DISTINCT e.scenario_code)::integer
    INTO evidence_total,evidence_pass,scenario_total
    FROM public.saas_tenant_backup_provider_acceptance_evidence e
    WHERE e.tenant_id=NEW.tenant_id AND e.acceptance_id=NEW.acceptance_id;
  IF evidence_total<>10 OR scenario_total<>10 THEN
    RAISE EXCEPTION 'provider acceptance requires the complete ten-scenario evidence matrix' USING ERRCODE='55000';
  END IF;
  IF NEW.status='ACCEPTED' THEN
    IF evidence_pass<>10 OR NEW.valid_until IS NULL OR NEW.valid_until<=NEW.reviewed_at
       OR NEW.valid_until>NEW.reviewed_at+interval '90 days' THEN
      RAISE EXCEPTION 'provider acceptance needs ten passing scenarios and at most 90-day validity' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.valid_until IS NOT NULL THEN
    RAISE EXCEPTION 'rejected provider acceptance cannot have a validity window' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_backup_provider_acceptance_guard ON saas_tenant_backup_provider_acceptances;
CREATE TRIGGER saas_tenant_backup_provider_acceptance_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_backup_provider_acceptances
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_backup_provider_acceptance();

CREATE OR REPLACE FUNCTION factoryos_guard_saas_backup_provider_acceptance_evidence()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE parent_status text;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'provider acceptance evidence is immutable' USING ERRCODE='55000';
  END IF;
  SELECT a.status INTO parent_status FROM public.saas_tenant_backup_provider_acceptances a
    WHERE a.tenant_id=NEW.tenant_id AND a.acceptance_id=NEW.acceptance_id FOR UPDATE;
  IF NOT FOUND OR parent_status<>'PENDING' THEN
    RAISE EXCEPTION 'provider acceptance evidence can only be added while the parent is pending' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_backup_provider_acceptance_evidence_guard ON saas_tenant_backup_provider_acceptance_evidence;
CREATE TRIGGER saas_tenant_backup_provider_acceptance_evidence_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_backup_provider_acceptance_evidence
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_backup_provider_acceptance_evidence();

CREATE OR REPLACE FUNCTION factoryos_guard_saas_backup_provider_acceptance_revocation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE submitted_by uuid; reviewed_by uuid; parent_status text;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'provider acceptance revocations are append-only' USING ERRCODE='55000';
  END IF;
  SELECT a.submitted_by_user_id,a.reviewed_by_user_id,a.status
    INTO submitted_by,reviewed_by,parent_status
    FROM public.saas_tenant_backup_provider_acceptances a
    WHERE a.tenant_id=NEW.tenant_id AND a.acceptance_id=NEW.acceptance_id FOR UPDATE;
  IF NOT FOUND OR parent_status<>'ACCEPTED' OR NEW.revoked_by_user_id IN (submitted_by,reviewed_by) THEN
    RAISE EXCEPTION 'revocation requires a currently accepted record and a third-party reviewer' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_backup_provider_acceptance_revocation_guard ON saas_tenant_backup_provider_acceptance_revocations;
CREATE TRIGGER saas_tenant_backup_provider_acceptance_revocation_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_backup_provider_acceptance_revocations
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_backup_provider_acceptance_revocation();

INSERT INTO factoryos_governance.tenant_relation_inventory
  (schema_name,relation_name,scope_model,data_category,export_disposition,erasure_disposition,audit_requirement,rationale)
VALUES
  ('public','saas_tenant_backup_provider_acceptances','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Provider acceptance records bind ten independently evidenced staging scenarios and their immutable provider scope to an independent reviewer.'),
  ('public','saas_tenant_backup_provider_acceptance_evidence','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Immutable per-scenario evidence digests supporting provider acceptance.'),
  ('public','saas_tenant_backup_provider_acceptance_revocations','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Append-only revocations immediately invalidate backup provider acceptance.')
ON CONFLICT(schema_name,relation_name) DO UPDATE SET
  scope_model=EXCLUDED.scope_model,data_category=EXCLUDED.data_category,
  export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
  audit_requirement=EXCLUDED.audit_requirement,rationale=EXCLUDED.rationale,classified_at=clock_timestamp();

INSERT INTO factoryos_governance.tenant_relation_ownership_reviews
  (schema_name,relation_name,ownership_class,evidence_type,evidence_detail,scope_predicate,
   export_disposition,erasure_disposition,review_status)
VALUES
  ('public','saas_tenant_backup_provider_acceptances','DIRECT_TENANT','DIRECT_TENANT_COLUMN_AND_RLS',
   'Provider acceptance records are tenant scoped, revisioned, immutable after independent review and scoped to a non-secret provider identity reference.',
   'tenant_id = public.factoryos_current_tenant_id()','EXCLUDED','PROTECTED','VERIFIED'),
  ('public','saas_tenant_backup_provider_acceptance_evidence','DIRECT_TENANT','DIRECT_TENANT_COLUMN_AND_RLS',
   'Each provider test scenario evidence record is immutable and tenant-scoped.',
   'tenant_id = public.factoryos_current_tenant_id()','EXCLUDED','PROTECTED','VERIFIED'),
  ('public','saas_tenant_backup_provider_acceptance_revocations','DIRECT_TENANT','DIRECT_TENANT_COLUMN_AND_RLS',
   'Revocation facts are append-only and tenant-scoped.',
   'tenant_id = public.factoryos_current_tenant_id()','EXCLUDED','PROTECTED','VERIFIED')
ON CONFLICT (schema_name,relation_name) DO UPDATE SET
  ownership_class=EXCLUDED.ownership_class,evidence_type=EXCLUDED.evidence_type,
  evidence_detail=EXCLUDED.evidence_detail,scope_predicate=EXCLUDED.scope_predicate,
  export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
  review_status=EXCLUDED.review_status,reviewed_at=clock_timestamp();

INSERT INTO schema_migrations(version,checksum)
VALUES ('224_saas_backup_provider_acceptance_registry',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;

    AND adapter_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
    AND adapter_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'
    AND provider_reference !~ '://' AND provider_scope_reference !~ '://'
    AND configuration_reference !~ '://' AND staging_evidence_reference !~ '://'
    AND (provider_reference || provider_scope_reference || configuration_reference || staging_evidence_reference)
      !~* '(secret|password|credential|access[-_]?key|token)'
  ),
  CONSTRAINT chk_saas_backup_provider_acceptance_digests CHECK (
    provider_scope_digest ~ '^[a-f0-9]{64}$'
    AND evidence_manifest_digest ~ '^[a-f0-9]{64}$'
    AND request_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT chk_saas_backup_provider_acceptance_scenarios CHECK (scenario_count=10),
  CONSTRAINT chk_saas_backup_provider_acceptance_status CHECK (status IN ('PENDING','ACCEPTED','REJECTED')),
  CONSTRAINT chk_saas_backup_provider_acceptance_review CHECK (
    (status='PENDING' AND reviewed_by_user_id IS NULL AND review_reason IS NULL
      AND reviewed_at IS NULL AND valid_until IS NULL)
    OR (status='REJECTED' AND reviewed_by_user_id IS NOT NULL
      AND reviewed_by_user_id<>submitted_by_user_id
      AND review_reason IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND reviewed_at IS NOT NULL AND valid_until IS NULL)
    OR (status='ACCEPTED' AND reviewed_by_user_id IS NOT NULL
      AND reviewed_by_user_id<>submitted_by_user_id
      AND review_reason IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND reviewed_at IS NOT NULL AND valid_until>reviewed_at
      AND valid_until<=reviewed_at+interval '90 days')
  )
);
CREATE INDEX IF NOT EXISTS idx_saas_backup_provider_acceptance_current
  ON saas_tenant_backup_provider_acceptances
  (tenant_id,category_code,provider_scope_digest,revision DESC);

CREATE TABLE IF NOT EXISTS saas_tenant_backup_provider_acceptance_evidence (
  tenant_id uuid NOT NULL,
  acceptance_id uuid NOT NULL,
  scenario_code varchar(48) NOT NULL,
  outcome varchar(12) NOT NULL,
  evidence_reference varchar(200) NOT NULL,
  evidence_sha256 varchar(64) NOT NULL,
  executed_at timestamptz NOT NULL,
  runner_reference varchar(200) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,acceptance_id,scenario_code),
  CONSTRAINT fk_saas_backup_provider_acceptance_evidence_parent
    FOREIGN KEY (tenant_id,acceptance_id)
    REFERENCES saas_tenant_backup_provider_acceptances(tenant_id,acceptance_id) ON DELETE RESTRICT,
  CONSTRAINT chk_saas_backup_provider_acceptance_scenario CHECK (scenario_code IN (
    'POLICY_DENY_READBACK',
    'COPY_OBJECT_DURING_FENCE',
    'MULTIPART_COMPLETION_DURING_FENCE',
    'REPLICATION_DELETE_MARKER',
    'POLICY_DRIFT_DETECTED',
    'CRASH_RECOVERY_DENY_PRESERVED',
    'DELAYED_WRITER_REJECTED',
    'TOMBSTONE_REPLAY_BEFORE_RELEASE',
    'INDEPENDENT_RESIDUAL_LISTING',
    'RESTORE_AFTER_TOMBSTONE_REPLAY'
  )),
  CONSTRAINT chk_saas_backup_provider_acceptance_outcome CHECK (outcome IN ('PASS','FAIL','NOT_RUN')),
  CONSTRAINT chk_saas_backup_provider_acceptance_evidence_reference CHECK (
    evidence_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND runner_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND evidence_reference !~ '://' AND runner_reference !~ '://'
    AND (evidence_reference || runner_reference) !~* '(secret|password|credential|access[-_]?key|token)'
  ),
  CONSTRAINT chk_saas_backup_provider_acceptance_evidence_digest CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_saas_backup_provider_acceptance_evidence_time CHECK (executed_at<=clock_timestamp())
);
CREATE INDEX IF NOT EXISTS idx_saas_backup_provider_acceptance_evidence_parent
  ON saas_tenant_backup_provider_acceptance_evidence(tenant_id,acceptance_id,scenario_code);

CREATE TABLE IF NOT EXISTS saas_tenant_backup_provider_acceptance_revocations (
  revocation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  acceptance_id uuid NOT NULL,
  revoked_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason varchar(1000) NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_saas_backup_provider_acceptance_revocation UNIQUE (tenant_id,acceptance_id),
  CONSTRAINT fk_saas_backup_provider_acceptance_revocation_parent
    FOREIGN KEY (tenant_id,acceptance_id)
    REFERENCES saas_tenant_backup_provider_acceptances(tenant_id,acceptance_id) ON DELETE RESTRICT,
  CONSTRAINT chk_saas_backup_provider_acceptance_revocation_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 1000)
);

ALTER TABLE saas_tenant_backup_provider_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_backup_provider_acceptances FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptances_tenant_allow ON saas_tenant_backup_provider_acceptances;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptances_tenant_enforce ON saas_tenant_backup_provider_acceptances;
CREATE POLICY saas_tenant_backup_provider_acceptances_tenant_allow ON saas_tenant_backup_provider_acceptances AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_backup_provider_acceptances_tenant_enforce ON saas_tenant_backup_provider_acceptances AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

ALTER TABLE saas_tenant_backup_provider_acceptance_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_backup_provider_acceptance_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptance_evidence_tenant_allow ON saas_tenant_backup_provider_acceptance_evidence;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptance_evidence_tenant_enforce ON saas_tenant_backup_provider_acceptance_evidence;
CREATE POLICY saas_tenant_backup_provider_acceptance_evidence_tenant_allow ON saas_tenant_backup_provider_acceptance_evidence AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_backup_provider_acceptance_evidence_tenant_enforce ON saas_tenant_backup_provider_acceptance_evidence AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

ALTER TABLE saas_tenant_backup_provider_acceptance_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_backup_provider_acceptance_revocations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptance_revocations_tenant_allow ON saas_tenant_backup_provider_acceptance_revocations;
DROP POLICY IF EXISTS saas_tenant_backup_provider_acceptance_revocations_tenant_enforce ON saas_tenant_backup_provider_acceptance_revocations;
CREATE POLICY saas_tenant_backup_provider_acceptance_revocations_tenant_allow ON saas_tenant_backup_provider_acceptance_revocations AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_backup_provider_acceptance_revocations_tenant_enforce ON saas_tenant_backup_provider_acceptance_revocations AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_saas_backup_provider_acceptance()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE latest_id uuid; evidence_total integer; evidence_pass integer; scenario_total integer;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'backup provider acceptance records are retained as governance evidence' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'PENDING' OR NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.valid_until IS NOT NULL THEN
      RAISE EXCEPTION 'backup provider acceptance must start pending independent review' USING ERRCODE='55000';
    END IF;
    PERFORM 1 FROM public.tenants t WHERE t.id=NEW.tenant_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'backup provider acceptance requires an existing tenant' USING ERRCODE='23503'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.acceptance_id,NEW.tenant_id,NEW.category_code,NEW.revision,NEW.provider_reference,
      NEW.provider_scope_reference,NEW.provider_scope_digest,NEW.configuration_reference,
      NEW.adapter_key,NEW.adapter_version,NEW.staging_evidence_reference,
      NEW.evidence_manifest_digest,NEW.scenario_count,NEW.idempotency_key,NEW.request_hash,
      NEW.submitted_by_user_id,NEW.submitted_at)
     IS DISTINCT FROM
     (OLD.acceptance_id,OLD.tenant_id,OLD.category_code,OLD.revision,OLD.provider_reference,
      OLD.provider_scope_reference,OLD.provider_scope_digest,OLD.configuration_reference,
      OLD.adapter_key,OLD.adapter_version,OLD.staging_evidence_reference,
      OLD.evidence_manifest_digest,OLD.scenario_count,OLD.idempotency_key,OLD.request_hash,
      OLD.submitted_by_user_id,OLD.submitted_at) THEN
    RAISE EXCEPTION 'backup provider acceptance identity and evidence manifest are immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status<>'PENDING' OR NEW.status NOT IN ('ACCEPTED','REJECTED')
      OR NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_by_user_id=OLD.submitted_by_user_id
      OR NEW.review_reason IS NULL OR length(btrim(NEW.review_reason)) NOT BETWEEN 3 AND 1000
      OR NEW.reviewed_at IS NULL THEN
    RAISE EXCEPTION 'only pending provider acceptances may receive an independent review' USING ERRCODE='55000';
  END IF;
  SELECT a.acceptance_id INTO latest_id
    FROM public.saas_tenant_backup_provider_acceptances a
    WHERE a.tenant_id=NEW.tenant_id AND a.category_code=NEW.category_code
      AND a.provider_scope_digest=NEW.provider_scope_digest
    ORDER BY a.revision DESC LIMIT 1 FOR UPDATE;
  IF latest_id IS DISTINCT FROM NEW.acceptance_id THEN
    RAISE EXCEPTION 'only the latest provider acceptance revision may be reviewed' USING ERRCODE='55000';
  END IF;
  SELECT count(*)::integer,count(*) FILTER (WHERE e.outcome='PASS')::integer,
         count(DISTINCT e.scenario_code)::integer
    INTO evidence_total,evidence_pass,scenario_total
    FROM public.saas_tenant_backup_provider_acceptance_evidence e
    WHERE e.tenant_id=NEW.tenant_id AND e.acceptance_id=NEW.acceptance_id;
  IF evidence_total<>10 OR scenario_total<>10 THEN
    RAISE EXCEPTION 'provider acceptance requires the complete ten-scenario evidence matrix' USING ERRCODE='55000';
  END IF;
  IF NEW.status='ACCEPTED' THEN
    IF evidence_pass<>10 OR NEW.valid_until IS NULL OR NEW.valid_until<=NEW.reviewed_at
       OR NEW.valid_until>NEW.reviewed_at+interval '90 days' THEN
      RAISE EXCEPTION 'provider acceptance needs ten passing scenarios and at most 90-day validity' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.valid_until IS NOT NULL THEN
    RAISE EXCEPTION 'rejected provider acceptance cannot have a validity window' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_backup_provider_acceptance_guard ON saas_tenant_backup_provider_acceptances;
CREATE TRIGGER saas_tenant_backup_provider_acceptance_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_backup_provider_acceptances
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_backup_provider_acceptance();

CREATE OR REPLACE FUNCTION factoryos_guard_saas_backup_provider_acceptance_evidence()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE parent_status text;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'provider acceptance evidence is immutable' USING ERRCODE='55000';
  END IF;
  SELECT a.status INTO parent_status FROM public.saas_tenant_backup_provider_acceptances a
    WHERE a.tenant_id=NEW.tenant_id AND a.acceptance_id=NEW.acceptance_id FOR UPDATE;
  IF NOT FOUND OR parent_status<>'PENDING' THEN
    RAISE EXCEPTION 'provider acceptance evidence can only be added while the parent is pending' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_backup_provider_acceptance_evidence_guard ON saas_tenant_backup_provider_acceptance_evidence;
CREATE TRIGGER saas_tenant_backup_provider_acceptance_evidence_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_backup_provider_acceptance_evidence
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_backup_provider_acceptance_evidence();

CREATE OR REPLACE FUNCTION factoryos_guard_saas_backup_provider_acceptance_revocation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE submitted_by uuid; reviewed_by uuid; parent_status text;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'provider acceptance revocations are append-only' USING ERRCODE='55000';
  END IF;
  SELECT a.submitted_by_user_id,a.reviewed_by_user_id,a.status
    INTO submitted_by,reviewed_by,parent_status
    FROM public.saas_tenant_backup_provider_acceptances a
    WHERE a.tenant_id=NEW.tenant_id AND a.acceptance_id=NEW.acceptance_id FOR UPDATE;
  IF NOT FOUND OR parent_status<>'ACCEPTED' OR NEW.revoked_by_user_id IN (submitted_by,reviewed_by) THEN
    RAISE EXCEPTION 'revocation requires a currently accepted record and a third-party reviewer' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_backup_provider_acceptance_revocation_guard ON saas_tenant_backup_provider_acceptance_revocations;
CREATE TRIGGER saas_tenant_backup_provider_acceptance_revocation_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_backup_provider_acceptance_revocations
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_backup_provider_acceptance_revocation();

INSERT INTO factoryos_governance.tenant_relation_inventory
  (schema_name,relation_name,scope_model,data_category,export_disposition,erasure_disposition,audit_requirement,rationale)
VALUES
  ('public','saas_tenant_backup_provider_acceptances','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Provider acceptance records bind ten independently evidenced staging scenarios and their immutable provider scope to an independent reviewer.'),
  ('public','saas_tenant_backup_provider_acceptance_evidence','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Immutable per-scenario evidence digests supporting provider acceptance.'),
  ('public','saas_tenant_backup_provider_acceptance_revocations','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Append-only revocations immediately invalidate backup provider acceptance.')
ON CONFLICT(schema_name,relation_name) DO UPDATE SET
  scope_model=EXCLUDED.scope_model,data_category=EXCLUDED.data_category,
  export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
  audit_requirement=EXCLUDED.audit_requirement,rationale=EXCLUDED.rationale,classified_at=clock_timestamp();

INSERT INTO factoryos_governance.tenant_relation_ownership_reviews
  (schema_name,relation_name,ownership_class,evidence_type,evidence_detail,scope_predicate,
   export_disposition,erasure_disposition,review_status)
VALUES
  ('public','saas_tenant_backup_provider_acceptances','DIRECT_TENANT','DIRECT_TENANT_COLUMN_AND_RLS',
   'Provider acceptance records are tenant scoped, revisioned, immutable after independent review and scoped to a non-secret provider identity reference.',
   'tenant_id = public.factoryos_current_tenant_id()','EXCLUDED','PROTECTED','VERIFIED'),
  ('public','saas_tenant_backup_provider_acceptance_evidence','DIRECT_TENANT','DIRECT_TENANT_COLUMN_AND_RLS',
   'Each provider test scenario evidence record is immutable and tenant-scoped.',
   'tenant_id = public.factoryos_current_tenant_id()','EXCLUDED','PROTECTED','VERIFIED'),
  ('public','saas_tenant_backup_provider_acceptance_revocations','DIRECT_TENANT','DIRECT_TENANT_COLUMN_AND_RLS',
   'Revocation facts are append-only and tenant-scoped.',
   'tenant_id = public.factoryos_current_tenant_id()','EXCLUDED','PROTECTED','VERIFIED')
ON CONFLICT (schema_name,relation_name) DO UPDATE SET
  ownership_class=EXCLUDED.ownership_class,evidence_type=EXCLUDED.evidence_type,
  evidence_detail=EXCLUDED.evidence_detail,scope_predicate=EXCLUDED.scope_predicate,
  export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
  review_status=EXCLUDED.review_status,reviewed_at=clock_timestamp();

INSERT INTO schema_migrations(version,checksum)
VALUES ('224_saas_backup_provider_acceptance_registry',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
