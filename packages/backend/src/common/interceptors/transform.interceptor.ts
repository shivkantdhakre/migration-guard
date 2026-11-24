import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { v4 as uuidv4 } from 'uuid';
import { CryptoUtil } from '../crypto/crypto.util';

export interface ApiResponse<T> {
  data: T;
  meta: {
    requestId: string;
    timestamp: string;
  };
}

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, ApiResponse<T>> {
  intercept(context: ExecutionContext, next: CallHandler): Observable<ApiResponse<T>> {
    const req = context.switchToHttp().getRequest();
    const requestId = req?.headers['x-request-id'] || `req_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

    // If endpoint already sent a stream or raw file (like CSV / HTML download), do not wrap
    const res = context.switchToHttp().getResponse();
    if (res?.getHeader('Content-Type') && (res.getHeader('Content-Type').includes('text/csv') || res.getHeader('Content-Type').includes('text/html'))) {
      return next.handle();
    }

    const isAuthRoute = req?.url && (req.url.includes('/auth/login') || req.url.includes('/auth/register'));

    return next.handle().pipe(
      map((data) => {
        const contentType = String(res?.getHeader?.('Content-Type') || '');
        if (res?.headersSent || contentType.includes('text/csv') || contentType.includes('text/html')) {
          return data;
        }

        // Redact any accidental secret fields in data before responding (preserving accessToken on auth routes)
        let sanitizedData: any;
        if (isAuthRoute && data && typeof data === 'object') {
          const originalToken = (data as any).accessToken;
          sanitizedData = CryptoUtil.redactSecrets(data);
          if (originalToken) {
            sanitizedData.accessToken = originalToken;
          }
        } else {
          sanitizedData = CryptoUtil.redactSecrets(data);
        }

        return {
          data: sanitizedData,
          meta: {
            requestId,
            timestamp: new Date().toISOString(),
          },
        };
      }),
    );
  }
}
