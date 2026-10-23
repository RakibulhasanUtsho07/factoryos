import { jest } from '@jest/globals';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { GrowthService } from './growth.service';

const TENANT_ID = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY_ID = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const OPPORTUNITY_ID = '69ef2a43-8157-4d91-aa59-7b4260ef1778';

function evaluations(count = 10, semantics = 'HEURISTIC_RANGE') {
  return Array.from({ length: count }, (_, index) => ({
    model_version: 'model-v1',
    metric_key: 'finance.actual_revenue',
    unit: 'BDT',
    forecast_value: '100.00000000',
    actual_value: '110.00000000',
    signed_error: '-10.00000000',
    absolute_error: '10.00000000',
    squared_error: '100.00000000',
    symmetric_percentage_error: '9.52380952',
    interval_hit: semantics === 'NONE' ? null : true,
    nominal_coverage_pct: null,
    interval_semantics: semantics,
    evaluated_at: new Date(Date.UTC(2026, 9, index + 1)).toISOString(),
    total_count: String(count),
  }));
}

const approvedPolicy = {
  id: 'bccd4a6c-6a67-47c1-83d8-91a2cba52a28',
  domain: 'FINANCE',
  model_version: 'model-v1',
  metric_key: 'finance.actual_revenue',
  unit: 'BDT',
  policy_version: '2',
  minimum_sample_count: '10',
  max_mean_absolute_error: '5.00000000',
  max_root_mean_squared_error: '5.00000000',
  max_absolute_mean_error: '5.00000000',
  max_mean_symmetric_percentage_error_pct: '10.0000',
  max_absolute_calibration_gap_pct_points: '10.0000',
  residual_coverage_target_pct: '90.00',
  max_empirical_absolute_residual: '15.00000000',
};

describe('GrowthService domain-specific calibration policy reporting', () => {
  let service: GrowthService;
  let database: { query: ReturnType<typeof jest.fn> };

  beforeEach(() => {
    database = { query: jest.fn() };
    service = new GrowthService(database as unknown as DatabaseService, { record: jest.fn() } as unknown as AuditService);
  });

  it('applies only an approved matching policy and keeps heuristic ranges out of coverage calibration', async () => {
    database.query
      .mockResolvedValueOnce({ rows: evaluations() })
      .mockResolvedValueOnce({ rows: [approvedPolicy] });

    const report = await service.getForecastCalibration(TENANT_ID, FACTORY_ID, OPPORTUNITY_ID, 'FINANCE');
    const cohort = report.calibration[0] as Record<string, unknown>;

    expect(cohort.error_threshold_assessment).toBe('EXCEEDS_APPROVED_ERROR_THRESHOLDS');
    expect(cohort.error_threshold_failures).toEqual([
      'MEAN_ABSOLUTE_ERROR', 'ROOT_MEAN_SQUARED_ERROR', 'ABSOLUTE_BIAS',
    ]);
    expect(cohort.interval_threshold_assessment).toBe('NOT_CALIBRATABLE_HEURISTIC_RANGE');
    expect(cohort.uncertainty_threshold_assessment).toBe('WITHIN_APPROVED_RESIDUAL_THRESHOLD');
    expect(cohort.empirical_residual_threshold).toMatchObject({
      requested_coverage_pct: 90, minimum_sample_count: 10,
      threshold_value: '10.00000000', status: 'ESTIMATED_FROM_HELD_OUT_RESIDUALS',
    });
    expect(cohort.calibration_policy).toMatchObject({ thresholds: {
      residual_coverage_target_pct: 90, max_empirical_absolute_residual: 15,
    } });
    expect(report.interpretation).toContain('never described as a confidence or calibrated prediction interval');
  });

  it('requires an approved domain policy and explicit domain when cohorts overlap across domains', async () => {
    database.query
      .mockResolvedValueOnce({ rows: evaluations() })
      .mockResolvedValueOnce({ rows: [] });
    const withoutPolicy = await service.getForecastCalibration(TENANT_ID, FACTORY_ID, OPPORTUNITY_ID);
    expect((withoutPolicy.calibration[0] as Record<string, unknown>).error_threshold_assessment).toBe('NO_APPROVED_POLICY');
    expect((withoutPolicy.calibration[0] as Record<string, unknown>).uncertainty_threshold_assessment).toBe('NO_APPROVED_POLICY');
    expect((withoutPolicy.calibration[0] as Record<string, unknown>).empirical_residual_threshold).toMatchObject({
      threshold_value: null, status: 'NO_APPROVED_POLICY',
    });

    database.query.mockReset();
    database.query
      .mockResolvedValueOnce({ rows: evaluations() })
      .mockResolvedValueOnce({ rows: [
        approvedPolicy,
        { ...approvedPolicy, id: 'ab8d0da5-541d-4ca1-a8a1-0f08e6d96cef', domain: 'PRODUCTION' },
      ] });
    const ambiguous = await service.getForecastCalibration(TENANT_ID, FACTORY_ID, OPPORTUNITY_ID);
    expect((ambiguous.calibration[0] as Record<string, unknown>).error_threshold_assessment).toBe('DOMAIN_REQUIRED');
  });

  it('does not assess an approved policy below its domain-specific sample floor', async () => {
    database.query
      .mockResolvedValueOnce({ rows: evaluations(9) })
      .mockResolvedValueOnce({ rows: [approvedPolicy] });
    const report = await service.getForecastCalibration(TENANT_ID, FACTORY_ID, OPPORTUNITY_ID, 'FINANCE');
    const cohort = report.calibration[0] as Record<string, unknown>;
    expect(cohort.error_threshold_assessment).toBe('INSUFFICIENT_POLICY_SAMPLE');
    expect(cohort.empirical_residual_threshold).toMatchObject({
      sample_count: 9, minimum_sample_count: 10, threshold_value: null, status: 'INSUFFICIENT_SAMPLE',
    });
    expect(cohort.uncertainty_threshold_assessment).toBe('INSUFFICIENT_SAMPLE');
  });
});
