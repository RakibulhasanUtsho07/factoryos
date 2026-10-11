import { BadRequestException, ConflictException } from '@nestjs/common';
import { jest } from '@jest/globals';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { CreateGrowthOpportunityDto } from './dto/create-growth-opportunity.dto';
import { CreateGrowthScenarioDto } from './dto/create-growth-scenario.dto';
import { GrowthService } from './growth.service';

const USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT_ID = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY_ID = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const OPPORTUNITY_ID = '69ef2a43-8157-4d91-aa59-7b4260ef1778';

describe('GrowthService', () => {
  let service: GrowthService;
  let client: { query: ReturnType<typeof jest.fn> };
  let database: {
    transaction: ReturnType<typeof jest.fn>;
    query: ReturnType<typeof jest.fn>;
  };
  let audit: { record: ReturnType<typeof jest.fn> };

  beforeEach(() => {
    client = { query: jest.fn() };
    database = {
      transaction: jest.fn(async (first: unknown, second?: unknown) => {
        const callback = typeof first === 'function' ? first : second;
        if (typeof callback !== 'function') throw new Error('transaction callback missing');
        return (callback as (clientArg: typeof client) => Promise<unknown>)(client);
      }),
      query: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue('audit-id') };
    service = new GrowthService(
      database as unknown as DatabaseService,
      audit as unknown as AuditService,
    );
  });

  it('requires source evidence before creating an opportunity', async () => {
    const dto = {
      title: 'Improve fabric yield',
      category: 'COST_REDUCTION',
      opportunity_statement: 'Fabric waste is above target.',
      success_hypothesis: 'A controlled process change reduces waste without lowering quality.',
      assumptions: ['Baseline scrap data is representative'],
      expected_value_low: 100,
      expected_value_high: 500,
      uncertainty_pct: 20,
      effort: 'MEDIUM',
      time_to_impact_days: 30,
      implementation_risk: 'MEDIUM',
      evidence: [],
    } as unknown as CreateGrowthOpportunityDto;

    await expect(service.createOpportunity(
      USER_ID, TENANT_ID, FACTORY_ID, dto, null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('uses a deterministic, version-labelled sensitivity formula instead of pretending to forecast', () => {
    const model = service as unknown as {
      runSensitivityModel: (input: {
        baseline_revenue: number; baseline_variable_cost: number; baseline_fixed_cost: number;
        price_change_pct: number; volume_change_pct: number; variable_cost_change_pct: number;
        fixed_cost_change_pct: number; investment: number; uncertainty_pct: number;
      }) => {
        model: string; method: string;
        baseline: { operatingProfit: number };
        proposed: { revenue: number; operatingProfit: number };
        impact: { operatingProfitDeltaBeforeInvestment: number; netImpactPoint: number; lowerBound: number; upperBound: number };
      };
    };

    const result = model.runSensitivityModel({
      baseline_revenue: 1000,
      baseline_variable_cost: 400,
      baseline_fixed_cost: 200,
      price_change_pct: 10,
      volume_change_pct: 20,
      variable_cost_change_pct: 10,
      fixed_cost_change_pct: 5,
      investment: 50,
      uncertainty_pct: 10,
    });

    expect(result.model).toBe('factoryos.growth.financial-sensitivity.v1');
    expect(result.method).toBe('deterministic_sensitivity_not_a_forecast');
    expect(result.baseline.operatingProfit).toBe(400);
    expect(result.proposed.revenue).toBe(1320);
    expect(result.proposed.operatingProfit).toBe(582);
    expect(result.impact.operatingProfitDeltaBeforeInvestment).toBe(182);
    expect(result.impact.netImpactPoint).toBe(132);
    expect(result.impact.lowerBound).toBe(113.8);
    expect(result.impact.upperBound).toBe(150.2);
  });

  it('will not run scenarios for an unapproved hypothesis', async () => {
    client.query.mockResolvedValueOnce({ rows: [{ status: 'PROPOSED' }] });
    const dto: CreateGrowthScenarioDto = {
      scenario_name: 'Price and volume sensitivity',
      scenario_type: 'UPSIDE',
      data_vintage: '2026-10-01T00:00:00.000Z',
      baseline_source_ref: 'tenant-report:finance-month-end-2026-09',
      baseline_revenue: 1000,
      baseline_variable_cost: 400,
      baseline_fixed_cost: 200,
      price_change_pct: 10,
      volume_change_pct: 20,
      variable_cost_change_pct: 10,
      fixed_cost_change_pct: 5,
      investment: 50,
      uncertainty_pct: 10,
    };

    await expect(service.createScenario(
      USER_ID, TENANT_ID, FACTORY_ID, OPPORTUNITY_ID, dto, null, null,
    )).rejects.toBeInstanceOf(ConflictException);

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0][0]).toContain('SELECT status FROM growth_opportunities');
  });

  it('keeps a sensitivity scenario exploratory when constraint snapshots or projections are missing', () => {
    const evaluator = service as unknown as {
      evaluateConstraintGate: (snapshot: Record<string, unknown>, projected?: Record<string, unknown>, refs?: Set<string>) => {
        status: string; decisionReady: boolean; missingConstraints: string[]; missingProjectedMetrics: string[];
      };
    };
    const gate = evaluator.evaluateConstraintGate({}, undefined, new Set());
    expect(gate.status).toBe('REVIEW_REQUIRED');
    expect(gate.decisionReady).toBe(false);
    expect(gate.missingConstraints).toEqual(expect.arrayContaining(['capacity', 'quality', 'cash', 'delivery']));
    expect(gate.missingProjectedMetrics).toContain('capacity_utilization_pct');
  });

  it('marks projections blocked when any declared factory limit would be breached', () => {
    const evaluator = service as unknown as {
      evaluateConstraintGate: (snapshot: Record<string, unknown>, projected: Record<string, unknown>, refs: Set<string>) => {
        status: string; decisionReady: boolean; violations: string[];
      };
    };
    const asOf = '2026-10-01T00:00:00.000Z';
    const sources = {
      capacity: { max_utilization_pct: 85, source_ref: 'capacity-report:sep', as_of: asOf },
      quality: { min_yield_pct: 98, source_ref: 'quality-report:sep', as_of: asOf },
      cash: { minimum_reserve: 50000, currency: 'BDT', source_ref: 'cash-forecast:oct', as_of: asOf },
      delivery: { max_backlog_days: 7, source_ref: 'delivery-dashboard:sep', as_of: asOf },
    };
    const refs = new Set(['capacity-report:sep', 'quality-report:sep', 'cash-forecast:oct', 'delivery-dashboard:sep']);
    const projection = {
      capacity_utilization_pct: 92,
      quality_yield_pct: 97,
      cash_after_investment: 42000,
      cash_currency: 'BDT',
      delivery_backlog_days: 12,
    };

    const gate = evaluator.evaluateConstraintGate(sources, projection, refs);
    expect(gate.status).toBe('BLOCKED');
    expect(gate.decisionReady).toBe(false);
    expect(gate.violations).toEqual(expect.arrayContaining(['capacity', 'quality', 'cash', 'delivery']));
  });

  it('allows decision-ready scenarios only when all four source-backed constraints pass', () => {
    const evaluator = service as unknown as {
      evaluateConstraintGate: (snapshot: Record<string, unknown>, projected: Record<string, unknown>, refs: Set<string>) => {
        status: string; decisionReady: boolean; checks: Array<{ dimension: string; passed: boolean }>;
      };
    };
    const asOf = '2026-10-01T00:00:00.000Z';
    const sources = {
      capacity: { max_utilization_pct: 85, source_ref: 'capacity-report:sep', as_of: asOf },
      quality: { min_yield_pct: 98, source_ref: 'quality-report:sep', as_of: asOf },
      cash: { minimum_reserve: 50000, currency: 'BDT', source_ref: 'cash-forecast:oct', as_of: asOf },
      delivery: { max_backlog_days: 7, source_ref: 'delivery-dashboard:sep', as_of: asOf },
    };
    const refs = new Set(['capacity-report:sep', 'quality-report:sep', 'cash-forecast:oct', 'delivery-dashboard:sep']);
    const projection = {
      capacity_utilization_pct: 80,
      quality_yield_pct: 99,
      cash_after_investment: 100000,
      cash_currency: 'BDT',
      delivery_backlog_days: 4,
    };

    const gate = evaluator.evaluateConstraintGate(sources, projection, refs);
    expect(gate.status).toBe('PASS');
    expect(gate.decisionReady).toBe(true);
    expect(gate.checks).toHaveLength(4);
    expect(gate.checks.every(item => item.passed)).toBe(true);
  });

});
