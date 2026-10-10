import { jest } from '@jest/globals';

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import { AiOperationalEvaluationService } from './ai.operational.evaluation.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const userId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const decisionId = '6f1a3333-3333-4333-8333-333333333333';

function input(overrides: Record<string, unknown> = {}) {
  return {
    decision_id: decisionId,
    evaluation_key: 'eval-key-001',
    domain: 'QUALITY' as const,
    metric_key: 'defect-detection',
    model_version: 'model-2.1.0',
    confidence: 0.8,
    prediction_correct: true,
    ...overrides,
  };
}

function policyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '3f2b2222-2222-4222-8222-222222222222',
    tenant_id: tenantId,
    factory_id: factoryId,
    policy_key: 'planning.lead-time',
    policy_version: 'v1',
    domain: 'PLANNING',
    metric_key: 'lead-time',
    minimum_samples: '3',
    max_mean_absolute_error: '2.000000',
    max_mean_absolute_percentage_error: null,
    min_within_tolerance_rate: '0.700000',
    max_expected_calibration_error: null,
    request_hash: 'c'.repeat(64),
    created_by: userId,
    created_at: '2026-10-10T09:00:00.000Z',
    ...overrides,
  };
}

function evaluationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '8f1a2222-2222-4222-8222-222222222222',
    tenant_id: tenantId,
    factory_id: factoryId,
    decision_id: decisionId,
    evaluation_key: 'eval-key-001',
    domain: 'QUALITY',
    metric_key: 'defect-detection',
    model_version: 'model-2.1.0',
    confidence: '0.800000',
    prediction_correct: true,
    request_hash: 'b'.repeat(64),
    source_outcome_id: null,
    predicted_value: null,
    actual_value: null,
    absolute_error: null,
    absolute_percentage_error: null,
    tolerance: null,
    created_by: userId,
    observed_at: '2026-10-10T09:00:00.000Z',
    created_at: '2026-10-10T09:00:00.000Z',
    ...overrides,
  };
}

describe('AiOperationalEvaluationService', () => {
  const database = {
    query: jest.fn<(query: string, values?: unknown[], context?: unknown) => Promise<{ rows: unknown[] }>>(),
  };
  const iamService = {
    authorize: jest.fn<(...args: unknown[]) => Promise<void>>(),
  };
  const auditService = {
    record: jest.fn<(...args: unknown[]) => Promise<string>>(),
  };
  let service: AiOperationalEvaluationService;

  beforeEach(() => {
    jest.clearAllMocks();
    database.query.mockReset();
    iamService.authorize.mockResolvedValue(undefined);
    auditService.record.mockResolvedValue('audit-id');
    service = new AiOperationalEvaluationService(
      database as never,
      iamService as never,
      auditService as never,
    );
  });

  it('records an evaluation linked to a tenant-scoped AI decision and audits the result', async () => {
    database.query
      .mockResolvedValueOnce({
        rows: [{ id: decisionId, metadata: { model_version: 'model-2.1.0' } }],
      })
      .mockResolvedValueOnce({ rows: [evaluationRow()] });

    const result = await service.recordEvaluation(
      tenantId,
      factoryId,
      userId,
      input() as never,
    );

    expect(result.idempotent).toBe(false);
    expect(result.evaluation.domain).toBe('QUALITY');
    expect(result.evaluation.confidence).toBe(0.8);
    expect(iamService.authorize).toHaveBeenCalledWith(
      userId,
      tenantId,
      'ai.outcomes.write',
      factoryId,
    );
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'AI_OPERATIONAL_EVALUATION',
        action: 'CREATE',
      }),
    );
  });

  it('rejects an evaluation that relabels the model version declared on its decision', async () => {
    database.query.mockResolvedValueOnce({
      rows: [{ id: decisionId, metadata: { model_version: 'model-1.9.0' } }],
    });

    await expect(
      service.recordEvaluation(
        tenantId,
        factoryId,
        userId,
        input({ model_version: 'model-2.1.0' }) as never,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(database.query).toHaveBeenCalledTimes(1);
  });

  it('replays the same evaluation key only when the request fingerprint matches', async () => {
    // Mirror the normalized request hash persisted by the service.
    const savedRequestHash = (
      service as unknown as {
        requestHash: (request: Record<string, unknown>) => string;
      }
    ).requestHash({
      tenantId,
      factoryId,
      actorUserId: userId,
      decisionId,
      evaluationKey: 'eval-key-001',
      domain: 'QUALITY',
      metricKey: 'defect-detection',
      modelVersion: 'model-2.1.0',
      confidence: 0.8,
      predictionCorrect: true,
      observedAt: null,
    });

    database.query.mockReset();
    database.query
      .mockResolvedValueOnce({
        rows: [{ id: decisionId, metadata: { model_version: 'model-2.1.0' } }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [evaluationRow({ request_hash: savedRequestHash })],
      });

    const result = await service.recordEvaluation(
      tenantId,
      factoryId,
      userId,
      input() as never,
    );

    expect(result.idempotent).toBe(true);
    expect(database.query).toHaveBeenCalledTimes(3);
  });

  it('rejects reuse of an evaluation key with a different payload', async () => {
    database.query
      .mockResolvedValueOnce({
        rows: [{ id: decisionId, metadata: { model_version: 'model-2.1.0' } }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [evaluationRow({ request_hash: 'a'.repeat(64) })],
      });

    await expect(
      service.recordEvaluation(
        tenantId,
        factoryId,
        userId,
        input({ confidence: 0.4 }) as never,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects evaluation for a decision outside the active factory scope', async () => {
    database.query.mockResolvedValueOnce({ rows: [] });

    await expect(
      service.recordEvaluation(tenantId, factoryId, userId, input() as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(database.query).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported domains and over-precision confidence values', async () => {
    database.query.mockResolvedValueOnce({ rows: [{ id: decisionId }] });

    await expect(
      service.recordEvaluation(
        tenantId,
        factoryId,
        userId,
        input({ domain: 'WAREHOUSE' }) as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.recordEvaluation(
        tenantId,
        factoryId,
        userId,
        input({ confidence: 0.1234567 }) as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns per-domain confidence bins and aggregate calibration metrics for the last 90 days', async () => {
    database.query.mockResolvedValueOnce({
      rows: [
        {
          domain: 'QUALITY',
          metric_key: 'defect-detection',
          model_version: 'model-2.1.0',
          bucket_index: 8,
          sample_count: 4,
          mean_confidence: 0.8,
          observed_accuracy: 0.75,
          brier_score: 0.2,
        },
        {
          domain: 'QUALITY',
          metric_key: 'defect-detection',
          model_version: 'model-2.1.0',
          bucket_index: 9,
          sample_count: 2,
          mean_confidence: 0.86,
          observed_accuracy: 1,
          brier_score: 0.025,
        },
      ],
    });

    const result = await service.getCalibration(
      tenantId,
      factoryId,
      userId,
      { domain: 'QUALITY', bins: 10 },
    );

    expect(result.windowDays).toBe(90);
    expect(result.totalSamples).toBe(6);
    expect(result.series).toHaveLength(1);
    expect(result.series[0]?.expectedCalibrationError).toBeGreaterThanOrEqual(0);
    expect(result.series[0]?.bins).toHaveLength(2);
    expect(iamService.authorize).toHaveBeenCalledWith(
      userId,
      tenantId,
      'ai.business.read',
      factoryId,
    );
  });

  it('scores a forecast using numeric values from an observed, scoped outcome', async () => {
    const observedAt = '2026-10-10T09:00:00.000Z';
    database.query
      .mockResolvedValueOnce({
        rows: [{
          id: '9f1a2222-2222-4222-8222-222222222222',
          decision_id: decisionId,
          expected_metric: { 'defect-rate': 10 },
          actual_metric: { 'defect-rate': 10.2 },
          status: 'OBSERVED',
          observed_at: observedAt,
          decision_metadata: { model_version: 'model-2.1.0' },
        }],
      })
      .mockResolvedValueOnce({
        rows: [evaluationRow({
          source_outcome_id: '9f1a2222-2222-4222-8222-222222222222',
          predicted_value: '10',
          actual_value: '10.2',
          absolute_error: '0.2',
          absolute_percentage_error: String(0.2 / 10.2),
          tolerance: '0.3',
          prediction_correct: true,
          observed_at: observedAt,
        })],
      });

    const result = await service.reconcileForecast(
      tenantId,
      factoryId,
      userId,
      {
        source_outcome_id: '9f1a2222-2222-4222-8222-222222222222',
        evaluation_key: 'forecast-key-001',
        domain: 'QUALITY',
        metric_key: 'defect-rate',
        model_version: 'model-2.1.0',
        confidence: 0.8,
        tolerance: 0.3,
      } as never,
    );

    expect(result.idempotent).toBe(false);
    expect(result.evaluation.predictedValue).toBe(10);
    expect(result.evaluation.actualValue).toBe(10.2);
    expect(result.evaluation.absoluteError).toBeCloseTo(0.2);
    expect(result.evaluation.predictionCorrect).toBe(true);
    expect(database.query).toHaveBeenCalledTimes(2);
  });

  it('rejects a forecast model version that conflicts with its source decision', async () => {
    database.query.mockResolvedValueOnce({
      rows: [{
        id: '9f1a2222-2222-4222-8222-222222222222',
        decision_id: decisionId,
        expected_metric: { 'defect-rate': 10 },
        actual_metric: { 'defect-rate': 10.2 },
        status: 'OBSERVED',
        observed_at: '2026-10-10T09:00:00.000Z',
        decision_metadata: { model_version: 'model-1.9.0' },
      }],
    });

    await expect(
      service.reconcileForecast(
        tenantId,
        factoryId,
        userId,
        {
          source_outcome_id: '9f1a2222-2222-4222-8222-222222222222',
          evaluation_key: 'forecast-model-mismatch',
          domain: 'QUALITY',
          metric_key: 'defect-rate',
          model_version: 'model-2.1.0',
          confidence: 0.8,
          tolerance: 0.3,
        } as never,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(database.query).toHaveBeenCalledTimes(1);
  });

  it('refuses to score an outcome that is not marked OBSERVED', async () => {
    database.query.mockResolvedValueOnce({
      rows: [{
        id: '9f1a2222-2222-4222-8222-222222222222',
        decision_id: decisionId,
        expected_metric: { 'defect-rate': 10 },
        actual_metric: { 'defect-rate': 10.2 },
        status: 'EXPECTED',
        observed_at: '2026-10-10T09:00:00.000Z',
      }],
    });

    await expect(
      service.reconcileForecast(
        tenantId,
        factoryId,
        userId,
        {
          source_outcome_id: '9f1a2222-2222-4222-8222-222222222222',
          evaluation_key: 'forecast-key-002',
          domain: 'QUALITY',
          metric_key: 'defect-rate',
          model_version: 'model-2.1.0',
          confidence: 0.8,
          tolerance: 0.3,
        } as never,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(database.query).toHaveBeenCalledTimes(1);
  });

  it('rejects non-numeric values in the source outcome metric', async () => {
    database.query.mockResolvedValueOnce({
      rows: [{
        id: '9f1a2222-2222-4222-8222-222222222222',
        decision_id: decisionId,
        expected_metric: { 'defect-rate': 'ten' },
        actual_metric: { 'defect-rate': 10.2 },
        status: 'OBSERVED',
        observed_at: '2026-10-10T09:00:00.000Z',
      }],
    });

    await expect(
      service.reconcileForecast(
        tenantId,
        factoryId,
        userId,
        {
          source_outcome_id: '9f1a2222-2222-4222-8222-222222222222',
          evaluation_key: 'forecast-key-003',
          domain: 'QUALITY',
          metric_key: 'defect-rate',
          model_version: 'model-2.1.0',
          confidence: 0.8,
          tolerance: 0.3,
        } as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(database.query).toHaveBeenCalledTimes(1);
  });

  it('aggregates numeric forecast error by scoped domain, metric, and model', async () => {
    database.query.mockResolvedValueOnce({
      rows: [{
        domain: 'PLANNING',
        metric_key: 'lead-time',
        model_version: 'planner-1',
        sample_count: '4',
        mean_absolute_error: 1.5,
        mean_absolute_percentage_error: 0.12,
        mean_signed_error: -0.5,
        within_tolerance_rate: 0.75,
      }],
    });

    const result = await service.getForecastAccuracy(
      tenantId,
      factoryId,
      userId,
      { domain: 'PLANNING', metricKey: 'lead-time' },
    );

    expect(result.totalSamples).toBe(4);
    expect(result.series[0]).toEqual({
      domain: 'PLANNING',
      metricKey: 'lead-time',
      modelVersion: 'planner-1',
      sampleCount: 4,
      meanAbsoluteError: 1.5,
      meanAbsolutePercentageError: 0.12,
      meanSignedError: -0.5,
      withinToleranceRate: 0.75,
    });
  });

  it('creates an append-only scoped evaluation policy version and audits it', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [policyRow()] });

    const result = await service.createEvaluationPolicy(
      tenantId,
      factoryId,
      userId,
      {
        policy_key: 'planning.lead-time',
        policy_version: 'v1',
        domain: 'PLANNING',
        metric_key: 'lead-time',
        minimum_samples: 3,
        max_mean_absolute_error: 2,
        min_within_tolerance_rate: 0.7,
      } as never,
    );

    expect(result.idempotent).toBe(false);
    expect(result.policy).toMatchObject({
      policyKey: 'planning.lead-time',
      policyVersion: 'v1',
      minimumSamples: 3,
      maxMeanAbsoluteError: 2,
      minWithinToleranceRate: 0.7,
    });
    expect(iamService.authorize).toHaveBeenCalledWith(
      userId,
      tenantId,
      'ai.evaluation.policies.write',
      factoryId,
    );
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CREATE_POLICY_VERSION',
        resourceId: policyRow().id,
      }),
    );
    expect(database.query).toHaveBeenCalledTimes(3);
  });

  it('replays an identical policy version idempotently', async () => {
    const savedRequestHash = (
      service as unknown as {
        requestHash: (request: Record<string, unknown>) => string;
      }
    ).requestHash({
      tenantId,
      factoryId,
      actorUserId: userId,
      policyKey: 'planning.lead-time',
      policyVersion: 'v1',
      domain: 'PLANNING',
      metricKey: 'lead-time',
      minimumSamples: 3,
      maxMae: 2,
      maxMape: null,
      minWithinToleranceRate: 0.7,
      maxEce: null,
    });

    database.query.mockResolvedValueOnce({
      rows: [policyRow({ request_hash: savedRequestHash })],
    });

    const result = await service.createEvaluationPolicy(
      tenantId,
      factoryId,
      userId,
      {
        policy_key: 'planning.lead-time',
        policy_version: 'v1',
        domain: 'PLANNING',
        metric_key: 'lead-time',
        minimum_samples: 3,
        max_mean_absolute_error: 2,
        min_within_tolerance_rate: 0.7,
      } as never,
    );

    expect(result.idempotent).toBe(true);
    expect(database.query).toHaveBeenCalledTimes(1);
  });

  it('requires at least one measurable threshold when creating a policy', async () => {
    await expect(
      service.createEvaluationPolicy(
        tenantId,
        factoryId,
        userId,
        {
          policy_key: 'planning.lead-time',
          policy_version: 'v1',
          domain: 'PLANNING',
          metric_key: 'lead-time',
          minimum_samples: 3,
        } as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(database.query).not.toHaveBeenCalled();
  });

  it('compares baseline and candidate forecasts using scoped observed outcomes', async () => {
    database.query.mockResolvedValueOnce({
      rows: [
        {
          model_version: 'planner-1',
          sample_count: '4',
          mean_absolute_error: 2.5,
          mean_absolute_percentage_error: 0.2,
          mean_signed_error: -1,
          within_tolerance_rate: 0.5,
        },
        {
          model_version: 'planner-2',
          sample_count: '5',
          mean_absolute_error: 1.5,
          mean_absolute_percentage_error: 0.1,
          mean_signed_error: 0.5,
          within_tolerance_rate: 0.8,
        },
      ],
    });

    const result = await service.compareForecastModels(
      tenantId,
      factoryId,
      userId,
      {
        domain: 'PLANNING',
        metricKey: 'lead-time',
        baselineModelVersion: 'planner-1',
        candidateModelVersion: 'planner-2',
      },
    );

    expect(result).toMatchObject({
      windowDays: 90,
      domain: 'PLANNING',
      metricKey: 'lead-time',
      comparisonMode: 'descriptive_only',
      comparable: true,
      baseline: {
        modelVersion: 'planner-1',
        sampleCount: 4,
        meanAbsoluteError: 2.5,
      },
      candidate: {
        modelVersion: 'planner-2',
        sampleCount: 5,
        meanAbsoluteError: 1.5,
      },
      delta: {
        meanAbsoluteError: -1,
        meanAbsolutePercentageError: -0.1,
        meanSignedError: 1.5,
        withinToleranceRate: 0.3,
      },
    });
    expect(iamService.authorize).toHaveBeenCalledWith(
      userId,
      tenantId,
      'ai.business.read',
      factoryId,
    );
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining('model_version IN ($5, $6)'),
      [
        tenantId,
        factoryId,
        'PLANNING',
        'lead-time',
        'planner-1',
        'planner-2',
      ],
      { tenantId, userId },
    );
  });

  it('evaluates candidate forecast metrics against the latest matching policy version', async () => {
    database.query
      .mockResolvedValueOnce({
        rows: [
          {
            model_version: 'planner-1',
            sample_count: '4',
            mean_absolute_error: 2.5,
            mean_absolute_percentage_error: 0.2,
            mean_signed_error: -1,
            within_tolerance_rate: 0.5,
          },
          {
            model_version: 'planner-2',
            sample_count: '5',
            mean_absolute_error: 1.5,
            mean_absolute_percentage_error: 0.1,
            mean_signed_error: 0.5,
            within_tolerance_rate: 0.8,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [policyRow()],
      });

    const result = await service.compareForecastModels(
      tenantId,
      factoryId,
      userId,
      {
        domain: 'PLANNING',
        metricKey: 'lead-time',
        baselineModelVersion: 'planner-1',
        candidateModelVersion: 'planner-2',
        policyKey: 'planning.lead-time',
      },
    );

    expect(result.comparisonMode).toBe('policy_evaluated');
    expect(result.policyEvaluation).toEqual({
      policyKey: 'planning.lead-time',
      policyVersion: 'v1',
      minimumSamples: 3,
      status: 'MEETS_POLICY',
      checks: {
        maxMeanAbsoluteError: true,
        minWithinToleranceRate: true,
      },
      candidateExpectedCalibrationError: null,
      calibrationSampleCount: null,
    });
  });

  it('reports a candidate that violates a configured forecast threshold', async () => {
    database.query
      .mockResolvedValueOnce({
        rows: [
          {
            model_version: 'planner-1',
            sample_count: '4',
            mean_absolute_error: 2.5,
            mean_absolute_percentage_error: 0.2,
            mean_signed_error: -1,
            within_tolerance_rate: 0.5,
          },
          {
            model_version: 'planner-2',
            sample_count: '5',
            mean_absolute_error: 1.5,
            mean_absolute_percentage_error: 0.1,
            mean_signed_error: 0.5,
            within_tolerance_rate: 0.8,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [policyRow({ max_mean_absolute_error: '1.000000' })],
      });

    const result = await service.compareForecastModels(
      tenantId,
      factoryId,
      userId,
      {
        domain: 'PLANNING',
        metricKey: 'lead-time',
        baselineModelVersion: 'planner-1',
        candidateModelVersion: 'planner-2',
        policyKey: 'planning.lead-time',
      },
    );

    expect(result.policyEvaluation.status).toBe('DOES_NOT_MEET_POLICY');
    expect(result.policyEvaluation.checks.maxMeanAbsoluteError).toBe(false);
    expect(result.policyEvaluation.checks.minWithinToleranceRate).toBe(true);
  });

  it('rejects comparing the same model version against itself', async () => {
    await expect(
      service.compareForecastModels(
        tenantId,
        factoryId,
        userId,
        {
          domain: 'QUALITY',
          metricKey: 'defect-rate',
          baselineModelVersion: 'model-1',
          candidateModelVersion: 'model-1',
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(database.query).not.toHaveBeenCalled();
  });

  it('rejects an invalid calibration bin count before querying data', async () => {
    await expect(
      service.getCalibration(tenantId, factoryId, userId, { bins: 30 }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(database.query).not.toHaveBeenCalled();
  });
});
