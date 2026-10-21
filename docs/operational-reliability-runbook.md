# FactoryOS Operational Reliability Runbook

**Status:** Engineering runbook for the repository implementation. Production-specific values, alert routing, RPO/RTO and final SLOs require owner approval before release.

## 1. Distributed tracing, logs and operational metrics

### Request correlation and W3C Trace Context

Every request receives a bounded x-request-id and correlation x-trace-id. The API also accepts and emits W3C Trace Context version 00 traceparent and a validated bounded tracestate when present. A valid inbound traceparent keeps its trace ID and parent-span relationship while this API creates a new server-span ID. Invalid/all-zero context is not reflected; a new trace context is created. Legacy non-W3C x-trace-id values are preserved only as compatibility correlation IDs.

Root traces are sampled using TRACE_SAMPLE_RATIO (default 0.1, valid range 0–1); an inbound W3C sampling decision is respected. Sampled requests produce sanitized structured http.server.request JSON logs containing trace ID, span ID, parent span ID, request ID, bounded route template, method, status and duration. Do not add request/response bodies, full URLs, query strings, authorization headers, secrets, tenant IDs or user identifiers.

### OTLP/HTTP trace export

The optional OtlpTraceExporter emits OpenTelemetry-compatible OTLP/HTTP JSON HTTP server spans and PostgreSQL client spans to OTEL_EXPORTER_OTLP_TRACES_ENDPOINT (fixed URL ending in /v1/traces). Remote endpoints must use HTTPS; loopback HTTP is allowed only outside production. OTEL_SERVICE_NAME defaults to factoryos-api; OTEL_EXPORTER_OTLP_TRACES_TOKEN is an optional collector bearer token and must be kept in the deployment secret manager.

Export is non-blocking with a bounded in-memory queue (2,048 spans), batches of at most 128 and a 1.5-second collector timeout. Collector errors drop the failed batch rather than blocking or retaining an infinite backlog; these losses are exposed in exporter metrics. If no endpoint is configured, trace export is disabled while request correlation headers continue to work. Use a central OpenTelemetry Collector/backend for persistence, cross-service search, retention and alerting; process-local buffering is not durable.

### Prometheus-compatible operational metrics

When enabled, GET /api/internal/metrics returns Prometheus text exposition. It is disabled when METRICS_SCRAPE_TOKEN is missing or shorter than 32 characters. Set a high-entropy token out of band in a secret manager; a restricted collector must send Authorization: Bearer token. Comparison is constant-time after equal-length validation. Never put the token in a URL or commit it.

The exported metric families include:

- factoryos_http_requests_total by bounded method and status class.
- factoryos_http_route_requests_total by bounded route template, method and status class. Raw URLs, query strings and customer IDs are never labels; unmatched/dynamic unsafe paths are grouped as unmatched or a sanitized :id template.
- factoryos_http_requests_in_flight and factoryos_http_request_duration_seconds histogram.
- factoryos_process_memory_bytes, factoryos_process_cpu_seconds_total, factoryos_nodejs_event_loop_utilization_ratio and factoryos_process_uptime_seconds.
- factoryos_db_operations_total, factoryos_db_operation_duration_seconds and factoryos_db_pool_connections: bounded SQL-operation success/error counts, query/transaction latency histograms, and total/idle/waiting pool connections. SQL statement text and bind values are not exported.
- factoryos_dependency_health{dependency="database"}: 1 healthy, 0 unhealthy, -1 not yet checked by a readiness probe.
- factoryos_trace_spans_exported_total, factoryos_trace_spans_dropped_total, factoryos_trace_export_errors_total and factoryos_trace_export_queue_length.

Metrics are process-local, reset on restart and must be scraped per instance. They do not replace centralized storage, alert routing, DB pool/lock metrics, business outcome metrics, OT edge queue-age signals or production SLO approval.

### Health endpoints and release operation

- GET /api/health/live is a dependency-free liveness probe.
- GET /api/health/ready checks SELECT 1 against PostgreSQL and updates the dependency-health metric.
- GET /api/health remains backward-compatible as a readiness check.

Configure scrape access from a private network or collector identity, not the public internet. Scrape every API instance, attach the deployed commit SHA in the monitoring system target metadata, alert on exporter errors/queue saturation and process saturation, and validate alert delivery with a test notification before release. Proposed thresholds later in this runbook are engineering starting points; named owners must approve actual SLOs and alert windows.

## 2. Initial alerting rules

The following are **proposed starting thresholds, not approved contractual SLOs**. Confirm service criticality, measurement windows and alert ownership with operations before treating them as release gates.

| Signal | Suggested trigger | First response |
|---|---|---|
| HTTP 5xx ratio | Above 1% for 5 minutes, with meaningful request volume | Inspect per-instance request rates, API CI/release SHA, recent deployments, DB connectivity and application logs. |
| Request latency | p95 above 500 ms for 10 minutes on ordinary API traffic | Separate database saturation, lock waits, downstream calls and CPU pressure; do not include long-running administrative jobs in an ordinary-request SLO without an explicit policy. |
| API/database health | Three consecutive failed external probes of GET /api/health/ready | Check database reachability, connection limits, credentials/secret rotation, recent migrations and host pressure. |
| Request saturation | In-flight request count grows continuously and does not drain | Check downstream dependencies and connection pools; capture a trace/correlation ID from a representative failed request. |
| OT telemetry gaps | New SEQUENCE_GAP or LATE records exceed the device/domain-specific baseline | Compare stream cursors, source sequences, source clocks and reconnect logs before replaying data. Preserve original event IDs and timestamps. |

Prometheus query examples (scrape each instance; apply alert windows and minimum traffic as appropriate):

~~~promql
sum(rate(factoryos_http_requests_total{status_class="5xx"}[5m]))
/
clamp_min(sum(rate(factoryos_http_requests_total[5m])), 1)
~~~

~~~promql
histogram_quantile(
  0.95,
  sum by (le) (rate(factoryos_http_request_duration_seconds_bucket[5m]))
)
~~~

The request metrics do not measure end-user availability, business success, queue age or OT protocol health. PostgreSQL client spans now mark whole transactions plus direct non-tenant queries; contextual query calls are observed as transactions, and SQL text/bind values are deliberately omitted. For DB saturation, inspect factoryos_db_pool_connections{state="waiting"} with transaction duration and host CPU/memory. For route-level failures, inspect factoryos_http_route_requests_total grouped by route/status_class; for exporter loss, alert on rate(factoryos_trace_export_errors_total[5m]) and factoryos_trace_export_queue_length. Add those signals to the selected monitoring backend before accepting a production SLO. Do not infer durable alerting from the presence of metrics alone.

## 3. Migration release gate

Before applying a migration to a customer database:

1. Pin the candidate Git commit SHA and confirm API, PostgreSQL integration, frontend and security workflows applicable to that commit are green.
2. Independently verify environment and database identity. Compare the repository's complete ordered migration list with the applied schema_migrations entries; do not rely on the largest numeric filename or assume files are safe to sort lexically. The PostgreSQL CI workflow documents the dependency order and fails if a numbered SQL file is omitted.
3. Take a fresh, access-restricted backup to the approved encrypted storage destination. Capture backup time, database identity, candidate SHA, tool versions and an integrity checksum in the change record.
4. Restore that backup into a separate, isolated database and confirm that restore succeeds. Run migration preflight/contract checks against the restore before touching the target.
5. Apply the exact candidate migrations to the isolated restore. Review locks, expected table scans, transaction duration, RLS and triggers. Test both successful paths and deliberate failures.
6. Record an operator-reviewed forward-fix or rollback decision. Do not assume destructive schema changes or business writes can be reversed by executing the migration backwards.
7. Apply production changes with the database owner/on-call operator present, capture output and timestamps, then run API health, authentication, tenant-scope and business smoke tests. If a gate fails, stop writes where appropriate and follow the approved incident/change plan.

### PostgreSQL backup/restore rehearsal example

Prefer the encrypted, identity-checked helper in **scripts/recovery/postgres-backup-restore-rehearsal.sh**. Its complete prerequisites, placeholders, operator commands and acceptance limits are documented in [Backup/Restore, Migration Recovery, Load and Security Acceptance](backup-restore-migration-load-security-acceptance.md). Use an approved PGSERVICEFILE/PGPASSFILE, GPG recipient/private key access, restricted output directory, a separately created empty restore database and a reviewed read-only restore smoke SQL file. Do not place database passwords in shell history or commit secrets.

The helper streams a custom-format pg_dump archive directly into GPG encryption, writes and verifies a SHA-256 checksum, compares source and restore database identity, rejects targets containing user relations, checks archive readability, restores using a single transaction, and runs the supplied smoke SQL. It deliberately refuses to overwrite an existing artifact and does not automatically drop a failed restore target. Retain the encrypted artifact/checksum, tool versions, release SHA, timestamps, restore duration and operator evidence. Its precondition contract test is run by API CI and the dependency-security workflow; it verifies unsafe/missing configuration is rejected before database clients are invoked. Run both helper contract suites with the commands in the acceptance guide.

For any production release, this rehearsal must run against explicitly approved source and isolated recovery targets. Never run an unreviewed restore against the source or an active customer database. Restore success does not prove point-in-time recovery, off-site replication, RPO/RTO, external adapter recovery or application correctness without the selected smoke checks.

The PostgreSQL CI workflow also runs an intentional transaction-failure probe after creating a table and inserting a row; CI expects the failure and verifies no probe table survives. This tests transactional fail-closed behavior in the disposable CI database only. Review each real migration's transaction boundaries and recovery plan independently.

## 4. Agent recovery and compensation safety

For an agent step with an ambiguous execution claim, **do not allocate a fresh execution key or blindly retry the external side effect**. Inspect the scoped durable claim and execution record, then use the supported reconciliation workflow with operator evidence. Retry only after the durable state is confirmed and the registered contract permits it.

Compensation is permitted only when the original step succeeded and the registered, versioned rollback contract is complete and entitled. A tool declaring rollback NONE, a changed action binding, an ambiguous claim or incomplete rollback contract must fail closed. A failed compensation without a durable execution record requires explicit operator confirmation/reconciliation before another attempt. Preserve task, step, action-intent, approval, execution and trace IDs in the incident record without copying credentials or secret payloads.

## 5. OT/edge bounded-slice troubleshooting

The OT API slice stores device registration metadata and accepts bounded, normalized telemetry batches. It does not open OPC UA sessions, subscribe to a broker, poll Modbus registers or operate a physical controller.

- Confirm that the device is in ACTIVE state and that the caller is scoped to its tenant and factory.
- An identical source_event_id plus identical event fingerprint returns a duplicate replay outcome; reuse of the ID with changed event content is a conflict.
- SEQUENCE_GAP means the incoming source sequence jumped over the last accepted cursor; LATE means it was at/below the cursor; neither classification edits prior events.
- Compare source clock quality, sequence resets, broker delivery guarantees and network interruption logs before resolving a gap. Do not use a replay to hide or rewrite original evidence.
- Connection and secret references are metadata only. Store real credentials in an approved secret manager. Do not enable write control or automatic PLC compensation from this API slice.
- Durable local spool storage, message-broker QoS/session policy, reconnect orchestration and real device protocol drivers remain separate deployment/integration acceptance gates.

## 6. Incident checklist and closure evidence

Capture: UTC incident window, affected service/tenant/factory where authorized, current and prior release SHA, workflow links, metric snapshots, sanitized request/trace IDs, DB health and pool observations, last successful migration, backup/restore evidence, event/claim identifiers, decision-maker and next action. Avoid attaching raw secrets, complete private payloads or tenant data dumps to tickets.

Close an incident only after the remediation is deployed and verified, the alert has cleared for the agreed observation window, and regression coverage or a documented follow-up exists. Record unresolved risks and assign an owner and due date; never mark a runbook gate as passed based only on a green CI badge.

## 7. Bounded API load smoke test (non-production only)

The repository includes `scripts/performance/api-load-smoke.mjs`, available as `npm --workspace services/api run test:load-smoke`. Both API CI workflows syntax-check the harness. It uses only Node's built-in fetch; it does not require a load-testing package or write application data by design (choose a read-only health/diagnostic route for the default run).

Defaults are intentionally conservative: 15 seconds, concurrency 5, 100,000 attempted requests maximum, and a five-second timeout per request. The report contains request rate, status/error counts and p50/p95/p99/max latencies; it never prints bearer tokens. A supplied p95 threshold is an operator-selected guardrail, not an approved FactoryOS SLO.

Linux/macOS example against a local API:

~~~sh
FACTORYOS_LOAD_BASE_URL=http://localhost:3001 \
FACTORYOS_LOAD_PATH=/health \
FACTORYOS_LOAD_DURATION_SECONDS=15 \
FACTORYOS_LOAD_CONCURRENCY=5 \
FACTORYOS_LOAD_MAX_REQUESTS=1000 \
npm --workspace services/api run test:load-smoke
~~~

PowerShell example:

~~~powershell
$env:FACTORYOS_LOAD_BASE_URL = "http://localhost:3001"
$env:FACTORYOS_LOAD_PATH = "/health"
$env:FACTORYOS_LOAD_DURATION_SECONDS = "15"
$env:FACTORYOS_LOAD_CONCURRENCY = "5"
$env:FACTORYOS_LOAD_MAX_REQUESTS = "1000"
npm --workspace services/api run test:load-smoke
~~~

Remote targets are rejected unless `FACTORYOS_LOAD_ALLOW_REMOTE=true` is explicitly set. Set this only after confirming that the URL targets an isolated, approved staging/performance environment with synthetic data, a known request budget, an agreed time window, and the owner's permission. Do not direct the script to production or perform a denial-of-service exercise with it. Set `FACTORYOS_LOAD_BEARER_TOKEN` only for a separately approved authenticated read-only route; the token is never part of the URL/report.

For example, require `FACTORYOS_LOAD_MAX_P95_MS=500` only if a 500 ms target has been formally approved for that route. The run fails when observed HTTP 5xx/network error rate exceeds `FACTORYOS_LOAD_MAX_ERROR_RATE` (default 1%), or when configured p95 threshold is exceeded. Save the sanitized JSON output with the candidate SHA and environment shape. A short smoke run is not capacity certification: test representative business journeys, realistic read/write mix, connection pool/DB pressure, saturation, soak behavior and recovery separately under an approved plan.


## 8. Central observability, SLO approval and capacity acceptance

The deployment bundle under `deploy/observability/` connects the API's process-local Prometheus scrape and bounded OTLP/HTTP exporter to a private Prometheus/Grafana/Alertmanager/Collector stack. PostgreSQL lock-wait/blocker/transaction metrics come from a least-privilege exporter; outbox count, oldest age, last-publication freshness and snapshot health are aggregated through tenant-scoped API transactions because `outbox_events` enforces RLS. See [Central Observability, SLO and Capacity Acceptance](central-observability-slo-capacity.md) for deployment prerequisites, secret files, TLS, dashboards, alert delivery, load stages and required evidence.

Before release, scrape every API replica with the bearer token and deployed commit SHA labels; verify PostgreSQL lock metrics and tenant-scoped API outbox metrics are present (an empty panel is not proof of zero pressure); check API latency/errors, pool waiters, blockers, transaction age, outbox oldest age/last publication/snapshot freshness, OTLP queue/dropped spans and per-instance process saturation. Alert rules use `policy_status: proposed`: the 500 ms p95, 1500 ms p99, 1% error and 300-second freshness values are examples only until the service owner records approval in `deploy/observability/slo-policy.yml`.

The separate `scripts/performance/api-soak-test.mjs` contract requires at least two synthetic tenant token aliases, accepts configurable weighted read-only GET scenarios, records p50/p95/p99, RPS, errors and per-tenant/per-scenario outcomes; an owner-approved minimum RPS can be enforced with `FACTORYOS_SOAK_MIN_RPS`, then measures time to three consecutive successful recovery probes. Remote testing requires HTTPS and explicit non-production acknowledgement. It never performs writes, so it is not a full read/write workload certification. Run it only in an owner-approved isolated staging environment and capture the dashboard's per-instance and database metrics alongside its JSON report.

Release evidence must include the actual collector/backend connectivity and retention configuration, healthy per-instance scrape targets, database exporter permission/signal verification, alert delivery acknowledged by the downstream receiver, candidate SHA, SLO approval reference, UTC test window, representative route/workload plan, saturation/recovery results and operator sign-off. CI checks configuration contracts and executes the harness against a local synthetic server; those checks do not replace staging evidence or constitute SLO approval.
