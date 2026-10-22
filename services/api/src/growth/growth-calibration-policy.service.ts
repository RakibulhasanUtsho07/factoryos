import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient } from 'pg';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { CreateGrowthCalibrationPolicyDto } from './dto/create-growth-calibration-policy.dto';
import { DecideGrowthCalibrationPolicyDto } from './dto/decide-growth-calibration-policy.dto';

@Injectable()
export class GrowthCalibrationPolicyService {
  constructor(private readonly database: DatabaseService, private readonly audit: AuditService) {}

  async createPolicy(
    userId: string, tenantId: string, factoryId: string,
    dto: CreateGrowthCalibrationPolicyDto, requestId: string | null, traceId: string | null,
  ) {
    this.assertScope(userId, tenantId, factoryId);
    const domain = dto.domain;
    const modelVersion = dto.model_version?.trim() ?? '';
    const metricKey = dto.metric_key?.trim() ?? '';
    const unit = dto.unit?.trim() ?? '';
    if (!['FINANCE', 'PRODUCTION', 'QUALITY', 'DELIVERY', 'COMMERCIAL', 'OTHER'].includes(domain)) {
      throw new BadRequestException('A supported domain is required');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(modelVersion)
      || !/^[a-z][a-z0-9_.-]{0,99}$/.test(metricKey) || !unit || unit.length > 40) {
      throw new BadRequestException('Model version, metric key and unit must use the stable cohort identifiers');
    }
    const thresholds = [
      dto.max_mean_absolute_error, dto.max_root_mean_squared_error, dto.max_absolute_mean_error,
      dto.max_mean_symmetric_percentage_error_pct, dto.max_absolute_calibration_gap_pct_points,
    ];
    if (!thresholds.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
      || dto.max_mean_absolute_error > 1e12 || dto.max_root_mean_squared_error > 1e12
      || dto.max_absolute_mean_error > 1e12
      || dto.max_mean_symmetric_percentage_error_pct > 200
      || dto.max_absolute_calibration_gap_pct_points > 100) {
      throw new BadRequestException('Calibration thresholds must be finite, non-negative and within supported metric bounds');
    }
    if (!Number.isInteger(dto.minimum_sample_count) || dto.minimum_sample_count < 10 || dto.minimum_sample_count > 1_000_000) {
      throw new BadRequestException('minimum_sample_count must be an integer of at least 10');
    }

    const row = await this.database.transaction({
      tenantId, userId,
      advisoryLockKey: ['growth-calibration-policy', tenantId, factoryId, domain, modelVersion, metricKey, unit].join(':'),
    }, async client => {
      const factory = await client.query(
        'SELECT id FROM factories WHERE id=$1 AND tenant_id=$2 AND status=$3 FOR SHARE',
        [factoryId, tenantId, 'ACTIVE'],
      );
      if (!factory.rows[0]) throw new NotFoundException('Active factory not found in tenant scope');
      const next = await client.query<{ policy_version: number | string }>(
        `SELECT COALESCE(MAX(policy_version),0)+1 AS policy_version
           FROM growth_forecast_calibration_policies
          WHERE tenant_id=$1 AND factory_id=$2 AND domain=$3 AND model_version=$4 AND metric_key=$5 AND unit=$6`,
        [tenantId, factoryId, domain, modelVersion, metricKey, unit],
      );
      const policyVersion = Number(next.rows[0]?.policy_version ?? 1);
      if (!Number.isSafeInteger(policyVersion) || policyVersion < 1) {
        throw new ConflictException('Unable to allocate the next calibration policy version');
      }
      const inserted = await client.query(
        `INSERT INTO growth_forecast_calibration_policies(
           tenant_id,factory_id,domain,model_version,metric_key,unit,policy_version,minimum_sample_count,
           max_mean_absolute_error,max_root_mean_squared_error,max_absolute_mean_error,
           max_mean_symmetric_percentage_error_pct,max_absolute_calibration_gap_pct_points,created_by
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id::text AS id,domain,model_version,metric_key,unit,policy_version,minimum_sample_count,
           max_mean_absolute_error::text AS max_mean_absolute_error,
           max_root_mean_squared_error::text AS max_root_mean_squared_error,
           max_absolute_mean_error::text AS max_absolute_mean_error,
           max_mean_symmetric_percentage_error_pct::text AS max_mean_symmetric_percentage_error_pct,
           max_absolute_calibration_gap_pct_points::text AS max_absolute_calibration_gap_pct_points,
           status,created_by::text AS created_by,created_at::text AS created_at`,
        [tenantId, factoryId, domain, modelVersion, metricKey, unit, policyVersion, dto.minimum_sample_count,
          dto.max_mean_absolute_error, dto.max_root_mean_squared_error, dto.max_absolute_mean_error,
          dto.max_mean_symmetric_percentage_error_pct, dto.max_absolute_calibration_gap_pct_points, userId],
      );
      const policy = inserted.rows[0];
      if (!policy) throw new Error('GROWTH_CALIBRATION_POLICY_INSERT_FAILED');
      await this.outbox(client, tenantId, factoryId, userId, policy.id, 'GROWTH.CALIBRATION_POLICY_PROPOSED',
        this.correlationId(requestId, traceId), { policy_id: policy.id, domain, model_version: modelVersion,
          metric_key: metricKey, unit, policy_version: policyVersion, status: 'PENDING_REVIEW' });
      return policy;
    });
    await this.auditSafely(tenantId, factoryId, userId, 'CALIBRATION_POLICY_PROPOSE', String(row.id), requestId, traceId,
      { domain, model_version: modelVersion, metric_key: metricKey, unit, policy_version: row.policy_version });
    return row;
  }

  async listPolicies(
    tenantId: string, factoryId: string,
    filters: { domain?: string; metric_key?: string; model_version?: string; status?: string; limit?: number },
  ) {
    this.assertReadScope(tenantId, factoryId);
    if (filters.domain && !['FINANCE', 'PRODUCTION', 'QUALITY', 'DELIVERY', 'COMMERCIAL', 'OTHER'].includes(filters.domain)) {
      throw new BadRequestException('Unsupported calibration domain');
    }
    if (filters.metric_key && !/^[a-z][a-z0-9_.-]{0,99}$/.test(filters.metric_key)) throw new BadRequestException('Invalid metric_key');
    if (filters.model_version && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(filters.model_version)) throw new BadRequestException('Invalid model_version');
    if (filters.status && !['PENDING_REVIEW', 'APPROVED', 'REJECTED'].includes(filters.status)) throw new BadRequestException('Invalid status');
    const limit = Number.isInteger(filters.limit) ? Math.min(Math.max(filters.limit as number, 1), 200) : 50;
    const result = await this.database.query(
      `SELECT id::text AS id,domain,model_version,metric_key,unit,policy_version,minimum_sample_count,
          max_mean_absolute_error::text AS max_mean_absolute_error,
          max_root_mean_squared_error::text AS max_root_mean_squared_error,
          max_absolute_mean_error::text AS max_absolute_mean_error,
          max_mean_symmetric_percentage_error_pct::text AS max_mean_symmetric_percentage_error_pct,
          max_absolute_calibration_gap_pct_points::text AS max_absolute_calibration_gap_pct_points,
          status,created_by::text AS created_by,decided_by::text AS decided_by,
          decided_at::text AS decided_at,decision_reason,created_at::text AS created_at
         FROM growth_forecast_calibration_policies
        WHERE tenant_id=$1 AND factory_id=$2
          AND ($3::text IS NULL OR domain=$3)
          AND ($4::text IS NULL OR metric_key=$4)
          AND ($5::text IS NULL OR model_version=$5)
          AND ($6::text IS NULL OR status=$6)
        ORDER BY created_at DESC,id DESC LIMIT $7`,
      [tenantId, factoryId, filters.domain ?? null, filters.metric_key ?? null,
        filters.model_version ?? null, filters.status ?? null, limit],
      { tenantId },
    );
    return { policies: result.rows };
  }

  async decidePolicy(
    userId: string, tenantId: string, factoryId: string, policyId: string,
    dto: DecideGrowthCalibrationPolicyDto, requestId: string | null, traceId: string | null,
  ) {
    this.assertScope(userId, tenantId, factoryId, policyId);
    if (!['APPROVE', 'REJECT'].includes(dto.decision)) throw new BadRequestException('Decision must be APPROVE or REJECT');
    const reason = dto.reason?.trim() ?? '';
    if (reason.length < 8 || reason.length > 1000) throw new BadRequestException('A review reason of 8–1000 characters is required');
    const status = dto.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';

    const row = await this.database.transaction({ tenantId, userId }, async client => {
      const current = await client.query<{ id: string; status: string; created_by: string }>(
        `SELECT id::text AS id,status,created_by::text AS created_by
           FROM growth_forecast_calibration_policies
          WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE`,
        [policyId, tenantId, factoryId],
      );
      const policy = current.rows[0];
      if (!policy) throw new NotFoundException('Calibration policy not found');
      if (policy.status !== 'PENDING_REVIEW') throw new ConflictException('Only a pending calibration policy can be reviewed');
      if (policy.created_by === userId) throw new ConflictException('Calibration policy maker cannot approve or reject their own policy');
      const updated = await client.query(
        `UPDATE growth_forecast_calibration_policies
            SET status=$1,decided_by=$2,decided_at=clock_timestamp(),decision_reason=$3
          WHERE id=$4 AND tenant_id=$5 AND factory_id=$6 AND status='PENDING_REVIEW' AND created_by<>$2
          RETURNING id::text AS id,domain,model_version,metric_key,unit,policy_version,status,
             decided_by::text AS decided_by,decided_at::text AS decided_at,decision_reason`,
        [status, userId, reason, policyId, tenantId, factoryId],
      );
      if (!updated.rows[0]) throw new ConflictException('Calibration policy was reviewed concurrently or fails maker-checker policy');
      await this.outbox(client, tenantId, factoryId, userId, policyId,
        status === 'APPROVED' ? 'GROWTH.CALIBRATION_POLICY_APPROVED' : 'GROWTH.CALIBRATION_POLICY_REJECTED',
        this.correlationId(requestId, traceId), { policy_id: policyId, status, reason });
      return updated.rows[0];
    });
    await this.auditSafely(tenantId, factoryId, userId,
      status === 'APPROVED' ? 'CALIBRATION_POLICY_APPROVE' : 'CALIBRATION_POLICY_REJECT',
      policyId, requestId, traceId, { status, reason });
    return row;
  }

  private async outbox(client: PoolClient,
    tenantId: string, factoryId: string, userId: string, aggregateId: string, eventType: string,
    correlationId: string, payload: Record<string, unknown>) {
    await client.query(
      `INSERT INTO outbox_events(
         tenant_id,factory_id,aggregate_type,aggregate_id,event_type,event_version,occurred_at,
         correlation_id,causation_id,actor,source,payload
       ) VALUES($1,$2,'GROWTH_CALIBRATION_POLICY',$3,$4,1,clock_timestamp(),$5::uuid,NULL,$6::jsonb,$7::jsonb,$8::jsonb)`,
      [tenantId, factoryId, aggregateId, eventType, correlationId,
        JSON.stringify({ type: 'user', id: userId }),
        JSON.stringify({ system: 'FactoryOS', connector: 'growth-calibration-policy', version: process.env.APP_VERSION ?? '0.1.0' }),
        JSON.stringify(payload)],
    );
  }

  private async auditSafely(tenantId: string, factoryId: string, userId: string, action: string,
    resourceId: string, requestId: string | null, traceId: string | null, payload: Record<string, unknown>) {
    try {
      await this.audit.record({
        tenantId, factoryId, actorUserId: userId, eventType: 'GROWTH', action,
        resourceType: 'GROWTH_CALIBRATION_POLICY', resourceId,
        requestId: this.uuidOrNull(requestId), correlationId: this.uuidOrNull(traceId),
        dataClass: 'INTERNAL', payload,
      });
    } catch { /* Transactional outbox retains the durable mutation event. */ }
  }

  private assertScope(userId: string, tenantId: string, factoryId: string, resourceId?: string) {
    this.assertReadScope(tenantId, factoryId, resourceId);
    if (!isUUID(userId)) throw new BadRequestException('Authenticated user scope is required');
  }

  private assertReadScope(tenantId: string, factoryId: string, resourceId?: string) {
    if (![tenantId, factoryId, ...(resourceId ? [resourceId] : [])].every(value => isUUID(value))) {
      throw new BadRequestException('Tenant, factory and optional resource scope must be UUIDs');
    }
  }

  private uuidOrNull(value: string | null): string | null {
    return value && isUUID(value) ? value : null;
  }

  private correlationId(requestId: string | null, traceId: string | null): string {
    return this.uuidOrNull(requestId) ?? this.uuidOrNull(traceId) ?? randomUUID();
  }
}
