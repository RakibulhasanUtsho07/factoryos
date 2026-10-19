import { ConflictException } from '@nestjs/common';
import { jest } from '@jest/globals';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { CreateGrowthScenarioSetDto } from './dto/create-growth-scenario-set.dto';
import { GrowthService } from './growth.service';

const USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT_ID = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY_ID = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const OPPORTUNITY_ID = '69ef2a43-8157-4d91-aa59-7b4260ef1778';
const SCENARIO_SET_ID = 'cd7f26ab-07b7-41a1-976a-6db8238c7bd2';

function scenarioSetInput(): CreateGrowthScenarioSetDto {
  const profile = (changes: Record<string, number> = {}) => ({
    price_change_pct: 0,
    volume_change_pct: 0,
    variable_cost_change_pct: 0,
    fixed_cost_change_pct: 0,
    investment: 50,
    uncertainty_pct: 10,
    ...changes,
  });
  return {
    set_name: 'Monthly channel growth case',
    data_vintage: '2026-10-01T00:00:00.000Z',
    baseline_source_ref: 'tenant-report:finance-2026-09',
    baseline: {
      baseline_revenue: 1000,
      baseline_variable_cost: 400,
      baseline_fixed_cost: 200,
    },
    profiles: {
      base: profile(),
      upside: profile({ price_change_pct: 5, volume_change_pct: 15 }),
      downside: profile({ price_change_pct: -5, volume_change_pct: -10 }),
      stress: profile({ volume_change_pct: -25, variable_cost_change_pct: 30, fixed_cost_change_pct: 10 }),
    },
    sensitivity: [{ parameter: 'price_change_pct', low_value: -10, high_value: 10, points: 3 }],
  } as CreateGrowthScenarioSetDto;
}

describe('GrowthService scenario sets', () => {
  it('persists one versioned set with four standard cases and deterministic sensitivity points', async () => {
    let scenarioIndex = 0;
    const client = {
      query: jest.fn().mockImplementation(async (queryText: unknown, values?: unknown[]) => {
        const sql = String(queryText);
        if (sql.includes('SELECT status, constraints_snapshot FROM growth_opportunities')) {
          return { rows: [{ status: 'ACCEPTED', constraints_snapshot: {} }] };
        }
        if (sql.includes('SELECT reference_ref, citation_url FROM growth_opportunity_evidence')) {
          return { rows: [{ reference_ref: 'tenant-report:finance-2026-09', citation_url: null }] };
        }
        if (sql.includes('SELECT COALESCE(MAX(set_version), 0) + 1')) {
          return { rows: [{ next_version: 1 }] };
        }
        if (sql.includes('INSERT INTO growth_scenario_sets')) {
          return { rows: [{
            id: SCENARIO_SET_ID,
            set_name: values?.[3],
            set_version: values?.[4],
            expected_scenario_count: values?.[5],
            model_version: values?.[6],
            data_vintage: values?.[7],
            baseline_source_ref: values?.[8],
            inputs: JSON.parse(String(values?.[9])),
            input_hash: values?.[10],
            created_by: USER_ID,
            created_at: '2026-10-19T00:00:00.000Z',
          }] };
        }
        if (sql.includes('INSERT INTO growth_scenarios (')) {
          scenarioIndex += 1;
          const output = JSON.parse(String(values?.[9])) as { constraintGate: { status: string } };
          return { rows: [{
            id: `bd68aa7b-aec2-4ec7-8b5e-${String(scenarioIndex).padStart(12, '0')}`,
            scenario_name: values?.[3],
            scenario_type: values?.[4],
            model_version: values?.[5],
            data_vintage: values?.[6],
            baseline_source_ref: values?.[7],
            inputs: JSON.parse(String(values?.[8])),
            output_snapshot: output,
            input_hash: values?.[10],
            decision_ready: output.constraintGate.status === 'PASS',
            created_at: '2026-10-19T00:00:00.000Z',
          }] };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: jest.fn(async (_context: unknown, callback: (clientArg: typeof client) => Promise<unknown>) => callback(client)),
      query: jest.fn(),
    };
    const audit = { record: jest.fn().mockResolvedValue('audit-id') };
    const service = new GrowthService(
      database as unknown as DatabaseService,
      audit as unknown as AuditService,
    );

    const result = await service.createScenarioSet(
      USER_ID, TENANT_ID, FACTORY_ID, OPPORTUNITY_ID, scenarioSetInput(), null, null,
    );

    expect(result.set_version).toBe(1);
    expect(result.expected_scenario_count).toBe(7);
    expect(result.model_version).toBe('factoryos.growth.financial-sensitivity.v1');
    expect(result.input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.scenario_count).toBe(7);
    expect(result.scenarios.map(item => item.scenario_type).slice(0, 4)).toEqual([
      'BASE', 'UPSIDE', 'DOWNSIDE', 'STRESS',
    ]);
    expect(result.scenarios.slice(4).map(item => item.sensitivity_value)).toEqual([-10, 0, 10]);
    expect(client.query.mock.calls.filter(([query]) => String(query).includes('INSERT INTO growth_scenarios ('))).toHaveLength(7);
    expect(client.query.mock.calls.filter(([query]) => String(query).includes('INSERT INTO growth_scenario_set_members'))).toHaveLength(7);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'SCENARIO_SET_RUN',
      resourceId: SCENARIO_SET_ID,
      payload: expect.objectContaining({
        decisionReady: false,
        sensitivityDecisionReady: false,
      }),
    }));
  });

  it('does not write a partial set if the opportunity is not accepted or in progress', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [{ status: 'PROPOSED', constraints_snapshot: {} }] }),
    };
    const database = {
      transaction: jest.fn(async (_context: unknown, callback: (clientArg: typeof client) => Promise<unknown>) => callback(client)),
      query: jest.fn(),
    };
    const service = new GrowthService(
      database as unknown as DatabaseService,
      { record: jest.fn() } as unknown as AuditService,
    );

    await expect(service.createScenarioSet(
      USER_ID, TENANT_ID, FACTORY_ID, OPPORTUNITY_ID, scenarioSetInput(), null, null,
    )).rejects.toBeInstanceOf(ConflictException);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls.some(([query]) => String(query).includes('INSERT INTO growth_scenario_sets'))).toBe(false);
  });
});
