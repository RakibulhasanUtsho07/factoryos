import {
  Controller,
  Get,
  ServiceUnavailableException,
} from '@nestjs/common';

import { Public } from '../auth/decorators/public.decorator';
import { DatabaseService } from '../database/database.service';
import { HttpMetricsService } from '../observability/http-metrics.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly database: DatabaseService,
    private readonly metrics: HttpMetricsService,
  ) {}

  @Public()
  @Get('live')
  live() {
    return {
      status: 'ok',
      service: 'factoryos-api',
      timestamp: new Date().toISOString(),
    };
  }

  /** Backward-compatible readiness probe: require the database to answer SELECT 1. */
  @Public()
  @Get()
  async check() {
    return this.checkDatabase();
  }

  @Public()
  @Get('ready')
  async ready() {
    return this.checkDatabase();
  }

  private async checkDatabase() {
    const startedAt = Date.now();
    try {
      const result = await this.database.query<{ result: number }>('SELECT 1 AS result');
      const databaseOk = result.rows[0]?.result === 1;
      this.metrics.setDependencyHealth('database', databaseOk);
      return {
        status: databaseOk ? 'ok' : 'error',
        service: 'factoryos-api',
        database: databaseOk ? 'ok' : 'error',
        timestamp: new Date().toISOString(),
        responseTimeMs: Date.now() - startedAt,
      };
    } catch {
      this.metrics.setDependencyHealth('database', false);
      throw new ServiceUnavailableException({
        status: 'error',
        service: 'factoryos-api',
        database: 'error',
      });
    }
  }
}
