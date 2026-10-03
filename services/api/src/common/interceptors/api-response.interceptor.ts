import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable, map } from 'rxjs';

import { ApiResponse } from '../types/api-response';

@Injectable()
export class ApiResponseInterceptor<T>
  implements NestInterceptor<T, ApiResponse<T>>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiResponse<T>> {
    const request =
      context.switchToHttp().getRequest<Request>();

    const requestId =
      request.factoryos?.requestId ??
      request.header('x-request-id') ??
      'unknown';

    const traceId =
      request.factoryos?.traceId ??
      request.header('x-trace-id') ??
      requestId;

    return next.handle().pipe(
      map((data) => {
        // Read verified tenant AFTER controller/guard execution.
        const tenantId =
          request.factoryos?.tenantId ?? null;

        return {
          request_id: requestId,
          trace_id: traceId,
          api_version: 'v1',
          tenant_id: tenantId,
          data,
          meta: {},
          errors: [],
        };
      }),
    );
  }
}