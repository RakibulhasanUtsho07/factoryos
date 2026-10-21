# Central Observability, SLO and Capacity Acceptance

## Status and release boundary

This bundle provisions a Prometheus/Grafana/Alertmanager monitoring plane, a TLS-protected OpenTelemetry Collector OTLP/HTTP receiver, PostgreSQL lock metrics plus tenant-scoped application outbox freshness, operator-routed alerting, and an authenticated multi-tenant GET-only soak/recovery harness.

**Production acceptance is not complete until an owner-approved deployment supplies real endpoints/secrets, every API instance and the database exporter are healthy, a test alert reaches the on-call destination, and a representative staging soak produces a reviewed evidence bundle.** A repository change, valid config files, unit/contract tests, or a green CI run is not proof that a collector/backend is deployed or that notifications were delivered.

The values in `deploy/observability/alert-rules.yml` are explicitly marked `policy_status: proposed`. The approval register in `deploy/observability/slo-policy.yml` must remain `NOT_OWNER_APPROVED` until the accountable service owner records an approver, UTC date, change reference, reviewed candidate SHA, representative route mix, throughput envelope and p95/p99/error/freshness/recovery targets. Do not advertise proposed values as contractual SLOs.

## Components

- `deploy/observability/compose.yaml`: private monitoring-plane services (Prometheus, Grafana, Alertmanager, OTLP Collector and PostgreSQL exporter). All browser-facing ports bind to loopback; place them behind the approved VPN/reverse proxy with authentication when remote access is needed. Pin each image to an organization-approved version and digest at deployment time.
- `otel-collector.yaml`: TLS-protected OTLP/HTTP receiver, memory limiter, batching, bounded exporter queue and retry window for the central OTLP backend.
- `prometheus.yml`: authenticated per-instance API scrapes with explicit release-SHA labels, PostgreSQL exporter scrape and alert rule loading.
- `postgres-queries.yml`: low-cardinality PostgreSQL blocker, longest current lock wait and active long-transaction metrics. Outbox status/count/age/freshness comes from the API dispatcher, which aggregates each tenant inside its RLS-scoped transaction before exposing bounded values; the exporter deliberately never queries tenant rows across RLS. The exporter must use a dedicated monitoring role with approved statistics visibility and a TLS-verified DSN.
- `alert-rules.yml` and `alertmanager.yml`: proposed error/latency, database pool/lock, queue freshness and OTLP congestion/loss alerts routed to a webhook URL mounted from a secret file.
- `grafana/dashboards/factoryos-operational-reliability.json`: per-instance HTTP throughput/latency, process memory, database pool waiters, PostgreSQL locks, outbox age/freshness, OTLP queue/drop rates and scrape health.

The API's in-process metrics remain process-local and reset on restart; collector/exporter queues are also bounded. Prometheus scrapes each replica, and the collector exports trace batches to the configured central backend. Do not put tenant IDs, event IDs, request paths with identifiers, SQL text, payloads or credentials in metric labels.

## Deployment prerequisites

1. Create a private network shared with the API replicas and database monitoring endpoint. Do not publish port 9187 or OTLP 4318 on a public interface.
2. Supply approved immutable image references through `OTEL_COLLECTOR_IMAGE`, `PROMETHEUS_IMAGE`, `ALERTMANAGER_IMAGE`, `GRAFANA_IMAGE` and `POSTGRES_EXPORTER_IMAGE`.
3. Create secret files outside the repository and make them readable only by the deploy operator/service: `FACTORYOS_OTEL_RECEIVER_TOKEN_FILE`, `FACTORYOS_METRICS_SCRAPE_TOKEN_FILE`, `FACTORYOS_ONCALL_WEBHOOK_URL_FILE`, `FACTORYOS_GRAFANA_ADMIN_PASSWORD_FILE`, `FACTORYOS_POSTGRES_EXPORTER_USER_FILE`, `FACTORYOS_POSTGRES_EXPORTER_PASSWORD_FILE`, `FACTORYOS_OTEL_RECEIVER_CERT_FILE` and `FACTORYOS_OTEL_RECEIVER_KEY_FILE`. The API's `METRICS_SCRAPE_TOKEN` must have at least 32 characters and exactly match the scrape-token file.
4. Mount `FACTORYOS_OTEL_RECEIVER_TOKEN_FILE` as a raw high-entropy token value; set the same token as `OTEL_EXPORTER_OTLP_TRACES_TOKEN` in each API instance's secret manager. The collector validates the Authorization Bearer header using the contrib `bearertokenauth` receiver extension and TLS. Configure `OTEL_BACKEND_ENDPOINT` as the approved HTTPS OTLP backend root endpoint (not a signal-specific path). Inject `OTEL_BACKEND_AUTHORIZATION` via the deployment secret manager, not source control. Trust the collector receiver certificate's issuing CA in every API container/host, and ensure its SAN matches `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (which ends in `/v1/traces`).
5. Configure `FACTORYOS_POSTGRES_EXPORTER_URI` as a credential-free URI with `sslmode=verify-full` and an approved CA path where required. The monitoring role needs approved visibility into the intended `pg_stat_activity`/lock statistics. It does not need SELECT on `outbox_events` because the dispatcher exports aggregate queue signals through tenant-scoped queries; do not use a superuser. Validate permissions in staging before enabling alerts.
6. Change both placeholder API targets in `prometheus.yml` to the actual private DNS names/ports for every replica, update each `instance_id`, and replace `REPLACE_WITH_DEPLOYED_COMMIT_SHA` with the deployed 40-character SHA. Add or remove target entries when replica count changes; do not replace per-instance scraping with a load-balancer target.
7. Set the collector resource's `deployment.environment.name` to the real environment before deploying a staging copy. Prometheus external labels must likewise use the actual environment.
8. Create the external Docker network named by `FACTORYOS_MONITORING_NETWORK` (default `factoryos-monitoring`) and ensure it includes the private API and database/exporter routes. Start the stack from this directory with `docker compose -f deploy/observability/compose.yaml up -d` after the required environment variables and secret files are present.
9. Confirm the Grafana provisioning files load and the FactoryOS dashboard appears. Prometheus should show all `factoryos-api`, `factoryos-postgres-exporter`, `prometheus` and `alertmanager` targets as healthy. If the custom PostgreSQL query metrics are absent, do not interpret empty queue/lock panels as zero pressure: treat database monitoring as incomplete.

### Database exporter query validation

Use the custom query file with the pinned `prometheus-community/postgres_exporter` image configured by your deployment. Validate the chosen exporter version's `--extend.query-path`, `--datasource.user-file` and `--datasource.pass-file` flags before rollout, then test `/metrics` in the private network for these names:

- `factoryos_pg_blocking_sessions_count`, `factoryos_pg_lock_wait_max_wait_seconds` and `factoryos_pg_long_transactions_count`

Outbox metrics `factoryos_outbox_events`, `factoryos_outbox_oldest_age_seconds` and `factoryos_outbox_freshness_seconds_since_last_publish` are emitted by the API metrics endpoint from aggregate values collected in tenant-scoped transactions; the metric endpoint does not export tenant/factory/event labels. `factoryos_outbox_metrics_snapshot_age_seconds` and `factoryos_outbox_metrics_collection_success` reveal stale or failed aggregation, so an absent or stale snapshot must not be interpreted as an empty queue. Database monitoring permissions, query runtime, exporter connectivity and scrape latency must be tested against the real schema/version.

## Alert delivery test

Before release, use the operator's approved change window and non-paging test destination where possible:

1. Confirm `/run/secrets/oncall_webhook_url` is mounted into Alertmanager, contains the actual secret-backed URL accepted by the approved webhook relay, and is never copied into a ticket or shell history.
2. Verify Prometheus loaded every rule and Alertmanager shows its configured receiver. Confirm routes and inhibition rules with the expected warning/critical labels.
3. Submit a uniquely named short-lived test alert to Alertmanager's private `/api/v2/alerts` endpoint, with an annotation saying this is an observability delivery test. Verify the downstream receiver accepted it and the intended operator/on-call destination acknowledged receipt.
4. Resolve/expire the test alert and verify the resolved notification if the receiver supports it. Record UTC start/finish, candidate SHA, Alertmanager/Prometheus versions, receiver result, operator and evidence link.

Do not mark alert delivery as accepted based only on an alert being visible in Prometheus or queued inside Alertmanager. The external receiver must confirm delivery. Remove the test alert and avoid triggering an unplanned page.

## Representative multi-tenant soak and saturation recovery

The harness `scripts/performance/api-soak-test.mjs` issues authenticated GET requests only, distributed across at least two aliases with the required `synthetic-` prefix. It rotates token aliases and configurable route scenarios, records per-synthetic-tenant and per-scenario request/failure counts, throughput, status distribution, p50/p95/p99/max latency, error rate, and post-load recovery (three consecutive successful probes). Tokens and request bodies are never written to its report; the target report contains only the target origin, not route query strings.

Prepare a protected JSON token file outside the repository with real staging JWTs whose decoded claims have been independently confirmed by the test operator to belong to separate **synthetic** tenants/factories:

~~~json
[
  { "tenant": "synthetic-tenant-a", "token": "REPLACE_WITH_STAGING_JWT_A" },
  { "tenant": "synthetic-tenant-b", "token": "REPLACE_WITH_STAGING_JWT_B" }
]
~~~

Example scenario file, using approved read-only routes and bounded data:

~~~json
[
  { "name": "orders-list", "path": "/api/v2/orders?limit=10", "weight": 5 },
  { "name": "inventory-list", "path": "/api/v2/inventory/stock?limit=10", "weight": 3 },
  { "name": "readiness", "path": "/api/health/ready", "weight": 1 }
]
~~~

Use paths supported by the deployed API/version and test accounts. Never assume examples exist in every deployment. The harness deliberately supports only GET to avoid accidental production writes; this is read-heavy capacity evidence, not a full read/write certification. If writes must be tested, implement a separate application-specific fixture workflow with disposable data, approved idempotency semantics, clean-up and owner authorization; do not weaken this guard into arbitrary mutating requests.

Bash example (run on a secured operator host; use a fresh evidence path):

~~~sh
set -euo pipefail
export FACTORYOS_SOAK_BASE_URL="https://factoryos-staging.internal"
export FACTORYOS_SOAK_ALLOW_REMOTE=true
export FACTORYOS_SOAK_ACKNOWLEDGE_NON_PRODUCTION=true
export FACTORYOS_SOAK_CANDIDATE_SHA="REPLACE_WITH_40_CHARACTER_CANDIDATE_SHA"
export FACTORYOS_SOAK_TOKENS_FILE="/secure/factoryos-synthetic-tenant-tokens.json"
export FACTORYOS_SOAK_SCENARIOS_FILE="/secure/factoryos-read-scenarios.json"
export FACTORYOS_SOAK_DURATION_SECONDS=900
export FACTORYOS_SOAK_CONCURRENCY=10
export FACTORYOS_SOAK_MAX_REQUESTS=100000
# Only configure these values after the service owner approves the relevant policy.
export FACTORYOS_SOAK_MAX_ERROR_RATE=0.01
export FACTORYOS_SOAK_MAX_P95_MS=500
export FACTORYOS_SOAK_MAX_P99_MS=1500
export FACTORYOS_SOAK_RECOVERY_SECONDS=30
export FACTORYOS_SOAK_MAX_RECOVERY_SECONDS=30
node scripts/performance/api-soak-test.mjs | tee "/secure/evidence/factoryos-soak-$FACTORYOS_SOAK_CANDIDATE_SHA.json"
~~~

The sample thresholds are explicitly illustrative; only run the configured limits when the owner has approved them. Use `node --test scripts/performance/api-soak-test.test.mjs scripts/performance/observability-config.test.mjs` for local contract validation.

Run multiple controlled stages rather than a single huge test: low-volume baseline, planned concurrency/throughput steps, a sustained soak appropriate to the intended workload, and a post-saturation recovery period. Determine concurrency and request caps from the agreed test budget. Do not point the harness at production, use real customer tokens/data, or execute a denial-of-service exercise. Remote targets require HTTPS plus both `FACTORYOS_SOAK_ALLOW_REMOTE=true` and `FACTORYOS_SOAK_ACKNOWLEDGE_NON_PRODUCTION=true`; the report additionally binds to a candidate SHA.

### Evidence required for acceptance

For each exact candidate SHA, store a restricted evidence bundle containing:

- Approved SLO policy/change reference; test owner/operator; environment and replica topology; instance IDs and candidate SHA; UTC window; sanitized workload/scenario names; synthetic tenant aliases only.
- Soak JSON report and load-plan parameters; baseline/step/soak results; p50/p95/p99, RPS, non-2xx/network error rate, all per-tenant/per-route outcomes, saturation recovery streak and measured recovery time.
- Prometheus/Grafana snapshots or time-bounded query exports for each API instance: CPU/memory/event loop, in-flight requests, HTTP latency/errors, database pool total/idle/waiting, PostgreSQL blockers/lock-wait duration/long transactions, outbox status/oldest age/last publish, exporter queue/errors/dropped spans.
- Alert delivery result from the real receiver; collector/backend acceptance/retention configuration; scrape target health; verified instance and release SHA labels.
- Known constraints, failed stages, anomalies, saturation point and recovery behavior, cleanup results, and owner sign-off.

CI exercises the harness against a fake local HTTP server and verifies dashboard/config contracts. This verifies the tooling but is **not** a multi-tenant staging load result or real alert-delivery evidence. The following operational gates remain pending until completed in the approved environment: collector/backend connectivity and retention, per-instance scraping, database exporter permission/signal correctness, actual alert delivery, sustained soak, saturation/recovery evidence, and owner approval of numeric SLOs.
