import { BadRequestException, ConflictException } from '@nestjs/common';
import { jest } from '@jest/globals';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { GrowthService } from './growth.service';
import { GrowthSourceOfRecordService } from './growth-source-of-record.service';
import { RecordGrowthExperimentResultFromSourceDto } from './dto/record-growth-experiment-result-from-source.dto';
import { RecordGrowthOpportunityOutcomeFromSourceDto } from './dto/record-growth-opportunity-outcome-from-source.dto';
import { GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION } from './growth-source-of-record-adapters';

const USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT_ID = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY_ID = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const EXPERIMENT_ID = '69ef2a43-8157-4d91-aa59-7b4260ef1778';
const OPPORTUNITY_ID = 'a9816b59-9f47-4bcb-b594-8ef2b23c0cb8';
const BASELINE_ID = '6d1f65c2-8d34-45af-8bbb-c2eff5a5fdb1';
const ACTUAL_ID = 'cebadc20-718d-4331-8cd0-1ae49b0b601c';

describe('GrowthSourceOfRecordService experiment result feed', () => {
  let service: GrowthSourceOfRecordService;
  let database: { query: ReturnType<typeof jest.fn> };
  let growth: { recordExperimentResult: ReturnType<typeof jest.fn>; recordOpportunityOutcome: ReturnType<typeof jest.fn> };

  beforeEach(() => {
    database = { query: jest.fn() };
    growth = {
      recordExperimentResult: jest.fn().mockResolvedValue({ id: 'result-1' }),
      recordOpportunityOutcome: jest.fn().mockResolvedValue({ id: 'outcome-1' }),
    };
    service = new GrowthSourceOfRecordService(
      database as unknown as DatabaseService,
      { record: jest.fn() } as unknown as AuditService,
      growth as unknown as GrowthService,
    );
  });

  function dto(): RecordGrowthExperimentResultFromSourceDto {
    return {
      assessment: 'POSITIVE',
      stop_condition_triggered: false,
      kpi_measurements: [{
        metric_key: 'production.good_quantity',
        baseline_observation_id: BASELINE_ID,
        actual_observation_id: ACTUAL_ID,
        direction: 'INCREASE',
      }],
    };
  }

  function observations(actualTimestamp = '2026-10-10T14:00:00.000Z') {
    return [
      {
        id: BASELINE_ID, opportunity_id: OPPORTUNITY_ID, source_kind: 'PRODUCTION_OUTPUT',
        adapter_version: GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION, metric_key: 'production.good_quantity',
        unit: 'PCS', value: '900.00000000', observed_at: '2026-10-01T14:00:00.000Z',
        source_record_ref: `production-output:${BASELINE_ID}`, source_revision_hash: 'a'.repeat(64),
      },
      {
        id: ACTUAL_ID, opportunity_id: OPPORTUNITY_ID, source_kind: 'PRODUCTION_OUTPUT',
        adapter_version: GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION, metric_key: 'production.good_quantity',
        unit: 'PCS', value: '950.00000000', observed_at: actualTimestamp,
        source_record_ref: `production-output:${ACTUAL_ID}`, source_revision_hash: 'b'.repeat(64),
      },
    ];
  }

  it('derives pre/post values, event time and evidence refs from immutable observations, not caller values', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [{ id: EXPERIMENT_ID, opportunity_id: OPPORTUNITY_ID, status: 'RUNNING' }] })
      .mockResolvedValueOnce({ rows: observations() });

    const result = await service.recordExperimentResultFromSource(
      USER_ID, TENANT_ID, FACTORY_ID, EXPERIMENT_ID, dto(), null, null,
    );

    expect(growth.recordExperimentResult).toHaveBeenCalledTimes(1);
    const args = growth.recordExperimentResult.mock.calls[0] as unknown as unknown[];
    const recorded = args[4] as Record<string, unknown>;
    expect(recorded.pre_measurements).toEqual({ 'production.good_quantity': 900 });
    expect(recorded.post_measurements).toEqual({ 'production.good_quantity': 950 });
    expect(recorded.observed_at).toBe('2026-10-10T14:00:00.000Z');
    expect(recorded.evidence_refs).toEqual([
      `factoryos://growth/source-observations/${BASELINE_ID}`,
      `factoryos://growth/source-observations/${ACTUAL_ID}`,
    ]);
    expect(recorded.kpi_measurements).toEqual([expect.objectContaining({
      metric_key: 'production.good_quantity', unit: 'PCS',
      baseline_evidence_ref: `factoryos://growth/source-observations/${BASELINE_ID}`,
      evidence_ref: `factoryos://growth/source-observations/${ACTUAL_ID}`,
    })]);
    expect(result).toEqual({ id: 'result-1' });
  });


  it('creates normalized realized outcome and KPI evidence only from immutable source observations', async () => {
    database.query.mockResolvedValueOnce({ rows: [
      {
        id: BASELINE_ID, opportunity_id: OPPORTUNITY_ID, source_kind: 'PRODUCTION_OUTPUT',
        adapter_version: GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION, metric_key: 'production.good_quantity',
        unit: 'PCS', value: '900.00000000', observed_at: '2026-10-01T14:00:00.000Z',
        source_record_ref: `production-output:${BASELINE_ID}`, source_revision_hash: 'a'.repeat(64),
        evidence_id: 'c9b1d129-1f21-4c9e-afc0-0bbfd6288a44',
      },
      {
        id: ACTUAL_ID, opportunity_id: OPPORTUNITY_ID, source_kind: 'PRODUCTION_OUTPUT',
        adapter_version: GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION, metric_key: 'production.good_quantity',
        unit: 'PCS', value: '950.00000000', observed_at: '2026-10-10T14:00:00.000Z',
        source_record_ref: `production-output:${ACTUAL_ID}`, source_revision_hash: 'b'.repeat(64),
        evidence_id: 'fe8d4a1e-2a65-4ee3-bb38-18d8c182ab38',
      },
    ] });

    const dto: RecordGrowthOpportunityOutcomeFromSourceDto = {
      assessment: 'POSITIVE',
      confidence: 0.65,
      notes: 'Observed after the trial period',
      kpi_measurements: [{
        metric_key: 'production.good_quantity',
        baseline_observation_id: BASELINE_ID,
        actual_observation_id: ACTUAL_ID,
        direction: 'INCREASE',
        target_value: 940,
      }],
    };
    const result = await service.recordOpportunityOutcomeFromSource(
      USER_ID, TENANT_ID, FACTORY_ID, OPPORTUNITY_ID, dto, null, null,
    );

    expect(result).toEqual({ id: 'outcome-1' });
    expect(growth.recordOpportunityOutcome).toHaveBeenCalledTimes(1);
    const args = growth.recordOpportunityOutcome.mock.calls[0] as unknown as unknown[];
    expect(args.slice(0, 4)).toEqual([USER_ID, TENANT_ID, FACTORY_ID, OPPORTUNITY_ID]);
    const outcome = args[4] as Record<string, unknown>;
    expect(outcome.realized_metrics).toEqual({ 'production.good_quantity': 950 });
    expect(outcome.observed_at).toBe('2026-10-10T14:00:00.000Z');
    expect(outcome.evidence_refs).toEqual([
      `factoryos://growth/source-observations/${BASELINE_ID}`,
      `factoryos://growth/source-observations/${ACTUAL_ID}`,
    ]);
    expect(outcome.kpi_measurements).toEqual([expect.objectContaining({
      metric_key: 'production.good_quantity', unit: 'PCS', baseline_value: 900,
      actual_value: 950, target_value: 940, direction: 'INCREASE',
      baseline_evidence_ref: `factoryos://growth/source-observations/${BASELINE_ID}`,
      evidence_ref: `factoryos://growth/source-observations/${ACTUAL_ID}`,
    })]);
  });

  it('rejects a realized outcome whose baseline source timestamp is not earlier', async () => {
    database.query.mockResolvedValueOnce({ rows: [
      { id: BASELINE_ID, opportunity_id: OPPORTUNITY_ID, source_kind: 'PRODUCTION_OUTPUT',
        adapter_version: GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION, metric_key: 'production.good_quantity',
        unit: 'PCS', value: '900.00000000', observed_at: '2026-10-10T14:00:00.000Z',
        source_record_ref: `production-output:${BASELINE_ID}`, source_revision_hash: 'a'.repeat(64) },
      { id: ACTUAL_ID, opportunity_id: OPPORTUNITY_ID, source_kind: 'PRODUCTION_OUTPUT',
        adapter_version: GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION, metric_key: 'production.good_quantity',
        unit: 'PCS', value: '950.00000000', observed_at: '2026-10-10T14:00:00.000Z',
        source_record_ref: `production-output:${ACTUAL_ID}`, source_revision_hash: 'b'.repeat(64) },
    ] });
    const dto: RecordGrowthOpportunityOutcomeFromSourceDto = {
      assessment: 'POSITIVE',
      kpi_measurements: [{ metric_key: 'production.good_quantity',
        baseline_observation_id: BASELINE_ID, actual_observation_id: ACTUAL_ID, direction: 'INCREASE' }],
    };
    await expect(service.recordOpportunityOutcomeFromSource(
      USER_ID, TENANT_ID, FACTORY_ID, OPPORTUNITY_ID, dto, null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(growth.recordOpportunityOutcome).not.toHaveBeenCalled();
  });

  it('rejects forecast-only financial source observations as realized actuals', async () => {
    database.query.mockResolvedValueOnce({ rows: [
      { id: BASELINE_ID, opportunity_id: OPPORTUNITY_ID, source_kind: 'FINANCIAL_FACT',
        adapter_version: GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION, metric_key: 'finance.forecast_revenue',
        unit: 'BDT', value: '100.00000000', observed_at: '2026-10-01T14:00:00.000Z',
        source_record_ref: `finance-fact:${BASELINE_ID}`, source_revision_hash: 'a'.repeat(64) },
      { id: ACTUAL_ID, opportunity_id: OPPORTUNITY_ID, source_kind: 'FINANCIAL_FACT',
        adapter_version: GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION, metric_key: 'finance.forecast_revenue',
        unit: 'BDT', value: '120.00000000', observed_at: '2026-10-10T14:00:00.000Z',
        source_record_ref: `finance-fact:${ACTUAL_ID}`, source_revision_hash: 'b'.repeat(64) },
    ] });
    const dto: RecordGrowthOpportunityOutcomeFromSourceDto = {
      assessment: 'POSITIVE',
      kpi_measurements: [{ metric_key: 'finance.forecast_revenue',
        baseline_observation_id: BASELINE_ID, actual_observation_id: ACTUAL_ID, direction: 'INCREASE' }],
    };
    await expect(service.recordOpportunityOutcomeFromSource(
      USER_ID, TENANT_ID, FACTORY_ID, OPPORTUNITY_ID, dto, null, null,
    )).rejects.toBeInstanceOf(ConflictException);
    expect(growth.recordOpportunityOutcome).not.toHaveBeenCalled();
  });

  it('rejects a baseline that does not precede the actual observation', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [{ id: EXPERIMENT_ID, opportunity_id: OPPORTUNITY_ID, status: 'RUNNING' }] })
      .mockResolvedValueOnce({ rows: observations('2026-09-30T14:00:00.000Z') });

    await expect(service.recordExperimentResultFromSource(
      USER_ID, TENANT_ID, FACTORY_ID, EXPERIMENT_ID, dto(), null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(growth.recordExperimentResult).not.toHaveBeenCalled();
  });

  it('rejects mixed KPI observation timestamps in one realized feed', async () => {
    const sourceRows = observations();
    const alternateActual = {
      ...sourceRows[1], id: '6bc5616a-7edf-4a39-b0c1-7c41e1ac77f4',
      metric_key: 'production.scrap_quantity', value: '10.00000000',
      observed_at: '2026-10-11T14:00:00.000Z',
    };
    const mixed = dto();
    mixed.kpi_measurements.push({
      metric_key: 'production.scrap_quantity',
      baseline_observation_id: '6d1f65c2-8d34-45af-8bbb-c2eff5a5fdb2',
      actual_observation_id: '6bc5616a-7edf-4a39-b0c1-7c41e1ac77f4',
      direction: 'DECREASE',
    });
    const baselineTwo = {
      ...sourceRows[0], id: '6d1f65c2-8d34-45af-8bbb-c2eff5a5fdb2',
      metric_key: 'production.scrap_quantity', value: '20.00000000',
    };
    database.query
      .mockResolvedValueOnce({ rows: [{ id: EXPERIMENT_ID, opportunity_id: OPPORTUNITY_ID, status: 'RUNNING' }] })
      .mockResolvedValueOnce({ rows: [sourceRows[0], sourceRows[1], baselineTwo, alternateActual] });

    await expect(service.recordExperimentResultFromSource(
      USER_ID, TENANT_ID, FACTORY_ID, EXPERIMENT_ID, mixed, null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(growth.recordExperimentResult).not.toHaveBeenCalled();
  });

  it('rejects source-derived forecasts or commitments as realized finance outcomes', async () => {
    const finance = observations().map(row => ({
      ...row,
      source_kind: 'FINANCIAL_FACT',
      metric_key: 'finance.forecast_revenue',
      unit: 'BDT',
    }));
    database.query
      .mockResolvedValueOnce({ rows: [{ id: EXPERIMENT_ID, opportunity_id: OPPORTUNITY_ID, status: 'RUNNING' }] })
      .mockResolvedValueOnce({ rows: finance });

    const forecastDto = dto();
    forecastDto.kpi_measurements = [{
      metric_key: 'finance.forecast_revenue',
      baseline_observation_id: BASELINE_ID,
      actual_observation_id: ACTUAL_ID,
      direction: 'INCREASE',
    }];
    await expect(service.recordExperimentResultFromSource(
      USER_ID, TENANT_ID, FACTORY_ID, EXPERIMENT_ID, forecastDto, null, null,
    )).rejects.toBeInstanceOf(ConflictException);
    expect(growth.recordExperimentResult).not.toHaveBeenCalled();
  });
});
