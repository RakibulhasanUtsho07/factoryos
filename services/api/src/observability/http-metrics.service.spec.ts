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
