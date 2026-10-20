import { jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import { OtlpTraceExporter } from './otlp-trace-exporter.service';
import { HttpMetricsService } from './http-metrics.service';

describe('OtlpTraceExporter', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock<(...args: unknown[]) => Promise<unknown>>;
  let counters: {
    setTraceQueueLength: jest.Mock;
    recordTraceExported: jest.Mock;
    recordTraceDropped: jest.Mock;
    recordTraceExportError: jest.Mock;
  };

  const context = {
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    spanId: '00f067aa0ba902b7',
    parentSpanId: 'b7ad6b7169203331',
    traceFlags: '01',
    sampled: true,
    traceState: null,
    startTimeUnixNano: '1760961600000000000',
  };

  function create(config: Record<string, string | undefined>) {
    counters = {
      setTraceQueueLength: jest.fn(),
      recordTraceExported: jest.fn(),
      recordTraceDropped: jest.fn(),
      recordTraceExportError: jest.fn(),
    };
    const configService = {
      get: jest.fn((key: string) => config[key]),
    } as unknown as ConfigService;
    return new OtlpTraceExporter(configService, counters as unknown as HttpMetricsService);
  }

  beforeEach(() => {
    fetchMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterAll(() => { global.fetch = originalFetch; });

  it('batches sampled server spans as OTLP JSON with trace parent, service resource and bounded attributes', async () => {
    const exporter = create({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://otel-collector.internal/v1/traces',
      OTEL_EXPORTER_OTLP_TRACES_TOKEN: 'trace-collector-token',
      OTEL_SERVICE_NAME: 'factoryos-api',
      NODE_ENV: 'production',
      HOSTNAME: 'api-instance-2',
    });
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    exporter.exportServerSpan({
      context, method: 'GET', route: '/api/orders/:orderId', statusCode: 200,
      startTimeUnixNano: context.startTimeUnixNano,
      endTimeUnixNano: '1760961600050000000',
      durationMs: 50, requestId: 'request-123',
    });
    await exporter.flushNow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://otel-collector.internal/v1/traces');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer trace-collector-token');
    const body = JSON.parse(String(init.body)) as Record<string, any>;
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(body.resourceSpans[0].resource.attributes).toEqual(expect.arrayContaining([
      { key: 'service.name', value: { stringValue: 'factoryos-api' } },
      { key: 'service.instance.id', value: { stringValue: 'api-instance-2' } },
    ]));
    expect(span).toMatchObject({
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      name: 'GET /api/orders/:orderId',
      kind: 2,
      status: { code: 1 },
    });
    expect(span.attributes).toContainEqual({ key: 'http.route', value: { stringValue: '/api/orders/:orderId' } });
    expect(counters.recordTraceExported).toHaveBeenCalledWith(1);
    expect(counters.recordTraceExportError).not.toHaveBeenCalled();
  });

  it('skips unsampled spans and records invalid endpoint/export failures without affecting the caller', async () => {
    const exporter = create({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://remote-collector.internal/v1/traces',
      NODE_ENV: 'production',
    });
    exporter.exportServerSpan({
      context: { ...context, sampled: false }, method: 'POST', route: '/api/orders',
      statusCode: 500, startTimeUnixNano: context.startTimeUnixNano,
      endTimeUnixNano: context.startTimeUnixNano, durationMs: 1, requestId: 'request-2',
    });
    await exporter.flushNow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(counters.recordTraceExportError).not.toHaveBeenCalled();

    exporter.exportServerSpan({
      context, method: 'POST', route: '/api/orders', statusCode: 500,
      startTimeUnixNano: context.startTimeUnixNano,
      endTimeUnixNano: context.startTimeUnixNano, durationMs: 1, requestId: 'request-3',
    });
    await exporter.flushNow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(counters.recordTraceExportError).toHaveBeenCalledTimes(1);
  });

  it('exports PostgreSQL operations as child client spans without SQL text or parameter values', async () => {
    const exporter = create({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://otel-collector.internal/v1/traces',
      NODE_ENV: 'production',
    });
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    exporter.exportDatabaseOperation({
      context,
      operation: 'SELECT',
      status: 'success',
      startTimeUnixNano: context.startTimeUnixNano,
      endTimeUnixNano: '1760961600010000000',
      durationMs: 10,
    });
    await exporter.flushNow();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, any>;
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span).toMatchObject({
      traceId: context.traceId,
      parentSpanId: context.spanId,
      name: 'postgresql select',
      kind: 3,
      status: { code: 1 },
    });
    expect(span.attributes).toContainEqual({ key: 'db.system', value: { stringValue: 'postgresql' } });
    expect(span.attributes).toContainEqual({ key: 'db.operation.name', value: { stringValue: 'SELECT' } });
    expect(JSON.stringify(span)).not.toContain('SELECT *');
    expect(counters.recordTraceExported).toHaveBeenCalledWith(1);
  });

  it('records collector failures while dropping the failed batch instead of retaining an infinite backlog', async () => {
    const exporter = create({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://otel-collector.internal/v1/traces', NODE_ENV: 'production' });
    fetchMock.mockResolvedValueOnce(new Response('rejected', { status: 503 }));
    exporter.exportServerSpan({
      context, method: 'GET', route: '/api/health', statusCode: 503,
      startTimeUnixNano: context.startTimeUnixNano,
      endTimeUnixNano: context.startTimeUnixNano, durationMs: 100, requestId: 'request-4',
    });
    await exporter.flushNow();
    expect(counters.recordTraceExportError).toHaveBeenCalledTimes(1);
    expect(counters.setTraceQueueLength).toHaveBeenLastCalledWith(0);
  });
});
