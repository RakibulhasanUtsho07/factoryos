import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Reflector } from '@nestjs/core';
import { Observable, map } from 'rxjs';

import { ApiResponse } from '../types/api-response';
import { SKIP_API_RESPONSE_KEY } from '../decorators/skip-api-response.decorator';

@Injectable()
export class ApiResponseInterceptor<T>
  implements NestInterceptor<T, ApiResponse<T> | T>
{
  constructor(private readonly reflector: Reflector) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiResponse<T> | T> {
    const skipEnvelope = this.reflector.getAllAndOverride<boolean>(
      SKIP_API_RESPONSE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (skipEnvelope) return next.handle();

    const request = context.switchToHttp().getRequest<Request>();
    const requestId = request.factoryos?.requestId ?? request.header('x-request-id') ?? 'unknown';
    const traceId = request.factoryos?.traceId ?? request.header('x-trace-id') ?? requestId;
    return next.handle().pipe(
      map((data) => ({
        request_id: requestId,
        trace_id: traceId,
        api_version: 'v1',
        tenant_id: request.factoryos?.tenantId ?? null,
        data,
        meta: {},
        errors: [],
      })),
    );
  }
}
