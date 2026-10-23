BEGIN;

-- Task 23: persist real provider-operation requests and append-only outcome evidence.
-- These records are not a substitute for a registered infrastructure adapter:
-- operations without an approved adapter must be recorded as FAILED, never simulated.
INSERT INTO permissions(code,description) VALUES
 ('saas.physical_provisioning.read','Read physical sandbox, deployment and rollout operation receipts')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r CROSS JOIN permissions p
WHERE r.is_system=true AND r.code IN ('ORG_ADMIN','FINANCE_MANAGER')
  AND p.code='saas.physical_provisioning.read'
ON CONFLICT(role_id,permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS saas_physical_provisioning_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  operation VARCHAR(40) NOT NULL,
  resource_type VARCHAR(24) NOT NULL,
  resource_id UUID NOT NULL,
  resource_key VARCHAR(200) NOT NULL,
  resource_version BIGINT NOT NULL,
  topology VARCHAR(24) NOT NULL,
  deployment_reference VARCHAR(200),
  failure_policy VARCHAR(12) NOT NULL DEFAULT 'HALT',
  health_timeout_seconds SMALLINT NOT NULL DEFAULT 60,
  artifact_digest VARCHAR(64),
  dataset_manifest_digest VARCHAR(64),
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_saas_physical_run_scope UNIQUE(id,tenant_id),
  CONSTRAINT uq_saas_physical_run_idempotency UNIQUE(tenant_id,idempotency_key),
  CONSTRAINT chk_saas_physical_operation CHECK(operation IN (
    'SANDBOX_PROVISION','DEPLOYMENT_PROFILE_PROVISION','RELEASE_DEPLOY'
  )),
  CONSTRAINT chk_saas_physical_resource_type CHECK(resource_type IN ('SANDBOX','DEPLOYMENT_PROFILE','RELEASE')),
  CONSTRAINT chk_saas_physical_operation_resource CHECK(
    (operation='SANDBOX_PROVISION' AND resource_type='SANDBOX')
    OR (operation='DEPLOYMENT_PROFILE_PROVISION' AND resource_type='DEPLOYMENT_PROFILE')
    OR (operation='RELEASE_DEPLOY' AND resource_type='RELEASE')
  ),
  CONSTRAINT chk_saas_physical_resource_key CHECK(length(btrim(resource_key)) BETWEEN 1 AND 200),
  CONSTRAINT chk_saas_physical_resource_version CHECK(resource_version BETWEEN 1 AND 9223372036854775807),
  CONSTRAINT chk_saas_physical_topology CHECK(topology IN (
    'SHARED_SAAS','SINGLE_TENANT','DEDICATED_VPC','HYBRID_EDGE_CLOUD'
  )),
  CONSTRAINT chk_saas_physical_deployment_reference CHECK(
    deployment_reference IS NULL OR deployment_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
  ),
  CONSTRAINT chk_saas_physical_failure_policy CHECK(failure_policy IN ('HALT','ROLLBACK')),
  CONSTRAINT chk_saas_physical_health_timeout CHECK(health_timeout_seconds BETWEEN 5 AND 300),
  CONSTRAINT chk_saas_physical_artifact_digest CHECK(artifact_digest IS NULL OR artifact_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_saas_physical_dataset_digest CHECK(dataset_manifest_digest IS NULL OR dataset_manifest_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_saas_physical_idempotency CHECK(idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_physical_request_hash CHECK(request_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_saas_physical_runs_history
  ON saas_physical_provisioning_runs(tenant_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_saas_physical_runs_resource
  ON saas_physical_provisioning_runs(tenant_id,resource_type,resource_id,created_at DESC);
DROP TRIGGER IF EXISTS saas_physical_provisioning_runs_immutable ON saas_physical_provisioning_runs;
CREATE TRIGGER saas_physical_provisioning_runs_immutable
BEFORE UPDATE OR DELETE ON saas_physical_provisioning_runs
FOR EACH ROW EXECUTE FUNCTION factoryos_reject_versioned_mutation();

CREATE TABLE IF NOT EXISTS saas_physical_provisioning_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  run_id UUID NOT NULL,
  event_version BIGINT NOT NULL,
  event_status VARCHAR(24) NOT NULL,
  provider_code VARCHAR(60),
  provider_reference VARCHAR(255),
  evidence_digest VARCHAR(64),
  reason_code VARCHAR(80),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_saas_physical_event_run_scope
    FOREIGN KEY(run_id,tenant_id) REFERENCES saas_physical_provisioning_runs(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT uq_saas_physical_event_version UNIQUE(run_id,event_version),
  CONSTRAINT uq_saas_physical_event_idempotency UNIQUE(tenant_id,idempotency_key),
  CONSTRAINT chk_saas_physical_event_version CHECK(event_version BETWEEN 1 AND 9223372036854775807),
  CONSTRAINT chk_saas_physical_event_status CHECK(event_status IN (
    'REQUESTED','IN_PROGRESS','SUCCEEDED','FAILED','HALTED',
    'ROLLBACK_IN_PROGRESS','ROLLED_BACK','ROLLBACK_FAILED'
  )),
  CONSTRAINT chk_saas_physical_provider_code CHECK(provider_code IS NULL OR provider_code ~ '^[a-z][a-z0-9._:-]{0,59}$'),
  CONSTRAINT chk_saas_physical_provider_reference CHECK(
    provider_reference IS NULL OR (
      length(provider_reference) BETWEEN 1 AND 255
      AND provider_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'
      AND position('://' in provider_reference)=0
    )
  ),
  CONSTRAINT chk_saas_physical_evidence_digest CHECK(evidence_digest IS NULL OR evidence_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_saas_physical_reason_code CHECK(reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_:-]{0,79}$'),
  CONSTRAINT chk_saas_physical_evidence_object CHECK(
    jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=16384
  ),
  CONSTRAINT chk_saas_physical_event_idempotency CHECK(idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
);
CREATE INDEX IF NOT EXISTS idx_saas_physical_events_timeline
  ON saas_physical_provisioning_events(tenant_id,run_id,event_version);
CREATE INDEX IF NOT EXISTS idx_saas_physical_events_status
  ON saas_physical_provisioning_events(tenant_id,event_status,created_at DESC);
DROP TRIGGER IF EXISTS saas_physical_provisioning_events_immutable ON saas_physical_provisioning_events;
CREATE TRIGGER saas_physical_provisioning_events_immutable
BEFORE UPDATE OR DELETE ON saas_physical_provisioning_events
FOR EACH ROW EXECUTE FUNCTION factoryos_reject_versioned_mutation();

CREATE OR REPLACE FUNCTION factoryos_guard_saas_physical_event_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $physical_event_guard$
DECLARE
  previous_version BIGINT;
  previous_status VARCHAR(24);
BEGIN
  PERFORM 1
  FROM public.saas_physical_provisioning_runs r
  WHERE r.id=NEW.run_id AND r.tenant_id=NEW.tenant_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Physical provisioning run is missing or outside the requested tenant'
      USING ERRCODE='23503';
  END IF;

  SELECT e.event_version,e.event_status
    INTO previous_version,previous_status
  FROM public.saas_physical_provisioning_events e
  WHERE e.run_id=NEW.run_id AND e.tenant_id=NEW.tenant_id
  ORDER BY e.event_version DESC LIMIT 1;

  IF previous_version IS NULL THEN
    IF NEW.event_version<>1 OR NEW.event_status<>'REQUESTED' THEN
      RAISE EXCEPTION 'A physical operation must begin with REQUESTED version 1'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.event_version<>previous_version+1 THEN
    RAISE EXCEPTION 'Physical operation event versions must increase exactly once'
      USING ERRCODE='23514';
  END IF;

  IF NOT (
    (previous_status='REQUESTED' AND NEW.event_status IN ('IN_PROGRESS','FAILED'))
    OR (previous_status='IN_PROGRESS' AND NEW.event_status IN ('SUCCEEDED','FAILED','HALTED','ROLLBACK_IN_PROGRESS'))
    OR (previous_status='ROLLBACK_IN_PROGRESS' AND NEW.event_status IN ('ROLLED_BACK','ROLLBACK_FAILED'))
  ) THEN
    RAISE EXCEPTION 'Illegal physical operation status transition: % -> %',previous_status,NEW.event_status
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$physical_event_guard$;

DROP TRIGGER IF EXISTS saas_physical_event_state_guard ON saas_physical_provisioning_events;
CREATE TRIGGER saas_physical_event_state_guard
BEFORE INSERT ON saas_physical_provisioning_events
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_physical_event_transition();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'saas_physical_provisioning_runs','saas_physical_provisioning_events'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',table_name || '_tenant_isolation',table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL USING (tenant_id=public.factoryos_current_tenant_id()) WITH CHECK (tenant_id=public.factoryos_current_tenant_id())',
      table_name || '_tenant_isolation',table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS fo_privacy_scope_enforce ON public.%I',table_name);
    EXECUTE format(
      'CREATE POLICY fo_privacy_scope_enforce ON public.%I AS RESTRICTIVE FOR ALL USING (tenant_id=public.factoryos_current_tenant_id()) WITH CHECK (tenant_id=public.factoryos_current_tenant_id())',
      table_name
    );

    INSERT INTO factoryos_governance.tenant_relation_inventory(
      schema_name,relation_name,scope_model,data_category,export_disposition,
      erasure_disposition,audit_requirement,rationale
    ) VALUES(
      'public',table_name,'DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED',
      'BLOCKED_FINANCE_REVIEW','DOMAIN_LEDGER_OR_AUDIT_REVIEW',
      'Physical SaaS infrastructure provision/deployment evidence; immutable provider receipts must be retained until reviewed.'
    )
    ON CONFLICT(schema_name,relation_name) DO UPDATE SET
      scope_model=EXCLUDED.scope_model,data_category=EXCLUDED.data_category,
      export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
      audit_requirement=EXCLUDED.audit_requirement,rationale=EXCLUDED.rationale,classified_at=clock_timestamp();

    INSERT INTO factoryos_governance.tenant_relation_ownership_reviews(
      schema_name,relation_name,ownership_class,evidence_type,evidence_detail,
      scope_predicate,export_disposition,erasure_disposition,review_status
    ) VALUES(
      'public',table_name,'DIRECT_TENANT','DIRECT_TENANT_COLUMN_AND_RLS',
      'Physical provisioning runs and append-only events are directly tenant-scoped and guarded by ENABLE/FORCE RLS plus restrictive tenant policy in migration 186.',
      'tenant_id = public.factoryos_current_tenant_id()','EXCLUDED','BLOCKED_FINANCE_REVIEW','VERIFIED'
    )
    ON CONFLICT(schema_name,relation_name) DO UPDATE SET
      ownership_class=EXCLUDED.ownership_class,evidence_type=EXCLUDED.evidence_type,
      evidence_detail=EXCLUDED.evidence_detail,scope_predicate=EXCLUDED.scope_predicate,
      export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
      review_status=EXCLUDED.review_status,reviewed_at=clock_timestamp();
  END LOOP;
END $$;

INSERT INTO schema_migrations(version,checksum)
VALUES('186_saas_physical_infrastructure_execution',NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
