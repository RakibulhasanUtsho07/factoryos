const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'OTHER'] as const;
type HttpMethodLabel = (typeof HTTP_METHODS)[number];
const STATUS_CLASSES = ['1xx', '2xx', '3xx', '4xx', '5xx', 'other'] as const;
const BUCKETS_SECONDS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] as const;

interface DurationAggregate {
  /** Cumulative counts for each finite Prometheus histogram bucket. */
  bucketCounts: number[];
  count: number;
  sum: number;
}

function normalizeMethod(method: string): HttpMethodLabel {
  const normalized = method.trim().toUpperCase();
  return (HTTP_METHODS as readonly string[]).includes(normalized)
    ? normalized as HttpMethodLabel
    : 'OTHER';
}

function normalizeStatus(statusCode: number): (typeof STATUS_CLASSES)[number] {
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) return 'other';
  return (Math.floor(statusCode / 100) + 'xx') as (typeof STATUS_CLASSES)[number];
}

/**
 * Low-cardinality, process-local HTTP metrics for Prometheus-compatible scraping.
 * Never label metrics by tenant, user, request ID, trace ID or arbitrary URL.
 */
export class HttpMetricsService {
  private readonly requestCounts = new Map<string, number>();
  private readonly inFlight = new Map<HttpMethodLabel, number>();
  private readonly durations = new Map<HttpMethodLabel, DurationAggregate>();

  beginRequest(method: string): HttpMethodLabel {
    const label = normalizeMethod(method);
    this.inFlight.set(label, (this.inFlight.get(label) ?? 0) + 1);
    return label;
  }

  completeRequest(method: HttpMethodLabel, statusCode: number, durationSeconds: number): void {
    this.inFlight.set(method, Math.max(0, (this.inFlight.get(method) ?? 0) - 1));
    const statusClass = normalizeStatus(statusCode);
    const key = method + '\u0000' + statusClass;
    this.requestCounts.set(key, (this.requestCounts.get(key) ?? 0) + 1);

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

  renderPrometheus(): string {
    const lines = [
      '# HELP factoryos_http_requests_total Completed HTTP requests by method and status class.',
      '# TYPE factoryos_http_requests_total counter',
    ];
    for (const method of HTTP_METHODS) {
      for (const statusClass of STATUS_CLASSES) {
        const value = this.requestCounts.get(method + '\u0000' + statusClass) ?? 0;
        lines.push(`factoryos_http_requests_total{method="${method}",status_class="${statusClass}"} ${value}`);
      }
    }

    lines.push(
      '# HELP factoryos_http_requests_in_flight Current HTTP requests that have not completed.',
      '# TYPE factoryos_http_requests_in_flight gauge',
    );
    for (const method of HTTP_METHODS) {
      lines.push(`factoryos_http_requests_in_flight{method="${method}"} ${this.inFlight.get(method) ?? 0}`);
    }

    lines.push(
      '# HELP factoryos_http_request_duration_seconds HTTP request duration in seconds.',
      '# TYPE factoryos_http_request_duration_seconds histogram',
    );
    for (const method of HTTP_METHODS) {
      const aggregate = this.durations.get(method) ?? {
        bucketCounts: BUCKETS_SECONDS.map(() => 0),
        count: 0,
        sum: 0,
      };
      BUCKETS_SECONDS.forEach((bound, index) => {
        lines.push(
          `factoryos_http_request_duration_seconds_bucket{method="${method}",le="${bound}"} ${aggregate.bucketCounts[index]}`,
        );
      });
      lines.push(`factoryos_http_request_duration_seconds_bucket{method="${method}",le="+Inf"} ${aggregate.count}`);
      lines.push(`factoryos_http_request_duration_seconds_sum{method="${method}"} ${aggregate.sum.toFixed(6)}`);
      lines.push(`factoryos_http_request_duration_seconds_count{method="${method}"} ${aggregate.count}`);
    }

    lines.push(
      '# HELP factoryos_process_uptime_seconds Process uptime in seconds.',
      '# TYPE factoryos_process_uptime_seconds gauge',
      `factoryos_process_uptime_seconds ${Math.max(0, process.uptime()).toFixed(3)}`,
    );
    return lines.join('\n') + '\n';
  }
}
