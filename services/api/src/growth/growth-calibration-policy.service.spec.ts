import { ConflictException, BadRequestException } from '@nestjs/common';
import { jest } from '@jest/globals';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { CreateGrowthCalibrationPolicyDto } from './dto/create-growth-calibration-policy.dto';
import { DecideGrowthCalibrationPolicyDto } from './dto/decide-growth-calibration-policy.dto';
import { GrowthCalibrationPolicyService } from './growth-calibration-policy.service';

const USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const REVIEWER_ID = 'ae5826b7-e1ef-4f91-b4b9-c79b7aeae324';
const TENANT_ID = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY_ID = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const POLICY_ID = 'bccd4a6c-6a67-47c1-83d8-91a2cba52a28';

function policyDto(): CreateGrowthCalibrationPolicyDto {
  return {
    domain: 'FINANCE',
    model_version: 'revenue-forecast-v3',
    metric_key: 'finance.actual_revenue',
    unit: 'BDT',
    minimum_sample_count: 40,
    max_mean_absolute_error: 15000,
    max_root_mean_squared_error: 22000,
    max_absolute_mean_error: 5000,
    max_mean_symmetric_percentage_error_pct: 12,
    max_absolute_calibration_gap_pct_points: 8,
    residual_coverage_target_pct: 90,
    max_empirical_absolute_residual: 35000,
  };
}

describe('GrowthCalibrationPolicyService', () => {
  let service: GrowthCalibrationPolicyService;
  let database: { transaction: ReturnType<typeof jest.fn>; query: ReturnType<typeof jest.fn> };
  let client: { query: ReturnType<typeof jest.fn> };
  let audit: { record: ReturnType<typeof jest.fn> };

  beforeEach(() => {
    client = { query: jest.fn() };
    database = {
      transaction: jest.fn().mockImplementation(async (
        _options: unknown,
        callback: (tx: unknown) => Promise<unknown>,
      ) => callback(client)),
      query: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new GrowthCalibrationPolicyService(
      database as unknown as DatabaseService,
      audit as unknown as AuditService,
    );
  });

  it('proposes a versioned residual policy with unit-aware limits and durable outbox evidence', async () => {
    const savedPolicy = {
      id: POLICY_ID, domain: 'FINANCE', model_version: 'revenue-forecast-v3',
      metric_key: 'finance.actual_revenue', unit: 'BDT', policy_version: 3,
      minimum_sample_count: 40, residual_coverage_target_pct: '90.00',
      max_empirical_absolute_residual: '35000.00000000',
      status: 'PENDING_REVIEW', created_by: USER_ID,
    };
    client.query
      .mockResolvedValueOnce({ rows: [{ id: FACTORY_ID }] })
      .mockResolvedValueOnce({ rows: [{ policy_version: 3 }] })
      .mockResolvedValueOnce({ rows: [savedPolicy] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await service.createPolicy(USER_ID, TENANT_ID, FACTORY_ID, policyDto(), null, null);

    expect(result).toMatchObject(savedPolicy);
    const insert = client.query.mock.calls.find(call => String(call[0]).includes('INSERT INTO growth_forecast_calibration_policies'));
    expect(insert).toBeDefined();
    const params = insert?.[1] as unknown[];
    expect(params[6]).toBe(4);
    expect(params[7]).toBe(40);
    expect(params[13]).toBe(90);
    expect(params[14]).toBe(35000);
    expect(params[15]).toBe(USER_ID);
    const outbox = client.query.mock.calls.find(call => String(call[0]).includes('INSERT INTO outbox_events'));
    expect(outbox?.[1]?.[3]).toBe('GROWTH.CALIBRATION_POLICY_PROPOSED');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'CALIBRATION_POLICY_PROPOSE',
      payload: expect.objectContaining({
        residual_coverage_target_pct: 90,
        max_empirical_absolute_residual: 35000,
      }),
    }));
  });

  it('requires valid residual coverage and a supported sample floor before touching the database', async () => {
    await expect(service.createPolicy(USER_ID, TENANT_ID, FACTORY_ID, {
      ...policyDto(), residual_coverage_target_pct: 100,
    }, null, null)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createPolicy(USER_ID, TENANT_ID, FACTORY_ID, {
      ...policyDto(), minimum_sample_count: 9,
    }, null, null)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('enforces maker-checker separation before any policy update', async () => {
    client.query.mockResolvedValueOnce({ rows: [{
      id: POLICY_ID, status: 'PENDING_REVIEW', created_by: USER_ID,
    }] });
    const dto: DecideGrowthCalibrationPolicyDto = {
      decision: 'APPROVE', reason: 'Reviewed against approved finance history',
    };

    await expect(service.decidePolicy(USER_ID, TENANT_ID, FACTORY_ID, POLICY_ID, dto, null, null))
      .rejects.toBeInstanceOf(ConflictException);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('records an independent reasoned approval without modifying proposed thresholds', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [{
        id: POLICY_ID, status: 'PENDING_REVIEW', created_by: USER_ID,
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: POLICY_ID, domain: 'FINANCE', model_version: 'revenue-forecast-v3',
        metric_key: 'finance.actual_revenue', unit: 'BDT', policy_version: 3,
        status: 'APPROVED', decided_by: REVIEWER_ID,
        decision_reason: 'Reviewed against 24 months of reconciled actuals',
      }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await service.decidePolicy(REVIEWER_ID, TENANT_ID, FACTORY_ID, POLICY_ID, {
      decision: 'APPROVE', reason: 'Reviewed against 24 months of reconciled actuals',
    }, null, null);

    expect(result).toMatchObject({ id: POLICY_ID, status: 'APPROVED', decided_by: REVIEWER_ID });
    expect(client.query.mock.calls[1][0]).toContain("status='PENDING_REVIEW'");
    expect(client.query.mock.calls.some(call => String(call[0]).includes('INSERT INTO outbox_events'))).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'CALIBRATION_POLICY_APPROVE' }));
  });
});
