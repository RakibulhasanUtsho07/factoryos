import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { DistributedTraceContext } from '../common/types/request-context';
import { HttpMetricsService } from './http-metrics.service';

export interface HttpServerSpan {
  context: DistributedTraceContext;
  method: string;
  route: string;
  statusCode: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  durationMs: number;
  requestId: string;
}

export interface DatabaseOperationSpan {
  context: DistributedTraceContext;
  operation: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'OTHER' | 'TRANSACTION';
  status: 'success' | 'error';
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  durationMs: number;
}

interface OtlpAttribute { key: string; value: { stringValue?: string; intValue?: string; boolValue?: boolean; doubleValue?: number } }
interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status: { code: number; message?: string };
}

const MAX_QUEUE = 2048;
const MAX_BATCH = 128;

@Injectable()
export class OtlpTraceExporter {
  private readonly queue: OtlpSpan[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private flushing = false;
  private enabled = false;

  constructor(private readonly config: ConfigService, private readonly metrics: HttpMetricsService) {
    this.enabled = Boolean(this.config.get<string>('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT')?.trim());
  }

  isEnabled(): boolean { return this.enabled; }

  exportServerSpan(input: HttpServerSpan): void {
    if (!this.enabled) return;
    if (!input.context.sampled) return;
    if (this.queue.length >= MAX_QUEUE) {
      this.metrics.recordTraceDropped(1);
      return;
    }
    const attributes: OtlpAttribute[] = [
      { key: 'http.request.method', value: { stringValue: input.method } },
      { key: 'http.route', value: { stringValue: input.route } },
      { key: 'http.response.status_code', value: { intValue: String(input.statusCode) } },
      { key: 'server.request.id', value: { stringValue: input.requestId } },
      { key: 'http.request.duration_ms', value: { doubleValue: Number(input.durationMs.toFixed(3)) } },
    ];
    const span: OtlpSpan = {
      traceId: input.context.traceId,
      spanId: input.context.spanId,
      ...(input.context.parentSpanId ? { parentSpanId: input.context.parentSpanId } : {}),
      name: input.method + ' ' + input.route,
      kind: 2,
      startTimeUnixNano: input.startTimeUnixNano,
      endTimeUnixNano: input.endTimeUnixNano,
      attributes,
      status: input.statusCode >= 500 ? { code: 2, message: 'HTTP server error' } : { code: 1 },
    };
    this.enqueue(span);
  }

  exportDatabaseOperation(input: DatabaseOperationSpan): void {
    if (!this.enabled || !input.context.sampled) return;
    const spanId = randomBytes(8).toString('hex');
    const span: OtlpSpan = {
      traceId: input.context.traceId,
      spanId,
      parentSpanId: input.context.spanId,
      name: 'postgresql ' + input.operation.toLowerCase(),
      kind: 3,
      startTimeUnixNano: input.startTimeUnixNano,
      endTimeUnixNano: input.endTimeUnixNano,
      attributes: [
        { key: 'db.system', value: { stringValue: 'postgresql' } },
        { key: 'db.operation.name', value: { stringValue: input.operation } },
        { key: 'db.operation.status', value: { stringValue: input.status } },
        { key: 'db.operation.duration_ms', value: { doubleValue: Number(input.durationMs.toFixed(3)) } },
      ],
      status: input.status === 'error' ? { code: 2, message: 'Database operation failed' } : { code: 1 },
    };
    this.enqueue(span);
  }

  private enqueue(span: OtlpSpan): void {
    if (this.queue.length >= MAX_QUEUE) {
      this.metrics.recordTraceDropped(1);
      return;
    }
    this.queue.push(span);
    this.metrics.setTraceQueueLength(this.queue.length);
    if (this.queue.length >= MAX_BATCH) {
      void this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        void this.flush();
      }, 1000);
      this.flushTimer.unref?.();
    }
  }

  async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const batch = this.queue.splice(0, MAX_BATCH);
    this.metrics.setTraceQueueLength(this.queue.length);
    try {
      const endpoint = this.resolveEndpoint();
      const token = this.config.get<string>('OTEL_EXPORTER_OTLP_TRACES_TOKEN')?.trim();
      const body = JSON.stringify({
        resourceSpans: [{
          resource: { attributes: [
            { key: 'service.name', value: { stringValue: this.config.get<string>('OTEL_SERVICE_NAME')?.trim() || 'factoryos-api' } },
            { key: 'service.instance.id', value: { stringValue: this.config.get<string>('HOSTNAME')?.trim() || 'unknown' } },
            { key: 'deployment.environment.name', value: { stringValue: this.config.get<string>('NODE_ENV')?.trim() || 'unknown' } },
          ] },
          scopeSpans: [{ scope: { name: 'factoryos.http', version: '1.0.0' }, spans: batch }],
        }],
      });
      const response = await fetch(endpoint.toString(), {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(token ? { authorization: 'Bearer ' + token } : {}),
        },
        body,
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) throw new Error('OTLP collector did not accept the trace batch');
      this.metrics.recordTraceExported(batch.length);
    } catch {
      this.metrics.recordTraceExportError();
      // Do not retain failed batches forever; tracing must not affect API availability.
    } finally {
      this.flushing = false;
      this.metrics.setTraceQueueLength(this.queue.length);
      if (this.queue.length > 0) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = undefined;
          void this.flush();
        }, 100);
        this.flushTimer.unref?.();
      }
    }
  }

  private resolveEndpoint(): URL {
    const configured = this.config.get<string>('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT')?.trim();
    if (!configured) throw new Error('OTLP endpoint is not configured');
    let endpoint: URL;
    try { endpoint = new URL(configured); } catch { throw new Error('OTLP endpoint is invalid'); }
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || !endpoint.pathname.endsWith('/v1/traces')) {
      throw new Error('OTLP endpoint must be a fixed /v1/traces URL');
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
    const developmentHttp = this.config.get<string>('NODE_ENV') !== 'production'
      && loopback && endpoint.protocol === 'http:';
    if (endpoint.protocol !== 'https:' && !developmentHttp) {
      throw new Error('OTLP endpoint must use HTTPS outside loopback development');
    }
    return endpoint;
  }
}
