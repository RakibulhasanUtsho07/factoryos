# FactoryOS Operational Reliability Runbook

**Status:** Engineering runbook for the repository implementation. Production-specific values, alert routing, RPO/RTO and final SLOs require owner approval before release.

## 1. Observability and safe metrics scraping

Every request has an x-request-id and x-trace-id. An incoming x-trace-id is preserved only when it matches the bounded pattern `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`; malformed or oversized values are replaced with a generated UUID. Correlation identifiers are not authentication credentials. Do not put customer data, secrets, access tokens, or personally identifiable information in them.

The process exposes low-cardinality Prometheus text metrics at GET /internal/metrics:

- factoryos_http_requests_total by bounded HTTP method and status class
- factoryos_http_requests_in_flight by bounded method
- factoryos_http_request_duration_seconds histogram
- factoryos_process_uptime_seconds

The scrape route is **disabled by default**. Set METRICS_SCRAPE_TOKEN in the deployment secret manager to a high-entropy value of at least 32 characters, then send Authorization: Bearer token from a restricted metrics collector. An unconfigured endpoint responds as not found; a missing or invalid token is rejected. Rotate the token through the secret manager and update the collector as one controlled operation. Never commit the token or put it in a URL.

Metrics are process-local and reset on restart. They deliberately have no tenant, user, trace, or URL-path labels, avoiding high-cardinality labels and cross-tenant traffic disclosure. They are not a durable telemetry store and do not replace a central collector, per-instance scraping, log aggregation or distributed tracing backend.

## 2. Initial alerting rules

The following are **proposed starting thresholds, not approved contractual SLOs**. Confirm service criticality, measurement windows and alert ownership with operations before treating them as release gates.

| Signal | Suggested trigger | First response |
|---|---|---|
| HTTP 5xx ratio | Above 1% for 5 minutes, with meaningful request volume | Inspect per-instance request rates, API CI/release SHA, recent deployments, DB connectivity and application logs. |
| Request latency | p95 above 500 ms for 10 minutes on ordinary API traffic | Separate database saturation, lock waits, downstream calls and CPU pressure; do not include long-running administrative jobs in an ordinary-request SLO without an explicit policy. |
| API/database health | Three consecutive failed external probes of GET /health | Check database reachability, connection limits, credentials/secret rotation, recent migrations and host pressure. |
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

The request metrics do not measure end-user availability, business success, queue age, DB pool utilization or OT protocol health. Add those signals to the selected monitoring backend before accepting a production SLO. Do not infer durable alerting from the presence of metrics alone.

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

Run these commands only with approved connection identities, a dedicated isolated restore target and secrets supplied out-of-band (for example, a protected service definition or PGPASSFILE). Do not type production passwords into shell history.

~~~sh
pg_dump --format=custom --no-owner --no-acl \
  --file=factoryos-prechange.dump \
  "$SOURCE_DATABASE_URL"

pg_restore --list factoryos-prechange.dump > factoryos-prechange.contents.txt

# Create an EMPTY, isolated database through an approved admin connection first.
pg_restore --exit-on-error --no-owner --no-acl \
  --dbname="$ISOLATED_RESTORE_DATABASE_URL" \
  factoryos-prechange.dump
~~~

These commands illustrate the mechanics, not a complete disaster-recovery plan. Validate extensions, roles, grants, RLS context, object ownership, data checks, restore time and application smoke tests. A successful pg_restore exit code by itself is not proof that the application works. Keep backups encrypted with controlled retention and prove access to decryption material using the organization's recovery process.

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
