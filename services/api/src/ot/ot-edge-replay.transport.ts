import type { OtEdgeScope, OtEdgeTelemetryEvent, OtTelemetryReplayTransport } from './ot-edge-spool.store';

type OtApiTokenProvider = () => string | Promise<string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Concrete spool-to-FactoryOS transport. Provide a token provider backed by the
 * gateway's workload identity when tokens need refreshing; a static env token is
 * supported for deployments whose identity mechanism already rotates the process.
 */
export class OtTelemetryHttpReplayTransport implements OtTelemetryReplayTransport {
  constructor(
    private readonly tokenProvider: OtApiTokenProvider = () => process.env.FACTORYOS_OT_API_TOKEN?.trim() ?? '',
  ) {}

  async deliver(scope: OtEdgeScope, events: OtEdgeTelemetryEvent[]) {
    this.validateScope(scope);
    if (!Array.isArray(events) || events.length < 1 || events.length > 20) {
      throw new Error('OT API replay batch must contain between 1 and 20 events');
    }
    const endpoint = this.resolveEndpoint(scope.device_id);
    const token = (await this.tokenProvider()).trim();
    if (token.length < 32) throw new Error('OT API service identity token is not configured');
    const expectedIds = new Set<string>();
    for (const event of events) {
      if (!event || typeof event.source_event_id !== 'string'
        || !/^[A-Za-z0-9_.:-]{1,200}$/.test(event.source_event_id)
        || expectedIds.has(event.source_event_id)) {
        throw new Error('OT API replay batch contains an invalid or duplicate source event ID');
      }
      expectedIds.add(event.source_event_id);
    }

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
          events: events.map((event) => ({
            source_event_id: event.source_event_id,
            event_type: event.event_type,
            stream_key: event.stream_key,
            ...(event.source_sequence === null ? {} : { source_sequence: event.source_sequence }),
            observed_at: event.observed_at,
            payload: event.payload,
          })),
        }),
        signal: AbortSignal.timeout(this.resolveTimeout()),
      });
    } catch {
      throw new Error('OT API telemetry replay request failed before acknowledgement');
    }
    if (!response.ok) throw new Error('OT API did not accept the telemetry replay batch');

    let decoded: unknown;
    try {
      decoded = JSON.parse(await this.readBoundedBody(response, 32 * 1024)) as unknown;
    } catch {
      throw new Error('OT API replay acknowledgement was invalid or oversized');
    }

    const envelope = this.asRecord(decoded);
    if (envelope['tenant_id'] !== scope.tenant_id) {
      throw new Error('OT API replay acknowledgement tenant did not match the queued scope');
    }
    const data = this.asRecord(envelope['data']);
    if (data['device_id'] !== scope.device_id || data['received'] !== events.length || !Array.isArray(data['items'])) {
      throw new Error('OT API replay acknowledgement did not match the queued device or batch');
    }
    if (data['items'].length !== events.length) throw new Error('OT API replay acknowledgement count was incomplete');
    const accepted = new Set(['ON_TIME', 'LATE', 'SEQUENCE_GAP', 'DUPLICATE_REPLAY']);
    const seen = new Set<string>();
    const results = data['items'].map((raw) => {
      const item = this.asRecord(raw);
      const sourceEventId = item['source_event_id'];
      const status = item['status'];
      if (typeof sourceEventId !== 'string' || !expectedIds.has(sourceEventId) || seen.has(sourceEventId)
        || typeof status !== 'string' || !accepted.has(status)) {
        throw new Error('OT API replay acknowledgement included an unexpected event or status');
      }
      seen.add(sourceEventId);
      return { source_event_id: sourceEventId, status };
    });
    if (seen.size !== expectedIds.size) throw new Error('OT API replay acknowledgement omitted an event');
    return results;
  }

  private validateScope(scope: OtEdgeScope): void {
    for (const [key, value] of Object.entries(scope)) {
      if (typeof value !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
        throw new Error('OT API replay scope ' + key + ' must be a UUID');
      }
    }
  }

  private resolveEndpoint(deviceId: string): URL {
    const configured = process.env.FACTORYOS_OT_API_URL?.trim();
    if (!configured) throw new Error('OT API replay base URL is not configured');
    let base: URL;
    try { base = new URL(configured); } catch {
      throw new Error('OT API replay base URL is invalid');
    }
    if (base.username || base.password || base.search || base.hash || (base.pathname !== '/' && base.pathname !== '')) {
      throw new Error('OT API replay base URL must be a fixed origin without path, credentials, query or fragment');
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    const developmentHttp = process.env.NODE_ENV !== 'production' && loopback && base.protocol === 'http:';
    if (base.protocol !== 'https:' && !developmentHttp) {
      throw new Error('OT API replay transport requires HTTPS outside loopback development');
    }
    base.pathname = '/api/ot/devices/' + encodeURIComponent(deviceId) + '/telemetry/batch';
    return base;
  }

  private resolveTimeout(): number {
    const configured = process.env.FACTORYOS_OT_API_TIMEOUT_MS;
    if (configured === undefined || configured.trim() === '') return 3500;
    const timeout = Number(configured);
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 5000) {
      throw new Error('OT API replay timeout must be an integer from 100 to 5000 ms');
    }
    return timeout;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) throw new Error('OT API acknowledgement object is invalid');
    return value;
  }

  private async readBoundedBody(response: Response, maxBytes: number): Promise<string> {
    if (!response.body) throw new Error('OT API acknowledgement body is empty');
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
          throw new Error('OT API acknowledgement exceeds the response limit');
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
