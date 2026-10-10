import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { createHash } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { QueryResultRow } from 'pg';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { IamService } from '../iam/iam.service';

import {
  AiOperationalDomain,
  CreateAiOperationalEvaluationDto,
} from './dto/create-ai-operational-evaluation.dto';

import {
  ReconcileAiOperationalForecastDto,
} from './dto/reconcile-ai-operational-forecast.dto';

interface EvaluationRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  decision_id: string;
  evaluation_key: string;
  domain: AiOperationalDomain;
  metric_key: string;
  model_version: string;
  confidence: number | string;
  prediction_correct: boolean;
  request_hash: string;
  source_outcome_id: string | null;
  predicted_value: number | string | null;
  actual_value: number | string | null;
  absolute_error: number | string | null;
  absolute_percentage_error: number | string | null;
  tolerance: number | string | null;
  created_by: string;
  observed_at: string;
  created_at: string;
}

interface CalibrationRow extends QueryResultRow {
  domain: AiOperationalDomain;
  metric_key: string;
  model_version: string;
  bucket_index: number | string;
  sample_count: number | string;
  mean_confidence: number | string;
  observed_accuracy: number | string;
  brier_score: number | string;
}

interface NormalizedEvaluation {
  decisionId: string;
  evaluationKey: string;
  domain: AiOperationalDomain;
  metricKey: string;
  modelVersion: string;
  confidence: number;
  predictionCorrect: boolean;
  observedAt: string | null;
}

const OPERATIONAL_DOMAINS = new Set<string>(Object.values(AiOperationalDomain));

@Injectable()
export class AiOperationalEvaluationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
  ) {}

  async recordEvaluation(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    input: CreateAiOperationalEvaluationDto,
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.outcomes.write',
      factoryId,
    );

    const normalized = this.normalizeEvaluation(input);
    const requestHash = this.requestHash({
      tenantId,
      factoryId,
      actorUserId,
      ...normalized,
    });

    const decision = await this.database.query<{
      id: string;
      metadata?: unknown;
    }>(
      `
      SELECT id::text AS id, metadata
      FROM ai_decision_envelopes
      WHERE id = $1
        AND tenant_id = $2
        AND factory_id = $3
      LIMIT 1
      `,
      [normalized.decisionId, tenantId, factoryId],
      { tenantId, userId: actorUserId },
    );

    if (!decision.rows[0]) {
      throw new NotFoundException(
        'AI decision envelope was not found for this factory',
      );
    }

    this.assertModelVersionMatchesDecisionMetadata(
      normalized.modelVersion,
      decision.rows[0].metadata,
    );

    const inserted = await this.database.query<EvaluationRow>(
      `
      INSERT INTO ai_operational_evaluation_records (
        id,
        tenant_id,
        factory_id,
        decision_id,
        evaluation_key,
        domain,
        metric_key,
        model_version,
        confidence,
        prediction_correct,
        request_hash,
        created_by,
        observed_at
      )
      VALUES (
        gen_random_uuid(),
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
        COALESCE($12::timestamptz, NOW())
      )
      ON CONFLICT (tenant_id, factory_id, evaluation_key) DO NOTHING
      RETURNING
        id::text AS id,
        tenant_id::text AS tenant_id,
        factory_id::text AS factory_id,
        decision_id::text AS decision_id,
        evaluation_key,
        domain,
        metric_key,
        model_version,
        confidence,
        prediction_correct,
        request_hash,
        source_outcome_id::text AS source_outcome_id,
        predicted_value,
        actual_value,
        absolute_error,
        absolute_percentage_error,
        tolerance,
        created_by::text AS created_by,
        observed_at::text AS observed_at,
        created_at::text AS created_at
      `,
      [
        tenantId,
        factoryId,
        normalized.decisionId,
        normalized.evaluationKey,
        normalized.domain,
        normalized.metricKey,
        normalized.modelVersion,
        normalized.confidence,
        normalized.predictionCorrect,
        requestHash,
        actorUserId,
        normalized.observedAt,
      ],
      { tenantId, userId: actorUserId },
    );

    const row = inserted.rows[0];
    if (row) {
      await this.recordAuditSafely({
        tenantId,
        factoryId,
        actorUserId,
        resourceId: row.id,
        action: 'CREATE',
        payload: {
          decisionId: row.decision_id,
          domain: row.domain,
          metricKey: row.metric_key,
          modelVersion: row.model_version,
          confidence: Number(row.confidence),
          predictionCorrect: row.prediction_correct,
        },
      });

      return {
        idempotent: false,
        evaluation: this.mapEvaluation(row),
      };
    }

    const existingResult = await this.database.query<EvaluationRow>(
      `
      SELECT
        id::text AS id,
        tenant_id::text AS tenant_id,
        factory_id::text AS factory_id,
        decision_id::text AS decision_id,
        evaluation_key,
        domain,
        metric_key,
        model_version,
        confidence,
        prediction_correct,
        request_hash,
        source_outcome_id::text AS source_outcome_id,
        predicted_value,
        actual_value,
        absolute_error,
        absolute_percentage_error,
        tolerance,
        created_by::text AS created_by,
        observed_at::text AS observed_at,
        created_at::text AS created_at
      FROM ai_operational_evaluation_records
      WHERE tenant_id = $1
        AND factory_id = $2
        AND evaluation_key = $3
      LIMIT 1
      `,
      [tenantId, factoryId, normalized.evaluationKey],
      { tenantId, userId: actorUserId },
    );

    const existing = existingResult.rows[0];
    if (!existing) {
      throw new ConflictException(
        'The evaluation could not be recorded because a conflicting request was detected',
      );
    }

    if (existing.request_hash !== requestHash) {
      throw new ConflictException(
        'The evaluation key was already used for a different evaluation request',
      );
    }

    return {
      idempotent: true,
      evaluation: this.mapEvaluation(existing),
    };
  }

  async reconcileForecast(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    input: ReconcileAiOperationalForecastDto,
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.outcomes.write',
      factoryId,
    );

    const sourceOutcomeId = this.requiredUuid(
      input.source_outcome_id,
      'source_outcome_id',
    );
    const evaluationKey = this.requiredString(
      input.evaluation_key,
      'evaluation_key',
      255,
    );
    const domain = this.normalizeDomain(input.domain);
    const metricKey = this.requiredString(input.metric_key, 'metric_key', 100);
    const modelVersion = this.requiredString(input.model_version, 'model_version', 100);

    if (
      typeof input.confidence !== 'number' ||
      !Number.isFinite(input.confidence) ||
      input.confidence < 0 ||
      input.confidence > 1 ||
      Math.round(input.confidence * 1_000_000) / 1_000_000 !== input.confidence
    ) {
      throw new BadRequestException(
        'confidence must be a number between 0 and 1 with at most six decimal places',
      );
    }

    if (
      typeof input.tolerance !== 'number' ||
      !Number.isFinite(input.tolerance) ||
      input.tolerance < 0 ||
      input.tolerance > 1_000_000_000_000_000 ||
      Math.round(input.tolerance * 1_000_000) / 1_000_000 !== input.tolerance
    ) {
      throw new BadRequestException(
        'tolerance must be a finite non-negative number with at most six decimal places',
      );
    }

    const outcomeResult = await this.database.query<{
      id: string;
      decision_id: string;
      expected_metric: Record<string, unknown>;
      actual_metric: Record<string, unknown>;
      status: string;
      observed_at: string;
      decision_metadata?: unknown;
    }>(
      `
      SELECT
        o.id::text AS id,
        o.decision_id::text AS decision_id,
        o.expected_metric,
        o.actual_metric,
        o.status,
        o.created_at::text AS observed_at,
        d.metadata AS decision_metadata
      FROM ai_outcome_links o
      INNER JOIN ai_decision_envelopes d
        ON d.id = o.decision_id
        AND d.tenant_id = o.tenant_id
        AND d.factory_id = o.factory_id
      WHERE o.id = $1
        AND o.tenant_id = $2
        AND o.factory_id = $3
      LIMIT 1
      `,
      [sourceOutcomeId, tenantId, factoryId],
      { tenantId, userId: actorUserId },
    );

    const outcome = outcomeResult.rows[0];
    if (!outcome) {
      throw new NotFoundException(
        'Observed AI outcome was not found for this factory',
      );
    }

    if (outcome.status !== 'OBSERVED') {
      throw new ConflictException(
        'Only an OBSERVED AI outcome can be used to score an operational forecast',
      );
    }

    this.assertModelVersionMatchesDecisionMetadata(
      modelVersion,
      outcome.decision_metadata,
    );

    const predictedValue = this.metricNumber(
      outcome.expected_metric,
      metricKey,
      'expected_metric',
    );
    const actualValue = this.metricNumber(
      outcome.actual_metric,
      metricKey,
      'actual_metric',
    );
    const absoluteError = Math.abs(predictedValue - actualValue);
    const absolutePercentageError =
      actualValue === 0 ? null : absoluteError / Math.abs(actualValue);
    const predictionCorrect = absoluteError <= input.tolerance;
    const observedAt = new Date(outcome.observed_at).toISOString();

    const requestHash = this.requestHash({
      tenantId,
      factoryId,
      actorUserId,
      sourceOutcomeId,
      decisionId: outcome.decision_id,
      evaluationKey,
      domain,
      metricKey,
      modelVersion,
      confidence: input.confidence,
      tolerance: input.tolerance,
      predictedValue,
      actualValue,
      observedAt,
    });

    const inserted = await this.database.query<EvaluationRow>(
      `
      INSERT INTO ai_operational_evaluation_records (
        id,
        tenant_id,
        factory_id,
        decision_id,
        source_outcome_id,
        evaluation_key,
        domain,
        metric_key,
        model_version,
        confidence,
        prediction_correct,
        request_hash,
        created_by,
        observed_at,
        predicted_value,
        actual_value,
        absolute_error,
        absolute_percentage_error,
        tolerance
      )
      VALUES (
        gen_random_uuid(),
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18
      )
      ON CONFLICT (tenant_id, factory_id, evaluation_key) DO NOTHING
      RETURNING
        id::text AS id,
        tenant_id::text AS tenant_id,
        factory_id::text AS factory_id,
        decision_id::text AS decision_id,
        evaluation_key,
        domain,
        metric_key,
        model_version,
        confidence,
        prediction_correct,
        request_hash,
        source_outcome_id::text AS source_outcome_id,
        predicted_value,
        actual_value,
        absolute_error,
        absolute_percentage_error,
        tolerance,
        created_by::text AS created_by,
        observed_at::text AS observed_at,
        created_at::text AS created_at
      `,
      [
        tenantId,
        factoryId,
        outcome.decision_id,
        sourceOutcomeId,
        evaluationKey,
        domain,
        metricKey,
        modelVersion,
        input.confidence,
        predictionCorrect,
        requestHash,
        actorUserId,
        observedAt,
        predictedValue,
        actualValue,
        absoluteError,
        absolutePercentageError,
        input.tolerance,
      ],
      { tenantId, userId: actorUserId },
    );

    const insertedRow = inserted.rows[0];
    if (insertedRow) {
      await this.recordAuditSafely({
        tenantId,
        factoryId,
        actorUserId,
        resourceId: insertedRow.id,
        action: 'RECONCILE_FORECAST',
        payload: {
          decisionId: outcome.decision_id,
          sourceOutcomeId,
          domain,
          metricKey,
          modelVersion,
          confidence: input.confidence,
          predictedValue,
          actualValue,
          absoluteError,
          absolutePercentageError,
          tolerance: input.tolerance,
          predictionCorrect,
        },
      });

      return {
        idempotent: false,
        evaluation: this.mapEvaluation(insertedRow),
      };
    }

    const existingResult = await this.database.query<EvaluationRow>(
      `
      SELECT
        id::text AS id,
        tenant_id::text AS tenant_id,
        factory_id::text AS factory_id,
        decision_id::text AS decision_id,
        evaluation_key,
        domain,
        metric_key,
        model_version,
        confidence,
        prediction_correct,
        request_hash,
        source_outcome_id::text AS source_outcome_id,
        predicted_value,
        actual_value,
        absolute_error,
        absolute_percentage_error,
        tolerance,
        created_by::text AS created_by,
        observed_at::text AS observed_at,
        created_at::text AS created_at
      FROM ai_operational_evaluation_records
      WHERE tenant_id = $1
        AND factory_id = $2
        AND evaluation_key = $3
      LIMIT 1
      `,
      [tenantId, factoryId, evaluationKey],
      { tenantId, userId: actorUserId },
    );

    const existing = existingResult.rows[0];
    if (!existing) {
      throw new ConflictException(
        'The forecast could not be scored because a conflicting request was detected',
      );
    }

    if (existing.request_hash !== requestHash) {
      throw new ConflictException(
        'The evaluation key was already used for a different forecast request',
      );
    }

    return {
      idempotent: true,
      evaluation: this.mapEvaluation(existing),
    };
  }

  async getForecastAccuracy(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    filters: {
      domain?: string;
      metricKey?: string;
      modelVersion?: string;
    } = {},
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.business.read',
      factoryId,
    );

    const domain = filters.domain
      ? this.normalizeDomain(filters.domain)
      : null;
    const metricKey = filters.metricKey
      ? this.requiredString(filters.metricKey, 'metric_key', 100)
      : null;
    const modelVersion = filters.modelVersion
      ? this.requiredString(filters.modelVersion, 'model_version', 100)
      : null;

    const result = await this.database.query<{
      domain: AiOperationalDomain;
      metric_key: string;
      model_version: string;
      sample_count: number | string;
      mean_absolute_error: number | string;
      mean_absolute_percentage_error: number | string | null;
      mean_signed_error: number | string;
      within_tolerance_rate: number | string;
    }>(
      `
      SELECT
        domain,
        metric_key,
        model_version,
        COUNT(*)::integer AS sample_count,
        AVG(absolute_error)::double precision AS mean_absolute_error,
        AVG(absolute_percentage_error)
          FILTER (WHERE absolute_percentage_error IS NOT NULL)
          ::double precision AS mean_absolute_percentage_error,
        AVG(actual_value - predicted_value)::double precision AS mean_signed_error,
        AVG((absolute_error <= tolerance)::integer)::double precision AS within_tolerance_rate
      FROM ai_operational_evaluation_records
      WHERE tenant_id = $1
        AND factory_id = $2
        AND source_outcome_id IS NOT NULL
        AND observed_at >= NOW() - INTERVAL '90 days'
        AND ($3::varchar IS NULL OR domain = $3)
        AND ($4::varchar IS NULL OR metric_key = $4)
        AND ($5::varchar IS NULL OR model_version = $5)
      GROUP BY domain, metric_key, model_version
      ORDER BY domain, metric_key, model_version
      `,
      [tenantId, factoryId, domain, metricKey, modelVersion],
      { tenantId, userId: actorUserId },
    );

    return {
      windowDays: 90,
      totalSamples: result.rows.reduce(
        (sum, row) => sum + Number(row.sample_count),
        0,
      ),
      series: result.rows.map((row) => ({
        domain: row.domain,
        metricKey: row.metric_key,
        modelVersion: row.model_version,
        sampleCount: Number(row.sample_count),
        meanAbsoluteError: this.round(Number(row.mean_absolute_error)),
        meanAbsolutePercentageError:
          row.mean_absolute_percentage_error === null
            ? null
            : this.round(Number(row.mean_absolute_percentage_error)),
        meanSignedError: this.round(Number(row.mean_signed_error)),
        withinToleranceRate: this.round(Number(row.within_tolerance_rate)),
      })),
    };
  }

  async compareForecastModels(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    filters: {
      domain?: string;
      metricKey?: string;
      baselineModelVersion?: string;
      candidateModelVersion?: string;
    } = {},
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.business.read',
      factoryId,
    );

    const domain = this.normalizeDomain(filters.domain);
    const metricKey = this.requiredString(filters.metricKey, 'metric_key', 100);
    const baselineModelVersion = this.requiredString(
      filters.baselineModelVersion,
      'baseline_model_version',
      100,
    );
    const candidateModelVersion = this.requiredString(
      filters.candidateModelVersion,
      'candidate_model_version',
      100,
    );

    if (baselineModelVersion === candidateModelVersion) {
      throw new BadRequestException(
        'baseline_model_version and candidate_model_version must be different',
      );
    }

    const result = await this.database.query<{
      model_version: string;
      sample_count: number | string;
      mean_absolute_error: number | string;
      mean_absolute_percentage_error: number | string | null;
      mean_signed_error: number | string;
      within_tolerance_rate: number | string;
    }>(
      `
      SELECT
        model_version,
        COUNT(*)::integer AS sample_count,
        AVG(absolute_error)::double precision AS mean_absolute_error,
        AVG(absolute_percentage_error)
          FILTER (WHERE absolute_percentage_error IS NOT NULL)
          ::double precision AS mean_absolute_percentage_error,
        AVG(actual_value - predicted_value)::double precision AS mean_signed_error,
        AVG((absolute_error <= tolerance)::integer)::double precision AS within_tolerance_rate
      FROM ai_operational_evaluation_records
      WHERE tenant_id = $1
        AND factory_id = $2
        AND domain = $3
        AND metric_key = $4
        AND model_version IN ($5, $6)
        AND source_outcome_id IS NOT NULL
        AND observed_at >= NOW() - INTERVAL '90 days'
      GROUP BY model_version
      ORDER BY model_version
      `,
      [
        tenantId,
        factoryId,
        domain,
        metricKey,
        baselineModelVersion,
        candidateModelVersion,
      ],
      { tenantId, userId: actorUserId },
    );

    const byVersion = new Map(
      result.rows.map((row) => [row.model_version, row]),
    );

    const toMetrics = (modelVersion: string) => {
      const row = byVersion.get(modelVersion);
      if (!row) {
        return null;
      }

      return {
        modelVersion,
        sampleCount: Number(row.sample_count),
        meanAbsoluteError: this.round(Number(row.mean_absolute_error)),
        meanAbsolutePercentageError:
          row.mean_absolute_percentage_error === null
            ? null
            : this.round(Number(row.mean_absolute_percentage_error)),
        meanSignedError: this.round(Number(row.mean_signed_error)),
        withinToleranceRate: this.round(Number(row.within_tolerance_rate)),
      };
    };

    const baseline = toMetrics(baselineModelVersion);
    const candidate = toMetrics(candidateModelVersion);
    const delta =
      baseline && candidate
        ? {
            meanAbsoluteError: this.round(
              candidate.meanAbsoluteError - baseline.meanAbsoluteError,
            ),
            meanAbsolutePercentageError:
              baseline.meanAbsolutePercentageError === null ||
              candidate.meanAbsolutePercentageError === null
                ? null
                : this.round(
                    candidate.meanAbsolutePercentageError -
                      baseline.meanAbsolutePercentageError,
                  ),
            meanSignedError: this.round(
              candidate.meanSignedError - baseline.meanSignedError,
            ),
            withinToleranceRate: this.round(
              candidate.withinToleranceRate - baseline.withinToleranceRate,
            ),
          }
        : null;

    return {
      windowDays: 90,
      domain,
      metricKey,
      comparisonMode: 'descriptive_only' as const,
      comparable: baseline !== null && candidate !== null,
      baseline,
      candidate,
      delta,
    };
  }

  async getCalibration(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    filters: {
      domain?: string;
      metricKey?: string;
      modelVersion?: string;
      bins?: number;
    } = {},
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.business.read',
      factoryId,
    );

    const domain = filters.domain
      ? this.normalizeDomain(filters.domain)
      : null;
    const metricKey = filters.metricKey
      ? this.requiredString(filters.metricKey, 'metric_key', 100)
      : null;
    const modelVersion = filters.modelVersion
      ? this.requiredString(filters.modelVersion, 'model_version', 100)
      : null;
    const bins = filters.bins ?? 10;

    if (!Number.isInteger(bins) || bins < 2 || bins > 20) {
      throw new BadRequestException('bins must be an integer between 2 and 20');
    }

    const result = await this.database.query<CalibrationRow>(
      `
      SELECT
        domain,
        metric_key,
        model_version,
        LEAST($6::integer, FLOOR(confidence * $6::numeric)::integer + 1) AS bucket_index,
        COUNT(*)::integer AS sample_count,
        AVG(confidence)::double precision AS mean_confidence,
        AVG(CASE WHEN prediction_correct THEN 1.0 ELSE 0.0 END)::double precision AS observed_accuracy,
        AVG(
          POWER(
            confidence::double precision
              - CASE WHEN prediction_correct THEN 1.0 ELSE 0.0 END,
            2
          )
        )::double precision AS brier_score
      FROM ai_operational_evaluation_records
      WHERE tenant_id = $1
        AND factory_id = $2
        AND ($3::varchar IS NULL OR domain = $3)
        AND ($4::varchar IS NULL OR metric_key = $4)
        AND ($5::varchar IS NULL OR model_version = $5)
        AND observed_at >= NOW() - INTERVAL '90 days'
      GROUP BY
        domain,
        metric_key,
        model_version,
        LEAST($6::integer, FLOOR(confidence * $6::numeric)::integer + 1)
      ORDER BY domain, metric_key, model_version, bucket_index
      `,
      [tenantId, factoryId, domain, metricKey, modelVersion, bins],
      { tenantId, userId: actorUserId },
    );

    const seriesMap = new Map<string, {
      domain: AiOperationalDomain;
      metricKey: string;
      modelVersion: string;
      sampleCount: number;
      confidenceTotal: number;
      accuracyTotal: number;
      brierTotal: number;
      eceTotal: number;
      bins: Array<{
        index: number;
        lowerBound: number;
        upperBound: number;
        sampleCount: number;
        meanConfidence: number;
        observedAccuracy: number;
        brierScore: number;
        calibrationGap: number;
      }>;
    }>();

    for (const row of result.rows) {
      const key = JSON.stringify([row.domain, row.metric_key, row.model_version]);
      let series = seriesMap.get(key);

      if (!series) {
        series = {
          domain: row.domain,
          metricKey: row.metric_key,
          modelVersion: row.model_version,
          sampleCount: 0,
          confidenceTotal: 0,
          accuracyTotal: 0,
          brierTotal: 0,
          eceTotal: 0,
          bins: [],
        };
        seriesMap.set(key, series);
      }

      const bucketIndex = Number(row.bucket_index);
      const sampleCount = Number(row.sample_count);
      const meanConfidence = Number(row.mean_confidence);
      const observedAccuracy = Number(row.observed_accuracy);
      const brierScore = Number(row.brier_score);
      const calibrationGap = Math.abs(meanConfidence - observedAccuracy);

      series.sampleCount += sampleCount;
      series.confidenceTotal += meanConfidence * sampleCount;
      series.accuracyTotal += observedAccuracy * sampleCount;
      series.brierTotal += brierScore * sampleCount;
      series.eceTotal += calibrationGap * sampleCount;
      series.bins.push({
        index: bucketIndex,
        lowerBound: this.round((bucketIndex - 1) / bins),
        upperBound: this.round(bucketIndex / bins),
        sampleCount,
        meanConfidence: this.round(meanConfidence),
        observedAccuracy: this.round(observedAccuracy),
        brierScore: this.round(brierScore),
        calibrationGap: this.round(calibrationGap),
      });
    }

    const series = Array.from(seriesMap.values()).map((item) => ({
      domain: item.domain,
      metricKey: item.metricKey,
      modelVersion: item.modelVersion,
      sampleCount: item.sampleCount,
      meanConfidence: this.round(item.confidenceTotal / item.sampleCount),
      observedAccuracy: this.round(item.accuracyTotal / item.sampleCount),
      brierScore: this.round(item.brierTotal / item.sampleCount),
      expectedCalibrationError: this.round(item.eceTotal / item.sampleCount),
      bins: item.bins,
    }));

    return {
      windowDays: 90,
      binCount: bins,
      totalSamples: series.reduce((sum, item) => sum + item.sampleCount, 0),
      series,
    };
  }

  private normalizeEvaluation(
    input: CreateAiOperationalEvaluationDto,
  ): NormalizedEvaluation {
    const decisionId = this.requiredUuid(input.decision_id, 'decision_id');
    const evaluationKey = this.requiredString(
      input.evaluation_key,
      'evaluation_key',
      255,
    );
    const domain = this.normalizeDomain(input.domain);
    const metricKey = this.requiredString(input.metric_key, 'metric_key', 100);
    const modelVersion = this.requiredString(input.model_version, 'model_version', 100);

    if (
      typeof input.confidence !== 'number' ||
      !Number.isFinite(input.confidence) ||
      input.confidence < 0 ||
      input.confidence > 1 ||
      Math.round(input.confidence * 1_000_000) / 1_000_000 !== input.confidence
    ) {
      throw new BadRequestException(
        'confidence must be a number between 0 and 1 with at most six decimal places',
      );
    }

    if (typeof input.prediction_correct !== 'boolean') {
      throw new BadRequestException('prediction_correct must be a boolean');
    }

    let observedAt: string | null = null;
    if (input.observed_at !== undefined && input.observed_at !== null) {
      const parsed = new Date(input.observed_at);
      if (!Number.isFinite(parsed.getTime())) {
        throw new BadRequestException('observed_at must be a valid ISO date');
      }
      if (parsed.getTime() > Date.now()) {
        throw new BadRequestException('observed_at cannot be in the future');
      }
      observedAt = parsed.toISOString();
    }

    return {
      decisionId,
      evaluationKey,
      domain,
      metricKey,
      modelVersion,
      confidence: input.confidence,
      predictionCorrect: input.prediction_correct,
      observedAt,
    };
  }

  /**
   * A model version recorded on the immutable decision envelope is the
   * canonical label when present. Legacy decisions without that metadata
   * remain readable, but an explicitly declared version cannot be relabelled
   * during evaluation.
   */
  private assertModelVersionMatchesDecisionMetadata(
    modelVersion: string,
    metadata: unknown,
  ): void {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return;
    }

    const record = metadata as Record<string, unknown>;
    const declaredVersion = record.model_version ?? record.modelVersion;

    if (declaredVersion === undefined || declaredVersion === null) {
      return;
    }

    if (
      typeof declaredVersion !== 'string' ||
      declaredVersion.trim().length === 0
    ) {
      throw new ConflictException(
        'The source AI decision contains an invalid model version reference',
      );
    }

    if (declaredVersion.trim() !== modelVersion) {
      throw new ConflictException(
        'model_version does not match the source AI decision metadata',
      );
    }
  }

  private metricNumber(
    metrics: Record<string, unknown>,
    metricKey: string,
    field: 'expected_metric' | 'actual_metric',
  ): number {
    const value = metrics[metricKey];

    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      Math.abs(value) > 1_000_000_000_000_000
    ) {
      throw new BadRequestException(
        `${field}.${metricKey} must be a finite numeric value within the supported range`,
      );
    }

    return value;
  }

  private normalizeDomain(value: unknown): AiOperationalDomain {
    if (typeof value !== 'string') {
      throw new BadRequestException('domain is required');
    }

    const normalized = value.trim().toUpperCase();
    if (!OPERATIONAL_DOMAINS.has(normalized)) {
      throw new BadRequestException(
        'domain must be PLANNING, QUALITY, MAINTENANCE, FINANCE, or ENERGY',
      );
    }

    return normalized as AiOperationalDomain;
  }

  private requiredString(value: unknown, field: string, maxLength: number): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} is required`);
    }

    const normalized = value.trim();
    if (!normalized || normalized.length > maxLength) {
      throw new BadRequestException(
        `${field} must contain between 1 and ${maxLength} characters`,
      );
    }
    return normalized;
  }

  private requiredUuid(value: unknown, field: string): string {
    if (typeof value !== 'string' || !isUUID(value)) {
      throw new BadRequestException(`${field} must be a valid UUID`);
    }
    return value;
  }

  private validateScope(tenantId: string, factoryId: string, actorUserId: string): void {
    this.requiredUuid(tenantId, 'tenantId');
    this.requiredUuid(factoryId, 'factoryId');
    this.requiredUuid(actorUserId, 'actorUserId');
  }

  private requestHash(input: Record<string, unknown>): string {
    return createHash('sha256')
      .update(JSON.stringify(input), 'utf8')
      .digest('hex');
  }

  private mapEvaluation(row: EvaluationRow) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      factoryId: row.factory_id,
      decisionId: row.decision_id,
      evaluationKey: row.evaluation_key,
      domain: row.domain,
      metricKey: row.metric_key,
      modelVersion: row.model_version,
      confidence: Number(row.confidence),
      predictionCorrect: row.prediction_correct,
      sourceOutcomeId: row.source_outcome_id ?? null,
      predictedValue:
        row.predicted_value === null || row.predicted_value === undefined
          ? null
          : Number(row.predicted_value),
      actualValue:
        row.actual_value === null || row.actual_value === undefined
          ? null
          : Number(row.actual_value),
      absoluteError:
        row.absolute_error === null || row.absolute_error === undefined
          ? null
          : Number(row.absolute_error),
      absolutePercentageError:
        row.absolute_percentage_error === null || row.absolute_percentage_error === undefined
          ? null
          : Number(row.absolute_percentage_error),
      tolerance:
        row.tolerance === null || row.tolerance === undefined
          ? null
          : Number(row.tolerance),
      observedAt: row.observed_at,
      createdAt: row.created_at,
    };
  }

  private async recordAuditSafely(input: {
    tenantId: string;
    factoryId: string;
    actorUserId: string;
    resourceId: string;
    action: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.auditService.record({
        tenantId: input.tenantId,
        factoryId: input.factoryId,
        actorUserId: input.actorUserId,
        eventType: 'AI_OPERATIONAL_EVALUATION',
        action: input.action,
        resourceType: 'AI_OPERATIONAL_EVALUATION',
        resourceId: input.resourceId,
        dataClass: 'INTERNAL',
        payload: input.payload,
      });
    } catch {
      // The append-only evaluation record remains authoritative if audit
      // delivery is temporarily unavailable; callers can safely retry by key.
    }
  }

  private round(value: number): number {
    return Number(value.toFixed(6));
  }
}
