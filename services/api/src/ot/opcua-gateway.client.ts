import {
  BadGatewayException,
  GatewayTimeoutException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  canonicalOtJson,
  normalizeOtObject,
  validateOpcUaNodeId,
} from './ot-device.contract';

export type OpcUaValueStatus = 'GOOD' | 'UNCERTAIN' | 'BAD';

export interface OpcUaGatewayReadInput {
  requestId: string;
  tenantId: string;
  factoryId: string;
  deviceId: string;
  deviceKey: string;
  connectionReference: string;
  nodeIds: string[];
}

export interface OpcUaReadValue {
  node_id: string;
  status: OpcUaValueStatus;
  value: unknown;
  source_timestamp: string | null;
  server_timestamp: string | null;
  source_sequence: number | null;
}

/**
 * Central API -> trusted OT edge gateway contract. The URL and bearer token are
 * deployment configuration only; request payloads can never select a network host.
 * The edge gateway resolves connection references and credentials in its own trust zone.
 */
@Injectable()
export class OpcUaGatewayClient {
  async read(input: OpcUaGatewayReadInput): Promise<{ request_id: string; values: OpcUaReadValue[] }> {
    const endpoint = this.resolveEndpoint();
    const token = process.env.FACTORYOS_OPCUA_GATEWAY_TOKEN?.trim();
    if (!token || token.length < 32) {
      throw new ServiceUnavailableException('OPC UA read gateway authentication is not configured');
    }
    if (!Array.isArray(input.nodeIds) || input.nodeIds.length < 1 || input.nodeIds.length > 10) {
      throw new BadGatewayException('OPC UA read batch exceeds the adapter contract');
    }
    const nodeIds = input.nodeIds.map(validateOpcUaNodeId);
    const timeoutMs = this.resolveTimeout();
    let response: Response;
    try {
      response = await fetch(endpoint.toString(), {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          schema_version: 1,
          request_id: input.requestId,
          tenant_id: input.tenantId,
          factory_id: input.factoryId,
          device_id: input.deviceId,
          device_key: input.deviceKey,
          connection_reference: input.connectionReference,
          node_ids: nodeIds,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new GatewayTimeoutException('OPC UA read gateway timed out');
      }
      throw new ServiceUnavailableException('OPC UA read gateway is unavailable');
    }

    if (!response.ok) {
      throw new BadGatewayException('OPC UA read gateway rejected the read request');
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(await this.readBoundedBody(response, 16384)) as unknown;
    } catch {
      throw new BadGatewayException('OPC UA read gateway returned an invalid or oversized response');
    }

    try {
      const envelope = this.asRecord(decoded, 'response');
      if (envelope['schema_version'] !== 1 || envelope['request_id'] !== input.requestId) {
        throw new Error('response envelope does not match the request');
      }
      const rawResults = envelope['results'];
      if (!Array.isArray(rawResults) || rawResults.length !== nodeIds.length) {
        throw new Error('response node count does not match the request');
      }
      const expected = new Set(nodeIds);
      const seen = new Set<string>();
      const values: OpcUaReadValue[] = rawResults.map((raw) => {
        const row = this.asRecord(raw, 'result');
        const nodeId = validateOpcUaNodeId(row['node_id']);
        if (!expected.has(nodeId) || seen.has(nodeId)) {
          throw new Error('response includes an unrequested or duplicated NodeId');
        }
        seen.add(nodeId);
        const status = row['status'];
        if (status !== 'GOOD' && status !== 'UNCERTAIN' && status !== 'BAD') {
          throw new Error('response has an unsupported OPC UA quality');
        }
        if (!Object.prototype.hasOwnProperty.call(row, 'value')) {
          throw new Error('response value is missing');
        }
        const normalizedValue = normalizeOtObject({ value: row['value'] }, 'OPC UA value');
        if (Buffer.byteLength(canonicalOtJson(normalizedValue), 'utf8') > 4096) {
          throw new Error('OPC UA value exceeds the payload bound');
        }
        const sourceSequence = row['source_sequence'] ?? null;
        if (sourceSequence !== null && (!Number.isSafeInteger(sourceSequence) || Number(sourceSequence) < 1)) {
          throw new Error('response source sequence is invalid');
        }
        return {
          node_id: nodeId,
          status,
          value: normalizedValue['value'],
          source_timestamp: this.normalizeTimestamp(row['source_timestamp']),
          server_timestamp: this.normalizeTimestamp(row['server_timestamp']),
          source_sequence: sourceSequence as number | null,
        };
      });
      if (seen.size !== expected.size) throw new Error('response omits a requested NodeId');
      values.sort((left, right) => nodeIds.indexOf(left.node_id) - nodeIds.indexOf(right.node_id));
      return { request_id: input.requestId, values };
    } catch {
      throw new BadGatewayException('OPC UA read gateway response failed schema or NodeId validation');
    }
  }

  private resolveEndpoint(): URL {
    const configured = process.env.FACTORYOS_OPCUA_GATEWAY_URL?.trim();
    if (!configured) throw new ServiceUnavailableException('OPC UA read gateway is not configured');
    let endpoint: URL;
    try {
      endpoint = new URL(configured);
    } catch {
      throw new ServiceUnavailableException('OPC UA read gateway URL is invalid');
    }
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || !endpoint.pathname.endsWith('/api/v1/read')) {
      throw new ServiceUnavailableException('OPC UA read gateway URL must be a fixed /api/v1/read endpoint');
    }
    const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
    const developmentHttp = process.env.NODE_ENV !== 'production' && localHost && endpoint.protocol === 'http:';
    if (endpoint.protocol !== 'https:' && !developmentHttp) {
      throw new ServiceUnavailableException('OPC UA read gateway must use HTTPS outside local development');
    }
    return endpoint;
  }

  private resolveTimeout(): number {
    const configured = process.env.FACTORYOS_OPCUA_GATEWAY_TIMEOUT_MS;
    if (configured === undefined || configured.trim() === '') return 3500;
    const timeout = Number(configured);
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 5000) {
      throw new ServiceUnavailableException('OPC UA gateway timeout must be an integer from 100 to 5000 ms');
    }
    return timeout;
  }

  private normalizeTimestamp(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') throw new Error('timestamp must be a string');
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) throw new Error('timestamp is invalid');
    return parsed.toISOString();
  }

  private asRecord(value: unknown, label: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(label + ' must be an object');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(label + ' is not plain JSON');
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
          throw new Error('response body exceeds the configured limit');
        }
        chunks.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }
    const combined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(combined);
  }
}
