import { performance } from 'node:perf_hooks';

const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'OTHER'] as const;
type HttpMethodLabel = (typeof HTTP_METHODS)[number];
const STATUS_CLASSES = ['1xx', '2xx', '3xx', '4xx', '5xx', 'other'] as const;
const BUCKETS_SECONDS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] as const;
type DependencyName = 'database';
type DatabaseOperationLabel = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'OTHER' | 'TRANSACTION';
type DatabaseOperationStatus = 'success' | 'error';
const OUTBOX_STATUSES = ['PENDING', 'FAILED', 'PROCESSING', 'QUARANTINED'] as const;
type OutboxStatus = (typeof OUTBOX_STATUSES)[number];
interface OutboxQueueSnapshot { status: OutboxStatus; count: number; oldestAgeSeconds: number; }
interface DatabaseDurationAggregate { bucketCounts: number[]; count: number; sum: number; }

interface DurationAggregate { bucketCounts: number[]; count: number; sum: number; }

function normalizeMethod(method: string): HttpMethodLabel {
  const normalized = method.trim().toUpperCase();
  return (HTTP_METHODS as readonly string[]).includes(normalized) ? normalized as HttpMethodLabel : 'OTHER';
}
function normalizeStatus(statusCode: number): (typeof STATUS_CLASSES)[number] {
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) return 'other';
  return (Math.floor(statusCode / 100) + 'xx') as (typeof STATUS_CLASSES)[number];
}
function normalizeRoute(route: string | undefined): string {
  if (!route || route.length > 160 || !route.startsWith('/')) return 'unmatched';
  let bounded = route
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,36}(?=\/|$)/gi, '/:id')
    .replace(/\/[0-9]{1,18}(?=\/|$)/g, '/:id');
  if (!/^\/[A-Za-z0-9_./:-]*$/.test(bounded)) return 'unmatched';
  return bounded;
}

/** Process-local low-cardinality Prometheus metrics; never attach tenant, user, IDs or raw URL labels. */
export class HttpMetricsService {
  private readonly requestCounts = new Map<string, number>();
  private readonly routeRequestCounts = new Map<string, number>();
  private readonly inFlight = new Map<HttpMethodLabel, number>();
  private readonly durations = new Map<HttpMethodLabel, DurationAggregate>();
  private readonly dependencyHealth = new Map<DependencyName, number>([['database', -1]]);
  private readonly databaseOperationCounts = new Map<string, number>();
  private readonly databaseDurations = new Map<DatabaseOperationLabel, DatabaseDurationAggregate>();
  private databasePool = { total: 0, idle: 0, waiting: 0 };
  private readonly outboxCounts = new Map<OutboxStatus, number>();
  private readonly outboxOldestAgeSeconds = new Map<OutboxStatus, number>();
  private outboxSecondsSinceLastPublish = -1;
  private outboxMetricsCollectedAtMs = 0;
  private outboxMetricsCollectionHealthy = -1;
  private outboxMetricsCollectionErrors = 0;
  private traceSpansExported = 0;
  private traceSpansDropped = 0;
  private traceExportErrors = 0;
  private traceQueueLength = 0;

  beginRequest(method: string): HttpMethodLabel {
    const label = normalizeMethod(method);
    this.inFlight.set(label, (this.inFlight.get(label) ?? 0) + 1);
    return label;
  }

  completeRequest(method: HttpMethodLabel, statusCode: number, durationSeconds: number, route = 'unmatched'): void {
    this.inFlight.set(method, Math.max(0, (this.inFlight.get(method) ?? 0) - 1));
    const statusClass = normalizeStatus(statusCode);
    const normalizedRoute = normalizeRoute(route.startsWith('/') ? route : undefined);
    const key = method + '\u0000' + statusClass;
    this.requestCounts.set(key, (this.requestCounts.get(key) ?? 0) + 1);
    const routeKey = method + '\u0000' + normalizedRoute + '\u0000' + statusClass;
    this.routeRequestCounts.set(routeKey, (this.routeRequestCounts.get(routeKey) ?? 0) + 1);
    const duration = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0;
    let aggregate = this.durations.get(method);
    if (!aggregate) {
      aggregate = { bucketCounts: BUCKETS_SECONDS.map(() => 0), count: 0, sum: 0 };
      this.durations.set(method, aggregate);
    }
    BUCKETS_SECONDS.forEach((bound, index) => {
      if (duration <= bound) aggregate!.bucketCounts[index] += 1;
    });
    aggregate.count += 1;
    aggregate.sum += duration;
  }

  recordDatabaseOperation(
    operation: DatabaseOperationLabel,
    status: DatabaseOperationStatus,
    durationSeconds: number,
    pool?: { total: number; idle: number; waiting: number },
  ): void {
    const key = operation + '\u0000' + status;
    this.databaseOperationCounts.set(key, (this.databaseOperationCounts.get(key) ?? 0) + 1);
    const duration = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0;
    let aggregate = this.databaseDurations.get(operation);
    if (!aggregate) {
      aggregate = { bucketCounts: BUCKETS_SECONDS.map(() => 0), count: 0, sum: 0 };
      this.databaseDurations.set(operation, aggregate);
    }
    BUCKETS_SECONDS.forEach((bound, index) => { if (duration <= bound) aggregate!.bucketCounts[index] += 1; });
    aggregate.count += 1;
    aggregate.sum += duration;
    if (pool) {
      this.databasePool = {
        total: Math.max(0, Math.floor(pool.total)),
        idle: Math.max(0, Math.floor(pool.idle)),
        waiting: Math.max(0, Math.floor(pool.waiting)),
      };
    }
  }

  setDependencyHealth(dependency: DependencyName, healthy: boolean): void {
    this.dependencyHealth.set(dependency, healthy ? 1 : 0);
  }

  recordOutboxQueueSnapshot(snapshot: OutboxQueueSnapshot[], secondsSinceLastPublish: number): void {
    for (const status of OUTBOX_STATUSES) {
      this.outboxCounts.set(status, 0);
      this.outboxOldestAgeSeconds.set(status, 0);
    }
    for (const item of snapshot) {
      if (!(OUTBOX_STATUSES as readonly string[]).includes(item.status)) continue;
      const count = Number.isFinite(item.count) ? Math.max(0, Math.floor(item.count)) : 0;
      const oldestAge = Number.isFinite(item.oldestAgeSeconds) ? Math.max(0, item.oldestAgeSeconds) : 0;
      this.outboxCounts.set(item.status, (this.outboxCounts.get(item.status) ?? 0) + count);
      this.outboxOldestAgeSeconds.set(item.status, Math.max(this.outboxOldestAgeSeconds.get(item.status) ?? 0, oldestAge));
    }
    this.outboxSecondsSinceLastPublish = Number.isFinite(secondsSinceLastPublish) && secondsSinceLastPublish >= 0
      ? Math.max(0, secondsSinceLastPublish) : -1;
    this.outboxMetricsCollectedAtMs = Date.now();
    this.outboxMetricsCollectionHealthy = 1;
  }

  recordOutboxQueueSnapshotFailure(): void {
    this.outboxMetricsCollectionHealthy = 0;
    this.outboxMetricsCollectionErrors += 1;
  }

  recordTraceExported(count: number): void { this.traceSpansExported += Math.max(0, Math.floor(count)); }
  recordTraceDropped(count: number): void { this.traceSpansDropped += Math.max(0, Math.floor(count)); }
  recordTraceExportError(): void { this.traceExportErrors += 1; }
  setTraceQueueLength(count: number): void { this.traceQueueLength = Math.max(0, Math.floor(count)); }

  renderPrometheus(): string {
    const lines = [
      '# HELP factoryos_http_requests_total Completed HTTP requests by method and status class.',
      '# TYPE factoryos_http_requests_total counter',
    ];
    for (const method of HTTP_METHODS) {
      for (const statusClass of STATUS_CLASSES) {
        lines.push('factoryos_http_requests_total{method="' + method + '",status_class="' + statusClass + '"} '
          + (this.requestCounts.get(method + '\u0000' + statusClass) ?? 0));
      }
    }

    lines.push(
      '# HELP factoryos_http_route_requests_total Completed HTTP requests by bounded route template, method and status class.',
      '# TYPE factoryos_http_route_requests_total counter',
    );
    for (const [key, value] of [...this.routeRequestCounts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const [method, route, statusClass] = key.split('\u0000');
      lines.push('factoryos_http_route_requests_total{method="' + method + '",route="' + route + '",status_class="' + statusClass + '"} ' + value);
    }

    lines.push(
      '# HELP factoryos_http_requests_in_flight Current HTTP requests that have not completed.',
      '# TYPE factoryos_http_requests_in_flight gauge',
    );
    for (const method of HTTP_METHODS) {
      lines.push('factoryos_http_requests_in_flight{method="' + method + '"} ' + (this.inFlight.get(method) ?? 0));
    }

    lines.push(
      '# HELP factoryos_http_request_duration_seconds HTTP request duration in seconds.',
      '# TYPE factoryos_http_request_duration_seconds histogram',
    );
    for (const method of HTTP_METHODS) {
      const aggregate = this.durations.get(method) ?? { bucketCounts: BUCKETS_SECONDS.map(() => 0), count: 0, sum: 0 };
      BUCKETS_SECONDS.forEach((bound, index) => {
        lines.push('factoryos_http_request_duration_seconds_bucket{method="' + method + '",le="' + bound + '"} ' + aggregate.bucketCounts[index]);
      });
      lines.push('factoryos_http_request_duration_seconds_bucket{method="' + method + '",le="+Inf"} ' + aggregate.count);
      lines.push('factoryos_http_request_duration_seconds_sum{method="' + method + '"} ' + aggregate.sum.toFixed(6));
      lines.push('factoryos_http_request_duration_seconds_count{method="' + method + '"} ' + aggregate.count);
    }

    lines.push(
      '# HELP factoryos_db_operations_total PostgreSQL operations executed by bounded operation and result.',
      '# TYPE factoryos_db_operations_total counter',
    );
    for (const operation of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'OTHER', 'TRANSACTION'] as const) {
      for (const status of ['success', 'error'] as const) {
        lines.push('factoryos_db_operations_total{operation="' + operation + '",status="' + status + '"} '
          + (this.databaseOperationCounts.get(operation + '\u0000' + status) ?? 0));
      }
    }
    lines.push(
      '# HELP factoryos_db_operation_duration_seconds PostgreSQL query/transaction duration in seconds.',
      '# TYPE factoryos_db_operation_duration_seconds histogram',
    );
    for (const operation of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'OTHER', 'TRANSACTION'] as const) {
      const aggregate = this.databaseDurations.get(operation) ?? { bucketCounts: BUCKETS_SECONDS.map(() => 0), count: 0, sum: 0 };
      BUCKETS_SECONDS.forEach((bound, index) => {
        lines.push('factoryos_db_operation_duration_seconds_bucket{operation="' + operation + '",le="' + bound + '"} ' + aggregate.bucketCounts[index]);
      });
      lines.push('factoryos_db_operation_duration_seconds_bucket{operation="' + operation + '",le="+Inf"} ' + aggregate.count);
      lines.push('factoryos_db_operation_duration_seconds_sum{operation="' + operation + '"} ' + aggregate.sum.toFixed(6));
      lines.push('factoryos_db_operation_duration_seconds_count{operation="' + operation + '"} ' + aggregate.count);
    }
    lines.push(
      '# HELP factoryos_db_pool_connections PostgreSQL connection pool counts by state.',
      '# TYPE factoryos_db_pool_connections gauge',
      'factoryos_db_pool_connections{state="total"} ' + this.databasePool.total,
      'factoryos_db_pool_connections{state="idle"} ' + this.databasePool.idle,
      'factoryos_db_pool_connections{state="waiting"} ' + this.databasePool.waiting,
    );

    const memory = process.memoryUsage();
    lines.push('# HELP factoryos_process_memory_bytes Node.js process memory in bytes.', '# TYPE factoryos_process_memory_bytes gauge');
    for (const [kind, value] of [['rss', memory.rss], ['heap_used', memory.heapUsed], ['heap_total', memory.heapTotal], ['external', memory.external]] as const) {
      lines.push('factoryos_process_memory_bytes{type="' + kind + '"} ' + value);
    }
    const cpu = process.cpuUsage();
    lines.push(
      '# HELP factoryos_process_cpu_seconds_total Total process CPU time in seconds by mode.',
      '# TYPE factoryos_process_cpu_seconds_total counter',
      'factoryos_process_cpu_seconds_total{mode="user"} ' + (cpu.user / 1_000_000).toFixed(6),
      'factoryos_process_cpu_seconds_total{mode="system"} ' + (cpu.system / 1_000_000).toFixed(6),
      '# HELP factoryos_nodejs_event_loop_utilization_ratio Event loop utilization since process start.',
      '# TYPE factoryos_nodejs_event_loop_utilization_ratio gauge',
      'factoryos_nodejs_event_loop_utilization_ratio ' + performance.eventLoopUtilization().utilization.toFixed(6),
      '# HELP factoryos_process_uptime_seconds Process uptime in seconds.',
      '# TYPE factoryos_process_uptime_seconds gauge',
      'factoryos_process_uptime_seconds ' + Math.max(0, process.uptime()).toFixed(3),
      '# HELP factoryos_dependency_health Last observed dependency health: 1=healthy, 0=unhealthy, -1=not checked.',
      '# TYPE factoryos_dependency_health gauge',
    );
    for (const dependency of ['database'] as const) {
      lines.push('factoryos_dependency_health{dependency="' + dependency + '"} ' + (this.dependencyHealth.get(dependency) ?? -1));
    }
    lines.push(
      '# HELP factoryos_outbox_events Current outbox event count by bounded dispatch state.',
      '# TYPE factoryos_outbox_events gauge',
    );
    for (const status of OUTBOX_STATUSES) {
      lines.push('factoryos_outbox_events{status="' + status + '"} ' + (this.outboxCounts.get(status) ?? 0));
    }
    lines.push(
      '# HELP factoryos_outbox_oldest_age_seconds Age of the oldest unpublished outbox event by bounded dispatch state.',
      '# TYPE factoryos_outbox_oldest_age_seconds gauge',
    );
    for (const status of OUTBOX_STATUSES) {
      lines.push('factoryos_outbox_oldest_age_seconds{status="' + status + '"} ' + (this.outboxOldestAgeSeconds.get(status) ?? 0));
    }
    lines.push(
      '# HELP factoryos_outbox_freshness_seconds_since_last_publish Seconds since a successful outbox publication; -1 means no known publication.',
      '# TYPE factoryos_outbox_freshness_seconds_since_last_publish gauge',
      'factoryos_outbox_freshness_seconds_since_last_publish ' + this.outboxSecondsSinceLastPublish,
      '# HELP factoryos_outbox_metrics_snapshot_age_seconds Age of the last tenant-scoped queue metrics snapshot; -1 means no snapshot yet.',
      '# TYPE factoryos_outbox_metrics_snapshot_age_seconds gauge',
      'factoryos_outbox_metrics_snapshot_age_seconds ' + (this.outboxMetricsCollectedAtMs > 0
        ? Math.max(0, (Date.now() - this.outboxMetricsCollectedAtMs) / 1000).toFixed(3) : -1),
      '# HELP factoryos_outbox_metrics_collection_success Last queue metrics collection status: 1 success, 0 failed, -1 never attempted.',
      '# TYPE factoryos_outbox_metrics_collection_success gauge',
      'factoryos_outbox_metrics_collection_success ' + this.outboxMetricsCollectionHealthy,
      '# HELP factoryos_outbox_metrics_collection_errors_total Tenant-scoped queue metrics collection failures.',
      '# TYPE factoryos_outbox_metrics_collection_errors_total counter',
      'factoryos_outbox_metrics_collection_errors_total ' + this.outboxMetricsCollectionErrors,
    );

    lines.push(
      '# HELP factoryos_trace_spans_exported_total Trace spans successfully exported via OTLP/HTTP.',
      '# TYPE factoryos_trace_spans_exported_total counter',
      'factoryos_trace_spans_exported_total ' + this.traceSpansExported,
      '# HELP factoryos_trace_spans_dropped_total Trace spans not exported because the bounded queue was full.',
      '# TYPE factoryos_trace_spans_dropped_total counter',
      'factoryos_trace_spans_dropped_total ' + this.traceSpansDropped,
      '# HELP factoryos_trace_export_errors_total Failed OTLP export attempts.',
      '# TYPE factoryos_trace_export_errors_total counter',
      'factoryos_trace_export_errors_total ' + this.traceExportErrors,
      '# HELP factoryos_trace_export_queue_length Current in-memory trace export queue length.',
      '# TYPE factoryos_trace_export_queue_length gauge',
      'factoryos_trace_export_queue_length ' + this.traceQueueLength,
    );
    return lines.join('\n') + '\n';
  }
}
