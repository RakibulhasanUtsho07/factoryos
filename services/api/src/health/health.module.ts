import { Module } from '@nestjs/common';
import { ObservabilityModule } from '../observability/observability.module';
import { HealthController } from './health.controller';

@Module({
  imports: [ObservabilityModule],
  controllers: [HealthController],
})
export class HealthModule {}
