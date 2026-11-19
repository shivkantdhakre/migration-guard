import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { CryptoUtil } from '../crypto/crypto.util';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const requestId =
      (request?.headers?.['x-request-id'] as string) ||
      `req_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_SERVER_ERROR';
    let message = 'An unexpected error occurred.';
    let details: any = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        const anyRes = res as any;
        message = anyRes.message || exception.message;
        code = anyRes.code || this.statusToCode(status);
        details = anyRes.details || (Array.isArray(anyRes.message) ? anyRes.message : undefined);
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      code = (exception as any).code || 'INTERNAL_ERROR';
    }

    // Never leak stack traces or raw secrets in error responses
    const errorBody = {
      error: {
        code: this.statusToCode(status, code),
        message: Array.isArray(message) ? message.join('; ') : message,
        details: details ? CryptoUtil.redactSecrets(details) : undefined,
        requestId,
      },
    };

    response.status(status).json(errorBody);
  }

  private statusToCode(status: number, fallbackCode?: string): string {
    if (fallbackCode && fallbackCode !== 'INTERNAL_ERROR') {
      return fallbackCode;
    }
    switch (status) {
      case 400:
        return 'BAD_REQUEST';
      case 401:
        return 'UNAUTHENTICATED';
      case 403:
        return 'UNAUTHORIZED';
      case 404:
        return 'NOT_FOUND';
      case 409:
        return 'CONFLICT';
      case 422:
        return 'UNPROCESSABLE_ENTITY';
      case 429:
        return 'RATE_LIMITED';
      case 502:
      case 503:
        return 'SERVICE_UNAVAILABLE';
      default:
        return 'INTERNAL_SERVER_ERROR';
    }
  }
}
