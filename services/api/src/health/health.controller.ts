import {
  Controller,
  Get,
  ServiceUnavailableException,
} from '@nestjs/common';

import { Public } from '../auth/decorators/public.decorator';
import { DatabaseService } from '../database/database.service';

@Controller('health')
export class HealthController {
  constructor(private readonly database: DatabaseService) {}

  @Public()
  @Get()
  async check() {
    const startedAt = Date.now();

    try {
      const result = await this.database.query<{
        result: number;
      }>('SELECT 1 AS result');

      const databaseOk = result.rows[0]?.result === 1;

      return {
        status: databaseOk ? 'ok' : 'error',
        service: 'factoryos-api',
        database: databaseOk ? 'ok' : 'error',
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