import { jest } from '@jest/globals';
import { OtTelemetryHttpReplayTransport } from './ot-edge-replay.transport';
import type { OtEdgeScope, OtEdgeTelemetryEvent } from './ot-edge-spool.store';

const scope: OtEdgeScope = {
  tenant_id: 'faaab63d-c447-46ce-950d-deebdd7f5f30',
  factory_id: '8aaab63d-c447-46ce-950d-deebdd7f5f31',
  device_id: '9aaab63d-c447-46ce-950d-deebdd7f5f32',
};
const event: OtEdgeTelemetryEvent = {
  source_event_id: 'mqtt:event-1',
  event_type: 'TEMPERATURE',
  stream_key: 'LINE-1',
  source_sequence: null,
  observed_at: '2026-10-20T10:00:00.000Z',
  payload: { temperature: 24.5 },
};
const envelope = (overrides: Record<string, unknown> = {}) => ({
  request_id: 'request-1',
  trace_id: 'trace-1',
  api_version: 'v1',
  tenant_id: scope.tenant_id,
  data: {
    device_id: scope.device_id,
    received: 1,
    accepted: 1,
    duplicate_replays: 0,
    late: 0,
    sequence_gaps: 0,
    items: [{ source_event_id: event.source_event_id, status: 'ON_TIME' }],
  },
  meta: {},
  errors: [],
  ...overrides,
});

describe('OtTelemetryHttpReplayTransport', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock<(...args: unknown[]) => Promise<unknown>>;
  let transport: OtTelemetryHttpReplayTransport;

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.FACTORYOS_OT_API_URL = 'https://factoryos.internal';
    process.env.FACTORYOS_OT_API_TOKEN = 'test-service-identity-token-with-more-than-32-chars';
    delete process.env.FACTORYOS_OT_API_TIMEOUT_MS;
    fetchMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();
    global.fetch = fetchMock as unknown as typeof fetch;
    transport = new OtTelemetryHttpReplayTransport();
  });
  afterAll(() => {
    global.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it('sends an idempotent batch to the scoped telemetry route and validates its API envelope', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(envelope()), { status: 200 }));
    await expect(transport.deliver(scope, [event])).resolves.toEqual([
      { source_event_id: 'mqtt:event-1', status: 'ON_TIME' },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://factoryos.internal/api/ot/devices/9aaab63d-c447-46ce-950d-deebdd7f5f32/telemetry/batch');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-service-identity-token-with-more-than-32-chars');
    expect(JSON.parse(String(init.body))).toEqual({ events: [{
      source_event_id: 'mqtt:event-1',
      event_type: 'TEMPERATURE',
      stream_key: 'LINE-1',
      observed_at: '2026-10-20T10:00:00.000Z',
      payload: { temperature: 24.5 },
    }] });
  });

  it('rejects wrong tenant, incomplete acknowledgements and remote HTTP URLs', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(envelope({ tenant_id: 'bbbbbb63-c447-46ce-950d-deebdd7f5f30' })), { status: 200 }));
    await expect(transport.deliver(scope, [event])).rejects.toThrow(/tenant/);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(envelope({ data: { ...envelope().data, items: [] } })), { status: 200 }));
    await expect(transport.deliver(scope, [event])).rejects.toThrow(/count/);
    process.env.FACTORYOS_OT_API_URL = 'http://factoryos.remote';
    await expect(transport.deliver(scope, [event])).rejects.toThrow(/HTTPS/);
  });

  it('supports a token provider for rotating workload identities', async () => {
    const rotating = new OtTelemetryHttpReplayTransport(async () => 'rotated-identity-token-with-more-than-32-chars');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(envelope()), { status: 200 }));
    await rotating.deliver(scope, [event]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer rotated-identity-token-with-more-than-32-chars');
  });
});
