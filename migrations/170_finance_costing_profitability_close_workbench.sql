BEGIN;

-- Task 19 / FR-FIN-03, FR-FIN-04, FR-FIN-08, FR-FIN-09:
-- A finance close is a read-side, currency-specific snapshot of governed
-- facts. It never posts an accounting journal, payment, bank transaction or tax.
INSERT INTO permissions(code,description) VALUES
 ('finance.workbench.read','Read period-wise finance costing, profitability and working-capital workbench'),
 ('finance.close.read','Read finance-close period requests and immutable snapshots'),
 ('finance.close.write','Create and refresh a draft finance-close snapshot'),
 ('finance.close.submit','Submit a reconciled finance-close snapshot for independent approval'),
 ('finance.close.approve','Approve a submitted finance-close snapshot using maker-checker controls')
ON CONFLICT(code) DO UPDATE SET description=EXCLUDED.description;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='ORG_ADMIN' AND r.is_system=true
  AND p.code IN (
    'finance.workbench.read','finance.close.read','finance.close.write',
    'finance.close.submit','finance.close.approve'
  )
ON CONFLICT(role_id,permission_id) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='FACTORY_MANAGER' AND r.is_system=false
  AND p.code IN ('finance.workbench.read','finance.close.read')
ON CONFLICT(role_id,permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS finance_close_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  currency char(3) NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'DRAFT',
  row_version bigint NOT NULL DEFAULT 1,
  idempotency_key varchar(200) NOT NULL,
  request_hash char(64) NOT NULL,
  snapshot jsonb NOT NULL,
  snapshot_hash char(64) NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  submitted_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  submitted_at timestamptz,
  approved_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  approval_reason varchar(1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_finance_close_period_scope UNIQUE(id,tenant_id,factory_id),
  CONSTRAINT uq_finance_close_period_currency UNIQUE(tenant_id,factory_id,currency,period_start,period_end),
  CONSTRAINT uq_finance_close_period_idempotency UNIQUE(tenant_id,factory_id,idempotency_key),
  CONSTRAINT fk_finance_close_period_factory FOREIGN KEY(factory_id,tenant_id)
    REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT chk_finance_close_currency CHECK(currency ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_finance_close_period_range CHECK(period_end>=period_start AND period_end-period_start<=370),
  CONSTRAINT chk_finance_close_status CHECK(status IN ('DRAFT','SUBMITTED','APPROVED')),
  CONSTRAINT chk_finance_close_version CHECK(row_version>0),
  CONSTRAINT chk_finance_close_idempotency CHECK(length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  CONSTRAINT chk_finance_close_request_hash CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_finance_close_snapshot_hash CHECK(snapshot_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_finance_close_snapshot_object CHECK(jsonb_typeof(snapshot)='object'),
  CONSTRAINT chk_finance_close_lifecycle CHECK(
    (status='DRAFT' AND submitted_by_user_id IS NULL AND submitted_at IS NULL
      AND approved_by_user_id IS NULL AND approved_at IS NULL AND approval_reason IS NULL)
    OR
    (status='SUBMITTED' AND submitted_by_user_id IS NOT NULL AND submitted_at IS NOT NULL
      AND approved_by_user_id IS NULL AND approved_at IS NULL AND approval_reason IS NULL)
    OR
    (status='APPROVED' AND submitted_by_user_id IS NOT NULL AND submitted_at IS NOT NULL
      AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL
      AND approved_by_user_id<>submitted_by_user_id AND length(btrim(approval_reason)) BETWEEN 8 AND 1000)
  )
);

CREATE INDEX IF NOT EXISTS idx_finance_close_period_list
  ON finance_close_periods(tenant_id,factory_id,status,period_end DESC,currency);

CREATE TABLE IF NOT EXISTS finance_close_period_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  close_period_id uuid NOT NULL,
  event_version bigint NOT NULL,
  action varchar(16) NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason varchar(1000) NOT NULL,
  snapshot_hash char(64) NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_finance_close_history_period FOREIGN KEY(close_period_id,tenant_id,factory_id)
    REFERENCES finance_close_periods(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT uq_finance_close_history_version UNIQUE(close_period_id,event_version),
  CONSTRAINT chk_finance_close_history_action CHECK(action IN ('CREATED','REFRESHED','SUBMITTED','RECALLED','APPROVED')),
  CONSTRAINT chk_finance_close_history_reason CHECK(length(btrim(reason)) BETWEEN 3 AND 1000),
  CONSTRAINT chk_finance_close_history_hash CHECK(snapshot_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_finance_close_history_details CHECK(jsonb_typeof(details)='object')
);

CREATE INDEX IF NOT EXISTS idx_finance_close_history_scope_time
  ON finance_close_period_history(tenant_id,factory_id,close_period_id,created_at DESC);

CREATE OR REPLACE FUNCTION factoryos_guard_finance_close_period()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Finance-close records are retained for audit' USING ERRCODE='55000';
  END IF;

  IF TG_OP='INSERT' THEN
    IF NEW.status<>'DRAFT' OR NEW.row_version<>1
       OR NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id()
       OR NEW.submitted_by_user_id IS NOT NULL OR NEW.approved_by_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'Finance-close period must begin as a draft created by the authenticated user'
        USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW.id,NEW.tenant_id,NEW.factory_id,NEW.currency,NEW.period_start,NEW.period_end,
         NEW.idempotency_key,NEW.request_hash,NEW.created_by_user_id,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.tenant_id,OLD.factory_id,OLD.currency,OLD.period_start,OLD.period_end,
         OLD.idempotency_key,OLD.request_hash,OLD.created_by_user_id,OLD.created_at) THEN
    RAISE EXCEPTION 'Finance-close identity and create request are immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status='APPROVED' THEN
    RAISE EXCEPTION 'Approved finance-close snapshots are immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.row_version<>OLD.row_version+1 THEN
    RAISE EXCEPTION 'Finance-close transition requires the next row version' USING ERRCODE='40001';
  END IF;
  IF NOT (
    (OLD.status='DRAFT' AND NEW.status IN ('DRAFT','SUBMITTED'))
    OR (OLD.status='SUBMITTED' AND NEW.status IN ('DRAFT','APPROVED'))
  ) THEN
    RAISE EXCEPTION 'Invalid finance-close lifecycle transition' USING ERRCODE='23514';
  END IF;

  IF NEW.status='SUBMITTED' AND
     (NEW.submitted_by_user_id IS DISTINCT FROM factoryos_current_user_id()
       OR NEW.submitted_at IS NULL OR NEW.approved_by_user_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Finance-close submission actor must match the authenticated user'
      USING ERRCODE='42501';
  END IF;
  IF OLD.status='SUBMITTED' AND NEW.status='DRAFT' AND
     (OLD.submitted_by_user_id IS DISTINCT FROM factoryos_current_user_id()
       OR NEW.submitted_by_user_id IS NOT NULL OR NEW.submitted_at IS NOT NULL
       OR NEW.approved_by_user_id IS NOT NULL OR NEW.approved_at IS NOT NULL
       OR NEW.approval_reason IS NOT NULL) THEN
    RAISE EXCEPTION 'Only the submitting user may recall a submitted finance-close period'
      USING ERRCODE='42501';
  END IF;
  IF NEW.status='APPROVED' AND
     (NEW.approved_by_user_id IS DISTINCT FROM factoryos_current_user_id()
       OR NEW.approved_by_user_id IS NULL
       OR NEW.approved_by_user_id=NEW.submitted_by_user_id
       OR NEW.approved_at IS NULL
       OR length(btrim(COALESCE(NEW.approval_reason,'')))<8) THEN
    RAISE EXCEPTION 'Finance-close approval requires an independent reviewer and reason'
      USING ERRCODE='42501';
  END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_finance_close_period_guard ON finance_close_periods;
CREATE TRIGGER trg_finance_close_period_guard
  BEFORE INSERT OR UPDATE OR DELETE ON finance_close_periods
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_finance_close_period();

CREATE OR REPLACE FUNCTION factoryos_guard_finance_close_period_history()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.actor_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
      RAISE EXCEPTION 'Finance-close history actor must match the authenticated user'
        USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Finance-close history is append-only' USING ERRCODE='55000';
END $$;

DROP TRIGGER IF EXISTS trg_finance_close_period_history_guard ON finance_close_period_history;
CREATE TRIGGER trg_finance_close_period_history_guard
  BEFORE INSERT OR UPDATE OR DELETE ON finance_close_period_history
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_finance_close_period_history();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_close_periods','finance_close_period_history'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I',t||'_tenant_isolation',t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id())',
      t||'_tenant_isolation',t
    );
  END LOOP;
END $$;

INSERT INTO schema_migrations(version,checksum)
VALUES('170_finance_costing_profitability_close_workbench',NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
