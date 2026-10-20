import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpMetricsMiddleware } from './http-metrics.middleware';
import { HttpMetricsService } from './http-metrics.service';
import { InternalMetricsController } from './internal-metrics.controller';
import { OtlpTraceExporter } from './otlp-trace-exporter.service';

@Module({
  imports: [ConfigModule],
  controllers: [InternalMetricsController],
  providers: [HttpMetricsService, HttpMetricsMiddleware, OtlpTraceExporter],
  exports: [HttpMetricsService, HttpMetricsMiddleware, OtlpTraceExporter],
})
export class ObservabilityModule {}
