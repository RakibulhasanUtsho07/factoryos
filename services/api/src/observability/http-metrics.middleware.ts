import { Injectable, NestMiddleware } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import type { NextFunction, Request, Response } from 'express';
import { HttpMetricsService } from './http-metrics.service';
import { OtlpTraceExporter } from './otlp-trace-exporter.service';

function routeTemplate(req: Request): string {
  const routePath = typeof req.route?.path === 'string' ? req.route.path : null;
  if (!routePath || routePath.length > 128) return 'unmatched';
  const route = ((req.baseUrl || '') + (routePath.startsWith('/') ? routePath : '/' + routePath))
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,36}(?=\/|$)/gi, '/:id')
    .replace(/\/[0-9]{1,18}(?=\/|$)/g, '/:id');
  return route.length <= 160 && /^\/[A-Za-z0-9_./:-]*$/.test(route) ? route : 'unmatched';
}

@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(
    private readonly metrics: HttpMetricsService,
    private readonly traces: OtlpTraceExporter,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const startedAt = performance.now();
    const startTimeUnixNano = (BigInt(Date.now()) * 1_000_000n).toString();
    const method = this.metrics.beginRequest(req.method);
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      const durationSeconds = Math.max(0, (performance.now() - startedAt) / 1000);
      const statusCode = res.writableEnded ? res.statusCode : 499;
      const route = routeTemplate(req);
      this.metrics.completeRequest(method, statusCode, durationSeconds, route);
      const traceContext = req.traceContext ?? req.factoryos?.traceContext;
      if (traceContext?.sampled) {
        const endTimeUnixNano = (BigInt(Date.now()) * 1_000_000n).toString();
        const durationMs = durationSeconds * 1000;
        this.traces.exportServerSpan({
          context: traceContext,
          method,
          route,
          statusCode,
          startTimeUnixNano: traceContext.startTimeUnixNano || startTimeUnixNano,
          endTimeUnixNano,
          durationMs,
          requestId: req.factoryos?.requestId ?? req.header('x-request-id') ?? 'unknown',
        });
        // Structured, sampled request spans only. Never log URL/query, body, token or tenant/user IDs.
        console.log(JSON.stringify({
          severity: statusCode >= 500 ? 'ERROR' : 'INFO',
          event: 'http.server.request',
          timestamp: new Date().toISOString(),
          trace_id: traceContext.traceId,
          span_id: traceContext.spanId,
          parent_span_id: traceContext.parentSpanId,
          request_id: req.factoryos?.requestId ?? 'unknown',
          http_method: method,
          http_route: route,
          http_status_code: statusCode,
          duration_ms: Number(durationMs.toFixed(3)),
        }));
      }
    };
    res.once('finish', finish);
    res.once('close', finish);
    next();
  }
}
