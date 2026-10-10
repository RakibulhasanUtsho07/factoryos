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

    const decision = await this.database.query<{ id: string }>(
      `
      SELECT id::text AS id
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
