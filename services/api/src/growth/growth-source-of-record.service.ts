import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { GrowthService } from './growth.service';
import { RecordGrowthExperimentResultDto } from './dto/record-growth-experiment-result.dto';
import { SyncGrowthSourceObservationsDto } from './dto/sync-growth-source-observations.dto';
import { RecordGrowthExperimentResultFromSourceDto } from './dto/record-growth-experiment-result-from-source.dto';
import {
  allowedGrowthSourceMetrics,
  GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION,
  resolveFinancialFactMetric,
  resolveProductionOutputMetric,
  type FinancialFactSourceRow,
  type ProductionOutputSourceRow,
  type ResolvedGrowthSourceMetric,
} from './growth-source-of-record-adapters';

@Injectable()
export class GrowthSourceOfRecordService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly growth: GrowthService,
  ) {}

  async syncObservations(
    userId: string, tenantId: string, factoryId: string, opportunityId: string,
    dto: SyncGrowthSourceObservationsDto, requestId: string | null, traceId: string | null,
  ) {
    this.assertScope(userId, tenantId, factoryId, opportunityId);
    if (!Array.isArray(dto.source_record_ids) || dto.source_record_ids.length < 1 || dto.source_record_ids.length > 50) {
      throw new BadRequestException('source_record_ids must contain 1–50 canonical source record IDs');
    }
    if (!Array.isArray(dto.metric_keys) || dto.metric_keys.length < 1 || dto.metric_keys.length > 8) {
      throw new BadRequestException('metric_keys must contain 1–8 allowlisted metrics');
    }
    const sourceIds = dto.source_record_ids.map(value => typeof value === 'string' ? value.toLowerCase() : '');
    const metricKeys = dto.metric_keys.map(value => typeof value === 'string' ? value.trim() : '');
    if (sourceIds.some(value => !isUUID(value)) || new Set(sourceIds).size !== sourceIds.length) {
      throw new BadRequestException('source_record_ids must be valid unique UUIDs');
    }
    if (metricKeys.some(value => !allowedGrowthSourceMetrics(dto.source_kind).includes(value))
      || new Set(metricKeys).size !== metricKeys.length) {
      throw new BadRequestException('One or more metric_keys are not supported by this source adapter or are duplicated');
    }
    const idempotencyKey = typeof dto.idempotency_key === 'string' ? dto.idempotency_key.trim() : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)) {
      throw new BadRequestException('idempotency_key must be a stable token of 8–128 characters');
    }
    sourceIds.sort();
    metricKeys.sort();
    const canonical = {
      schema_version: 1,
      adapter_version: GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION,
      tenant_id: tenantId,
      factory_id: factoryId,
      opportunity_id: opportunityId,
      source_kind: dto.source_kind,
      source_record_ids: sourceIds,
      metric_keys: metricKeys,
    };
    const inputHash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');

    const result = await this.database.transaction({
      tenantId, userId,
      advisoryLockKey: 'growth-source-observation:' + tenantId + ':' + factoryId + ':' + opportunityId,
    }, async client => {
      const opportunityResult = await client.query<{ status: string }>(
        'SELECT status FROM growth_opportunities WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
        [opportunityId, tenantId, factoryId],
      );
      const opportunity = opportunityResult.rows[0];
      if (!opportunity) throw new NotFoundException('Growth opportunity not found');
      if (!['ACCEPTED', 'IN_PROGRESS', 'REALIZED'].includes(opportunity.status)) {
        throw new ConflictException('Source observations require an accepted or in-progress growth opportunity');
      }
      const prior = await client.query<{ id: string; input_hash: string }>(
        'SELECT id::text AS id,input_hash FROM growth_kpi_source_sync_runs WHERE tenant_id=$1 AND factory_id=$2 AND opportunity_id=$3 AND idempotency_key=$4 FOR UPDATE',
        [tenantId, factoryId, opportunityId, idempotencyKey],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].input_hash !== inputHash) {
          throw new ConflictException('Source-observation idempotency key was reused for different inputs');
        }
        const replay = await client.query(
          `SELECT o.id::text AS id,o.source_kind,o.adapter_version,o.metric_key,o.unit,o.value::text AS value,
              o.observed_at::text AS observed_at,o.source_record_ref,o.source_revision_hash,
              o.observation_hash,o.evidence_id::text AS evidence_id,o.created_at::text AS created_at
             FROM growth_kpi_source_sync_items i
             JOIN growth_kpi_source_observations o ON o.id=i.observation_id
               AND o.tenant_id=i.tenant_id AND o.factory_id=i.factory_id AND o.opportunity_id=i.opportunity_id
            WHERE i.sync_run_id=$1 AND i.tenant_id=$2 AND i.factory_id=$3 AND i.opportunity_id=$4
            ORDER BY o.observed_at,o.metric_key,o.id`,
          [prior.rows[0].id, tenantId, factoryId, opportunityId],
        );
        return { sync_run_id: prior.rows[0].id, adapter_version: GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION, replayed: true, observations: replay.rows };
      }

      const records: Array<FinancialFactSourceRow | ProductionOutputSourceRow> = dto.source_kind === 'FINANCIAL_FACT'
        ? (await client.query<FinancialFactSourceRow>(
          `SELECT f.id::text AS id,f.fact_type,f.effective_at::text AS effective_at,
                  f.currency,f.amount::text AS amount,f.fact_hash
             FROM financial_facts f
             JOIN finance_connectors c ON c.id=f.connector_id AND c.tenant_id=f.tenant_id AND c.factory_id=f.factory_id
            WHERE f.id=ANY($1::uuid[]) AND f.tenant_id=$2 AND f.factory_id=$3
              AND c.status='ACTIVE' AND c.is_reporting_source=TRUE
            ORDER BY f.id FOR SHARE OF f,c`,
          [sourceIds, tenantId, factoryId],
        )).rows
        : (await client.query<ProductionOutputSourceRow>(
          `SELECT p.id::text AS id,p.created_at::text AS created_at,i.unit,
                  p.good_quantity::text AS good_quantity,p.scrap_quantity::text AS scrap_quantity,
                  p.yield_percentage::text AS yield_percentage,
                  p.cumulative_yield_percentage::text AS cumulative_yield_percentage,
                  p.request_hash
             FROM production_output_postings p
             JOIN inventory_items i ON i.id=p.finished_item_id AND i.tenant_id=p.tenant_id AND i.factory_id=p.factory_id
            WHERE p.id=ANY($1::uuid[]) AND p.tenant_id=$2 AND p.factory_id=$3
            ORDER BY p.id FOR SHARE OF p,i`,
          [sourceIds, tenantId, factoryId],
        )).rows;
      if (records.length !== sourceIds.length) {
        throw new NotFoundException('One or more source records are missing, outside this factory, or not from an active Finance reporting connector');
      }

      const syncId = randomUUID();
      await client.query(
        `INSERT INTO growth_kpi_source_sync_runs(
           id,tenant_id,factory_id,opportunity_id,source_kind,adapter_version,idempotency_key,
           input_hash,source_record_ids,metric_keys,created_by
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)`,
        [syncId, tenantId, factoryId, opportunityId, dto.source_kind, GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION,
          idempotencyKey, inputHash, JSON.stringify(sourceIds), JSON.stringify(metricKeys), userId],
      );

      const observations: Array<Record<string, unknown>> = [];
      for (const sourceRow of records) {
        for (const metricKey of metricKeys) {
          let mapped: ResolvedGrowthSourceMetric;
          try {
            mapped = dto.source_kind === 'FINANCIAL_FACT'
              ? resolveFinancialFactMetric(sourceRow as FinancialFactSourceRow, metricKey)
              : resolveProductionOutputMetric(sourceRow as ProductionOutputSourceRow, metricKey);
          } catch (error) {
            const code = error instanceof Error ? error.message : 'GROWTH_SOURCE_MAPPING_INVALID';
            throw new BadRequestException(code);
          }
          const financeId = dto.source_kind === 'FINANCIAL_FACT' ? sourceRow.id : null;
          const productionId = dto.source_kind === 'PRODUCTION_OUTPUT' ? sourceRow.id : null;
          const existing = await client.query<{
            id: string; evidence_id: string; observation_hash: string; value: string; unit: string;
            observed_at: string; source_record_ref: string; source_revision_hash: string;
          }>(
            dto.source_kind === 'FINANCIAL_FACT'
              ? `SELECT id::text AS id,evidence_id::text AS evidence_id,observation_hash,value::text AS value,unit,
                         observed_at::text AS observed_at,source_record_ref,source_revision_hash
                   FROM growth_kpi_source_observations
                  WHERE tenant_id=$1 AND factory_id=$2 AND opportunity_id=$3
                    AND source_financial_fact_id=$4 AND metric_key=$5 AND adapter_version=$6
                  FOR SHARE`
              : `SELECT id::text AS id,evidence_id::text AS evidence_id,observation_hash,value::text AS value,unit,
                         observed_at::text AS observed_at,source_record_ref,source_revision_hash
                   FROM growth_kpi_source_observations
                  WHERE tenant_id=$1 AND factory_id=$2 AND opportunity_id=$3
                    AND source_production_output_posting_id=$4 AND metric_key=$5 AND adapter_version=$6
                  FOR SHARE`,
            [tenantId, factoryId, opportunityId, sourceRow.id, metricKey, GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION],
          );
          let observationId: string;
          let evidenceId: string;
          let observationHash: string;
          if (existing.rows[0]) {
            const priorObservation = existing.rows[0];
            if (priorObservation.value !== mapped.value || priorObservation.unit !== mapped.unit
              || new Date(priorObservation.observed_at).toISOString() !== mapped.observed_at
              || priorObservation.source_record_ref !== mapped.source_record_ref
              || priorObservation.source_revision_hash !== mapped.source_revision_hash) {
              throw new ConflictException('An existing pinned source observation no longer matches its canonical source row');
            }
            observationId = priorObservation.id;
            evidenceId = priorObservation.evidence_id;
            observationHash = priorObservation.observation_hash;
          } else {
            observationId = randomUUID();
            evidenceId = randomUUID();
            const snapshot = {
              source_kind: mapped.source_kind,
              source_record_ref: mapped.source_record_ref,
              source_revision_hash: mapped.source_revision_hash,
              adapter_version: GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION,
              metric_key: mapped.metric_key,
              unit: mapped.unit,
              value: mapped.value,
              observed_at: mapped.observed_at,
              source_record_id: sourceRow.id,
            };
            observationHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
            await client.query(
              `INSERT INTO growth_opportunity_evidence(
                 id,tenant_id,factory_id,opportunity_id,evidence_type,origin_class,reference_ref,
                 description,confidence,evidence_snapshot,created_by
               ) VALUES($1,$2,$3,$4,'OPERATIONAL_METRIC','OPERATIONAL',$5,$6,0.8,$7::jsonb,$8)`,
              [evidenceId, tenantId, factoryId, opportunityId,
                `factoryos://growth/source-observations/${observationId}`,
                `Version-pinned ${mapped.source_kind} observation for ${mapped.metric_key} from ${mapped.source_record_ref}`,
                JSON.stringify(snapshot), userId],
            );
            await client.query(
              `INSERT INTO growth_kpi_source_observations(
                 id,tenant_id,factory_id,opportunity_id,sync_run_id,source_kind,adapter_version,
                 metric_key,unit,value,observed_at,source_record_ref,source_revision_hash,observation_hash,
                 source_financial_fact_id,source_production_output_posting_id,evidence_id,created_by
               ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11,$12,$13,$14,$15,$16,$17,$18)`,
              [observationId, tenantId, factoryId, opportunityId, syncId, mapped.source_kind,
                GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION, mapped.metric_key, mapped.unit, mapped.value,
                mapped.observed_at, mapped.source_record_ref, mapped.source_revision_hash, observationHash,
                financeId, productionId, evidenceId, userId],
            );
          }
          await client.query(
            `INSERT INTO growth_kpi_source_sync_items(tenant_id,factory_id,opportunity_id,sync_run_id,observation_id)
             VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [tenantId, factoryId, opportunityId, syncId, observationId],
          );
          observations.push({
            id: observationId, source_kind: mapped.source_kind,
            adapter_version: GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION, metric_key: mapped.metric_key,
            unit: mapped.unit, value: mapped.value, observed_at: mapped.observed_at,
            source_record_ref: mapped.source_record_ref, source_revision_hash: mapped.source_revision_hash,
            observation_hash: observationHash, evidence_id: evidenceId,
          });
        }
      }

      await client.query(
        `INSERT INTO outbox_events(
           tenant_id,factory_id,aggregate_type,aggregate_id,event_type,event_version,occurred_at,
           correlation_id,causation_id,actor,source,payload
         ) VALUES($1,$2,'GROWTH_KPI_SOURCE_SYNC',$3,'GROWTH.SOURCE_OBSERVATIONS_SYNCED',1,
           clock_timestamp(),$4::uuid,NULL,$5::jsonb,$6::jsonb,$7::jsonb)`,
        [tenantId, factoryId, syncId, this.correlationId(requestId, traceId),
          JSON.stringify({ type: 'user', id: userId }),
          JSON.stringify({ system: 'FactoryOS', connector: 'growth-source-of-record', version: GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION }),
          JSON.stringify({ opportunity_id: opportunityId, source_kind: dto.source_kind,
            adapter_version: GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION, observation_count: observations.length,
            source_record_ids: sourceIds, metric_keys: metricKeys, input_hash: inputHash })],
      );
      return { sync_run_id: syncId, adapter_version: GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION, input_hash: inputHash, replayed: false, observations };
    });

    if (!result.replayed) {
      try {
        await this.audit.record({
          tenantId, factoryId, actorUserId: userId, eventType: 'GROWTH',
          action: 'SOURCE_OF_RECORD_KPI_SYNC', resourceType: 'GROWTH_KPI_SOURCE_SYNC',
          resourceId: String(result.sync_run_id), requestId: this.uuidOrNull(requestId),
          correlationId: this.uuidOrNull(traceId), dataClass: 'INTERNAL',
          payload: { opportunityId, sourceKind: dto.source_kind, adapterVersion: GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION, observationCount: result.observations.length, inputHash: result.input_hash },
        });
      } catch { /* Transactional outbox remains the durable audit/dispatch record. */ }
    }
    return result;
  }

  async listObservations(
    tenantId: string, factoryId: string, opportunityId: string,
    filters: { source_kind?: string; metric_key?: string; limit?: number },
  ) {
    this.assertReadScope(tenantId, factoryId, opportunityId);
    if (filters.source_kind && !['FINANCIAL_FACT', 'PRODUCTION_OUTPUT'].includes(filters.source_kind)) {
      throw new BadRequestException('source_kind must be FINANCIAL_FACT or PRODUCTION_OUTPUT');
    }
    if (filters.metric_key && !/^[a-z][a-z0-9_.-]{0,99}$/.test(filters.metric_key)) {
      throw new BadRequestException('metric_key must be a stable lowercase identifier');
    }
    const limit = Number.isInteger(filters.limit) ? Math.min(Math.max(filters.limit as number, 1), 200) : 50;
    const result = await this.database.query(
      `SELECT o.id::text AS id,o.source_kind,o.adapter_version,o.metric_key,o.unit,o.value::text AS value,
              o.observed_at::text AS observed_at,o.source_record_ref,o.source_revision_hash,o.observation_hash,
              o.evidence_id::text AS evidence_id,o.created_at::text AS created_at
         FROM growth_kpi_source_observations o
        WHERE o.tenant_id=$1 AND o.factory_id=$2 AND o.opportunity_id=$3
          AND ($4::text IS NULL OR o.source_kind=$4)
          AND ($5::text IS NULL OR o.metric_key=$5)
        ORDER BY o.observed_at DESC,o.metric_key,o.id
        LIMIT $6`,
      [tenantId, factoryId, opportunityId, filters.source_kind ?? null, filters.metric_key ?? null, limit],
      { tenantId },
    );
    return { adapter_version: GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION, observations: result.rows };
  }

  async recordExperimentResultFromSource(
    userId: string, tenantId: string, factoryId: string, experimentId: string,
    dto: RecordGrowthExperimentResultFromSourceDto, requestId: string | null, traceId: string | null,
  ) {
    this.assertScope(userId, tenantId, factoryId, experimentId);
    if (!Array.isArray(dto.kpi_measurements) || dto.kpi_measurements.length < 1 || dto.kpi_measurements.length > 100) {
      throw new BadRequestException('Provide 1–100 explicitly mapped source-observation KPI pairs');
    }
    const keys = new Set<string>();
    const observationIds = new Set<string>();
    for (const kpi of dto.kpi_measurements) {
      if (!/^[a-z][a-z0-9_.-]{0,99}$/.test(kpi.metric_key) || keys.has(kpi.metric_key)) {
        throw new BadRequestException('Source KPI metric keys must be unique lowercase identifiers');
      }
      keys.add(kpi.metric_key);
      for (const id of [kpi.baseline_observation_id, kpi.actual_observation_id]) {
        if (!isUUID(id) || observationIds.has(id)) throw new BadRequestException('Baseline and actual observation IDs must be unique UUIDs');
        observationIds.add(id);
      }
      if (kpi.target_value !== undefined && (!Number.isFinite(kpi.target_value) || Math.abs(kpi.target_value) > 1e12)) {
        throw new BadRequestException('target_value must be finite and within supported bounds');
      }
    }

    const experiment = await this.database.query<{ id: string; opportunity_id: string; status: string }>(
      `SELECT id::text AS id,opportunity_id::text AS opportunity_id,status
         FROM growth_experiments
        WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
      [experimentId, tenantId, factoryId], { tenantId },
    );
    const currentExperiment = experiment.rows[0];
    if (!currentExperiment) throw new NotFoundException('Growth experiment not found');
    if (currentExperiment.status !== 'RUNNING') throw new ConflictException('Only a running experiment may consume source observations');

    const observations = await this.database.query<{
      id: string; opportunity_id: string; source_kind: string; adapter_version: string;
      metric_key: string; unit: string; value: string; observed_at: string;
      source_record_ref: string; source_revision_hash: string;
    }>(
      `SELECT id::text AS id,opportunity_id::text AS opportunity_id,source_kind,adapter_version,
              metric_key,unit,value::text AS value,observed_at::text AS observed_at,
              source_record_ref,source_revision_hash
         FROM growth_kpi_source_observations
        WHERE id=ANY($1::uuid[]) AND tenant_id=$2 AND factory_id=$3 AND opportunity_id=$4`,
      [[...observationIds], tenantId, factoryId, currentExperiment.opportunity_id], { tenantId },
    );
    if (observations.rows.length !== observationIds.size) {
      throw new NotFoundException('One or more source observations do not belong to this experiment opportunity');
    }
    const byId = new Map(observations.rows.map(row => [row.id, row]));
    const pre: Record<string, number> = {};
    const post: Record<string, number> = {};
    const refs = new Set<string>();
    let realizedAt: string | null = null;
    const kpis: RecordGrowthExperimentResultDto['kpi_measurements'] = [];

    for (const pair of dto.kpi_measurements) {
      const baseline = byId.get(pair.baseline_observation_id);
      const actual = byId.get(pair.actual_observation_id);
      if (!baseline || !actual) throw new NotFoundException('Baseline or actual observation was not found');
      if (baseline.metric_key !== pair.metric_key || actual.metric_key !== pair.metric_key || baseline.unit !== actual.unit
        || baseline.source_kind !== actual.source_kind || baseline.adapter_version !== GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION
        || actual.adapter_version !== GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION) {
        throw new ConflictException('Baseline and actual must use the same KPI key, unit and pinned source-adapter version');
      }
      if (actual.source_kind === 'FINANCIAL_FACT' && !actual.metric_key.startsWith('finance.actual_')) {
        throw new ConflictException('A forecast, balance or commitment fact cannot be recorded as a realized financial outcome KPI');
      }
      if (Date.parse(baseline.observed_at) >= Date.parse(actual.observed_at)) {
        throw new BadRequestException('Actual source observation must be later than its baseline');
      }
      const actualObservedAt = new Date(actual.observed_at).toISOString();
      if (realizedAt !== null && realizedAt !== actualObservedAt) {
        throw new BadRequestException('All KPI actual observations in one realized experiment result must share the same observation timestamp');
      }
      realizedAt = actualObservedAt;
      const baselineValue = this.toSafeMeasurementNumber(baseline.value);
      const actualValue = this.toSafeMeasurementNumber(actual.value);
      pre[pair.metric_key] = baselineValue;
      post[pair.metric_key] = actualValue;
      const baselineRef = `factoryos://growth/source-observations/${baseline.id}`;
      const actualRef = `factoryos://growth/source-observations/${actual.id}`;
      refs.add(baselineRef);
      refs.add(actualRef);
      kpis.push({
        metric_key: pair.metric_key, unit: actual.unit, direction: pair.direction,
        ...(pair.target_value === undefined ? {} : { target_value: pair.target_value }),
        evidence_ref: actualRef,
      });
    }

    const resultDto: RecordGrowthExperimentResultDto = {
      pre_measurements: pre,
      post_measurements: post,
      assessment: dto.assessment,
      stop_condition_triggered: dto.stop_condition_triggered,
      result_notes: [dto.result_notes?.trim(), `Source-of-record adapter ${GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION}; baseline/actual observation IDs are recorded in evidence refs.`]
        .filter(Boolean).join('\n').slice(0, 4000),
      evidence_refs: [...refs].sort(),
      kpi_measurements: kpis,
      observed_at: realizedAt as string,
    };
    return this.growth.recordExperimentResult(userId, tenantId, factoryId, experimentId, resultDto, requestId, traceId);
  }

  private toSafeMeasurementNumber(value: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || Math.abs(parsed) > 1e12 || parsed.toFixed(8) !== value) {
      throw new BadRequestException('Source value cannot be represented without precision loss in the experiment-result numeric contract');
    }
    return parsed;
  }

  private assertScope(userId: string, tenantId: string, factoryId: string, resourceId: string) {
    this.assertReadScope(tenantId, factoryId, resourceId);
    if (!isUUID(userId)) throw new BadRequestException('Authenticated user scope is required');
  }

  private assertReadScope(tenantId: string, factoryId: string, resourceId: string) {
    if (![tenantId, factoryId, resourceId].every(value => isUUID(value))) {
      throw new BadRequestException('Tenant, factory and resource scope must be UUIDs');
    }
  }

  private uuidOrNull(value: string | null): string | null {
    return value && isUUID(value) ? value : null;
  }

  private correlationId(requestId: string | null, traceId: string | null): string {
    return this.uuidOrNull(requestId) ?? this.uuidOrNull(traceId) ?? randomUUID();
  }
}
