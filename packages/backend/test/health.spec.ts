import { describe, it, expect, beforeEach } from 'vitest';
import { HealthService } from '../src/health/health.service';
import { DatabaseService } from '../src/database/database.service';

describe('HealthModule', () => {
  let db: DatabaseService;
  let healthService: HealthService;

  beforeEach(async () => {
    db = new DatabaseService();
    await db.onModuleInit();
    healthService = new HealthService(db);
  });

  it('should return system health status', async () => {
    const health = await healthService.checkHealth();
    expect(health.status).toBe('OK');
    expect(health.components.database.status).toBeDefined();
    expect(health.components.redis.status).toBe('UP');
  });

  it('should return liveness status', async () => {
    const liveness = await healthService.checkLiveness();
    expect(liveness.status).toBe('ALIVE');
  });

  it('should return readiness status', async () => {
    const readiness = await healthService.checkReadiness();
    expect(readiness.status).toBe('READY');
  });
});
