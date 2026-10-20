import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const incomingRequestId = req.header('x-request-id')?.trim();
    const requestId = incomingRequestId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(incomingRequestId)
      ? incomingRequestId
      : randomUUID();

    res.setHeader('x-request-id', requestId);

    req.headers['x-request-id'] = requestId;

    next();
  }
}