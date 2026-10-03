import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
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

    const requestContext = request.factoryos;

    const requestId =
      requestContext?.requestId ??
      request.header('x-request-id') ??
      'unknown';

    const traceId =
      requestContext?.traceId ??
      request.header('x-trace-id') ??
      requestId;

    // IMPORTANT:
    // tenantId comes only from server-verified context.
    const tenantId =
      requestContext?.tenantId ?? null;

    return next.handle().pipe(
      map((data) => ({
        request_id: requestId,
        trace_id: traceId,
        api_version: 'v1',
        tenant_id: tenantId,
        data,
        meta: {},
        errors: [],
      })),
    );
  }
}