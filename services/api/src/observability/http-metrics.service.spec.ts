import { HttpMetricsService } from './http-metrics.service';

describe('HttpMetricsService', () => {
  it('records low-cardinality counters and cumulative histogram buckets', () => {
    const metrics = new HttpMetricsService();
    const method = metrics.beginRequest('GET');
    metrics.completeRequest(method, 200, 0.04);

    const output = metrics.renderPrometheus();
    expect(output).toContain('factoryos_http_requests_total{method="GET",status_class="2xx"} 1');
    expect(output).toContain('factoryos_http_requests_in_flight{method="GET"} 0');
    expect(output).toContain('factoryos_http_request_duration_seconds_bucket{method="GET",le="0.05"} 1');
    expect(output).toContain('factoryos_http_request_duration_seconds_bucket{method="GET",le="0.01"} 0');
    expect(output).toContain('factoryos_http_request_duration_seconds_count{method="GET"} 1');
    expect(output).toContain('factoryos_process_uptime_seconds ');
  });

  it('normalizes unknown methods and classifies aborted requests without unbounded labels', () => {
    const metrics = new HttpMetricsService();
    metrics.completeRequest(metrics.beginRequest('/tenant/a/secret-id'), 499, 0.2);
    const output = metrics.renderPrometheus();
    expect(output).toContain('factoryos_http_requests_total{method="OTHER",status_class="4xx"} 1');
    expect(output).not.toContain('secret-id');
    expect(output).not.toContain('/tenant/a');
  });

  it('records bounded route counters, process gauges and dependency health', () => {
    const metrics = new HttpMetricsService();
    const method = metrics.beginRequest('GET');
    metrics.completeRequest(method, 200, 0.03, '/api/orders/:orderId');
    metrics.setDependencyHealth('database', true);
    const output = metrics.renderPrometheus();
    expect(output).toContain('factoryos_http_route_requests_total{method="GET",route="/api/orders/:orderId",status_class="2xx"} 1');
    expect(output).toContain('factoryos_dependency_health{dependency="database"} 1');
    expect(output).toContain('factoryos_process_memory_bytes{type="rss"} ');
    expect(output).toContain('factoryos_process_cpu_seconds_total{mode="user"} ');
    expect(output).toContain('factoryos_nodejs_event_loop_utilization_ratio ');
    expect(output).toContain('factoryos_trace_export_queue_length 0');
  });

  it('normalizes arbitrary path values rather than exposing identifiers as route labels', () => {
    const metrics = new HttpMetricsService();
    metrics.completeRequest(metrics.beginRequest('GET'), 404, 0.01, '/api/orders/123456');
    const output = metrics.renderPrometheus();
    expect(output).toContain('route="/api/orders/:id"');
    expect(output).not.toContain('route="/api/orders/123456"');
  });

  it('clamps invalid durations and prevents the in-flight gauge from becoming negative', () => {
    const metrics = new HttpMetricsService();
    const method = metrics.beginRequest('POST');
    metrics.completeRequest(method, 503, Number.NaN);
    metrics.completeRequest(method, 503, -1);
    const output = metrics.renderPrometheus();
    expect(output).toContain('factoryos_http_requests_total{method="POST",status_class="5xx"} 2');
    expect(output).toContain('factoryos_http_requests_in_flight{method="POST"} 0');
    expect(output).toContain('factoryos_http_request_duration_seconds_sum{method="POST"} 0.000000');
  });
});
