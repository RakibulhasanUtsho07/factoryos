# Distributed tracing and operational metrics

## Delivery scope

This repository slice adds W3C Trace Context propagation through async work and outbound OT gateway requests, sampled HTTP server and PostgreSQL client spans, optional OTLP/HTTP export, privacy-safe structured request-span logs, Prometheus-compatible HTTP/database/process/dependency/exporter metrics and separate liveness/readiness probes. The signed authoritative SRS/HLD/Blueprint are not present in this repository snapshot, so this is mapped to existing operational reliability/release documents and is not signed SRS acceptance.

## Trace propagation contract

The middleware strictly accepts W3C Trace Context version 00 traceparent with nonzero 32-hex trace ID and nonzero 16-hex span ID. This API creates a fresh server span ID, retains a valid upstream trace ID and parent span ID, and emits a response traceparent. A valid incoming sampling flag is respected. Invalid or all-zero context starts a fresh trace. Tracestate is bounded and checked before being forwarded. Existing x-trace-id is retained as a legacy correlation header; when it is a valid 32-hex trace ID it also seeds the W3C trace.

Root sampling is controlled by TRACE_SAMPLE_RATIO (default 0.1, accepted range 0–1). Invalid configuration safely results in no root sampling. Sampling decisions for an already valid incoming traceparent take precedence, keeping the distributed trace decision consistent.

## OTLP configuration and failure behavior

Use these settings:
- OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: fixed URL ending in /v1/traces; HTTPS is required for remote hosts.
- OTEL_EXPORTER_OTLP_TRACES_TOKEN: optional collector bearer token, stored only in secret management.
- OTEL_SERVICE_NAME: resource attribute; defaults to factoryos-api.
- TRACE_SAMPLE_RATIO: root trace sampling rate.

The exporter batches up to 128 spans in a bounded 2,048-span process-local queue and flushes asynchronously; a collector timeout is capped at 1.5 seconds. AsyncLocalStorage keeps the active span across asynchronous work; the reusable currentTracePropagationHeaders helper adds traceparent/tracestate to outbound requests, and the OPC UA/Modbus gateway clients use it. PostgreSQL transactions and direct non-tenant queries create database client spans with a new child span ID. Only bounded operation name/system/status/duration attributes are sent; query statement text, parameters and tenant/user IDs are omitted. Request handling does not await collector delivery. Failed export batches are dropped, counted and not automatically retried; metrics show export errors, queue size and dropped spans. No endpoint means export disabled. A central collector/backend is still needed for long-term storage, cross-service views and alerting. No third-party npm telemetry SDK is required for this OTLP/HTTP JSON contract.

## HTTP logs and privacy

Only sampled request completion logs are emitted as JSON with event name http.server.request. They include trace/span/parent IDs, bounded request ID, HTTP method, status, route template and duration. Raw path, query string, payload, auth header, secret, tenant ID and user ID are excluded.

Route metrics use a low-cardinality route template (Express route metadata, with numeric/UUID segments normalized; invalid or unknown routes collapse to unmatched). Never attach customer, tenant, user, request ID or trace ID as a metrics label. Do not enable body logging to make a trace easier to debug.

## Metrics and scrape authentication

GET /api/internal/metrics is Prometheus text format and is disabled unless METRICS_SCRAPE_TOKEN has at least 32 characters. The collector must use a bearer header and the endpoint should be available only to the monitoring plane. Tokens are not put in query strings or source control.

Metric groups: request counters by method/status; route-template counters by method/route/status; in-flight requests; request-duration histogram; PostgreSQL operation counters/latency histograms and total/idle/waiting connection-pool gauges; process memory/CPU/uptime/event-loop utilization; last observed database readiness; and trace export success/drop/error/queue metrics. Values are process-local and reset on restart; scrape every replica.

GET /api/health/live is dependency-free liveness. GET /api/health/ready checks DB readiness and updates the database dependency-health metric. The backward-compatible GET /api/health is still a readiness check.

## Useful PromQL starters

HTTP 5xx ratio:

~~~promql
sum(rate(factoryos_http_requests_total{status_class="5xx"}[5m]))
/
clamp_min(sum(rate(factoryos_http_requests_total[5m])), 1)
~~~

Route-level failures:

~~~promql
sum by (route, status_class) (rate(factoryos_http_route_requests_total{status_class=~"4xx|5xx"}[5m]))
~~~

95th percentile request latency:

~~~promql
histogram_quantile(0.95, sum by (le) (rate(factoryos_http_request_duration_seconds_bucket[5m])))
~~~

Trace export failures or congestion:

~~~promql
rate(factoryos_trace_export_errors_total[5m])
~~~

~~~promql
factoryos_trace_export_queue_length
~~~

Memory pressure and database readiness need service-specific thresholds and host context. These sample queries are not approved SLOs; alert windows, minimum request volume, notification destinations and ownership must be agreed by operations.

## Operational acceptance gates

Before production release, configure the private collector, token secret, scrape allowlist and per-instance scraping; verify cross-service propagation through at least two instrumented services; verify sampled/error spans and exporter-unavailable behavior; test liveness and readiness independently; confirm no dynamic IDs or credentials appear in metric labels/log fields; and test alert delivery. Record collector retention, access controls, sampling target, SLO thresholds, dashboard URLs, alert owner, release SHA and rollback/disable procedure. CI tests validate repository behavior, not deployed collector connectivity or actual alert delivery.


## Deployed collector, backend, dashboards and alerts

The implementation's deployment counterpart now lives in `deploy/observability/`: a TLS-protected OTLP/HTTP Collector exporter, authenticated per-replica Prometheus scrape, pre-provisioned Grafana dashboard, Alertmanager secret-file route, and PostgreSQL queries for active outbox age/publication freshness, blocking sessions, lock-wait age and long transactions. Deployment variables, secret file requirements, exporter permission checks, alert delivery verification, and required release evidence are described in [Central Observability, SLO and Capacity Acceptance](central-observability-slo-capacity.md).

This is repository configuration, not proof of a running deployment. SLO thresholds remain proposal-only until an accountable owner approves and records the exact policy. Run the local contract suite with `npm --workspace services/api run test:observability:contract`; run the multi-tenant read-only soak against approved staging using `npm --workspace services/api run test:soak`. The soak report requires an exact candidate SHA for remote targets and records UTC window, latency percentiles, error rate, per-synthetic-tenant traffic and recovery probe results. It does not mutate records or certify a production read/write workload.


## Deployed collector, backend, dashboards and alerts

The implementation's deployment counterpart now lives in `deploy/observability/`: a TLS-protected OTLP/HTTP Collector exporter, authenticated per-replica Prometheus scrape, pre-provisioned Grafana dashboard, Alertmanager secret-file route, and PostgreSQL queries for active outbox age/publication freshness, blocking sessions, lock-wait age and long transactions. Deployment variables, secret file requirements, exporter permission checks, alert delivery verification, and required release evidence are described in [Central Observability, SLO and Capacity Acceptance](central-observability-slo-capacity.md).

This is repository configuration, not proof of a running deployment. SLO thresholds remain proposal-only until an accountable owner approves and records the exact policy. Run the local contract suite with `npm --workspace services/api run test:observability:contract`; run the multi-tenant read-only soak against approved staging using `npm --workspace services/api run test:soak`. The soak report requires an exact candidate SHA for remote targets and records UTC window, latency percentiles, error rate, per-synthetic-tenant traffic and recovery probe results. It does not mutate records or certify a production read/write workload.


Outbox queue count/oldest-age/publication-freshness metrics are aggregated by the dispatcher from per-tenant transactions that set the existing transaction-local RLS context. They are not queried by the PostgreSQL exporter across tenants: `outbox_events` uses `FORCE ROW LEVEL SECURITY`. Queue snapshot health/age metrics distinguish a successful zero-backlog snapshot from a stale or failed collection. This preserves tenant isolation instead of making the monitoring role a bypass of business-table policies.
