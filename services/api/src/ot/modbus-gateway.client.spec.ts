import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import { jest } from '@jest/globals';
import { ModbusGatewayClient } from './modbus-gateway.client';

const request = {
  requestId: 'aaaaab63-c447-46ce-950d-deebdd7f5f33',
  tenantId: 'faaab63d-c447-46ce-950d-deebdd7f5f30',
  factoryId: '8aaab63d-c447-46ce-950d-deebdd7f5f31',
  deviceId: '9aaab63d-c447-46ce-950d-deebdd7f5f32',
  deviceKey: 'MACHINE-01',
  connectionReference: 'config://PLC_A',
  unitId: 7,
  registerMap: [{ stream_key: 'LINE_TEMPERATURE', function_code: 4 as const, address: 10, quantity: 2, data_type: 'FLOAT32' as const, word_order: 'ABCD' as const }],
};

describe('ModbusGatewayClient', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  let client: ModbusGatewayClient;
  let fetchMock: jest.Mock<(...args: unknown[]) => Promise<unknown>>;
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.FACTORYOS_OT_PROTOCOL_GATEWAY_URL = 'https://ot-gateway.internal/api/v1/modbus/read';
    process.env.FACTORYOS_OT_PROTOCOL_GATEWAY_TOKEN = 'test-protocol-gateway-token-with-more-than-32-chars';
    delete process.env.FACTORYOS_OT_PROTOCOL_GATEWAY_TIMEOUT_MS;
    fetchMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();
    global.fetch = fetchMock as unknown as typeof fetch;
    client = new ModbusGatewayClient();
  });
  afterAll(() => {
    global.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  it('requests only mapped register reads and deterministically decodes gateway words', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ schema_version: 1, request_id: request.requestId, results: [{ stream_key: 'LINE_TEMPERATURE', registers: [0x4120, 0], observed_at: '2026-10-20T12:00:00+00:00', source_sequence: 4 }] }), { status: 200 }));
    const result = await client.read(request);
    expect(result.values[0]).toMatchObject({ stream_key: 'LINE_TEMPERATURE', value: 10, observed_at: '2026-10-20T12:00:00.000Z', source_sequence: 4 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ot-gateway.internal/api/v1/modbus/read');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(JSON.parse(String(init.body))).toMatchObject({ schema_version: 1, protocol: 'MODBUS_TCP', connection_reference: 'config://PLC_A', unit_id: 7, register_map: [{ stream_key: 'LINE_TEMPERATURE', function_code: 4, address: 10, quantity: 2 }] });
    expect(String(init.body)).not.toContain('secret_reference');
    expect(String(init.body)).not.toContain('test-protocol-gateway-token-with-more-than-32-chars');
  });
  it('requires a fixed HTTPS endpoint and sufficiently long service credential', async () => {
    delete process.env.FACTORYOS_OT_PROTOCOL_GATEWAY_URL;
    await expect(client.read(request)).rejects.toBeInstanceOf(ServiceUnavailableException);
    process.env.FACTORYOS_OT_PROTOCOL_GATEWAY_URL = 'http://remote.internal/api/v1/modbus/read';
    await expect(client.read(request)).rejects.toBeInstanceOf(ServiceUnavailableException);
    process.env.FACTORYOS_OT_PROTOCOL_GATEWAY_URL = 'https://ot-gateway.internal/api/v1/modbus/write';
    await expect(client.read(request)).rejects.toBeInstanceOf(ServiceUnavailableException);
    process.env.FACTORYOS_OT_PROTOCOL_GATEWAY_URL = 'https://ot-gateway.internal/api/v1/modbus/read';
    delete process.env.FACTORYOS_OT_PROTOCOL_GATEWAY_TOKEN;
    await expect(client.read(request)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects wrong request IDs, unexpected stream keys, invalid words and oversized batches', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ schema_version: 1, request_id: 'other-id', results: [] }), { status: 200 }));
    await expect(client.read(request)).rejects.toBeInstanceOf(BadGatewayException);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ schema_version: 1, request_id: request.requestId, results: [{ stream_key: 'UNREGISTERED', registers: [0x4120, 0], observed_at: '2026-10-20T12:00:00Z' }] }), { status: 200 }));
    await expect(client.read(request)).rejects.toBeInstanceOf(BadGatewayException);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ schema_version: 1, request_id: request.requestId, results: [{ stream_key: 'LINE_TEMPERATURE', registers: [70000, 0], observed_at: '2026-10-20T12:00:00Z' }] }), { status: 200 }));
    await expect(client.read(request)).rejects.toBeInstanceOf(BadGatewayException);
    await expect(client.read({ ...request, registerMap: Array.from({ length: 11 }, (_, i) => ({ ...request.registerMap[0]!, stream_key: 'STREAM_' + i })) })).rejects.toBeInstanceOf(BadGatewayException);
  });
});
