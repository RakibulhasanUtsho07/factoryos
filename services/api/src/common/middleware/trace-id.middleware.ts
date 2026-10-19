import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

// Keep correlation IDs useful without reflecting arbitrary header bytes back to clients.
const TRACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

@Injectable()
export class TraceIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const candidate = req.header('x-trace-id')?.trim();
    const traceId = candidate && TRACE_ID_PATTERN.test(candidate)
      ? candidate
      : randomUUID();

    res.setHeader('x-trace-id', traceId);
    req.headers['x-trace-id'] = traceId;
    next();
  }
}
