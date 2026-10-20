import { jest } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';
import type { DatabaseService } from '../database/database.service';
import type { HttpMetricsService } from '../observability/http-metrics.service';

describe('HealthController', () => {
  const database = { query: jest.fn<(...args: unknown[]) => Promise<{ rows: Array<{ result: number }> }>>() };
  const metrics = { setDependencyHealth: jest.fn() };
  let controller: HealthController;

  beforeEach(() => {
    jest.resetAllMocks();
    controller = new HealthController(database as unknown as DatabaseService, metrics as unknown as HttpMetricsService);
  });

  it('provides a dependency-free liveness probe', () => {
    expect(controller.live()).toMatchObject({ status: 'ok', service: 'factoryos-api' });
    expect(database.query).not.toHaveBeenCalled();
  });

  it('checks database readiness and records its health gauge', async () => {
    database.query.mockResolvedValueOnce({ rows: [{ result: 1 }] });
    await expect(controller.ready()).resolves.toMatchObject({ status: 'ok', database: 'ok' });
    expect(metrics.setDependencyHealth).toHaveBeenCalledWith('database', true);
  });

  it('records a failing dependency and fails readiness when database is unavailable', async () => {
    database.query.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(metrics.setDependencyHealth).toHaveBeenCalledWith('database', false);
  });

  it('retains the legacy health route as a readiness probe', async () => {
    database.query.mockResolvedValueOnce({ rows: [{ result: 1 }] });
    await expect(controller.check()).resolves.toMatchObject({ status: 'ok' });
  });
});
