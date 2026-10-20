import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import { jest } from '@jest/globals';
import { OpcUaGatewayClient } from './opcua-gateway.client';
import { runWithTraceContext } from '../common/trace-context.store';

const request = {
  requestId: 'aaaaab63-c447-46ce-950d-deebdd7f5f33',
  tenantId: 'faaab63d-c447-46ce-950d-deebdd7f5f30',
  factoryId: '8aaab63d-c447-46ce-950d-deebdd7f5f31',
  deviceId: '9aaab63d-c447-46ce-950d-deebdd7f5f32',
  deviceKey: 'MACHINE-01',
  connectionReference: 'config://PLC_A',
  nodeIds: ['ns=2;s=Machine01.Temperature'],
};

describe('OpcUaGatewayClient', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  let client: OpcUaGatewayClient;
  let fetchMock: jest.Mock<(...args: unknown[]) => Promise<unknown>>;

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.FACTORYOS_OPCUA_GATEWAY_URL = 'https://ot-gateway.internal/api/v1/read';
    process.env.FACTORYOS_OPCUA_GATEWAY_TOKEN = 'test-gateway-token-with-more-than-32-chars';
    delete process.env.FACTORYOS_OPCUA_GATEWAY_TIMEOUT_MS;
    fetchMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();
    global.fetch = fetchMock as unknown as typeof fetch;
    client = new OpcUaGatewayClient();
  });

  afterAll(() => {
    global.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('sends only a bounded read request to the fixed configured gateway and normalizes values', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      schema_version: 1,
      request_id: request.requestId,
      results: [{
        node_id: 'ns=2;s=Machine01.Temperature',
        status: 'GOOD',
        value: 24.5,
        source_timestamp: '2026-10-20T12:00:00+00:00',
        server_timestamp: null,
        source_sequence: 7,
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const result = await client.read(request);
    expect(result.values[0]).toMatchObject({
      node_id: 'ns=2;s=Machine01.Temperature',
      status: 'GOOD',
      value: 24.5,
      source_timestamp: '2026-10-20T12:00:00.000Z',
      source_sequence: 7,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ot-gateway.internal/api/v1/read');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(JSON.parse(String(init.body))).toMatchObject({
      schema_version: 1,
      connection_reference: 'config://PLC_A',
      node_ids: request.nodeIds,
    });
    expect(String(init.body)).not.toContain('test-gateway-token-with-more-than-32-chars');
    expect(String(init.body)).not.toContain('secret_reference');
  });

  it('propagates the current W3C server span to the trusted OT gateway', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      schema_version: 1,
      request_id: request.requestId,
      results: [{
        node_id: 'ns=2;s=Machine01.Temperature',
        status: 'GOOD',
        value: 24.5,
        source_timestamp: null,
        server_timestamp: null,
        source_sequence: null,
      }],
    }), { status: 200 }));
    const trace = {
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      parentSpanId: null,
      traceFlags: '01',
      sampled: true,
      traceState: 'vendor=value',
      startTimeUnixNano: '1760961600000000000',
    };
    await runWithTraceContext(trace, () => client.read(request));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('traceparent')).toBe(
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    );
    expect(new Headers(init.headers).get('tracestate')).toBe('vendor=value');
  });

  it('fails closed when the gateway or service credential is not configured', async () => {
    delete process.env.FACTORYOS_OPCUA_GATEWAY_URL;
    await expect(client.read(request)).rejects.toBeInstanceOf(ServiceUnavailableException);
    process.env.FACTORYOS_OPCUA_GATEWAY_URL = 'https://ot-gateway.internal/api/v1/read';
    delete process.env.FACTORYOS_OPCUA_GATEWAY_TOKEN;
    await expect(client.read(request)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects non-HTTPS remote gateways and non-read paths', async () => {
    process.env.FACTORYOS_OPCUA_GATEWAY_URL = 'http://ot-gateway.internal/api/v1/read';
    await expect(client.read(request)).rejects.toBeInstanceOf(ServiceUnavailableException);
    process.env.FACTORYOS_OPCUA_GATEWAY_URL = 'https://ot-gateway.internal/api/v1/write';
    await expect(client.read(request)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unsolicited NodeIds and invalid response envelope identifiers', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      schema_version: 1,
      request_id: request.requestId,
      results: [{
        node_id: 'ns=2;s=Machine01.Pressure',
        status: 'GOOD', value: 2, source_timestamp: null, server_timestamp: null, source_sequence: null,
      }],
    }), { status: 200 }));
    await expect(client.read(request)).rejects.toBeInstanceOf(BadGatewayException);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      schema_version: 1, request_id: 'another-request', results: [],
    }), { status: 200 }));
    await expect(client.read(request)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('fails closed on credential-like values and oversized batches', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      schema_version: 1,
      request_id: request.requestId,
      results: [{
        node_id: 'ns=2;s=Machine01.Temperature',
        status: 'GOOD', value: { access_token: 'should-never-be-stored' },
        source_timestamp: null, server_timestamp: null, source_sequence: null,
      }],
    }), { status: 200 }));
    await expect(client.read(request)).rejects.toBeInstanceOf(BadGatewayException);
    await expect(client.read({ ...request, nodeIds: Array(11).fill('ns=2;s=Machine01.Temperature') }))
      .rejects.toBeInstanceOf(BadGatewayException);
  });
});
