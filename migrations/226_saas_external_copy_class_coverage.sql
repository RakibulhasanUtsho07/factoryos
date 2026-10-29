BEGIN;
CREATE TABLE IF NOT EXISTS public.saas_tenant_external_copy_coverage_decisions (
  decision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  category_code varchar(64) NOT NULL, store_kind varchar(32) NOT NULL, revision bigint NOT NULL,
  disposition varchar(20) NOT NULL, evidence_reference varchar(200) NOT NULL,
  evidence_sha256 varchar(64) NOT NULL, evidence_at timestamptz NOT NULL,
  data_owner_reference varchar(200) NOT NULL, infrastructure_owner_reference varchar(200) NOT NULL,
  policy_reference varchar(200) NOT NULL, reason varchar(1000) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'PENDING', idempotency_key varchar(100) NOT NULL,
  request_hash varchar(64) NOT NULL, submitted_by_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  reviewed_by_user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT, review_reason varchar(1000),
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(), reviewed_at timestamptz, valid_until timestamptz,
  CONSTRAINT uq_saas_external_copy_coverage_tenant_decision UNIQUE (tenant_id,decision_id),
  CONSTRAINT uq_saas_external_copy_coverage_revision UNIQUE (tenant_id,category_code,store_kind,revision),
  CONSTRAINT uq_saas_external_copy_coverage_idempotency UNIQUE (tenant_id,category_code,store_kind,idempotency_key),
  CONSTRAINT chk_saas_external_copy_coverage_category CHECK (category_code IN (
    'BUSINESS_DATA','AUDIT_LOG','EVIDENCE','APPROVALS','EFFECTIVE_DATED_MASTER_DATA','AI_CONTEXT',
    'LEARNING_EVALUATION','INTEGRATION_METADATA','FILE_REFERENCES','IAM_ACCESS')),
  CONSTRAINT chk_saas_external_copy_coverage_store_kind CHECK (store_kind IN (
    'OBJECT_STORAGE','CACHE','SEARCH_INDEX','VECTOR_STORE','LEARNING_ARTIFACT','EXTERNAL_PROVIDER','REPLICA','BACKUP')),
  CONSTRAINT chk_saas_external_copy_coverage_disposition CHECK (disposition IN ('SUPPORTED','NOT_APPLICABLE','UNRESOLVED')),
  CONSTRAINT chk_saas_external_copy_coverage_revision CHECK (revision BETWEEN 1 AND 9007199254740991),
  CONSTRAINT chk_saas_external_copy_coverage_digest CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$' AND request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_saas_external_copy_coverage_references CHECK (
    evidence_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND data_owner_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND infrastructure_owner_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND policy_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND evidence_reference !~ '://' AND data_owner_reference !~ '://'
    AND infrastructure_owner_reference !~ '://' AND policy_reference !~ '://'
    AND (evidence_reference || data_owner_reference || infrastructure_owner_reference || policy_reference)
      !~* '(secret|password|credential|access[-_]?key|token)'),
  CONSTRAINT chk_saas_external_copy_coverage_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  CONSTRAINT chk_saas_external_copy_coverage_status CHECK (status IN ('PENDING','ACCEPTED','REJECTED')),
  CONSTRAINT chk_saas_external_copy_coverage_review CHECK (
    (status='PENDING' AND reviewed_by_user_id IS NULL AND review_reason IS NULL AND reviewed_at IS NULL AND valid_until IS NULL)
    OR (status='REJECTED' AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>submitted_by_user_id
      AND review_reason IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000 AND reviewed_at IS NOT NULL AND valid_until IS NULL)
    OR (status='ACCEPTED' AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>submitted_by_user_id
      AND review_reason IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000 AND reviewed_at IS NOT NULL
      AND valid_until>reviewed_at AND valid_until<=reviewed_at+interval '90 days'))
);
CREATE INDEX IF NOT EXISTS idx_saas_external_copy_coverage_latest
 ON public.saas_tenant_external_copy_coverage_decisions (tenant_id,category_code,store_kind,revision DESC);
ALTER TABLE public.saas_tenant_external_copy_coverage_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saas_tenant_external_copy_coverage_decisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_external_copy_coverage_decisions_tenant_allow ON public.saas_tenant_external_copy_coverage_decisions;
DROP POLICY IF EXISTS saas_tenant_external_copy_coverage_decisions_tenant_enforce ON public.saas_tenant_external_copy_coverage_decisions;
CREATE POLICY saas_tenant_external_copy_coverage_decisions_tenant_allow ON public.saas_tenant_external_copy_coverage_decisions AS PERMISSIVE FOR ALL
 USING (tenant_id=public.factoryos_current_tenant_id()) WITH CHECK (tenant_id=public.factoryos_current_tenant_id());
CREATE POLICY saas_tenant_external_copy_coverage_decisions_tenant_enforce ON public.saas_tenant_external_copy_coverage_decisions AS RESTRICTIVE FOR ALL
 USING (tenant_id=public.factoryos_current_tenant_id()) WITH CHECK (tenant_id=public.factoryos_current_tenant_id());

-- The application can submit and review rows but cannot delete governance evidence.
-- Runtime role creation happens after the ordered migration replay in CI/deployment.
-- The deployment's table privilege policy grants access after the role exists; do not assume the role exists here.

CREATE OR REPLACE FUNCTION public.factoryos_guard_saas_external_copy_coverage_decision()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'external copy-class coverage decisions are immutable and cannot be deleted' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'PENDING' OR NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL
      OR NEW.review_reason IS NOT NULL OR NEW.valid_until IS NOT NULL THEN
      RAISE EXCEPTION 'external copy-class coverage must enter the pending review state' USING ERRCODE='55000';
    END IF;
    IF NEW.evidence_at>NEW.submitted_at+interval '5 minutes' OR NEW.evidence_at<NEW.submitted_at-interval '30 days' THEN
      RAISE EXCEPTION 'external copy-class evidence must be current at submission' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status<>'PENDING' OR NEW.status NOT IN ('ACCEPTED','REJECTED') THEN
    RAISE EXCEPTION 'reviewed external copy-class coverage decisions are immutable' USING ERRCODE='55000';
  END IF;
  IF (NEW.decision_id,NEW.tenant_id,NEW.category_code,NEW.store_kind,NEW.revision,NEW.disposition,NEW.evidence_reference,
      NEW.evidence_sha256,NEW.evidence_at,NEW.data_owner_reference,NEW.infrastructure_owner_reference,NEW.policy_reference,
      NEW.reason,NEW.idempotency_key,NEW.request_hash,NEW.submitted_by_user_id,NEW.submitted_at)
    IS DISTINCT FROM
     (OLD.decision_id,OLD.tenant_id,OLD.category_code,OLD.store_kind,OLD.revision,OLD.disposition,OLD.evidence_reference,
      OLD.evidence_sha256,OLD.evidence_at,OLD.data_owner_reference,OLD.infrastructure_owner_reference,OLD.policy_reference,
      OLD.reason,OLD.idempotency_key,OLD.request_hash,OLD.submitted_by_user_id,OLD.submitted_at) THEN
    RAISE EXCEPTION 'external copy-class evidence and scope are immutable after submission' USING ERRCODE='55000';
  END IF;
  IF NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_by_user_id=NEW.submitted_by_user_id OR NEW.reviewed_at IS NULL
    OR NEW.review_reason IS NULL OR length(btrim(NEW.review_reason)) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION 'external copy-class coverage requires a separate reviewer and reason' USING ERRCODE='55000';
  END IF;
  IF NEW.evidence_at>NEW.reviewed_at+interval '5 minutes' OR NEW.evidence_at<NEW.reviewed_at-interval '30 days' THEN
    RAISE EXCEPTION 'external copy-class evidence expired before approval' USING ERRCODE='55000';
  END IF;
  IF NEW.status='ACCEPTED' THEN
    IF NEW.valid_until IS NULL OR NEW.valid_until<=NEW.reviewed_at OR NEW.valid_until>NEW.reviewed_at+interval '90 days' THEN
      RAISE EXCEPTION 'accepted external copy-class coverage must have a validity window no longer than 90 days' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.valid_until IS NOT NULL THEN
    RAISE EXCEPTION 'rejected external copy-class coverage cannot have a validity window' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_external_copy_coverage_decision_guard ON public.saas_tenant_external_copy_coverage_decisions;
CREATE TRIGGER saas_tenant_external_copy_coverage_decision_guard
 BEFORE INSERT OR UPDATE OR DELETE ON public.saas_tenant_external_copy_coverage_decisions
 FOR EACH ROW EXECUTE FUNCTION public.factoryos_guard_saas_external_copy_coverage_decision();

INSERT INTO factoryos_governance.tenant_relation_inventory
 (schema_name,relation_name,scope_model,data_category,export_disposition,erasure_disposition,audit_requirement,rationale)
VALUES ('public','saas_tenant_external_copy_coverage_decisions','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT',
 'Revisioned evidence-backed copy-class coverage decisions; unresolved, expired or unreviewed coverage blocks whole-tenant erasure.')
ON CONFLICT(schema_name,relation_name) DO UPDATE SET scope_model=EXCLUDED.scope_model,data_category=EXCLUDED.data_category,
 export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
 audit_requirement=EXCLUDED.audit_requirement,rationale=EXCLUDED.rationale,classified_at=clock_timestamp();

INSERT INTO factoryos_governance.tenant_relation_ownership_reviews
 (schema_name,relation_name,ownership_class,evidence_type,evidence_detail,scope_predicate,export_disposition,erasure_disposition,review_status)
VALUES ('public','saas_tenant_external_copy_coverage_decisions','DIRECT_TENANT','DIRECT_TENANT_COLUMN_AND_RLS',
 'Copy-class applicability evidence is tenant-scoped, revisioned and immutable after independent review.',
 'tenant_id = public.factoryos_current_tenant_id()','EXCLUDED','PROTECTED','VERIFIED')
ON CONFLICT(schema_name,relation_name) DO UPDATE SET ownership_class=EXCLUDED.ownership_class,evidence_type=EXCLUDED.evidence_type,
 evidence_detail=EXCLUDED.evidence_detail,scope_predicate=EXCLUDED.scope_predicate,export_disposition=EXCLUDED.export_disposition,
 erasure_disposition=EXCLUDED.erasure_disposition,review_status=EXCLUDED.review_status,reviewed_at=clock_timestamp();
INSERT INTO schema_migrations(version,checksum) VALUES ('226_saas_external_copy_class_coverage',NULL) ON CONFLICT (version) DO NOTHING;
COMMIT;
