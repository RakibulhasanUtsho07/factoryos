import {
  BadGatewayException,
  GatewayTimeoutException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { decodeModbusRegisters, type ModbusRegisterDefinition } from './ot-protocol.contract';

export interface ModbusGatewayReadInput {
  requestId: string;
  tenantId: string;
  factoryId: string;
  deviceId: string;
  deviceKey: string;
  connectionReference: string;
  unitId: number;
  registerMap: ModbusRegisterDefinition[];
}

export interface ModbusReadValue {
  stream_key: string;
  value: number;
  observed_at: string;
  source_sequence: number | null;
}

/** Read-only API to trusted OT edge gateway. The gateway receives register addresses, never credentials or target URLs. */
@Injectable()
export class ModbusGatewayClient {
  async read(input: ModbusGatewayReadInput): Promise<{ request_id: string; values: ModbusReadValue[] }> {
    const endpoint = this.resolveEndpoint();
    const token = process.env.FACTORYOS_OT_PROTOCOL_GATEWAY_TOKEN?.trim();
    if (!token || token.length < 32) {
      throw new ServiceUnavailableException('OT protocol gateway authentication is not configured');
    }
    if (!Array.isArray(input.registerMap) || input.registerMap.length < 1 || input.registerMap.length > 10) {
      throw new BadGatewayException('Modbus read batch exceeds the adapter contract');
    }
    const timeoutMs = this.resolveTimeout();
    let response: Response;
    try {
      response = await fetch(endpoint.toString(), {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          schema_version: 1,
          request_id: input.requestId,
          protocol: 'MODBUS_TCP',
          tenant_id: input.tenantId,
          factory_id: input.factoryId,
          device_id: input.deviceId,
          device_key: input.deviceKey,
          connection_reference: input.connectionReference,
          unit_id: input.unitId,
          register_map: input.registerMap.map((item) => ({
            stream_key: item.stream_key,
            function_code: item.function_code,
            address: item.address,
            quantity: item.quantity,
          })),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new GatewayTimeoutException('Modbus read gateway timed out');
      }
      throw new ServiceUnavailableException('Modbus read gateway is unavailable');
    }
    if (!response.ok) throw new BadGatewayException('Modbus read gateway rejected the read request');

    let decoded: unknown;
    try {
      decoded = JSON.parse(await this.readBoundedBody(response, 16384)) as unknown;
    } catch {
      throw new BadGatewayException('Modbus read gateway returned an invalid or oversized response');
    }

    try {
      const envelope = this.asRecord(decoded);
      if (envelope['schema_version'] !== 1 || envelope['request_id'] !== input.requestId) {
        throw new Error('response envelope mismatch');
      }
      const rawResults = envelope['results'];
      if (!Array.isArray(rawResults) || rawResults.length !== input.registerMap.length) {
        throw new Error('result count mismatch');
      }
      const expected = new Map(input.registerMap.map((item) => [item.stream_key, item]));
      const seen = new Set<string>();
      const values: ModbusReadValue[] = rawResults.map((raw) => {
        const row = this.asRecord(raw);
        const streamKey = row['stream_key'];
        if (typeof streamKey !== 'string' || !expected.has(streamKey) || seen.has(streamKey)) {
          throw new Error('unexpected stream key');
        }
        seen.add(streamKey);
        const definition = expected.get(streamKey)!;
        const words = row['registers'];
        if (!Array.isArray(words) || words.length !== definition.quantity
          || words.some((word) => !Number.isInteger(word) || Number(word) < 0 || Number(word) > 65535)) {
          throw new Error('register response does not match the requested type');
        }
        const observedAt = row['observed_at'];
        if (typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))) {
          throw new Error('invalid observation timestamp');
        }
        const sourceSequence = row['source_sequence'] ?? null;
        if (sourceSequence !== null && (!Number.isSafeInteger(sourceSequence) || Number(sourceSequence) < 1)) {
          throw new Error('invalid source sequence');
        }
        const value = decodeModbusRegisters(words as number[], definition.data_type, definition.word_order);
        return {
          stream_key: streamKey,
          value,
          observed_at: new Date(observedAt).toISOString(),
          source_sequence: sourceSequence as number | null,
        };
      });
      if (seen.size !== expected.size) throw new Error('missing stream result');
      values.sort((a, b) => input.registerMap.findIndex((x) => x.stream_key === a.stream_key)
        - input.registerMap.findIndex((x) => x.stream_key === b.stream_key));
      return { request_id: input.requestId, values };
    } catch {
      throw new BadGatewayException('Modbus read gateway response failed schema or register-map validation');
    }
  }

  private resolveEndpoint(): URL {
    const configured = process.env.FACTORYOS_OT_PROTOCOL_GATEWAY_URL?.trim();
    if (!configured) throw new ServiceUnavailableException('OT protocol gateway is not configured');
    let endpoint: URL;
    try { endpoint = new URL(configured); } catch {
      throw new ServiceUnavailableException('OT protocol gateway URL is invalid');
    }
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || !endpoint.pathname.endsWith('/api/v1/modbus/read')) {
      throw new ServiceUnavailableException('OT protocol gateway URL must be a fixed /api/v1/modbus/read endpoint');
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
    const developmentHttp = process.env.NODE_ENV !== 'production' && loopback && endpoint.protocol === 'http:';
    if (endpoint.protocol !== 'https:' && !developmentHttp) {
      throw new ServiceUnavailableException('OT protocol gateway must use HTTPS outside local development');
    }
    return endpoint;
  }

  private resolveTimeout(): number {
    const configured = process.env.FACTORYOS_OT_PROTOCOL_GATEWAY_TIMEOUT_MS;
    if (configured === undefined || configured.trim() === '') return 3500;
    const timeout = Number(configured);
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 5000) {
      throw new ServiceUnavailableException('OT protocol gateway timeout must be an integer from 100 to 5000 ms');
    }
    return timeout;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object');
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('expected plain object');
    return value as Record<string, unknown>;
  }

  private async readBoundedBody(response: Response, maxBytes: number): Promise<string> {
    if (!response.body) throw new Error('response body is empty');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Error('response body exceeds limit');
        }
        chunks.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }
    const combined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', { fatal: true }).decode(combined);
  }
}
