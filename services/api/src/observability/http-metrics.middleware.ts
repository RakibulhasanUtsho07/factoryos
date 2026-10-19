import { Injectable, NestMiddleware } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import type { NextFunction, Request, Response } from 'express';
import { HttpMetricsService } from './http-metrics.service';

@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: HttpMetricsService) {}

  use(_req: Request, res: Response, next: NextFunction): void {
    const startedAt = performance.now();
    const method = this.metrics.beginRequest(_req.method);
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      const durationSeconds = Math.max(0, (performance.now() - startedAt) / 1000);
      // A socket that closes before the response finishes is recorded separately
      // as a client-aborted 4xx-class outcome instead of a false successful request.
      const statusCode = res.writableEnded ? res.statusCode : 499;
      this.metrics.completeRequest(method, statusCode, durationSeconds);
    };
    res.once('finish', finish);
    res.once('close', finish);
    next();
  }
}
