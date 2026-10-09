import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

@Injectable()
export class TraceIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const incomingTraceId = req.header('x-trace-id');
    const traceId = incomingTraceId?.trim() || randomUUID();

    res.setHeader('x-trace-id', traceId);
    req.headers['x-trace-id'] = traceId;

    next();
  }
}