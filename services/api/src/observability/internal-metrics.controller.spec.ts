import { jest } from '@jest/globals';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { InternalMetricsController } from './internal-metrics.controller';
import { HttpMetricsService } from './http-metrics.service';

describe('InternalMetricsController', () => {
  const token = '0123456789abcdef0123456789abcdef';
  const metrics = { renderPrometheus: jest.fn(() => '# metrics\\n') } as unknown as HttpMetricsService;

  function controller(configuredToken?: string) {
    return new InternalMetricsController(
      { get: jest.fn(() => configuredToken) } as unknown as ConfigService,
      metrics,
    );
  }

  beforeEach(() => jest.clearAllMocks());

  it('keeps scraping disabled if a strong token is not configured', () => {
    expect(() => controller().scrape('Bearer ' + token)).toThrow(NotFoundException);
    expect(metrics.renderPrometheus).not.toHaveBeenCalled();
  });

  it('requires exact bearer syntax and rejects invalid tokens', () => {
    expect(() => controller(token).scrape()).toThrow(UnauthorizedException);
    expect(() => controller(token).scrape('Bearer wrong')).toThrow(UnauthorizedException);
    expect(metrics.renderPrometheus).not.toHaveBeenCalled();
  });

  it('returns metrics only after a constant-time bearer-token comparison', () => {
    expect(controller(token).scrape('Bearer ' + token)).toBe('# metrics\\n');
    expect(metrics.renderPrometheus).toHaveBeenCalledTimes(1);
  });
});
