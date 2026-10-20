import { performance } from 'node:perf_hooks';

const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'OTHER'] as const;
type HttpMethodLabel = (typeof HTTP_METHODS)[number];
const STATUS_CLASSES = ['1xx', '2xx', '3xx', '4xx', '5xx', 'other'] as const;
const BUCKETS_SECONDS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] as const;
type DependencyName = 'database';

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

  setDependencyHealth(dependency: DependencyName, healthy: boolean): void {
    this.dependencyHealth.set(dependency, healthy ? 1 : 0);
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
