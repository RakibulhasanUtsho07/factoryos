import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { jest } from '@jest/globals';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { CreateGrowthOpportunityDto } from './dto/create-growth-opportunity.dto';
import { CreateGrowthScenarioDto } from './dto/create-growth-scenario.dto';
import { DecideGrowthOpportunityDto } from './dto/decide-growth-opportunity.dto';
import { RecordGrowthForecastEvaluationDto } from './dto/record-growth-forecast-evaluation.dto';
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

  it('allows only the currently assigned decision owner to accept or reject a hypothesis', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [{ id: OPPORTUNITY_ID, status: 'PROPOSED' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'owner-assignment-id', owner_user_id: 'c90a5f40-c8bb-44e8-8b3d-2f879d56aa10' }] });
    const dto: DecideGrowthOpportunityDto = { decision: 'ACCEPT', reason: 'Review proposal and evidence' };

    await expect(service.decideOpportunity(
      USER_ID, TENANT_ID, FACTORY_ID, OPPORTUNITY_ID, dto, null, null,
    )).rejects.toBeInstanceOf(ForbiddenException);

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls[1][0]).toContain("role_code = 'DECISION_OWNER'");
  });

  it('fails closed when the database governance readiness gate is incomplete', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [{ id: OPPORTUNITY_ID, status: 'PROPOSED' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'owner-assignment-id', owner_user_id: USER_ID }] })
      .mockResolvedValueOnce({ rows: [{ ready: false }] });
    const dto: DecideGrowthOpportunityDto = { decision: 'ACCEPT', reason: 'Review proposal and evidence' };

    await expect(service.decideOpportunity(
      USER_ID, TENANT_ID, FACTORY_ID, OPPORTUNITY_ID, dto, null, null,
    )).rejects.toBeInstanceOf(ConflictException);

    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.query.mock.calls[2][0]).toContain('factoryos_growth_opportunity_governance_ready');
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


  it('pins the exact source revision into a reproducible finance scenario input hash', async () => {
    const observationId = 'e6a20b27-1920-4cf0-9f8c-82c0f9d5e132';
    const sourceRef = `factoryos://growth/source-observations/${observationId}`;
    const sourceRow = {
      id: observationId, source_kind: 'FINANCIAL_FACT',
      adapter_version: 'factoryos.growth.source-of-record.v1',
      metric_key: 'finance.actual_revenue', unit: 'BDT', value: '1000.00000000',
      observed_at: '2026-10-05T12:00:00.000Z', source_record_ref: 'finance-fact:1234',
      source_revision_hash: 'a'.repeat(64), observation_hash: 'b'.repeat(64),
      evidence_id: 'bf0f335f-57f3-4b8c-8f64-167e50717d46',
    };
    client.query
      .mockResolvedValueOnce({ rows: [{ status: 'ACCEPTED', currency: 'BDT', constraints_snapshot: {} }] })
      .mockResolvedValueOnce({ rows: [sourceRow] })
      .mockResolvedValueOnce({ rows: [{ reference_ref: sourceRef, citation_url: null }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'ac3f38e5-3e3c-44d8-86f4-3a9ad7ec96ec',
        scenario_name: 'Source pinned base', scenario_type: 'BASE',
        model_version: 'factoryos.growth.financial-sensitivity.v1',
        data_vintage: '2026-10-10T00:00:00.000Z', baseline_source_ref: sourceRef,
        inputs: {}, output_snapshot: {}, input_hash: 'c'.repeat(64), decision_ready: false,
      }] })
      .mockResolvedValueOnce({ rows: [] });

    const dto: CreateGrowthScenarioDto = {
      scenario_name: 'Source pinned base',
      scenario_type: 'BASE',
      data_vintage: '2026-10-10T00:00:00.000Z',
      baseline_source_ref: sourceRef,
      baseline_source_observation_id: observationId,
      baseline_revenue: 1000,
      baseline_variable_cost: 400,
      baseline_fixed_cost: 200,
      price_change_pct: 0,
      volume_change_pct: 0,
      variable_cost_change_pct: 0,
      fixed_cost_change_pct: 0,
      investment: 0,
      uncertainty_pct: 0,
    };
    const result = await service.createScenario(
      USER_ID, TENANT_ID, FACTORY_ID, OPPORTUNITY_ID, dto, null, null,
    );
    expect(result.id).toBe('ac3f38e5-3e3c-44d8-86f4-3a9ad7ec96ec');
    const insert = client.query.mock.calls.find(call => String(call[0]).includes('INSERT INTO growth_scenarios'));
    expect(insert).toBeDefined();
    const values = insert?.[1] as unknown[];
    const inputs = JSON.parse(String(values[8])) as Record<string, unknown>;
    expect(inputs.baseline_source_observation).toEqual(expect.objectContaining({
      id: observationId,
      adapter_version: 'factoryos.growth.source-of-record.v1',
      metric_key: 'finance.actual_revenue',
      unit: 'BDT',
      value: '1000.00000000',
      source_revision_hash: 'a'.repeat(64),
      observation_hash: 'b'.repeat(64),
    }));
    expect(String(values[10])).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a scenario when its revenue baseline differs from the pinned source observation', async () => {
    const observationId = 'e6a20b27-1920-4cf0-9f8c-82c0f9d5e132';
    const sourceRef = `factoryos://growth/source-observations/${observationId}`;
    client.query
      .mockResolvedValueOnce({ rows: [{ status: 'ACCEPTED', currency: 'BDT', constraints_snapshot: {} }] })
      .mockResolvedValueOnce({ rows: [{
        id: observationId, source_kind: 'FINANCIAL_FACT',
        adapter_version: 'factoryos.growth.source-of-record.v1',
        metric_key: 'finance.actual_revenue', unit: 'BDT', value: '1000.00000000',
        observed_at: '2026-10-05T12:00:00.000Z', source_record_ref: 'finance-fact:1234',
        source_revision_hash: 'a'.repeat(64), observation_hash: 'b'.repeat(64),
        evidence_id: 'bf0f335f-57f3-4b8c-8f64-167e50717d46',
      }] });

    await expect(service.createScenario(
      USER_ID, TENANT_ID, FACTORY_ID, OPPORTUNITY_ID,
      {
        scenario_name: 'Invalid pinned base', scenario_type: 'BASE',
        data_vintage: '2026-10-10T00:00:00.000Z', baseline_source_ref: sourceRef,
        baseline_source_observation_id: observationId, baseline_revenue: 999,
        baseline_variable_cost: 400, baseline_fixed_cost: 200,
        price_change_pct: 0, volume_change_pct: 0, variable_cost_change_pct: 0,
        fixed_cost_change_pct: 0, investment: 0, uncertainty_pct: 0,
      }, null, null,
    )).rejects.toBeInstanceOf(ConflictException);
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
    expect(client.query.mock.calls[0][0]).toContain('SELECT status, currency, constraints_snapshot FROM growth_opportunities');
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


  it('persists KPI actuals, evidence links and a factory-scoped learning signal atomically', async () => {
    client.query.mockImplementation(async (queryText: unknown) => {
      const sql = String(queryText);
      if (sql.includes('SELECT id::text AS id, status FROM growth_opportunities')) return { rows: [{ id: OPPORTUNITY_ID, status: 'IN_PROGRESS' }] };
      if (sql.includes('INSERT INTO growth_opportunity_outcomes')) return { rows: [{
        id: 'a08ea4b8-e83e-43ab-a576-e3db6a06b70c', opportunity_id: OPPORTUNITY_ID, experiment_result_id: null,
        assessment: 'POSITIVE', realized_metrics: { scrap_rate_delta_pct: -3.2 }, evidence_refs: ['quality-report:pilot-17'],
        notes: null, observed_at: '2026-10-11T10:00:00.000Z', created_at: '2026-10-11T10:00:00.000Z',
      }] };
      if (sql.includes('INSERT INTO growth_outcome_kpi_measurements')) return { rows: [{
        id: 'bb6b2a76-5f52-4e5e-b9c8-3bd75d79d71a', metric_key: 'scrap_rate_delta_pct',
        baseline_value: '0', actual_value: '-3.2', target_value: '-2', unit: 'pct',
        direction: 'DECREASE', evidence_ref: 'quality-report:pilot-17', source_experiment_kpi_id: null,
      }] };
      if (sql.includes('INSERT INTO ai_learning_signals')) return { rows: [{ id: '0e06a9e0-bfcc-4dd3-9d13-4b60750dcb38' }] };
      return { rows: [] };
    });
    const result = await service.recordOpportunityOutcome(
      USER_ID, TENANT_ID, FACTORY_ID, OPPORTUNITY_ID,
      {
        assessment: 'POSITIVE', realized_metrics: { scrap_rate_delta_pct: -3.2 },
        evidence_refs: ['quality-report:pilot-17'],
        kpi_measurements: [{
          metric_key: 'scrap_rate_delta_pct', unit: 'pct', direction: 'DECREASE',
          baseline_value: 0, actual_value: -3.2, target_value: -2, evidence_ref: 'quality-report:pilot-17',
        }],
        observed_at: '2026-10-11T10:00:00.000Z', confidence: 0.8,
      }, null, null,
    );
    expect(result.learning_signal_id).toBe('0e06a9e0-bfcc-4dd3-9d13-4b60750dcb38');
    expect(result.kpi_measurements).toHaveLength(1);
    expect(client.query.mock.calls.some(([query]) => String(query).includes('INSERT INTO growth_outcome_kpi_measurements'))).toBe(true);
    const signalCall = client.query.mock.calls.find(([query]) => String(query).includes('INSERT INTO ai_learning_signals'));
    expect(signalCall?.[1]?.[5]).toContain('"metric_key":"scrap_rate_delta_pct"');
  });

  it('rejects a KPI whose actual value disagrees with the realized metric snapshot', async () => {
    await expect(service.recordOpportunityOutcome(
      USER_ID, TENANT_ID, FACTORY_ID, OPPORTUNITY_ID,
      {
        assessment: 'POSITIVE', realized_metrics: { scrap_rate_delta_pct: -3.2 },
        evidence_refs: ['quality-report:pilot-17'],
        kpi_measurements: [{
          metric_key: 'scrap_rate_delta_pct', unit: 'pct', direction: 'DECREASE',
          baseline_value: 0, actual_value: -2.5, target_value: -2, evidence_ref: 'quality-report:pilot-17',
        }],
        observed_at: '2026-10-11T10:00:00.000Z',
      }, null, null,
    )).rejects.toThrow('Each KPI actual_value must match realized_metrics at the same metric_key');
    expect(database.transaction).not.toHaveBeenCalled();
  });


  it('returns experiment result and realized outcome KPI evidence in opportunity detail', async () => {
    database.query.mockImplementation(async (queryText: unknown) => {
      const sql = String(queryText);
      if (sql.includes('FROM growth_opportunities WHERE id = $1 AND tenant_id = $2 AND factory_id = $3')) {
        return { rows: [{ id: OPPORTUNITY_ID, status: 'IN_PROGRESS' }] };
      }
      if (sql.includes('FROM growth_experiments WHERE opportunity_id')) {
        return { rows: [{ id: '4b32c4a9-60ac-480b-aeb5-1d7b12a2dafa', name: 'Yield pilot' }] };
      }
      if (sql.includes('FROM growth_experiment_results r')) {
        return { rows: [{
          id: 'b2e3dbf1-26b1-4c93-9686-f9d906c0b4e4',
          experiment_id: '4b32c4a9-60ac-480b-aeb5-1d7b12a2dafa',
          assessment: 'POSITIVE', pre_measurements: { scrap_rate_pct: 8 },
          post_measurements: { scrap_rate_pct: 5 }, evidence_refs: ['production-report:pilot-1'],
        }] };
      }
      if (sql.includes('FROM growth_experiment_result_kpis')) {
        return { rows: [{
          id: '73d4e2d5-073d-4e6e-8ae8-31932c6af4bf',
          experiment_result_id: 'b2e3dbf1-26b1-4c93-9686-f9d906c0b4e4',
          metric_key: 'scrap_rate_pct', baseline_value: '8', actual_value: '5',
          target_value: '4', unit: 'pct', direction: 'DECREASE',
          evidence_ref: 'production-report:pilot-1',
        }] };
      }
      if (sql.includes('FROM growth_opportunity_outcomes WHERE')) {
        return { rows: [{
          id: 'ddf4aa7c-9f41-443c-b769-99c22e763b03',
          experiment_result_id: 'b2e3dbf1-26b1-4c93-9686-f9d906c0b4e4',
          realized_metrics: { scrap_rate_pct: 4.5 }, evidence_refs: ['quality-report:final-check'],
        }] };
      }
      if (sql.includes('FROM growth_outcome_kpi_measurements')) {
        return { rows: [{
          id: 'e289c43b-75d3-4c9e-86e5-3274f2fc3e81',
          outcome_id: 'ddf4aa7c-9f41-443c-b769-99c22e763b03',
          source_experiment_kpi_id: '73d4e2d5-073d-4e6e-8ae8-31932c6af4bf',
          metric_key: 'scrap_rate_pct', baseline_value: '8', actual_value: '4.5',
          target_value: '4', unit: 'pct', direction: 'DECREASE',
          evidence_ref: 'quality-report:final-check',
        }] };
      }
      return { rows: [] };
    });
    const result = await service.getOpportunity(TENANT_ID, FACTORY_ID, OPPORTUNITY_ID) as {
      experiments: Array<{ results: Array<{ kpi_measurements: Array<{ metric_key: string; actual_value: string }> }> }>;
      outcomes: Array<{ kpi_measurements: Array<{ source_experiment_kpi_id: string; evidence_ref: string }> }>;
    };
    expect(result.experiments[0].results[0].kpi_measurements[0]).toEqual(expect.objectContaining({
      metric_key: 'scrap_rate_pct', actual_value: '5',
    }));
    expect(result.outcomes[0].kpi_measurements[0]).toEqual(expect.objectContaining({
      source_experiment_kpi_id: '73d4e2d5-073d-4e6e-8ae8-31932c6af4bf',
      evidence_ref: 'quality-report:final-check',
    }));
  });

  it('stores measured experiment KPIs with evidence and numeric pre/post linkage', async () => {
    client.query.mockImplementation(async (queryText: unknown) => {
      const sql = String(queryText);
      if (sql.includes('FROM growth_experiments WHERE id = $1')) {
        return { rows: [{ id: '4b32c4a9-60ac-480b-aeb5-1d7b12a2dafa', opportunity_id: OPPORTUNITY_ID, status: 'RUNNING' }] };
      }
      if (sql.includes('INSERT INTO growth_experiment_results')) {
        return { rows: [{
          id: 'b2e3dbf1-26b1-4c93-9686-f9d906c0b4e4',
          experiment_id: '4b32c4a9-60ac-480b-aeb5-1d7b12a2dafa',
          assessment: 'POSITIVE', stop_condition_triggered: false,
          pre_measurements: { scrap_rate_pct: 8 }, post_measurements: { scrap_rate_pct: 5 },
          evidence_refs: ['production-report:pilot-1'], observed_at: '2026-10-10T10:00:00.000Z',
        }] };
      }
      if (sql.includes('INSERT INTO growth_experiment_result_kpis')) {
        return { rows: [{
          id: '73d4e2d5-073d-4e6e-8ae8-31932c6af4bf',
          metric_key: 'scrap_rate_pct', baseline_value: '8', actual_value: '5',
          target_value: '4', unit: 'pct', direction: 'DECREASE', evidence_ref: 'production-report:pilot-1',
        }] };
      }
      return { rows: [] };
    });
    const result = await service.recordExperimentResult(
      USER_ID, TENANT_ID, FACTORY_ID, '4b32c4a9-60ac-480b-aeb5-1d7b12a2dafa',
      {
        pre_measurements: { scrap_rate_pct: 8 }, post_measurements: { scrap_rate_pct: 5 },
        assessment: 'POSITIVE', stop_condition_triggered: false,
        evidence_refs: ['production-report:pilot-1'],
        kpi_measurements: [{
          metric_key: 'scrap_rate_pct', unit: 'pct', direction: 'DECREASE',
          target_value: 4, evidence_ref: 'production-report:pilot-1',
        }],
        observed_at: '2026-10-10T10:00:00.000Z',
      }, null, null,
    );
    expect(result.kpi_measurements).toHaveLength(1);
    expect(client.query.mock.calls.some(([query, values]) =>
      String(query).includes('INSERT INTO growth_experiment_result_kpis') && values?.[6] === 8 && values?.[7] === 5,
    )).toBe(true);
  });

  it('rejects KPI evidence references that do not belong to the captured experiment result', async () => {
    await expect(service.recordExperimentResult(
      USER_ID, TENANT_ID, FACTORY_ID, '4b32c4a9-60ac-480b-aeb5-1d7b12a2dafa',
      {
        pre_measurements: { scrap_rate_pct: 8 }, post_measurements: { scrap_rate_pct: 5 },
        assessment: 'POSITIVE', stop_condition_triggered: false,
        evidence_refs: ['production-report:pilot-1'],
        kpi_measurements: [{
          metric_key: 'scrap_rate_pct', unit: 'pct', direction: 'DECREASE',
          evidence_ref: 'other-report:wrong-source',
        }],
        observed_at: '2026-10-10T10:00:00.000Z',
      }, null, null,
    )).rejects.toThrow('Each KPI evidence_ref must be included in experiment result evidence_refs');
    expect(database.transaction).not.toHaveBeenCalled();
  });


  it('ranks scenario comparisons only when model, baseline, vintage and constraint gates match', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [{ id: OPPORTUNITY_ID, status: 'ACCEPTED', currency: 'BDT' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: '7b16f2f4-cc37-452c-acad-7296fc9da8e8',
            scenario_name: 'Upside',
            scenario_type: 'UPSIDE',
            model_version: 'factoryos.growth.financial-sensitivity.v1',
            data_vintage: '2026-10-01 00:00:00+00',
            baseline_source_ref: 'finance-report:2026-09',
            inputs: { baseline_revenue: 100000, baseline_variable_cost: 50000, baseline_fixed_cost: 20000 },
            output_snapshot: {
              method: 'deterministic_sensitivity_not_a_forecast',
              impact: { netImpactPoint: 150, lowerBound: 130, upperBound: 170, investment: 50 },
              constraintGate: { status: 'PASS', decisionReady: true, violations: [] },
            },
            input_hash: 'a'.repeat(64),
            decision_ready: true,
            created_at: '2026-10-11 10:00:00+00',
          },
          {
            id: 'a9f4a5f8-5b10-4c02-a46b-4d13c1f2a657',
            scenario_name: 'Base',
            scenario_type: 'BASE',
            model_version: 'factoryos.growth.financial-sensitivity.v1',
            data_vintage: '2026-10-01 00:00:00+00',
            baseline_source_ref: 'finance-report:2026-09',
            inputs: { baseline_revenue: 100000, baseline_variable_cost: 50000, baseline_fixed_cost: 20000 },
            output_snapshot: {
              method: 'deterministic_sensitivity_not_a_forecast',
              impact: { netImpactPoint: 80, lowerBound: 70, upperBound: 90, investment: 20 },
              constraintGate: { status: 'PASS', decisionReady: true, violations: [] },
            },
            input_hash: 'b'.repeat(64),
            decision_ready: true,
            created_at: '2026-10-11 09:00:00+00',
          },
        ],
      });

    const result = await service.compareScenarios(TENANT_ID, FACTORY_ID, OPPORTUNITY_ID);

    expect(result.comparable).toBe(true);
    expect(result.ranking_enabled).toBe(true);
    expect(result.comparability_reasons).toEqual([]);
    expect(result.scenarios.find(s => s.scenario_type === 'UPSIDE')?.impact_rank).toBe(1);
    expect(result.scenarios.find(s => s.scenario_type === 'BASE')?.impact_rank).toBe(2);
    expect(result.ranking_basis).toContain('not a forecast');
  });

  it('does not rank scenarios across model, baseline or data-vintage mismatches', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [{ id: OPPORTUNITY_ID, status: 'ACCEPTED', currency: 'BDT' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: '7b16f2f4-cc37-452c-acad-7296fc9da8e8',
            scenario_name: 'Current',
            scenario_type: 'BASE',
            model_version: 'factoryos.growth.financial-sensitivity.v1',
            data_vintage: '2026-10-01 00:00:00+00',
            baseline_source_ref: 'finance-report:2026-09',
            inputs: { baseline_revenue: 100000, baseline_variable_cost: 50000, baseline_fixed_cost: 20000 },
            output_snapshot: { impact: { netImpactPoint: 150 }, constraintGate: { status: 'REVIEW_REQUIRED' } },
            input_hash: 'a'.repeat(64),
            decision_ready: false,
            created_at: '2026-10-11 10:00:00+00',
          },
          {
            id: 'a9f4a5f8-5b10-4c02-a46b-4d13c1f2a657',
            scenario_name: 'Older model',
            scenario_type: 'DOWNSIDE',
            model_version: 'factoryos.growth.financial-sensitivity.v0',
            data_vintage: '2026-09-01 00:00:00+00',
            baseline_source_ref: 'finance-report:2026-08',
            inputs: { baseline_revenue: 120000, baseline_variable_cost: 55000, baseline_fixed_cost: 21000 },
            output_snapshot: { impact: { netImpactPoint: 80 }, constraintGate: { status: 'REVIEW_REQUIRED' } },
            input_hash: 'b'.repeat(64),
            decision_ready: false,
            created_at: '2026-10-11 09:00:00+00',
          },
        ],
      });

    const result = await service.compareScenarios(TENANT_ID, FACTORY_ID, OPPORTUNITY_ID);

    expect(result.comparable).toBe(false);
    expect(result.ranking_enabled).toBe(false);
    expect(result.scenarios.every(s => s.impact_rank === null)).toBe(true);
    expect(result.comparability_reasons).toEqual(expect.arrayContaining([
      'MODEL_VERSION_MISMATCH', 'BASELINE_SOURCE_MISMATCH', 'BASELINE_INPUTS_MISMATCH', 'DATA_VINTAGE_MISMATCH',
    ]));
    expect(result.ranking_blockers).toContain('SCENARIO_NOT_DECISION_READY');
    expect(result.scenario_type_coverage.missing).toEqual(expect.arrayContaining(['UPSIDE', 'STRESS']));
  });

  it('does not compare scenarios that cite the same baseline source but use different baseline values', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [{ id: OPPORTUNITY_ID, status: 'ACCEPTED', currency: 'BDT' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: '7b16f2f4-cc37-452c-acad-7296fc9da8e8',
            scenario_name: 'Base',
            scenario_type: 'BASE',
            model_version: 'factoryos.growth.financial-sensitivity.v1',
            data_vintage: '2026-10-01 00:00:00+00',
            baseline_source_ref: 'finance-report:2026-09',
            inputs: { baseline_revenue: 100000, baseline_variable_cost: 50000, baseline_fixed_cost: 20000 },
            output_snapshot: { impact: { netImpactPoint: 150 }, constraintGate: { status: 'PASS' } },
            input_hash: 'a'.repeat(64),
            decision_ready: true,
            created_at: '2026-10-11 10:00:00+00',
          },
          {
            id: 'a9f4a5f8-5b10-4c02-a46b-4d13c1f2a657',
            scenario_name: 'Upside',
            scenario_type: 'UPSIDE',
            model_version: 'factoryos.growth.financial-sensitivity.v1',
            data_vintage: '2026-10-01 00:00:00+00',
            baseline_source_ref: 'finance-report:2026-09',
            inputs: { baseline_revenue: 140000, baseline_variable_cost: 60000, baseline_fixed_cost: 25000 },
            output_snapshot: { impact: { netImpactPoint: 250 }, constraintGate: { status: 'PASS' } },
            input_hash: 'b'.repeat(64),
            decision_ready: true,
            created_at: '2026-10-11 09:00:00+00',
          },
        ],
      });

    const result = await service.compareScenarios(TENANT_ID, FACTORY_ID, OPPORTUNITY_ID);

    expect(result.comparable).toBe(false);
    expect(result.comparability_reasons).toContain('BASELINE_INPUTS_MISMATCH');
    expect(result.ranking_enabled).toBe(false);
    expect(result.scenarios.every(s => s.impact_rank === null)).toBe(true);
  });


  it('fails closed when the forecast source is not attached to the opportunity', async () => {
    client.query.mockResolvedValueOnce({ rows: [] });
    const dto: RecordGrowthForecastEvaluationDto = {
      model_version: 'ops-v1', metric_key: 'daily_output', unit: 'pieces',
      forecast_origin_at: '2026-10-01T00:00:00.000Z',
      forecast_source_ref: 'unregistered-forecast-report', forecast_value: 100,
      outcome_id: OPPORTUNITY_ID, idempotency_key: 'forecast-eval-key-0001',
    };

    await expect(service.recordForecastEvaluation(
      USER_ID, TENANT_ID, FACTORY_ID, OPPORTUNITY_ID, dto, null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('persists deterministic point errors against the exact observed KPI and emits audit/outbox evidence', async () => {
    const outcomeId = '8f4074fc-07b4-4983-8cf9-a3afabf8b2e1';
    const idempotencyKey = 'forecast-eval-key-0002';
    client.query
      .mockResolvedValueOnce({ rows: [{ id: '8f8fba80-9438-481d-9fa9-f20eece93a0c' }] })
      .mockResolvedValueOnce({ rows: [{
        id: outcomeId, measurement_id: '1e84d4ea-4c73-4a78-8818-59ef865adb22', observed_at: '2026-10-05T00:00:00.000Z',
        actual_value: '90.00000000', unit: 'pieces', evidence_ref: 'actual-report:2026-10',
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        id: 'forecast-evaluation-id', model_version: 'ops-v1', metric_key: 'daily_output',
        unit: 'pieces', forecast_origin_at: '2026-10-01T00:00:00.000Z',
        forecast_source_ref: 'forecast-report:2026-10', forecast_source_evidence_id: '8f8fba80-9438-481d-9fa9-f20eece93a0c',
        outcome_id: outcomeId, outcome_kpi_measurement_id: '1e84d4ea-4c73-4a78-8818-59ef865adb22',
        actual_evidence_ref: 'actual-report:2026-10', forecast_value: '100.00000000', actual_value: '90.00000000',
        signed_error: '10.00000000', absolute_error: '10.00000000', squared_error: '100.00000000',
        absolute_percentage_error: '11.11111111', symmetric_percentage_error: '10.52631579',
        lower_bound: null, upper_bound: null, nominal_coverage_pct: null, interval_hit: null,
        interval_width: null, interval_semantics: 'NONE',
        method_version: 'factoryos.growth.forecast-evaluation.v1',
        input_hash: 'a'.repeat(64), idempotency_key: idempotencyKey,
        evaluated_at: '2026-10-06T00:00:00.000Z',
      }] });

    const dto: RecordGrowthForecastEvaluationDto = {
      model_version: 'ops-v1', metric_key: 'daily_output', unit: 'pieces',
      forecast_origin_at: '2026-10-01T00:00:00.000Z',
      forecast_source_ref: 'forecast-report:2026-10', forecast_value: 100,
      outcome_id: outcomeId, idempotency_key: idempotencyKey,
    };
    const result = await service.recordForecastEvaluation(
      USER_ID, TENANT_ID, FACTORY_ID, OPPORTUNITY_ID, dto, null, null,
    );

    expect(result.signed_error).toBe('10.00000000');
    expect(result.replayed).toBe(false);
    expect(client.query.mock.calls[2][0]).toContain('input_hash AS request_hash');
    expect(client.query.mock.calls[3][0]).toContain('outcome_kpi_measurement_id');
    expect(client.query.mock.calls[3][0]).toContain('actual_evidence_ref');
    expect(client.query.mock.calls[3][1]).toContain('1e84d4ea-4c73-4a78-8818-59ef865adb22');
    expect(client.query.mock.calls[3][1]).toContain('actual-report:2026-10');
    expect(client.query.mock.calls[3][0]).toContain('ON CONFLICT DO NOTHING');
    expect(client.query.mock.calls[4][0]).toContain('INSERT INTO outbox_events');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'GROWTH_FORECAST_EVALUATED',
    }));
  });

  it('rejects forecast evaluation when its unit differs from the observed KPI unit', async () => {
    const outcomeId = '8f4074fc-07b4-4983-8cf9-a3afabf8b2e1';
    client.query
      .mockResolvedValueOnce({ rows: [{ id: '8f8fba80-9438-481d-9fa9-f20eece93a0c' }] })
      .mockResolvedValueOnce({ rows: [{
        id: outcomeId, measurement_id: '1e84d4ea-4c73-4a78-8818-59ef865adb22', observed_at: '2026-10-05T00:00:00.000Z',
        actual_value: '90.00000000', unit: 'pieces', evidence_ref: 'actual-report:2026-10',
      }] });
    const dto: RecordGrowthForecastEvaluationDto = {
      model_version: 'ops-v1', metric_key: 'daily_output', unit: 'boxes',
      forecast_origin_at: '2026-10-01T00:00:00.000Z',
      forecast_source_ref: 'forecast-report:2026-10', forecast_value: 100,
      outcome_id: outcomeId, idempotency_key: 'forecast-eval-key-0003',
    };

    await expect(service.recordForecastEvaluation(
      USER_ID, TENANT_ID, FACTORY_ID, OPPORTUNITY_ID, dto, null, null,
    )).rejects.toBeInstanceOf(ConflictException);
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it('replays the same forecast evaluation across users without including the actor in the request fingerprint', async () => {
    const outcomeId = '8f4074fc-07b4-4983-8cf9-a3afabf8b2e1';
    const measurementId = '1e84d4ea-4c73-4a78-8818-59ef865adb22';
    const sourceEvidenceId = '8f8fba80-9438-481d-9fa9-f20eece93a0c';
    const evaluationId = 'bccd4a6c-6a67-47c1-83d8-91a2cba52a28';
    const idempotencyKey = 'forecast-eval-actor-replay-01';
    const dto: RecordGrowthForecastEvaluationDto = {
      model_version: 'ops-v1', metric_key: 'daily_output', unit: 'pieces',
      forecast_origin_at: '2026-10-01T00:00:00.000Z',
      forecast_source_ref: 'forecast-report:2026-10', forecast_value: 100,
      outcome_id: outcomeId, idempotency_key: idempotencyKey,
    };
    const source = { id: sourceEvidenceId };
    const actual = {
      id: outcomeId, measurement_id: measurementId, observed_at: '2026-10-05T00:00:00.000Z',
      actual_value: '90.00000000', unit: 'pieces', evidence_ref: 'actual-report:2026-10',
    };

    client.query
      .mockResolvedValueOnce({ rows: [source] })
      .mockResolvedValueOnce({ rows: [actual] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        id: evaluationId, input_hash: 'placeholder', model_version: 'ops-v1',
        metric_key: 'daily_output', unit: 'pieces', idempotency_key: idempotencyKey,
      }] })
      .mockResolvedValueOnce({ rows: [] });

    const first = await service.recordForecastEvaluation(
      USER_ID, TENANT_ID, FACTORY_ID, OPPORTUNITY_ID, dto, null, null,
    );
    expect(first.replayed).toBe(false);
    const insertCall = client.query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO growth_forecast_evaluations'),
    );
    const requestHash = insertCall?.[1]?.[26];
    expect(requestHash).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));

    client.query.mockReset();
    client.query
      .mockResolvedValueOnce({ rows: [source] })
      .mockResolvedValueOnce({ rows: [actual] })
      .mockResolvedValueOnce({ rows: [{ id: evaluationId, request_hash: requestHash }] })
      .mockResolvedValueOnce({ rows: [{
        id: evaluationId, input_hash: requestHash, model_version: 'ops-v1',
        metric_key: 'daily_output', unit: 'pieces', idempotency_key: idempotencyKey,
      }] });

    const second = await service.recordForecastEvaluation(
      '6c5a2fb2-9f42-45e1-86c8-65cf8d49c9e0', TENANT_ID, FACTORY_ID, OPPORTUNITY_ID, dto, null, null,
    );

    expect(second.id).toBe(evaluationId);
    expect(second.replayed).toBe(true);
    expect(client.query).toHaveBeenCalledTimes(4);
  });

  it('rejects a reused idempotency key when the frozen forecast fingerprint differs', async () => {
    const outcomeId = '8f4074fc-07b4-4983-8cf9-a3afabf8b2e1';
    client.query
      .mockResolvedValueOnce({ rows: [{ id: '8f8fba80-9438-481d-9fa9-f20eece93a0c' }] })
      .mockResolvedValueOnce({ rows: [{
        id: outcomeId, measurement_id: '1e84d4ea-4c73-4a78-8818-59ef865adb22', observed_at: '2026-10-05T00:00:00.000Z',
        actual_value: '90.00000000', unit: 'pieces', evidence_ref: 'actual-report:2026-10',
      }] })
      .mockResolvedValueOnce({ rows: [{ id: 'existing-evaluation', request_hash: 'different-request-hash' }] });
    const dto: RecordGrowthForecastEvaluationDto = {
      model_version: 'ops-v1', metric_key: 'daily_output', unit: 'pieces',
      forecast_origin_at: '2026-10-01T00:00:00.000Z',
      forecast_source_ref: 'forecast-report:2026-10', forecast_value: 100,
      outcome_id: outcomeId, idempotency_key: 'forecast-eval-key-0005',
    };

    await expect(service.recordForecastEvaluation(
      USER_ID, TENANT_ID, FACTORY_ID, OPPORTUNITY_ID, dto, null, null,
    )).rejects.toBeInstanceOf(ConflictException);
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.query.mock.calls[2][0]).toContain('FOR UPDATE');
  });

  it('returns calibration cohorts scoped to the requested tenant, factory and opportunity', async () => {
    database.query.mockResolvedValueOnce({
      rows: Array.from({ length: 10 }, (_, index) => ({
        model_version: 'ops-v1', metric_key: 'daily_output', unit: 'pieces',
        forecast_value: '100.00000000', actual_value: '101.00000000',
        signed_error: '-1.00000000', absolute_error: '1.00000000',
        squared_error: '1.00000000', symmetric_percentage_error: '0.99502488',
        interval_hit: index < 8, nominal_coverage_pct: '90.00', interval_semantics: 'DECLARED_NOMINAL_COVERAGE',
        evaluated_at: `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
        total_count: '10',
      })),
    });
    database.query.mockResolvedValueOnce({ rows: [] });

    const result = await service.getForecastCalibration(TENANT_ID, FACTORY_ID, OPPORTUNITY_ID);

    expect(database.query.mock.calls[0][1]).toEqual([TENANT_ID, FACTORY_ID, OPPORTUNITY_ID]);
    expect(database.query.mock.calls[0][0]).toContain('LIMIT 10000');
    expect(result.total_observations).toBe(10);
    expect(result.calibration[0].status).toBe('ASSESSABLE');
    expect(result.calibration[0].empirical_interval_coverage_pct).toBe(80);
    expect(result.calibration[0].calibration_gap_pct_points).toBe(-10);
  });

  it('rejects forecast origins without an explicit timezone offset', async () => {
    const dto: RecordGrowthForecastEvaluationDto = {
      model_version: 'ops-v1', metric_key: 'daily_output', unit: 'pieces',
      forecast_origin_at: '2026-10-01T00:00:00',
      forecast_source_ref: 'forecast-report:2026-10', forecast_value: 100,
      outcome_id: OPPORTUNITY_ID, idempotency_key: 'forecast-eval-key-0006',
    };

    await expect(service.recordForecastEvaluation(
      USER_ID, TENANT_ID, FACTORY_ID, OPPORTUNITY_ID, dto, null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('requires the forecast origin to precede the realized outcome timestamp', async () => {
    const outcomeId = '8f4074fc-07b4-4983-8cf9-a3afabf8b2e1';
    client.query
      .mockResolvedValueOnce({ rows: [{ id: '8f8fba80-9438-481d-9fa9-f20eece93a0c' }] })
      .mockResolvedValueOnce({ rows: [{
        id: outcomeId, measurement_id: '1e84d4ea-4c73-4a78-8818-59ef865adb22', observed_at: '2026-10-05T00:00:00.000Z',
        actual_value: '90.00000000', unit: 'pieces', evidence_ref: 'actual-report:2026-10',
      }] });
    const dto: RecordGrowthForecastEvaluationDto = {
      model_version: 'ops-v1', metric_key: 'daily_output', unit: 'pieces',
      forecast_origin_at: '2026-10-06T00:00:00.000Z',
      forecast_source_ref: 'forecast-report:2026-10', forecast_value: 100,
      outcome_id: outcomeId, idempotency_key: 'forecast-eval-key-0004',
    };

    await expect(service.recordForecastEvaluation(
      USER_ID, TENANT_ID, FACTORY_ID, OPPORTUNITY_ID, dto, null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(client.query).toHaveBeenCalledTimes(2);
  });

});
