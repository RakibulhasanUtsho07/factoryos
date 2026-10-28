BEGIN;

-- Slice C: durable, immutable exact-resource inventories and per-object execution
-- events. A provider target-level receipt is not enough to recover an uncertain
-- deletion after a process crash; this ledger binds each resource to one sealed
-- manifest and records intent before a destructive provider call.
CREATE TABLE IF NOT EXISTS saas_tenant_external_propagation_manifests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  run_id uuid NOT NULL,
  request_version bigint NOT NULL,
  target_id varchar(100) NOT NULL,
  store_kind varchar(32) NOT NULL,
  adapter_key varchar(100) NOT NULL,
  adapter_version varchar(100) NOT NULL,
  resource_class varchar(32) NOT NULL,
  max_page_size integer NOT NULL,
  max_batch_size integer NOT NULL,
  source_export_digest varchar(64) NOT NULL,
  manifest_digest varchar(64) NOT NULL,
  resource_count bigint NOT NULL,
  policy_versions jsonb NOT NULL,
  state varchar(12) NOT NULL DEFAULT 'STAGING',
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sealed_at timestamptz,
  CONSTRAINT uq_saas_external_manifest_tenant_id UNIQUE (tenant_id,id),
  CONSTRAINT uq_saas_external_manifest_scope UNIQUE
    (tenant_id,request_id,run_id,target_id,manifest_digest),
  CONSTRAINT fk_saas_external_manifest_run FOREIGN KEY
    (tenant_id,request_id,request_version,run_id)
    REFERENCES saas_tenant_external_propagation_runs
      (tenant_id,request_id,request_version,run_id) ON DELETE RESTRICT,
  CONSTRAINT fk_saas_external_manifest_target FOREIGN KEY (tenant_id,target_id)
    REFERENCES saas_tenant_external_data_targets (tenant_id,target_id) ON DELETE RESTRICT,
  CONSTRAINT chk_saas_external_manifest_kind CHECK (store_kind IN (
    'OBJECT_STORAGE','CACHE','SEARCH_INDEX','VECTOR_STORE','LEARNING_ARTIFACT',
    'EXTERNAL_PROVIDER','REPLICA','BACKUP'
  )),
  CONSTRAINT chk_saas_external_manifest_adapter CHECK (
    adapter_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
    AND adapter_version ~ '^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.-]+)?$'
    AND resource_class ~ '^[A-Za-z][A-Za-z0-9._:-]{0,31}$'
  ),
  CONSTRAINT chk_saas_external_manifest_limits CHECK (
    max_page_size BETWEEN 1 AND 5000 AND max_batch_size BETWEEN 1 AND 1000
  ),
  CONSTRAINT chk_saas_external_manifest_digests CHECK (
    source_export_digest ~ '^[a-f0-9]{64}$' AND manifest_digest ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT chk_saas_external_manifest_count CHECK (resource_count BETWEEN 0 AND 1000000),
  CONSTRAINT chk_saas_external_manifest_policies CHECK (
    jsonb_typeof(policy_versions)='object' AND octet_length(policy_versions::text)<=16384
  ),
  CONSTRAINT chk_saas_external_manifest_state CHECK (
    (state='STAGING' AND sealed_at IS NULL)
    OR (state='SEALED' AND sealed_at IS NOT NULL)
    OR (state='ABORTED' AND sealed_at IS NULL)
  ),
  CONSTRAINT chk_saas_external_manifest_request_version CHECK (request_version BETWEEN 1 AND 9007199254740991)
);

CREATE INDEX IF NOT EXISTS idx_saas_external_manifest_request
  ON saas_tenant_external_propagation_manifests(tenant_id,request_id,run_id,target_id,created_at DESC);

ALTER TABLE saas_tenant_external_propagation_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_external_propagation_manifests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_external_propagation_manifests_tenant_allow
  ON saas_tenant_external_propagation_manifests;
DROP POLICY IF EXISTS saas_tenant_external_propagation_manifests_tenant_enforce
  ON saas_tenant_external_propagation_manifests;
CREATE POLICY saas_tenant_external_propagation_manifests_tenant_allow
  ON saas_tenant_external_propagation_manifests AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_external_propagation_manifests_tenant_enforce
  ON saas_tenant_external_propagation_manifests AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_saas_external_propagation_manifest()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  run_row public.saas_tenant_external_propagation_runs%ROWTYPE;
  target_row public.saas_tenant_external_data_targets%ROWTYPE;
  actual_count bigint;
  first_ordinal integer;
  last_ordinal integer;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'external resource manifests are retained as erasure evidence' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'STAGING' OR NEW.sealed_at IS NOT NULL THEN
      RAISE EXCEPTION 'external resource manifests must be created in STAGING state' USING ERRCODE='55000';
    END IF;
    SELECT * INTO run_row FROM public.saas_tenant_external_propagation_runs r
    WHERE r.tenant_id=NEW.tenant_id AND r.request_id=NEW.request_id
      AND r.request_version=NEW.request_version AND r.run_id=NEW.run_id
    FOR KEY SHARE;
    IF NOT FOUND OR run_row.source_export_digest<>NEW.source_export_digest
      OR run_row.status<>'RUNNING' THEN
      RAISE EXCEPTION 'resource manifest must bind to the exact RUNNING erasure source export' USING ERRCODE='55000';
    END IF;
    SELECT * INTO target_row FROM public.saas_tenant_external_data_targets t
    WHERE t.tenant_id=NEW.tenant_id AND t.target_id=NEW.target_id
    FOR KEY SHARE;
    IF NOT FOUND OR target_row.status<>'ACTIVE' OR NOT target_row.required
      OR target_row.store_kind<>NEW.store_kind OR target_row.adapter_key<>NEW.adapter_key THEN
      RAISE EXCEPTION 'resource manifest must bind to the exact active, reviewed required target' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.tenant_id,NEW.request_id,NEW.run_id,NEW.request_version,NEW.target_id,NEW.store_kind,
      NEW.adapter_key,NEW.adapter_version,NEW.resource_class,NEW.max_page_size,NEW.max_batch_size,
      NEW.source_export_digest,NEW.manifest_digest,NEW.resource_count,NEW.policy_versions,
      NEW.created_by_user_id,NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id,OLD.request_id,OLD.run_id,OLD.request_version,OLD.target_id,OLD.store_kind,
      OLD.adapter_key,OLD.adapter_version,OLD.resource_class,OLD.max_page_size,OLD.max_batch_size,
      OLD.source_export_digest,OLD.manifest_digest,OLD.resource_count,OLD.policy_versions,
      OLD.created_by_user_id,OLD.created_at) THEN
    RAISE EXCEPTION 'external resource manifest identity is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.state<>'STAGING' OR NEW.state NOT IN ('SEALED','ABORTED') THEN
    RAISE EXCEPTION 'sealed/aborted external resource manifests cannot be changed' USING ERRCODE='55000';
  END IF;
  IF NEW.state='ABORTED' THEN
    IF NEW.sealed_at IS NOT NULL THEN
      RAISE EXCEPTION 'aborted resource manifests must not have a seal timestamp' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;

  SELECT count(*),min(resource_ordinal),max(resource_ordinal)
    INTO actual_count,first_ordinal,last_ordinal
  FROM public.saas_tenant_external_propagation_manifest_items i
  WHERE i.tenant_id=NEW.tenant_id AND i.manifest_id=NEW.id;
  IF actual_count<>NEW.resource_count
     OR (actual_count>0 AND (first_ordinal<>1 OR last_ordinal<>NEW.resource_count)) THEN
    RAISE EXCEPTION 'resource manifest cannot be sealed until every expected ordinal is durably recorded' USING ERRCODE='55000';
  END IF;
  NEW.sealed_at:=clock_timestamp();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_external_propagation_manifest_guard
  ON saas_tenant_external_propagation_manifests;
CREATE TRIGGER saas_tenant_external_propagation_manifest_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_external_propagation_manifests
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_external_propagation_manifest();

CREATE TABLE IF NOT EXISTS saas_tenant_external_propagation_manifest_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  manifest_id uuid NOT NULL,
  resource_ordinal integer NOT NULL,
  resource_kind varchar(32) NOT NULL,
  resource_identity_digest varchar(64) NOT NULL,
  resource_reference varchar(500) NOT NULL,
  resource_version_reference varchar(200),
  resource_content_digest varchar(64),
  operation_key varchar(160) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_saas_external_manifest_item_tenant_id UNIQUE (tenant_id,manifest_id,id),
  CONSTRAINT uq_saas_external_manifest_item_ordinal UNIQUE (tenant_id,manifest_id,resource_ordinal),
  CONSTRAINT uq_saas_external_manifest_item_identity UNIQUE (tenant_id,manifest_id,resource_identity_digest),
  CONSTRAINT uq_saas_external_manifest_item_reference UNIQUE NULLS NOT DISTINCT
    (tenant_id,manifest_id,resource_reference,resource_version_reference),
  CONSTRAINT uq_saas_external_manifest_item_operation_key UNIQUE (tenant_id,operation_key),
  CONSTRAINT fk_saas_external_manifest_item_manifest FOREIGN KEY (tenant_id,manifest_id)
    REFERENCES saas_tenant_external_propagation_manifests(tenant_id,id) ON DELETE RESTRICT,
  CONSTRAINT chk_saas_external_manifest_item_ordinal CHECK (resource_ordinal BETWEEN 1 AND 1000000),
  CONSTRAINT chk_saas_external_manifest_item_kind CHECK
    (resource_kind ~ '^[A-Za-z][A-Za-z0-9._:-]{0,31}$'),
  CONSTRAINT chk_saas_external_manifest_item_digest CHECK (resource_identity_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_saas_external_manifest_item_reference CHECK (
    resource_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,499}$'
    AND resource_reference !~* '://' AND resource_reference !~* '(secret|password|credential|access[-_]?key|token)'
    AND (resource_version_reference IS NULL OR (
      resource_version_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
      AND resource_version_reference !~* '://' AND resource_version_reference !~* '(secret|password|credential|access[-_]?key|token)'
    ))
  ),
  CONSTRAINT chk_saas_external_manifest_item_operation_key CHECK (
    operation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
    AND operation_key !~* '(secret|password|credential|access[-_]?key|token)'
  )
);
-- The ledger may be replayed by PostgreSQL CI or restored from an earlier draft
-- schema; keep the content-digest column/constraint additive and rerunnable.
ALTER TABLE saas_tenant_external_propagation_manifest_items
  ADD COLUMN IF NOT EXISTS resource_content_digest varchar(64);
ALTER TABLE saas_tenant_external_propagation_manifest_items
  DROP CONSTRAINT IF EXISTS chk_saas_external_manifest_item_content_digest;
ALTER TABLE saas_tenant_external_propagation_manifest_items
  ADD CONSTRAINT chk_saas_external_manifest_item_content_digest CHECK (
    resource_content_digest IS NULL OR resource_content_digest ~ '^[a-f0-9]{64}$'
  );
CREATE INDEX IF NOT EXISTS idx_saas_external_manifest_item_lookup
  ON saas_tenant_external_propagation_manifest_items(tenant_id,manifest_id,resource_ordinal);

ALTER TABLE saas_tenant_external_propagation_manifest_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_external_propagation_manifest_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_external_propagation_manifest_items_tenant_allow
  ON saas_tenant_external_propagation_manifest_items;
DROP POLICY IF EXISTS saas_tenant_external_propagation_manifest_items_tenant_enforce
  ON saas_tenant_external_propagation_manifest_items;
CREATE POLICY saas_tenant_external_propagation_manifest_items_tenant_allow
  ON saas_tenant_external_propagation_manifest_items AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_external_propagation_manifest_items_tenant_enforce
  ON saas_tenant_external_propagation_manifest_items AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_saas_external_propagation_manifest_item()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  manifest_state varchar(12);
  expected_count bigint;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'external resource manifest items are immutable' USING ERRCODE='55000';
  END IF;
  SELECT state,resource_count INTO manifest_state,expected_count
  FROM public.saas_tenant_external_propagation_manifests
  WHERE tenant_id=NEW.tenant_id AND id=NEW.manifest_id
  FOR KEY SHARE;
  IF NOT FOUND OR manifest_state<>'STAGING' THEN
    RAISE EXCEPTION 'resource identity can only be added to a STAGING manifest' USING ERRCODE='55000';
  END IF;
  IF NEW.resource_ordinal>expected_count THEN
    RAISE EXCEPTION 'resource identity ordinal exceeds the declared manifest count' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_external_propagation_manifest_item_guard
  ON saas_tenant_external_propagation_manifest_items;
CREATE TRIGGER saas_tenant_external_propagation_manifest_item_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_external_propagation_manifest_items
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_external_propagation_manifest_item();

CREATE TABLE IF NOT EXISTS saas_tenant_external_propagation_resource_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  manifest_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  resource_identity_digest varchar(64) NOT NULL,
  manifest_digest varchar(64) NOT NULL,
  attempt_no integer NOT NULL,
  event_no integer NOT NULL,
  outcome_code varchar(24) NOT NULL,
  provider_receipt_reference varchar(200),
  verification_reference varchar(200),
  verified_manifest_digest varchar(64),
  residual_count bigint NOT NULL DEFAULT 0,
  failure_code varchar(64),
  residual_reason varchar(1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_saas_external_resource_event_tenant_id UNIQUE (tenant_id,id),
  CONSTRAINT uq_saas_external_resource_event_sequence UNIQUE
    (tenant_id,manifest_id,resource_id,attempt_no,event_no),
  CONSTRAINT fk_saas_external_resource_event_item FOREIGN KEY
    (tenant_id,manifest_id,resource_id)
    REFERENCES saas_tenant_external_propagation_manifest_items(tenant_id,manifest_id,id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_saas_external_resource_event_numbers CHECK (attempt_no>=1 AND event_no>=1),
  CONSTRAINT chk_saas_external_resource_event_outcome CHECK (outcome_code IN (
    'PREPARED','DELETE_REQUESTED','DELETED','VERIFIED','BLOCKED','RETAINED','FAILED_RETRYABLE'
  )),
  CONSTRAINT chk_saas_external_resource_event_digests CHECK (
    resource_identity_digest ~ '^[a-f0-9]{64}$'
    AND manifest_digest ~ '^[a-f0-9]{64}$'
    AND (verified_manifest_digest IS NULL OR verified_manifest_digest ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT chk_saas_external_resource_event_reference CHECK (
    (provider_receipt_reference IS NULL OR (
      provider_receipt_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
      AND provider_receipt_reference !~* '://' AND provider_receipt_reference !~* '(secret|password|credential|access[-_]?key|token)'
    ))
    AND (verification_reference IS NULL OR (
      verification_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
      AND verification_reference !~* '://' AND verification_reference !~* '(secret|password|credential|access[-_]?key|token)'
    ))
  ),
  CONSTRAINT chk_saas_external_resource_event_result CHECK (
    residual_count>=0
    AND (
      (outcome_code IN ('PREPARED','DELETE_REQUESTED')
        AND provider_receipt_reference IS NULL AND verification_reference IS NULL
        AND verified_manifest_digest IS NULL AND failure_code IS NULL
        AND residual_reason IS NULL AND residual_count=0)
      OR (outcome_code='DELETED' AND provider_receipt_reference IS NOT NULL
        AND verification_reference IS NULL AND verified_manifest_digest IS NULL
        AND failure_code IS NULL AND residual_reason IS NULL AND residual_count=0)
      OR (outcome_code='VERIFIED' AND provider_receipt_reference IS NOT NULL
        AND verification_reference IS NOT NULL AND verified_manifest_digest IS NOT NULL
        AND verified_manifest_digest=manifest_digest
        AND failure_code IS NULL AND residual_count=0 AND residual_reason IS NULL)
      OR (outcome_code IN ('BLOCKED','RETAINED') AND failure_code IS NOT NULL
        AND failure_code ~ '^[A-Z0-9_]{1,64}$' AND residual_reason IS NOT NULL
        AND length(btrim(residual_reason)) BETWEEN 3 AND 1000
        AND provider_receipt_reference IS NULL AND verification_reference IS NULL
        AND verified_manifest_digest IS NULL AND residual_count=0)
      OR (outcome_code='FAILED_RETRYABLE' AND failure_code IS NOT NULL
        AND failure_code ~ '^[A-Z0-9_]{1,64}$' AND residual_reason IS NOT NULL
        AND length(btrim(residual_reason)) BETWEEN 3 AND 1000)
    )
  )
);
CREATE INDEX IF NOT EXISTS idx_saas_external_resource_event_latest
  ON saas_tenant_external_propagation_resource_events
    (tenant_id,manifest_id,resource_id,attempt_no DESC,event_no DESC);

ALTER TABLE saas_tenant_external_propagation_resource_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_external_propagation_resource_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_external_propagation_resource_events_tenant_allow
  ON saas_tenant_external_propagation_resource_events;
DROP POLICY IF EXISTS saas_tenant_external_propagation_resource_events_tenant_enforce
  ON saas_tenant_external_propagation_resource_events;
CREATE POLICY saas_tenant_external_propagation_resource_events_tenant_allow
  ON saas_tenant_external_propagation_resource_events AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_external_propagation_resource_events_tenant_enforce
  ON saas_tenant_external_propagation_resource_events AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_saas_external_propagation_resource_event()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  manifest_row public.saas_tenant_external_propagation_manifests%ROWTYPE;
  item_row public.saas_tenant_external_propagation_manifest_items%ROWTYPE;
  previous_row public.saas_tenant_external_propagation_resource_events%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'per-resource execution events are append-only evidence' USING ERRCODE='55000';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.tenant_id::text || ':' || NEW.manifest_id::text || ':' || NEW.resource_id::text,0));

  SELECT * INTO manifest_row
  FROM public.saas_tenant_external_propagation_manifests m
  WHERE m.tenant_id=NEW.tenant_id AND m.id=NEW.manifest_id
  FOR KEY SHARE;
  SELECT * INTO item_row
  FROM public.saas_tenant_external_propagation_manifest_items i
  WHERE i.tenant_id=NEW.tenant_id AND i.manifest_id=NEW.manifest_id AND i.id=NEW.resource_id
  FOR KEY SHARE;
  IF NOT FOUND OR manifest_row.id IS NULL OR manifest_row.state<>'SEALED'
     OR NEW.manifest_digest<>manifest_row.manifest_digest
     OR NEW.resource_identity_digest<>item_row.resource_identity_digest THEN
    RAISE EXCEPTION 'resource execution event must bind to one identity in an exact SEALED manifest' USING ERRCODE='55000';
  END IF;

  SELECT * INTO previous_row
  FROM public.saas_tenant_external_propagation_resource_events e
  WHERE e.tenant_id=NEW.tenant_id AND e.manifest_id=NEW.manifest_id
    AND e.resource_id=NEW.resource_id
  ORDER BY e.attempt_no DESC,e.event_no DESC
  LIMIT 1;

  IF NOT FOUND THEN
    IF NEW.attempt_no<>1 OR NEW.event_no<>1 OR NEW.outcome_code<>'PREPARED' THEN
      RAISE EXCEPTION 'each resource must first record attempt 1 PREPARED' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;

  IF previous_row.outcome_code IN ('VERIFIED','BLOCKED','RETAINED') THEN
    RAISE EXCEPTION 'terminal resource outcomes cannot be extended' USING ERRCODE='55000';
  ELSIF previous_row.outcome_code='FAILED_RETRYABLE' THEN
    IF NEW.attempt_no<>previous_row.attempt_no+1 OR NEW.event_no<>1 OR NEW.outcome_code<>'PREPARED' THEN
      RAISE EXCEPTION 'retryable outcomes require a new numbered PREPARED attempt for the same sealed identity' USING ERRCODE='55000';
    END IF;
  ELSE
    IF NEW.attempt_no<>previous_row.attempt_no OR NEW.event_no<>previous_row.event_no+1 THEN
      RAISE EXCEPTION 'resource events must be sequential within the current attempt' USING ERRCODE='55000';
    END IF;
    IF NOT (
      previous_row.outcome_code='PREPARED' AND NEW.outcome_code IN ('DELETE_REQUESTED','BLOCKED','RETAINED','FAILED_RETRYABLE')
      OR previous_row.outcome_code='DELETE_REQUESTED' AND NEW.outcome_code IN ('DELETED','FAILED_RETRYABLE')
      OR previous_row.outcome_code='DELETED' AND NEW.outcome_code IN ('VERIFIED','FAILED_RETRYABLE')
    ) THEN
      RAISE EXCEPTION 'invalid per-resource erasure event transition: % -> %',
        previous_row.outcome_code,NEW.outcome_code USING ERRCODE='40001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_external_propagation_resource_event_guard
  ON saas_tenant_external_propagation_resource_events;
CREATE TRIGGER saas_tenant_external_propagation_resource_event_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_external_propagation_resource_events
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_external_propagation_resource_event();

-- Governance evidence is protected from generic export/erasure; it must survive
-- the data lifecycle it is intended to prove.
INSERT INTO factoryos_governance.tenant_relation_inventory
  (schema_name,relation_name,scope_model,data_category,export_disposition,erasure_disposition,audit_requirement,rationale)
VALUES
  ('public','saas_tenant_external_propagation_manifests','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Sealed exact-resource identity manifests bound to the approved erasure request, run, target, source export and policy versions.'),
  ('public','saas_tenant_external_propagation_manifest_items','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Immutable resource identities and stable per-resource idempotency keys for external erasure.'),
  ('public','saas_tenant_external_propagation_resource_events','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Append-only intent, provider outcome, verification, residual and recovery events for every external resource identity.')
ON CONFLICT(schema_name,relation_name) DO UPDATE SET
  scope_model=EXCLUDED.scope_model,data_category=EXCLUDED.data_category,
  export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
  audit_requirement=EXCLUDED.audit_requirement,rationale=EXCLUDED.rationale,
  classified_at=clock_timestamp();

INSERT INTO schema_migrations(version,checksum)
VALUES ('219_saas_external_erasure_resource_manifest_receipts',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;

  );
CREATE INDEX IF NOT EXISTS idx_saas_external_manifest_item_lookup
  ON saas_tenant_external_propagation_manifest_items(tenant_id,manifest_id,resource_ordinal);

ALTER TABLE saas_tenant_external_propagation_manifest_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_external_propagation_manifest_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_external_propagation_manifest_items_tenant_allow
  ON saas_tenant_external_propagation_manifest_items;
DROP POLICY IF EXISTS saas_tenant_external_propagation_manifest_items_tenant_enforce
  ON saas_tenant_external_propagation_manifest_items;
CREATE POLICY saas_tenant_external_propagation_manifest_items_tenant_allow
  ON saas_tenant_external_propagation_manifest_items AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_external_propagation_manifest_items_tenant_enforce
  ON saas_tenant_external_propagation_manifest_items AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_saas_external_propagation_manifest_item()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  manifest_state varchar(12);
  expected_count bigint;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'external resource manifest items are immutable' USING ERRCODE='55000';
  END IF;
  SELECT state,resource_count INTO manifest_state,expected_count
  FROM public.saas_tenant_external_propagation_manifests
  WHERE tenant_id=NEW.tenant_id AND id=NEW.manifest_id
  FOR KEY SHARE;
  IF NOT FOUND OR manifest_state<>'STAGING' THEN
    RAISE EXCEPTION 'resource identity can only be added to a STAGING manifest' USING ERRCODE='55000';
  END IF;
  IF NEW.resource_ordinal>expected_count THEN
    RAISE EXCEPTION 'resource identity ordinal exceeds the declared manifest count' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_external_propagation_manifest_item_guard
  ON saas_tenant_external_propagation_manifest_items;
CREATE TRIGGER saas_tenant_external_propagation_manifest_item_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_external_propagation_manifest_items
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_external_propagation_manifest_item();

CREATE TABLE IF NOT EXISTS saas_tenant_external_propagation_resource_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  manifest_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  resource_identity_digest varchar(64) NOT NULL,
  manifest_digest varchar(64) NOT NULL,
  attempt_no integer NOT NULL,
  event_no integer NOT NULL,
  outcome_code varchar(24) NOT NULL,
  provider_receipt_reference varchar(200),
  verification_reference varchar(200),
  verified_manifest_digest varchar(64),
  residual_count bigint NOT NULL DEFAULT 0,
  failure_code varchar(64),
  residual_reason varchar(1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_saas_external_resource_event_tenant_id UNIQUE (tenant_id,id),
  CONSTRAINT uq_saas_external_resource_event_sequence UNIQUE
    (tenant_id,manifest_id,resource_id,attempt_no,event_no),
  CONSTRAINT fk_saas_external_resource_event_item FOREIGN KEY
    (tenant_id,manifest_id,resource_id)
    REFERENCES saas_tenant_external_propagation_manifest_items(tenant_id,manifest_id,id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_saas_external_resource_event_numbers CHECK (attempt_no>=1 AND event_no>=1),
  CONSTRAINT chk_saas_external_resource_event_outcome CHECK (outcome_code IN (
    'PREPARED','DELETE_REQUESTED','DELETED','VERIFIED','BLOCKED','RETAINED','FAILED_RETRYABLE'
  )),
  CONSTRAINT chk_saas_external_resource_event_digests CHECK (
    resource_identity_digest ~ '^[a-f0-9]{64}$'
    AND manifest_digest ~ '^[a-f0-9]{64}$'
    AND (verified_manifest_digest IS NULL OR verified_manifest_digest ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT chk_saas_external_resource_event_reference CHECK (
    (provider_receipt_reference IS NULL OR (
      provider_receipt_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
      AND provider_receipt_reference !~* '://' AND provider_receipt_reference !~* '(secret|password|credential|access[-_]?key|token)'
    ))
    AND (verification_reference IS NULL OR (
      verification_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
      AND verification_reference !~* '://' AND verification_reference !~* '(secret|password|credential|access[-_]?key|token)'
    ))
  ),
  CONSTRAINT chk_saas_external_resource_event_result CHECK (
    residual_count>=0
    AND (
      (outcome_code IN ('PREPARED','DELETE_REQUESTED')
        AND provider_receipt_reference IS NULL AND verification_reference IS NULL
        AND verified_manifest_digest IS NULL AND failure_code IS NULL
        AND residual_reason IS NULL AND residual_count=0)
      OR (outcome_code='DELETED' AND provider_receipt_reference IS NOT NULL
        AND verification_reference IS NULL AND verified_manifest_digest IS NULL
        AND failure_code IS NULL AND residual_reason IS NULL AND residual_count=0)
      OR (outcome_code='VERIFIED' AND provider_receipt_reference IS NOT NULL
        AND verification_reference IS NOT NULL AND verified_manifest_digest IS NOT NULL
        AND verified_manifest_digest=manifest_digest
        AND failure_code IS NULL AND residual_count=0 AND residual_reason IS NULL)
      OR (outcome_code IN ('BLOCKED','RETAINED') AND failure_code IS NOT NULL
        AND failure_code ~ '^[A-Z0-9_]{1,64}$' AND residual_reason IS NOT NULL
        AND length(btrim(residual_reason)) BETWEEN 3 AND 1000
        AND provider_receipt_reference IS NULL AND verification_reference IS NULL
        AND verified_manifest_digest IS NULL AND residual_count=0)
      OR (outcome_code='FAILED_RETRYABLE' AND failure_code IS NOT NULL
        AND failure_code ~ '^[A-Z0-9_]{1,64}$' AND residual_reason IS NOT NULL
        AND length(btrim(residual_reason)) BETWEEN 3 AND 1000)
    )
  )
);
CREATE INDEX IF NOT EXISTS idx_saas_external_resource_event_latest
  ON saas_tenant_external_propagation_resource_events
    (tenant_id,manifest_id,resource_id,attempt_no DESC,event_no DESC);

ALTER TABLE saas_tenant_external_propagation_resource_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_external_propagation_resource_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_external_propagation_resource_events_tenant_allow
  ON saas_tenant_external_propagation_resource_events;
DROP POLICY IF EXISTS saas_tenant_external_propagation_resource_events_tenant_enforce
  ON saas_tenant_external_propagation_resource_events;
CREATE POLICY saas_tenant_external_propagation_resource_events_tenant_allow
  ON saas_tenant_external_propagation_resource_events AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_external_propagation_resource_events_tenant_enforce
  ON saas_tenant_external_propagation_resource_events AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_saas_external_propagation_resource_event()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  manifest_row public.saas_tenant_external_propagation_manifests%ROWTYPE;
  item_row public.saas_tenant_external_propagation_manifest_items%ROWTYPE;
  previous_row public.saas_tenant_external_propagation_resource_events%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'per-resource execution events are append-only evidence' USING ERRCODE='55000';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.tenant_id::text || ':' || NEW.manifest_id::text || ':' || NEW.resource_id::text,0));

  SELECT * INTO manifest_row
  FROM public.saas_tenant_external_propagation_manifests m
  WHERE m.tenant_id=NEW.tenant_id AND m.id=NEW.manifest_id
  FOR KEY SHARE;
  SELECT * INTO item_row
  FROM public.saas_tenant_external_propagation_manifest_items i
  WHERE i.tenant_id=NEW.tenant_id AND i.manifest_id=NEW.manifest_id AND i.id=NEW.resource_id
  FOR KEY SHARE;
  IF NOT FOUND OR manifest_row.id IS NULL OR manifest_row.state<>'SEALED'
     OR NEW.manifest_digest<>manifest_row.manifest_digest
     OR NEW.resource_identity_digest<>item_row.resource_identity_digest THEN
    RAISE EXCEPTION 'resource execution event must bind to one identity in an exact SEALED manifest' USING ERRCODE='55000';
  END IF;

  SELECT * INTO previous_row
  FROM public.saas_tenant_external_propagation_resource_events e
  WHERE e.tenant_id=NEW.tenant_id AND e.manifest_id=NEW.manifest_id
    AND e.resource_id=NEW.resource_id
  ORDER BY e.attempt_no DESC,e.event_no DESC
  LIMIT 1;

  IF NOT FOUND THEN
    IF NEW.attempt_no<>1 OR NEW.event_no<>1 OR NEW.outcome_code<>'PREPARED' THEN
      RAISE EXCEPTION 'each resource must first record attempt 1 PREPARED' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;

  IF previous_row.outcome_code IN ('VERIFIED','BLOCKED','RETAINED') THEN
    RAISE EXCEPTION 'terminal resource outcomes cannot be extended' USING ERRCODE='55000';
  ELSIF previous_row.outcome_code='FAILED_RETRYABLE' THEN
    IF NEW.attempt_no<>previous_row.attempt_no+1 OR NEW.event_no<>1 OR NEW.outcome_code<>'PREPARED' THEN
      RAISE EXCEPTION 'retryable outcomes require a new numbered PREPARED attempt for the same sealed identity' USING ERRCODE='55000';
    END IF;
  ELSE
    IF NEW.attempt_no<>previous_row.attempt_no OR NEW.event_no<>previous_row.event_no+1 THEN
      RAISE EXCEPTION 'resource events must be sequential within the current attempt' USING ERRCODE='55000';
    END IF;
    IF NOT (
      previous_row.outcome_code='PREPARED' AND NEW.outcome_code IN ('DELETE_REQUESTED','BLOCKED','RETAINED','FAILED_RETRYABLE')
      OR previous_row.outcome_code='DELETE_REQUESTED' AND NEW.outcome_code IN ('DELETED','FAILED_RETRYABLE')
      OR previous_row.outcome_code='DELETED' AND NEW.outcome_code IN ('VERIFIED','FAILED_RETRYABLE')
    ) THEN
      RAISE EXCEPTION 'invalid per-resource erasure event transition: % -> %',
        previous_row.outcome_code,NEW.outcome_code USING ERRCODE='40001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_external_propagation_resource_event_guard
  ON saas_tenant_external_propagation_resource_events;
CREATE TRIGGER saas_tenant_external_propagation_resource_event_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_external_propagation_resource_events
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_external_propagation_resource_event();

-- Governance evidence is protected from generic export/erasure; it must survive
-- the data lifecycle it is intended to prove.
INSERT INTO factoryos_governance.tenant_relation_inventory
  (schema_name,relation_name,scope_model,data_category,export_disposition,erasure_disposition,audit_requirement,rationale)
VALUES
  ('public','saas_tenant_external_propagation_manifests','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Sealed exact-resource identity manifests bound to the approved erasure request, run, target, source export and policy versions.'),
  ('public','saas_tenant_external_propagation_manifest_items','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Immutable resource identities and stable per-resource idempotency keys for external erasure.'),
  ('public','saas_tenant_external_propagation_resource_events','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Append-only intent, provider outcome, verification, residual and recovery events for every external resource identity.')
ON CONFLICT(schema_name,relation_name) DO UPDATE SET
  scope_model=EXCLUDED.scope_model,data_category=EXCLUDED.data_category,
  export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
  audit_requirement=EXCLUDED.audit_requirement,rationale=EXCLUDED.rationale,
  classified_at=clock_timestamp();

INSERT INTO schema_migrations(version,checksum)
VALUES ('219_saas_external_erasure_resource_manifest_receipts',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;

  );
CREATE INDEX IF NOT EXISTS idx_saas_external_manifest_item_lookup
  ON saas_tenant_external_propagation_manifest_items(tenant_id,manifest_id,resource_ordinal);

ALTER TABLE saas_tenant_external_propagation_manifest_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_external_propagation_manifest_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_external_propagation_manifest_items_tenant_allow
  ON saas_tenant_external_propagation_manifest_items;
DROP POLICY IF EXISTS saas_tenant_external_propagation_manifest_items_tenant_enforce
  ON saas_tenant_external_propagation_manifest_items;
CREATE POLICY saas_tenant_external_propagation_manifest_items_tenant_allow
  ON saas_tenant_external_propagation_manifest_items AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_external_propagation_manifest_items_tenant_enforce
  ON saas_tenant_external_propagation_manifest_items AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_saas_external_propagation_manifest_item()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  manifest_state varchar(12);
  expected_count bigint;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'external resource manifest items are immutable' USING ERRCODE='55000';
  END IF;
  SELECT state,resource_count INTO manifest_state,expected_count
  FROM public.saas_tenant_external_propagation_manifests
  WHERE tenant_id=NEW.tenant_id AND id=NEW.manifest_id
  FOR KEY SHARE;
  IF NOT FOUND OR manifest_state<>'STAGING' THEN
    RAISE EXCEPTION 'resource identity can only be added to a STAGING manifest' USING ERRCODE='55000';
  END IF;
  IF NEW.resource_ordinal>expected_count THEN
    RAISE EXCEPTION 'resource identity ordinal exceeds the declared manifest count' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_external_propagation_manifest_item_guard
  ON saas_tenant_external_propagation_manifest_items;
CREATE TRIGGER saas_tenant_external_propagation_manifest_item_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_external_propagation_manifest_items
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_external_propagation_manifest_item();

CREATE TABLE IF NOT EXISTS saas_tenant_external_propagation_resource_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  manifest_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  resource_identity_digest varchar(64) NOT NULL,
  manifest_digest varchar(64) NOT NULL,
  attempt_no integer NOT NULL,
  event_no integer NOT NULL,
  outcome_code varchar(24) NOT NULL,
  provider_receipt_reference varchar(200),
  verification_reference varchar(200),
  verified_manifest_digest varchar(64),
  residual_count bigint NOT NULL DEFAULT 0,
  failure_code varchar(64),
  residual_reason varchar(1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_saas_external_resource_event_tenant_id UNIQUE (tenant_id,id),
  CONSTRAINT uq_saas_external_resource_event_sequence UNIQUE
    (tenant_id,manifest_id,resource_id,attempt_no,event_no),
  CONSTRAINT fk_saas_external_resource_event_item FOREIGN KEY
    (tenant_id,manifest_id,resource_id)
    REFERENCES saas_tenant_external_propagation_manifest_items(tenant_id,manifest_id,id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_saas_external_resource_event_numbers CHECK (attempt_no>=1 AND event_no>=1),
  CONSTRAINT chk_saas_external_resource_event_outcome CHECK (outcome_code IN (
    'PREPARED','DELETE_REQUESTED','DELETED','VERIFIED','BLOCKED','RETAINED','FAILED_RETRYABLE'
  )),
  CONSTRAINT chk_saas_external_resource_event_digests CHECK (
    resource_identity_digest ~ '^[a-f0-9]{64}$'
    AND manifest_digest ~ '^[a-f0-9]{64}$'
    AND (verified_manifest_digest IS NULL OR verified_manifest_digest ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT chk_saas_external_resource_event_reference CHECK (
    (provider_receipt_reference IS NULL OR (
      provider_receipt_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
      AND provider_receipt_reference !~* '://' AND provider_receipt_reference !~* '(secret|password|credential|access[-_]?key|token)'
    ))
    AND (verification_reference IS NULL OR (
      verification_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
      AND verification_reference !~* '://' AND verification_reference !~* '(secret|password|credential|access[-_]?key|token)'
    ))
  ),
  CONSTRAINT chk_saas_external_resource_event_result CHECK (
    residual_count>=0
    AND (
      (outcome_code IN ('PREPARED','DELETE_REQUESTED')
        AND provider_receipt_reference IS NULL AND verification_reference IS NULL
        AND verified_manifest_digest IS NULL AND failure_code IS NULL
        AND residual_reason IS NULL AND residual_count=0)
      OR (outcome_code='DELETED' AND provider_receipt_reference IS NOT NULL
        AND verification_reference IS NULL AND verified_manifest_digest IS NULL
        AND failure_code IS NULL AND residual_reason IS NULL AND residual_count=0)
      OR (outcome_code='VERIFIED' AND provider_receipt_reference IS NOT NULL
        AND verification_reference IS NOT NULL AND verified_manifest_digest IS NOT NULL
        AND verified_manifest_digest=manifest_digest
        AND failure_code IS NULL AND residual_count=0 AND residual_reason IS NULL)
      OR (outcome_code IN ('BLOCKED','RETAINED') AND failure_code IS NOT NULL
        AND failure_code ~ '^[A-Z0-9_]{1,64}$' AND residual_reason IS NOT NULL
        AND length(btrim(residual_reason)) BETWEEN 3 AND 1000
        AND provider_receipt_reference IS NULL AND verification_reference IS NULL
        AND verified_manifest_digest IS NULL AND residual_count=0)
      OR (outcome_code='FAILED_RETRYABLE' AND failure_code IS NOT NULL
        AND failure_code ~ '^[A-Z0-9_]{1,64}$' AND residual_reason IS NOT NULL
        AND length(btrim(residual_reason)) BETWEEN 3 AND 1000)
    )
  )
);
CREATE INDEX IF NOT EXISTS idx_saas_external_resource_event_latest
  ON saas_tenant_external_propagation_resource_events
    (tenant_id,manifest_id,resource_id,attempt_no DESC,event_no DESC);

ALTER TABLE saas_tenant_external_propagation_resource_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_external_propagation_resource_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_external_propagation_resource_events_tenant_allow
  ON saas_tenant_external_propagation_resource_events;
DROP POLICY IF EXISTS saas_tenant_external_propagation_resource_events_tenant_enforce
  ON saas_tenant_external_propagation_resource_events;
CREATE POLICY saas_tenant_external_propagation_resource_events_tenant_allow
  ON saas_tenant_external_propagation_resource_events AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_external_propagation_resource_events_tenant_enforce
  ON saas_tenant_external_propagation_resource_events AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_saas_external_propagation_resource_event()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  manifest_row public.saas_tenant_external_propagation_manifests%ROWTYPE;
  item_row public.saas_tenant_external_propagation_manifest_items%ROWTYPE;
  previous_row public.saas_tenant_external_propagation_resource_events%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'per-resource execution events are append-only evidence' USING ERRCODE='55000';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.tenant_id::text || ':' || NEW.manifest_id::text || ':' || NEW.resource_id::text,0));

  SELECT * INTO manifest_row
  FROM public.saas_tenant_external_propagation_manifests m
  WHERE m.tenant_id=NEW.tenant_id AND m.id=NEW.manifest_id
  FOR KEY SHARE;
  SELECT * INTO item_row
  FROM public.saas_tenant_external_propagation_manifest_items i
  WHERE i.tenant_id=NEW.tenant_id AND i.manifest_id=NEW.manifest_id AND i.id=NEW.resource_id
  FOR KEY SHARE;
  IF NOT FOUND OR manifest_row.id IS NULL OR manifest_row.state<>'SEALED'
     OR NEW.manifest_digest<>manifest_row.manifest_digest
     OR NEW.resource_identity_digest<>item_row.resource_identity_digest THEN
    RAISE EXCEPTION 'resource execution event must bind to one identity in an exact SEALED manifest' USING ERRCODE='55000';
  END IF;

  SELECT * INTO previous_row
  FROM public.saas_tenant_external_propagation_resource_events e
  WHERE e.tenant_id=NEW.tenant_id AND e.manifest_id=NEW.manifest_id
    AND e.resource_id=NEW.resource_id
  ORDER BY e.attempt_no DESC,e.event_no DESC
  LIMIT 1;

  IF NOT FOUND THEN
    IF NEW.attempt_no<>1 OR NEW.event_no<>1 OR NEW.outcome_code<>'PREPARED' THEN
      RAISE EXCEPTION 'each resource must first record attempt 1 PREPARED' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;

  IF previous_row.outcome_code IN ('VERIFIED','BLOCKED','RETAINED') THEN
    RAISE EXCEPTION 'terminal resource outcomes cannot be extended' USING ERRCODE='55000';
  ELSIF previous_row.outcome_code='FAILED_RETRYABLE' THEN
    IF NEW.attempt_no<>previous_row.attempt_no+1 OR NEW.event_no<>1 OR NEW.outcome_code<>'PREPARED' THEN
      RAISE EXCEPTION 'retryable outcomes require a new numbered PREPARED attempt for the same sealed identity' USING ERRCODE='55000';
    END IF;
  ELSE
    IF NEW.attempt_no<>previous_row.attempt_no OR NEW.event_no<>previous_row.event_no+1 THEN
      RAISE EXCEPTION 'resource events must be sequential within the current attempt' USING ERRCODE='55000';
    END IF;
    IF NOT (
      previous_row.outcome_code='PREPARED' AND NEW.outcome_code IN ('DELETE_REQUESTED','BLOCKED','RETAINED','FAILED_RETRYABLE')
      OR previous_row.outcome_code='DELETE_REQUESTED' AND NEW.outcome_code IN ('DELETED','FAILED_RETRYABLE')
      OR previous_row.outcome_code='DELETED' AND NEW.outcome_code IN ('VERIFIED','FAILED_RETRYABLE')
    ) THEN
      RAISE EXCEPTION 'invalid per-resource erasure event transition: % -> %',
        previous_row.outcome_code,NEW.outcome_code USING ERRCODE='40001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_external_propagation_resource_event_guard
  ON saas_tenant_external_propagation_resource_events;
CREATE TRIGGER saas_tenant_external_propagation_resource_event_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_external_propagation_resource_events
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_external_propagation_resource_event();

-- Governance evidence is protected from generic export/erasure; it must survive
-- the data lifecycle it is intended to prove.
INSERT INTO factoryos_governance.tenant_relation_inventory
  (schema_name,relation_name,scope_model,data_category,export_disposition,erasure_disposition,audit_requirement,rationale)
VALUES
  ('public','saas_tenant_external_propagation_manifests','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Sealed exact-resource identity manifests bound to the approved erasure request, run, target, source export and policy versions.'),
  ('public','saas_tenant_external_propagation_manifest_items','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Immutable resource identities and stable per-resource idempotency keys for external erasure.'),
  ('public','saas_tenant_external_propagation_resource_events','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Append-only intent, provider outcome, verification, residual and recovery events for every external resource identity.')
ON CONFLICT(schema_name,relation_name) DO UPDATE SET
  scope_model=EXCLUDED.scope_model,data_category=EXCLUDED.data_category,
  export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
  audit_requirement=EXCLUDED.audit_requirement,rationale=EXCLUDED.rationale,
  classified_at=clock_timestamp();

INSERT INTO schema_migrations(version,checksum)
VALUES ('219_saas_external_erasure_resource_manifest_receipts',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;

  );
CREATE INDEX IF NOT EXISTS idx_saas_external_manifest_item_lookup
  ON saas_tenant_external_propagation_manifest_items(tenant_id,manifest_id,resource_ordinal);

ALTER TABLE saas_tenant_external_propagation_manifest_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_external_propagation_manifest_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_external_propagation_manifest_items_tenant_allow
  ON saas_tenant_external_propagation_manifest_items;
DROP POLICY IF EXISTS saas_tenant_external_propagation_manifest_items_tenant_enforce
  ON saas_tenant_external_propagation_manifest_items;
CREATE POLICY saas_tenant_external_propagation_manifest_items_tenant_allow
  ON saas_tenant_external_propagation_manifest_items AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_external_propagation_manifest_items_tenant_enforce
  ON saas_tenant_external_propagation_manifest_items AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_saas_external_propagation_manifest_item()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  manifest_state varchar(12);
  expected_count bigint;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'external resource manifest items are immutable' USING ERRCODE='55000';
  END IF;
  SELECT state,resource_count INTO manifest_state,expected_count
  FROM public.saas_tenant_external_propagation_manifests
  WHERE tenant_id=NEW.tenant_id AND id=NEW.manifest_id
  FOR KEY SHARE;
  IF NOT FOUND OR manifest_state<>'STAGING' THEN
    RAISE EXCEPTION 'resource identity can only be added to a STAGING manifest' USING ERRCODE='55000';
  END IF;
  IF NEW.resource_ordinal>expected_count THEN
    RAISE EXCEPTION 'resource identity ordinal exceeds the declared manifest count' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_external_propagation_manifest_item_guard
  ON saas_tenant_external_propagation_manifest_items;
CREATE TRIGGER saas_tenant_external_propagation_manifest_item_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_external_propagation_manifest_items
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_external_propagation_manifest_item();

CREATE TABLE IF NOT EXISTS saas_tenant_external_propagation_resource_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  manifest_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  resource_identity_digest varchar(64) NOT NULL,
  manifest_digest varchar(64) NOT NULL,
  attempt_no integer NOT NULL,
  event_no integer NOT NULL,
  outcome_code varchar(24) NOT NULL,
  provider_receipt_reference varchar(200),
  verification_reference varchar(200),
  verified_manifest_digest varchar(64),
  residual_count bigint NOT NULL DEFAULT 0,
  failure_code varchar(64),
  residual_reason varchar(1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_saas_external_resource_event_tenant_id UNIQUE (tenant_id,id),
  CONSTRAINT uq_saas_external_resource_event_sequence UNIQUE
    (tenant_id,manifest_id,resource_id,attempt_no,event_no),
  CONSTRAINT fk_saas_external_resource_event_item FOREIGN KEY
    (tenant_id,manifest_id,resource_id)
    REFERENCES saas_tenant_external_propagation_manifest_items(tenant_id,manifest_id,id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_saas_external_resource_event_numbers CHECK (attempt_no>=1 AND event_no>=1),
  CONSTRAINT chk_saas_external_resource_event_outcome CHECK (outcome_code IN (
    'PREPARED','DELETE_REQUESTED','DELETED','VERIFIED','BLOCKED','RETAINED','FAILED_RETRYABLE'
  )),
  CONSTRAINT chk_saas_external_resource_event_digests CHECK (
    resource_identity_digest ~ '^[a-f0-9]{64}$'
    AND manifest_digest ~ '^[a-f0-9]{64}$'
    AND (verified_manifest_digest IS NULL OR verified_manifest_digest ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT chk_saas_external_resource_event_reference CHECK (
    (provider_receipt_reference IS NULL OR (
      provider_receipt_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
      AND provider_receipt_reference !~* '://' AND provider_receipt_reference !~* '(secret|password|credential|access[-_]?key|token)'
    ))
    AND (verification_reference IS NULL OR (
      verification_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
      AND verification_reference !~* '://' AND verification_reference !~* '(secret|password|credential|access[-_]?key|token)'
    ))
  ),
  CONSTRAINT chk_saas_external_resource_event_result CHECK (
    residual_count>=0
    AND (
      (outcome_code IN ('PREPARED','DELETE_REQUESTED')
        AND provider_receipt_reference IS NULL AND verification_reference IS NULL
        AND verified_manifest_digest IS NULL AND failure_code IS NULL
        AND residual_reason IS NULL AND residual_count=0)
      OR (outcome_code='DELETED' AND provider_receipt_reference IS NOT NULL
        AND verification_reference IS NULL AND verified_manifest_digest IS NULL
        AND failure_code IS NULL AND residual_reason IS NULL AND residual_count=0)
      OR (outcome_code='VERIFIED' AND provider_receipt_reference IS NOT NULL
        AND verification_reference IS NOT NULL AND verified_manifest_digest IS NOT NULL
        AND verified_manifest_digest=manifest_digest
        AND failure_code IS NULL AND residual_count=0 AND residual_reason IS NULL)
      OR (outcome_code IN ('BLOCKED','RETAINED') AND failure_code IS NOT NULL
        AND failure_code ~ '^[A-Z0-9_]{1,64}$' AND residual_reason IS NOT NULL
        AND length(btrim(residual_reason)) BETWEEN 3 AND 1000
        AND provider_receipt_reference IS NULL AND verification_reference IS NULL
        AND verified_manifest_digest IS NULL AND residual_count=0)
      OR (outcome_code='FAILED_RETRYABLE' AND failure_code IS NOT NULL
        AND failure_code ~ '^[A-Z0-9_]{1,64}$' AND residual_reason IS NOT NULL
        AND length(btrim(residual_reason)) BETWEEN 3 AND 1000)
    )
  )
);
CREATE INDEX IF NOT EXISTS idx_saas_external_resource_event_latest
  ON saas_tenant_external_propagation_resource_events
    (tenant_id,manifest_id,resource_id,attempt_no DESC,event_no DESC);

ALTER TABLE saas_tenant_external_propagation_resource_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_external_propagation_resource_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_external_propagation_resource_events_tenant_allow
  ON saas_tenant_external_propagation_resource_events;
DROP POLICY IF EXISTS saas_tenant_external_propagation_resource_events_tenant_enforce
  ON saas_tenant_external_propagation_resource_events;
CREATE POLICY saas_tenant_external_propagation_resource_events_tenant_allow
  ON saas_tenant_external_propagation_resource_events AS PERMISSIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE POLICY saas_tenant_external_propagation_resource_events_tenant_enforce
  ON saas_tenant_external_propagation_resource_events AS RESTRICTIVE FOR ALL
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_saas_external_propagation_resource_event()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  manifest_row public.saas_tenant_external_propagation_manifests%ROWTYPE;
  item_row public.saas_tenant_external_propagation_manifest_items%ROWTYPE;
  previous_row public.saas_tenant_external_propagation_resource_events%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'per-resource execution events are append-only evidence' USING ERRCODE='55000';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.tenant_id::text || ':' || NEW.manifest_id::text || ':' || NEW.resource_id::text,0));

  SELECT * INTO manifest_row
  FROM public.saas_tenant_external_propagation_manifests m
  WHERE m.tenant_id=NEW.tenant_id AND m.id=NEW.manifest_id
  FOR KEY SHARE;
  SELECT * INTO item_row
  FROM public.saas_tenant_external_propagation_manifest_items i
  WHERE i.tenant_id=NEW.tenant_id AND i.manifest_id=NEW.manifest_id AND i.id=NEW.resource_id
  FOR KEY SHARE;
  IF NOT FOUND OR manifest_row.id IS NULL OR manifest_row.state<>'SEALED'
     OR NEW.manifest_digest<>manifest_row.manifest_digest
     OR NEW.resource_identity_digest<>item_row.resource_identity_digest THEN
    RAISE EXCEPTION 'resource execution event must bind to one identity in an exact SEALED manifest' USING ERRCODE='55000';
  END IF;

  SELECT * INTO previous_row
  FROM public.saas_tenant_external_propagation_resource_events e
  WHERE e.tenant_id=NEW.tenant_id AND e.manifest_id=NEW.manifest_id
    AND e.resource_id=NEW.resource_id
  ORDER BY e.attempt_no DESC,e.event_no DESC
  LIMIT 1;

  IF NOT FOUND THEN
    IF NEW.attempt_no<>1 OR NEW.event_no<>1 OR NEW.outcome_code<>'PREPARED' THEN
      RAISE EXCEPTION 'each resource must first record attempt 1 PREPARED' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;

  IF previous_row.outcome_code IN ('VERIFIED','BLOCKED','RETAINED') THEN
    RAISE EXCEPTION 'terminal resource outcomes cannot be extended' USING ERRCODE='55000';
  ELSIF previous_row.outcome_code='FAILED_RETRYABLE' THEN
    IF NEW.attempt_no<>previous_row.attempt_no+1 OR NEW.event_no<>1 OR NEW.outcome_code<>'PREPARED' THEN
      RAISE EXCEPTION 'retryable outcomes require a new numbered PREPARED attempt for the same sealed identity' USING ERRCODE='55000';
    END IF;
  ELSE
    IF NEW.attempt_no<>previous_row.attempt_no OR NEW.event_no<>previous_row.event_no+1 THEN
      RAISE EXCEPTION 'resource events must be sequential within the current attempt' USING ERRCODE='55000';
    END IF;
    IF NOT (
      previous_row.outcome_code='PREPARED' AND NEW.outcome_code IN ('DELETE_REQUESTED','BLOCKED','RETAINED','FAILED_RETRYABLE')
      OR previous_row.outcome_code='DELETE_REQUESTED' AND NEW.outcome_code IN ('DELETED','FAILED_RETRYABLE')
      OR previous_row.outcome_code='DELETED' AND NEW.outcome_code IN ('VERIFIED','FAILED_RETRYABLE')
    ) THEN
      RAISE EXCEPTION 'invalid per-resource erasure event transition: % -> %',
        previous_row.outcome_code,NEW.outcome_code USING ERRCODE='40001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_external_propagation_resource_event_guard
  ON saas_tenant_external_propagation_resource_events;
CREATE TRIGGER saas_tenant_external_propagation_resource_event_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_external_propagation_resource_events
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_external_propagation_resource_event();

-- Governance evidence is protected from generic export/erasure; it must survive
-- the data lifecycle it is intended to prove.
INSERT INTO factoryos_governance.tenant_relation_inventory
  (schema_name,relation_name,scope_model,data_category,export_disposition,erasure_disposition,audit_requirement,rationale)
VALUES
  ('public','saas_tenant_external_propagation_manifests','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Sealed exact-resource identity manifests bound to the approved erasure request, run, target, source export and policy versions.'),
  ('public','saas_tenant_external_propagation_manifest_items','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Immutable resource identities and stable per-resource idempotency keys for external erasure.'),
  ('public','saas_tenant_external_propagation_resource_events','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Append-only intent, provider outcome, verification, residual and recovery events for every external resource identity.')
ON CONFLICT(schema_name,relation_name) DO UPDATE SET
  scope_model=EXCLUDED.scope_model,data_category=EXCLUDED.data_category,
  export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
  audit_requirement=EXCLUDED.audit_requirement,rationale=EXCLUDED.rationale,
  classified_at=clock_timestamp();

INSERT INTO schema_migrations(version,checksum)
VALUES ('219_saas_external_erasure_resource_manifest_receipts',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
