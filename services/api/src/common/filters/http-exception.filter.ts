import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';

interface ErrorResponse {
  message?: string | string[];
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();

    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    const requestId =
      request.header('x-request-id') ?? 'unknown';

    const traceId =
      request.header('x-trace-id') ?? requestId;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_SERVER_ERROR';
    let message = 'Internal server error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();

      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null
      ) {
        const responseBody = exceptionResponse as ErrorResponse;

        if (Array.isArray(responseBody.message)) {
          message = responseBody.message.join(', ');
        } else if (typeof responseBody.message === 'string') {
          message = responseBody.message;
        }
      }

      code = this.getErrorCode(status);
    }

    response.status(status).json({
      error: {
        code,
        message,
        retryable: status >= 500,
        details: {},
        trace_id: traceId,
        request_id: requestId,
      },
    });
  }

  private getErrorCode(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'BAD_REQUEST';

      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHORIZED';

      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';

      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';

      case HttpStatus.CONFLICT:
        return 'CONFLICT';

      case HttpStatus.UNPROCESSABLE_ENTITY:
        return 'VALIDATION_ERROR';

      case HttpStatus.TOO_MANY_REQUESTS:
        return 'RATE_LIMITED';

      default:
        return 'HTTP_ERROR';
    }
  }
}