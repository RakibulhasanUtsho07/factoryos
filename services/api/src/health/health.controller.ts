import {
  Controller,
  Get,
  ServiceUnavailableException,
} from '@nestjs/common';

import { DatabaseService } from '../database/database.service';

@Controller('health')
export class HealthController {
  constructor(private readonly database: DatabaseService) {}

  @Get()
  async check() {
    const startedAt = Date.now();

    try {
      const result = await this.database.query<{
        result: number;
      }>('SELECT 1 AS result');

      return {
        status: 'ok',
        service: 'factoryos-api',
        database: result.rows[0]?.result === 1 ? 'ok' : 'error',
        timestamp: new Date().toISOString(),
        responseTimeMs: Date.now() - startedAt,
      };
    } catch {
      throw new ServiceUnavailableException({
        status: 'error',
        service: 'factoryos-api',
        database: 'error',
      });
    }
  }
}