BEGIN;

-- One active UTC-minute counter per connector bounds storage while enforcing
-- the ingress request budget atomically across application workers.
CREATE TABLE public.integration_webhook_rate_limits (
  connector_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_integration_webhook_rate_connector
    FOREIGN KEY(connector_id,tenant_id,factory_id)
    REFERENCES public.integration_connectors(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_integration_webhook_rate_window_count
    CHECK(request_count BETWEEN 1 AND 10001)
);

ALTER TABLE public.integration_webhook_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_webhook_rate_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY integration_webhook_rate_limits_tenant_isolation
  ON public.integration_webhook_rate_limits
  USING (tenant_id=public.factoryos_current_tenant_id())
  WITH CHECK (tenant_id=public.factoryos_current_tenant_id());

INSERT INTO schema_migrations(version)
VALUES('121_integration_webhook_rate_limits')
ON CONFLICT(version) DO NOTHING;

COMMIT;
