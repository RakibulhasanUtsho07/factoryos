import { jest } from '@jest/globals';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';

import { GrowthOpportunityService } from './growth-opportunity.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const userId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const opportunityId = 'c4f7232a-6a66-4a82-9ee4-504944cc4c05';

function opportunityInput(overrides: Record<string, unknown> = {}) {
  return {
    opportunity_key: 'capacity.unlock',
    opportunity_version: 'v1',
    category: 'CAPACITY_UNLOCK',
    statement: 'Unlock bottleneck capacity without changing live production data.',
    evidence: [{
      kind: 'PRIVATE_OPERATIONAL',
      label: 'MES throughput snapshot',
      reference_id: 'MES:throughput:2026-10-09',
    }],
    assumptions: ['Baseline volume represents the last 30 completed production days.'],
    affected_nodes: [{ node_type: 'KPI', node_ref: 'production.throughput', label: 'Throughput' }],
    expected_value_min: 100,
    expected_value_max: 250,
    expected_value_metric: 'monthly_output',
    expected_value_unit: 'units',
    expected_value_currency: 'BDT',
    uncertainty: {
      level: 'MEDIUM',
      limitations: ['Demand remains unverified.'],
      sensitivity_factors: ['Machine downtime'],
      evidence_gaps: ['Next-month demand forecast'],
    },
    effort_estimate: 40,
    effort_unit: 'PERSON_HOURS',
    dependencies: ['planned-maintenance-window'],
    time_to_impact: 'NEAR_TERM',
    impact_date_assumption: '2026-12-01',
    risk_class: 'OPERATIONAL',
    validation_plan: 'Compare throughput and defect rate across four weekly checkpoints.',
    decision_owner_role: 'OPERATIONS_MANAGER',
    idempotency_key: 'capacity-unlock-v1',
    ...overrides,
  };
}

function opportunityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: opportunityId,
    tenant_id: tenantId,
    factory_id: factoryId,
    opportunity_key: 'capacity.unlock',
    opportunity_version: 'v1',
    category: 'CAPACITY_UNLOCK',
    statement: 'Unlock bottleneck capacity without changing live production data.',
    evidence: [{ kind: 'PRIVATE_OPERATIONAL', label: 'MES throughput snapshot', reference_id: 'MES:throughput:2026-10-09' }],
    assumptions: ['Baseline volume represents the last 30 completed production days.'],
    affected_nodes: [{ node_type: 'KPI', node_ref: 'production.throughput', label: 'Throughput' }],
    expected_value_min: '100.000000',
    expected_value_max: '250.000000',
    expected_value_metric: 'monthly_output',
    expected_value_unit: 'units',
    expected_value_currency: 'BDT',
    uncertainty: { level: 'MEDIUM', limitations: ['Demand remains unverified.'], sensitivity_factors: ['Machine downtime'], evidence_gaps: ['Next-month demand forecast'] },
    effort_estimate: '40.0000',
    effort_unit: 'PERSON_HOURS',
    dependencies: ['planned-maintenance-window'],
    time_to_impact: 'NEAR_TERM',
    impact_date_assumption: '2026-12-01',
    risk_class: 'OPERATIONAL',
    validation_plan: 'Compare throughput and defect rate across four weekly checkpoints.',
    decision_owner_role: 'OPERATIONS_MANAGER',
    request_hash: 'c'.repeat(64),
    idempotency_key: 'capacity-unlock-v1',
    created_by: userId,
    created_at: '2026-10-10T16:00:00.000Z',
    ...overrides,
  };
}

describe('GrowthOpportunityService', () => {
  const database = {
    query: jest.fn<(query: string, values?: unknown[], context?: unknown) => Promise<{ rows: unknown[] }>>(),
  };
  const iamService = {
    authorize: jest.fn<(...args: unknown[]) => Promise<void>>(),
  };
  const auditService = {
    record: jest.fn<(...args: unknown[]) => Promise<string>>(),
  };
  let service: GrowthOpportunityService;

  beforeEach(() => {
    jest.clearAllMocks();
    database.query.mockReset();
    iamService.authorize.mockResolvedValue(undefined);
    auditService.record.mockResolvedValue('audit-id');
    service = new GrowthOpportunityService(database as never, iamService as never, auditService as never);
  });

  it('registers an immutable opportunity version with explicit evidence, assumptions, range and uncertainty', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [opportunityRow()] });

    const result = await service.createOpportunity(tenantId, factoryId, userId, opportunityInput() as never);

    expect(result.idempotent).toBe(false);
    expect(result.opportunity.id).toBe(opportunityId);
    expect(result.opportunity.expectedValue).toEqual({
      min: 100,
      max: 250,
      metric: 'monthly_output',
      unit: 'units',
      currency: 'BDT',
    });
    expect(result.opportunity.valueSemantics).toBe('SCENARIO_RANGE_NOT_GUARANTEE');
    expect(iamService.authorize).toHaveBeenCalledWith(userId, tenantId, 'growth.opportunities.write', factoryId);
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'GROWTH_OPPORTUNITY_REGISTERED',
      payload: expect.objectContaining({ category: 'CAPACITY_UNLOCK', evidenceCount: 1 }),
    }));
  });

  it('rejects inverted expected value ranges before any database write', async () => {
    await expect(
      service.createOpportunity(tenantId, factoryId, userId, opportunityInput({
        expected_value_min: 300,
        expected_value_max: 200,
      }) as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(database.query).not.toHaveBeenCalled();
  });

  it('requires external research evidence to resolve to current approved claim/evidence citations', async () => {
    database.query.mockResolvedValueOnce({ rows: [] });

    await expect(
      service.createOpportunity(tenantId, factoryId, userId, opportunityInput({
        evidence: [{
          kind: 'EXTERNAL_RESEARCH',
          label: 'Research claim',
          claim_id: 'b4f7232a-6a66-4a82-9ee4-504944cc4c02',
          evidence_id: 'a4f7232a-6a66-4a82-9ee4-504944cc4c03',
          content_sha256: 'a'.repeat(64),
        }],
      }) as never),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(database.query).toHaveBeenCalledTimes(1);
    expect(database.query.mock.calls[0]?.[0]).toContain("v.verdict = $11");
  });

  it('fails closed when IAM denies growth write access', async () => {
    iamService.authorize.mockRejectedValueOnce(new ForbiddenException('not allowed'));

    await expect(
      service.createOpportunity(tenantId, factoryId, userId, opportunityInput() as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(database.query).not.toHaveBeenCalled();
  });

  it('rejects changing an immutable opportunity key/version with different content', async () => {
    database.query.mockResolvedValueOnce({ rows: [opportunityRow({ request_hash: 'd'.repeat(64) })] });

    await expect(
      service.createOpportunity(tenantId, factoryId, userId, opportunityInput({
        statement: 'Different hypothesis.',
      }) as never),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(database.query).toHaveBeenCalledTimes(1);
  });
});
