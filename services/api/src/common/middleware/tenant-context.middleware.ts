import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    const requestId =
      req.header('x-request-id') ?? 'unknown';

    const traceId =
      req.header('x-trace-id') ?? requestId;

    const requestedUserId =
      req.header('x-user-id')?.trim() || null;

    const requestedTenantId =
      req.header('x-tenant-id')?.trim() || null;

    req.factoryos = {
      requestId,
      traceId,
      requestedUserId,
      requestedTenantId,
      userId: null,
      tenantId: null,
    };

    next();
  }
}