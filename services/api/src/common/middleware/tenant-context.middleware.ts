import { Injectable } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

@Injectable()
export class TenantContextMiddleware {
  use(
    req: Request,
    _res: Response,
    next: NextFunction,
  ) {
    const requestId =
      req.header('x-request-id') ?? 'unknown';

    const traceId =
      req.header('x-trace-id') ?? requestId;

    const requestedUserId =
      req.header('x-user-id')?.trim() || null;

    const requestedTenantId =
      req.header('x-tenant-id')?.trim() || null;

    const requestedFactoryId =
      req.header('x-factory-id')?.trim() || null;

    req.factoryos = {
      requestId,
      traceId,
      requestedUserId,
      requestedTenantId,
      requestedFactoryId,

      userId: null,
      tenantId: null,
      factoryId: null,
    };

    next();
  }
}