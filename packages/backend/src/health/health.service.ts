import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class HealthService {
  constructor(private db: DatabaseService) {}

  async checkHealth() {
    const dbStatus = this.db.isDbConnected ? 'UP' : 'MEMORY_STORE_ACTIVE';

    return {
      status: 'OK',
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
    return {
      status: 'READY',
      timestamp: new Date().toISOString(),
      database: this.db.isDbConnected ? 'CONNECTED' : 'MEMORY_FALLBACK',
    };
  }
}
