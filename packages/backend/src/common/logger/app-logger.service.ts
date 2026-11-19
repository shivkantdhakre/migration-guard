import { Injectable, LoggerService } from '@nestjs/common';
import { CryptoUtil } from '../crypto/crypto.util';

@Injectable()
export class AppLogger implements LoggerService {
  private correlationId?: string;

  public setCorrelationId(id: string) {
    this.correlationId = id;
  }

  public log(message: any, ...optionalParams: any[]) {
    this.output('INFO', message, optionalParams);
  }

  public error(message: any, ...optionalParams: any[]) {
    this.output('ERROR', message, optionalParams);
  }

  public warn(message: any, ...optionalParams: any[]) {
    this.output('WARN', message, optionalParams);
  }

  public debug(message: any, ...optionalParams: any[]) {
    this.output('DEBUG', message, optionalParams);
  }

  public verbose(message: any, ...optionalParams: any[]) {
    this.output('VERBOSE', message, optionalParams);
  }

  private output(level: string, message: any, params: any[]) {
    const sanitizedMsg = typeof message === 'object' ? CryptoUtil.redactSecrets(message) : message;
    const sanitizedParams = params.map((p) =>
      typeof p === 'object' ? CryptoUtil.redactSecrets(p) : p,
    );

    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      correlationId: this.correlationId,
      message: sanitizedMsg,
      context: sanitizedParams.length > 0 ? sanitizedParams : undefined,
    };

    if (level === 'ERROR') {
      console.error(JSON.stringify(logEntry));
    } else if (level === 'WARN') {
      console.warn(JSON.stringify(logEntry));
    } else {
      console.log(JSON.stringify(logEntry));
    }
  }
}
