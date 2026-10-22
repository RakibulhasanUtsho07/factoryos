BEGIN;

-- factories are keyed by id, but dead-letter records also need tenant ownership
-- enforced by a composite FK. The unique index is valid because id is already
-- globally unique and makes that ownership reference enforceable by PostgreSQL.
CREATE UNIQUE INDEX IF NOT EXISTS uq_factories_id_tenant
  ON factories(id,tenant_id);

-- WP03 / Task 17: persistent broker-consumer DLQ and idempotent redrive receipts.
-- The original outbox DLQ continues to represent publisher-side failures.
-- These tables represent consumer-side failures after broker-confirmed publication.

CREATE TABLE IF NOT EXISTS outbox_bus_dead_letters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  factory_id UUID,
  event_id UUID NOT NULL,
  event_type VARCHAR(160) NOT NULL,
  event_version INTEGER NOT NULL,
  consumer_name VARCHAR(160) NOT NULL,
  source_topic VARCHAR(249) NOT NULL,
  source_partition INTEGER NOT NULL,
  source_offset BIGINT NOT NULL,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ,
  correlation_id UUID,
  failed_attempts INTEGER NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 1,
  failure_reason TEXT NOT NULL,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  status VARCHAR(24) NOT NULL DEFAULT 'QUARANTINED',
  redrive_count INTEGER NOT NULL DEFAULT 0,
  last_redriven_at TIMESTAMPTZ,
  last_redriven_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  row_version BIGINT NOT NULL DEFAULT 1,
  updated_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_outbox_bus_dead_letter_tenant_id UNIQUE(id, tenant_id),
  CONSTRAINT fk_outbox_bus_dead_letter_factory FOREIGN KEY(factory_id,tenant_id) REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT uq_outbox_bus_dead_letter_consumer_event UNIQUE(tenant_id, event_id, consumer_name),
  CONSTRAINT chk_outbox_bus_dlq_status CHECK(status IN ('QUARANTINED','REDRIVE_PENDING','REDRIVEN')),
  CONSTRAINT chk_outbox_bus_dlq_versions CHECK(event_version>0 AND row_version>0),
  CONSTRAINT chk_outbox_bus_dlq_attempts CHECK(failed_attempts>0 AND failure_count>0 AND redrive_count>=0),
  CONSTRAINT chk_outbox_bus_dlq_partition_offset CHECK(source_partition>=0 AND source_offset>=0),
  CONSTRAINT chk_outbox_bus_dlq_payload CHECK(jsonb_typeof(payload)='object'),
  CONSTRAINT chk_outbox_bus_dlq_reason CHECK(length(btrim(failure_reason)) BETWEEN 1 AND 4000)
);

CREATE INDEX IF NOT EXISTS idx_outbox_bus_dlq_inbox
  ON outbox_bus_dead_letters(tenant_id,factory_id,status,failed_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS outbox_bus_dlq_redrive_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  factory_id UUID,
  dead_letter_id UUID NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  last_error TEXT,
  correlation_id UUID,
  row_version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_outbox_bus_dlq_redrive_id_tenant UNIQUE(id,tenant_id),
  CONSTRAINT uq_outbox_bus_dlq_redrive_key UNIQUE(tenant_id,idempotency_key),
  CONSTRAINT fk_outbox_bus_dlq_redrive_dead_letter
    FOREIGN KEY(dead_letter_id,tenant_id)
    REFERENCES outbox_bus_dead_letters(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT chk_outbox_bus_dlq_redrive_status CHECK(status IN ('PENDING','PROCESSING','PUBLISHED','FAILED')),
  CONSTRAINT chk_outbox_bus_dlq_redrive_attempts CHECK(attempts>=0 AND row_version>0),
  CONSTRAINT chk_outbox_bus_dlq_redrive_request_hash CHECK(request_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_outbox_bus_dlq_redrive_work
  ON outbox_bus_dlq_redrive_requests(tenant_id,status,updated_at)
  WHERE status IN ('PENDING','FAILED','PROCESSING');

CREATE TABLE IF NOT EXISTS outbox_bus_dlq_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  dead_letter_id UUID NOT NULL,
  redrive_request_id UUID,
  event_version BIGINT NOT NULL,
  action VARCHAR(32) NOT NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_outbox_bus_dlq_audit_dead_letter
    FOREIGN KEY(dead_letter_id,tenant_id)
    REFERENCES outbox_bus_dead_letters(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_outbox_bus_dlq_audit_redrive
    FOREIGN KEY(redrive_request_id,tenant_id)
    REFERENCES outbox_bus_dlq_redrive_requests(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT chk_outbox_bus_dlq_audit_action CHECK(action IN
    ('QUARANTINED','FAILURE_RECORDED','REDRIVE_REQUESTED','REDRIVE_STARTED','REDRIVE_PUBLISHED','REDRIVE_FAILED')),
  CONSTRAINT chk_outbox_bus_dlq_audit_reason CHECK(length(btrim(reason))>0),
  CONSTRAINT chk_outbox_bus_dlq_audit_data CHECK(jsonb_typeof(event_data)='object')
);

CREATE INDEX IF NOT EXISTS idx_outbox_bus_dlq_audit_history
  ON outbox_bus_dlq_audit_events(tenant_id,dead_letter_id,created_at DESC);

CREATE OR REPLACE FUNCTION factoryos_guard_outbox_bus_dead_letter()
RETURNS trigger LANGUAGE plpgsql AS $bus_dlq_guard$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Broker consumer dead-letter evidence is retained for audit' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'QUARANTINED' OR NEW.row_version<>1 OR NEW.redrive_count<>0 THEN
      RAISE EXCEPTION 'Broker consumer dead-letter starts quarantined at version 1' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.factory_id IS DISTINCT FROM OLD.factory_id OR NEW.event_id IS DISTINCT FROM OLD.event_id
    OR NEW.event_type IS DISTINCT FROM OLD.event_type OR NEW.event_version IS DISTINCT FROM OLD.event_version
    OR NEW.consumer_name IS DISTINCT FROM OLD.consumer_name OR NEW.source_topic IS DISTINCT FROM OLD.source_topic
    OR NEW.source_partition IS DISTINCT FROM OLD.source_partition OR NEW.source_offset IS DISTINCT FROM OLD.source_offset
    OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
    OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Broker dead-letter envelope and source position are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.row_version<>OLD.row_version+1
    OR length(btrim(COALESCE(NEW.failure_reason,'')))=0
    OR NOT (
      (OLD.status='QUARANTINED' AND NEW.status IN ('QUARANTINED','REDRIVE_PENDING'))
      OR (OLD.status='REDRIVE_PENDING' AND NEW.status IN ('REDRIVEN','QUARANTINED'))
      OR (OLD.status='REDRIVEN' AND NEW.status='QUARANTINED')
    ) THEN
    RAISE EXCEPTION 'Invalid broker dead-letter lifecycle transition or stale version' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$bus_dlq_guard$;

CREATE OR REPLACE FUNCTION factoryos_guard_outbox_bus_dlq_redrive()
RETURNS trigger LANGUAGE plpgsql AS $bus_redrive_guard$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Broker DLQ redrive receipts are retained for audit' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'PENDING' OR NEW.row_version<>1 OR NEW.attempts<>0 THEN
      RAISE EXCEPTION 'Broker DLQ redrive must start PENDING at version 1' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.factory_id IS DISTINCT FROM OLD.factory_id OR NEW.dead_letter_id IS DISTINCT FROM OLD.dead_letter_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Broker DLQ redrive receipt identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.row_version<>OLD.row_version+1 OR NOT (
    (OLD.status='PENDING' AND NEW.status IN ('PROCESSING','FAILED'))
    OR (OLD.status='PROCESSING' AND NEW.status IN ('PUBLISHED','FAILED','PROCESSING'))
    OR (OLD.status='FAILED' AND NEW.status='PROCESSING')
    OR (OLD.status='PUBLISHED' AND NEW.status='PUBLISHED')
  ) THEN
    RAISE EXCEPTION 'Invalid broker DLQ redrive transition or stale version' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$bus_redrive_guard$;

CREATE OR REPLACE FUNCTION factoryos_append_outbox_bus_dlq_audit()
RETURNS trigger LANGUAGE plpgsql AS $bus_dlq_audit$
DECLARE
  v_action VARCHAR(32);
  v_reason TEXT;
BEGIN
  IF TG_TABLE_NAME='outbox_bus_dead_letters' THEN
    IF TG_OP='INSERT' THEN
      v_action:='QUARANTINED';
      v_reason:='Consumer delivery exceeded its retry budget and was quarantined';
    ELSE
      v_action:=CASE
        WHEN OLD.status IS DISTINCT FROM NEW.status AND NEW.status='REDRIVE_PENDING' THEN 'REDRIVE_REQUESTED'
        WHEN OLD.status IS DISTINCT FROM NEW.status AND NEW.status='REDRIVEN' THEN 'REDRIVE_PUBLISHED'
        WHEN OLD.status IS DISTINCT FROM NEW.status AND NEW.status='QUARANTINED' THEN 'FAILURE_RECORDED'
        ELSE 'FAILURE_RECORDED'
      END;
      v_reason:=NEW.failure_reason;
    END IF;
    INSERT INTO outbox_bus_dlq_audit_events(
      tenant_id,dead_letter_id,event_version,action,actor_user_id,reason,event_data
    ) VALUES(NEW.tenant_id,NEW.id,NEW.row_version,v_action,factoryos_current_user_id(),v_reason,
      jsonb_build_object('event_id',NEW.event_id,'event_type',NEW.event_type,'consumer_name',NEW.consumer_name,
        'status',NEW.status,'failed_attempts',NEW.failed_attempts,'failure_count',NEW.failure_count,
        'redrive_count',NEW.redrive_count,'source_topic',NEW.source_topic,'source_partition',NEW.source_partition,
        'source_offset',NEW.source_offset));
  ELSIF TG_TABLE_NAME='outbox_bus_dlq_redrive_requests' THEN
    IF TG_OP='INSERT' THEN
      v_action:='REDRIVE_REQUESTED';
      v_reason:='Authorized broker DLQ redrive requested';
    ELSE
      v_action:=CASE WHEN NEW.status='PUBLISHED' THEN 'REDRIVE_PUBLISHED' WHEN NEW.status='PROCESSING' THEN 'REDRIVE_STARTED' ELSE 'REDRIVE_FAILED' END;
      v_reason:=COALESCE(NEW.last_error,'Broker publication confirmation recorded');
    END IF;
    INSERT INTO outbox_bus_dlq_audit_events(
      tenant_id,dead_letter_id,redrive_request_id,event_version,action,actor_user_id,reason,event_data
    ) VALUES(NEW.tenant_id,NEW.dead_letter_id,NEW.id,NEW.row_version,v_action,NEW.actor_user_id,v_reason,
      jsonb_build_object('redrive_request_id',NEW.id,'status',NEW.status,'attempts',NEW.attempts,
        'idempotency_key',NEW.idempotency_key,'published_at',NEW.published_at));
  END IF;
  RETURN NEW;
END;
$bus_dlq_audit$;

CREATE OR REPLACE FUNCTION factoryos_guard_outbox_bus_dlq_audit()
RETURNS trigger LANGUAGE plpgsql AS $bus_dlq_audit_guard$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Broker DLQ audit records are append-only' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$bus_dlq_audit_guard$;

DROP TRIGGER IF EXISTS trg_outbox_bus_dead_letter_guard ON outbox_bus_dead_letters;
CREATE TRIGGER trg_outbox_bus_dead_letter_guard
  BEFORE INSERT OR UPDATE OR DELETE ON outbox_bus_dead_letters
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_outbox_bus_dead_letter();
DROP TRIGGER IF EXISTS trg_outbox_bus_dead_letter_audit ON outbox_bus_dead_letters;
CREATE TRIGGER trg_outbox_bus_dead_letter_audit
  AFTER INSERT OR UPDATE ON outbox_bus_dead_letters
  FOR EACH ROW EXECUTE FUNCTION factoryos_append_outbox_bus_dlq_audit();

DROP TRIGGER IF EXISTS trg_outbox_bus_dlq_redrive_guard ON outbox_bus_dlq_redrive_requests;
CREATE TRIGGER trg_outbox_bus_dlq_redrive_guard
  BEFORE INSERT OR UPDATE OR DELETE ON outbox_bus_dlq_redrive_requests
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_outbox_bus_dlq_redrive();
DROP TRIGGER IF EXISTS trg_outbox_bus_dlq_redrive_audit ON outbox_bus_dlq_redrive_requests;
CREATE TRIGGER trg_outbox_bus_dlq_redrive_audit
  AFTER INSERT OR UPDATE ON outbox_bus_dlq_redrive_requests
  FOR EACH ROW EXECUTE FUNCTION factoryos_append_outbox_bus_dlq_audit();
DROP TRIGGER IF EXISTS trg_outbox_bus_dlq_audit_immutable ON outbox_bus_dlq_audit_events;
CREATE TRIGGER trg_outbox_bus_dlq_audit_immutable
  BEFORE UPDATE OR DELETE ON outbox_bus_dlq_audit_events
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_outbox_bus_dlq_audit();

DO $bus_grants$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='factoryos_app') THEN
    EXECUTE 'GRANT SELECT,INSERT,UPDATE ON outbox_bus_dead_letters TO factoryos_app';
    EXECUTE 'GRANT SELECT,INSERT,UPDATE ON outbox_bus_dlq_redrive_requests TO factoryos_app';
    EXECUTE 'GRANT SELECT,INSERT ON outbox_bus_dlq_audit_events TO factoryos_app';
  END IF;
END;
$bus_grants$;

DO $bus_rls$
DECLARE v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'outbox_bus_dead_letters','outbox_bus_dlq_redrive_requests','outbox_bus_dlq_audit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',v_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',v_table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I',v_table||'_tenant_isolation',v_table);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id())',
      v_table||'_tenant_isolation',v_table
    );
  END LOOP;
END;
$bus_rls$;

INSERT INTO schema_migrations(version)
VALUES('169_kafka_event_bus_transport')
ON CONFLICT(version) DO NOTHING;

COMMIT;
