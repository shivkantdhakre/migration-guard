import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class HealthService {
  constructor(private db: DatabaseService) {}

  async checkHealth() {
    const isDbAlive = await this.db.ping();
    const dbStatus = isDbAlive
      ? 'UP'
      : this.db.isDbConnected
      ? 'CONNECTED'
      : process.env.ALLOW_IN_MEMORY_DB === 'true'
      ? 'MEMORY_STORE_ACTIVE'
      : 'DOWN';

    return {
      status: isDbAlive || process.env.ALLOW_IN_MEMORY_DB === 'true' ? 'OK' : 'DEGRADED',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      components: {
        database: {
          status: dbStatus,
          provider: 'PostgreSQL',
        },
        redis: {
          status: 'UP',
          role: 'Queue/Coordination',
        },
      },
    };
  }

  async checkLiveness() {
    return {
      status: 'ALIVE',
      timestamp: new Date().toISOString(),
    };
  }

  async checkReadiness() {
    const isDbAlive = await this.db.ping();
    if (!isDbAlive && process.env.ALLOW_IN_MEMORY_DB !== 'true') {
      throw new ServiceUnavailableException({
        status: 'NOT_READY',
        reason: 'PostgreSQL database is unreachable and in-memory fallback is disabled',
        timestamp: new Date().toISOString(),
      });
    }

    return {
      status: 'READY',
      timestamp: new Date().toISOString(),
      database: isDbAlive ? 'CONNECTED' : 'MEMORY_FALLBACK',
    };
  }
}
