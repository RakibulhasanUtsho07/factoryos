import { Controller, Get, Header, Headers, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { Public } from '../auth/decorators/public.decorator';
import { HttpMetricsService } from './http-metrics.service';

@Controller('internal')
export class InternalMetricsController {
  constructor(
    private readonly config: ConfigService,
    private readonly metrics: HttpMetricsService,
  ) {}

  @Public()
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(@Headers('authorization') authorization?: string): string {
    const expectedSecret = this.config.get<string>('METRICS_SCRAPE_TOKEN');
    // Disabled-by-default: no secret or a weak secret means no scrape endpoint.
    if (!expectedSecret || expectedSecret.length < 32) {
      throw new NotFoundException();
    }
    const match = authorization?.match(/^Bearer ([^\s]+)$/);
    if (!match) throw new UnauthorizedException('Metrics scrape token is required');
    const expected = Buffer.from(expectedSecret, 'utf8');
    const supplied = Buffer.from(match[1], 'utf8');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      throw new UnauthorizedException('Metrics scrape token is invalid');
    }
    return this.metrics.renderPrometheus();
  }
}
