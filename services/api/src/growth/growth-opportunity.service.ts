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
  CreateGrowthOpportunityDto,
  GrowthEvidenceKind,
  GrowthOpportunityCategory,
} from './dto/create-growth-opportunity.dto';
import {
  GrowthOpportunityDecision,
  RecordGrowthOpportunityDecisionDto,
} from './dto/record-growth-opportunity-decision.dto';
import {
  GrowthOutcomeStage,
  GrowthOutcomeSourceSystem,
  RecordGrowthOpportunityOutcomeDto,
} from './dto/record-growth-opportunity-outcome.dto';

type OpportunityRecord = QueryResultRow & {
  id: string;
  tenant_id: string;
  factory_id: string;
  opportunity_key: string;
  opportunity_version: string;
  category: GrowthOpportunityCategory;
  statement: string;
  evidence: unknown;
  assumptions: unknown;
  affected_nodes: unknown;
  expected_value_min: string | number;
  expected_value_max: string | number;
  expected_value_metric: string;
  expected_value_unit: string;
  expected_value_currency: string;
  uncertainty: unknown;
  effort_estimate: string | number;
  effort_unit: string;
  dependencies: unknown;
  time_to_impact: string;
  impact_date_assumption: string | null;
  risk_class: string;
  validation_plan: string;
  decision_owner_role: string;
  request_hash: string;
  idempotency_key: string;
  created_by: string;
  created_at: string;
  latest_decision?: GrowthOpportunityDecision | null;
  latest_decision_at?: string | null;
};

type DecisionRecord = QueryResultRow & {
  id: string;
  opportunity_id: string;
  decision: GrowthOpportunityDecision;
  rationale: string;
  decided_by: string;
  created_at: string;
  request_hash?: string;
  idempotency_key?: string;
};

type OutcomeRecord = QueryResultRow & {
  id: string;
  opportunity_id: string;
  measurement_stage: GrowthOutcomeStage;
  metric_key: string;
  actual_value: string | number;
  metric_unit: string;
  observed_at: string;
  source_system: GrowthOutcomeSourceSystem;
  source_record_ref: string;
  source_snapshot_sha256: string | null;
  recorded_by: string;
  created_at: string;
  request_hash?: string;
  idempotency_key?: string;
};

const CATEGORY_SET = new Set<string>(Object.values(GrowthOpportunityCategory));
const DECISION_SET = new Set<string>(Object.values(GrowthOpportunityDecision));
const STAGE_SET = new Set<string>(Object.values(GrowthOutcomeStage));
const SOURCE_SET = new Set<string>(Object.values(GrowthOutcomeSourceSystem));

const OPPORTUNITY_COLUMNS =
  'id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id, ' +
  'opportunity_key, opportunity_version, category, statement, evidence, assumptions, affected_nodes, ' +
  'expected_value_min, expected_value_max, expected_value_metric, expected_value_unit, expected_value_currency, ' +
  'uncertainty, effort_estimate, effort_unit, dependencies, time_to_impact, impact_date_assumption::text AS impact_date_assumption, ' +
  'risk_class, validation_plan, decision_owner_role, request_hash, idempotency_key, created_by::text AS created_by, created_at::text AS created_at';

@Injectable()
export class GrowthOpportunityService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
  ) {}

  async createOpportunity(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    input: CreateGrowthOpportunityDto,
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'growth.opportunities.write', factoryId);
    const normalized = this.normalizeOpportunity(input);
    for (const item of normalized.evidence as Array<Record<string, unknown>>) {
      if (item.kind === GrowthEvidenceKind.EXTERNAL_RESEARCH) {
        await this.requireApprovedResearchEvidence(
          tenantId,
          factoryId,
          actorUserId,
          String(item.claim_id),
          String(item.evidence_id),
          String(item.content_sha256),
        );
      }
    }

    const idempotencyKey = normalized.idempotency_key as string;
    const requestHash = this.hashPayload({
      tenantId,
      factoryId,
      actorUserId,
      ...normalized,
    });

    const lookup = await this.database.query<OpportunityRecord>(
      'SELECT ' + OPPORTUNITY_COLUMNS + ' FROM growth_opportunity_registry ' +
      'WHERE tenant_id = $1 AND factory_id = $2 AND ' +
      '((opportunity_key = $3 AND opportunity_version = $4) OR idempotency_key = $5) LIMIT 1',
      [tenantId, factoryId, normalized.opportunity_key, normalized.opportunity_version, idempotencyKey],
      { tenantId, userId: actorUserId },
    );
    const prior = lookup.rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash) {
        throw new ConflictException('Opportunity key/version or idempotency key was used for different content');
      }
      return { idempotent: true, opportunity: this.mapOpportunity(prior) };
    }

    const inserted = await this.database.query<OpportunityRecord>(
      'INSERT INTO growth_opportunity_registry (' +
      'tenant_id, factory_id, opportunity_key, opportunity_version, category, statement, evidence, assumptions, affected_nodes, ' +
      'expected_value_min, expected_value_max, expected_value_metric, expected_value_unit, expected_value_currency, uncertainty, ' +
      'effort_estimate, effort_unit, dependencies, time_to_impact, impact_date_assumption, risk_class, validation_plan, ' +
      'decision_owner_role, request_hash, idempotency_key, created_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18::jsonb,$19,$20,$21,$22,$23,$24,$25,$26) ' +
      'ON CONFLICT DO NOTHING RETURNING ' + OPPORTUNITY_COLUMNS,
      [
        tenantId, factoryId, normalized.opportunity_key, normalized.opportunity_version, normalized.category,
        normalized.statement, JSON.stringify(normalized.evidence), JSON.stringify(normalized.assumptions),
        JSON.stringify(normalized.affected_nodes), normalized.expected_value_min, normalized.expected_value_max,
        normalized.expected_value_metric, normalized.expected_value_unit, normalized.expected_value_currency,
        JSON.stringify(normalized.uncertainty), normalized.effort_estimate, normalized.effort_unit,
        JSON.stringify(normalized.dependencies), normalized.time_to_impact, normalized.impact_date_assumption,
        normalized.risk_class, normalized.validation_plan, normalized.decision_owner_role, requestHash,
        idempotencyKey, actorUserId,
      ],
      { tenantId, userId: actorUserId },
    );
    let row = inserted.rows[0];
    if (!row) {
      const raced = await this.database.query<OpportunityRecord>(
        'SELECT ' + OPPORTUNITY_COLUMNS + ' FROM growth_opportunity_registry ' +
        'WHERE tenant_id = $1 AND factory_id = $2 AND ' +
        '((opportunity_key = $3 AND opportunity_version = $4) OR idempotency_key = $5) LIMIT 1',
        [tenantId, factoryId, normalized.opportunity_key, normalized.opportunity_version, idempotencyKey],
        { tenantId, userId: actorUserId },
      );
      row = raced.rows[0];
      if (!row || row.request_hash !== requestHash) {
        throw new ConflictException('Opportunity was concurrently registered with conflicting content');
      }
      return { idempotent: true, opportunity: this.mapOpportunity(row) };
    }

    await this.auditSafely({
      tenantId, factoryId, actorUserId, eventType: 'GROWTH_OPPORTUNITY_REGISTERED',
      action: 'REGISTER_IMMUTABLE_GROWTH_HYPOTHESIS', resourceType: 'GROWTH_OPPORTUNITY',
      resourceId: row.id,
      payload: {
        opportunityKey: row.opportunity_key,
        opportunityVersion: row.opportunity_version,
        category: row.category,
        statementSha256: this.sha256(row.statement),
        evidenceCount: (normalized.evidence as unknown[]).length,
        externalResearchEvidenceCount: (normalized.evidence as Array<Record<string, unknown>>)
          .filter((item) => item.kind === GrowthEvidenceKind.EXTERNAL_RESEARCH).length,
      },
    });
    return { idempotent: false, opportunity: this.mapOpportunity(row) };
  }

  async listOpportunities(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    filters: { category?: string; limit?: number; offset?: number } = {},
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'growth.opportunities.read', factoryId);
    const limit = filters.limit ?? 25;
    const offset = filters.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }
    if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) {
      throw new BadRequestException('offset must be an integer between 0 and 10000');
    }
    const category = filters.category === undefined ? null : this.normalizeCategory(filters.category);
    const result = await this.database.query<OpportunityRecord>(
      'SELECT o.' + OPPORTUNITY_COLUMNS.split(', ').join(', o.') + ', d.decision AS latest_decision, d.created_at::text AS latest_decision_at ' +
      'FROM growth_opportunity_registry o ' +
      'LEFT JOIN LATERAL (SELECT decision, created_at FROM growth_opportunity_decisions ' +
      'WHERE tenant_id = o.tenant_id AND factory_id = o.factory_id AND opportunity_id = o.id ' +
      'ORDER BY created_at DESC, id DESC LIMIT 1) d ON TRUE ' +
      'WHERE o.tenant_id = $1 AND o.factory_id = $2 AND ($3::varchar IS NULL OR o.category = $3) ' +
      'ORDER BY o.created_at DESC, o.id DESC LIMIT $4 OFFSET $5',
      [tenantId, factoryId, category, limit + 1, offset],
      { tenantId, userId: actorUserId },
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    return {
      limit,
      offset,
      resultCount: rows.length,
      hasMore,
      nextOffset: hasMore ? offset + rows.length : null,
      opportunities: rows.map((row) => ({
        ...this.mapOpportunity(row),
        latestDecision: row.latest_decision ? {
          decision: row.latest_decision,
          createdAt: row.latest_decision_at,
        } : null,
      })),
    };
  }

  async getOpportunity(tenantId: string, factoryId: string, actorUserId: string, opportunityId: string) {
    this.validateScope(tenantId, factoryId, actorUserId);
    this.requiredUuid(opportunityId, 'opportunityId');
    await this.authorize(actorUserId, tenantId, 'growth.opportunities.read', factoryId);
    const opportunity = await this.findOpportunity(tenantId, factoryId, actorUserId, opportunityId);
    const [decisionsResult, outcomesResult] = await Promise.all([
      this.database.query<DecisionRecord>(
        'SELECT id::text AS id, opportunity_id::text AS opportunity_id, decision, rationale, decided_by::text AS decided_by, created_at::text AS created_at ' +
        'FROM growth_opportunity_decisions WHERE tenant_id = $1 AND factory_id = $2 AND opportunity_id = $3 ORDER BY created_at, id',
        [tenantId, factoryId, opportunityId], { tenantId, userId: actorUserId },
      ),
      this.database.query<OutcomeRecord>(
        'SELECT id::text AS id, opportunity_id::text AS opportunity_id, measurement_stage, metric_key, actual_value, metric_unit, ' +
        'observed_at::text AS observed_at, source_system, source_record_ref, source_snapshot_sha256, recorded_by::text AS recorded_by, created_at::text AS created_at ' +
        'FROM growth_opportunity_outcomes WHERE tenant_id = $1 AND factory_id = $2 AND opportunity_id = $3 ORDER BY observed_at, id',
        [tenantId, factoryId, opportunityId], { tenantId, userId: actorUserId },
      ),
    ]);
    return {
      opportunity: this.mapOpportunity(opportunity),
      decisions: decisionsResult.rows.map((row) => this.mapDecision(row)),
      outcomes: outcomesResult.rows.map((row) => this.mapOutcome(row)),
      governance: {
        expectedValueIsScenarioNotGuarantee: true,
        observedOutcomeRequiresSourceReference: true,
      },
    };
  }

  async recordDecision(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    opportunityId: string,
    input: RecordGrowthOpportunityDecisionDto,
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);
    this.requiredUuid(opportunityId, 'opportunityId');
    await this.authorize(actorUserId, tenantId, 'growth.opportunities.decisions.write', factoryId);
    const decision = this.requiredEnum(input?.decision, DECISION_SET, 'decision');
    const rationale = this.requiredString(input?.rationale, 'rationale', 2000);
    const idempotencyKey = this.normalizeIdempotencyKey(input?.idempotency_key);
    const opportunity = await this.findOpportunity(tenantId, factoryId, actorUserId, opportunityId);
    const requestHash = this.hashPayload({
      tenantId, factoryId, actorUserId, opportunityId, decision, rationale, idempotencyKey,
    });
    const priorResult = await this.database.query<DecisionRecord>(
      'SELECT id::text AS id, opportunity_id::text AS opportunity_id, decision, rationale, decided_by::text AS decided_by, ' +
      'created_at::text AS created_at, request_hash, idempotency_key FROM growth_opportunity_decisions ' +
      'WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3 LIMIT 1',
      [tenantId, factoryId, idempotencyKey], { tenantId, userId: actorUserId },
    );
    const prior = priorResult.rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash) throw new ConflictException('Decision idempotency key was reused for a different decision');
      return { idempotent: true, decision: this.mapDecision(prior) };
    }

    const latestResult = await this.database.query<QueryResultRow & { decision: GrowthOpportunityDecision }>(
      'SELECT decision FROM growth_opportunity_decisions WHERE tenant_id = $1 AND factory_id = $2 AND opportunity_id = $3 ' +
      'ORDER BY created_at DESC, id DESC LIMIT 1',
      [tenantId, factoryId, opportunityId], { tenantId, userId: actorUserId },
    );
    this.assertDecisionTransition(latestResult.rows[0]?.decision ?? null, decision);

    const inserted = await this.database.query<DecisionRecord>(
      'INSERT INTO growth_opportunity_decisions (tenant_id, factory_id, opportunity_id, decision, rationale, request_hash, idempotency_key, decided_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING ' +
      'RETURNING id::text AS id, opportunity_id::text AS opportunity_id, decision, rationale, decided_by::text AS decided_by, created_at::text AS created_at',
      [tenantId, factoryId, opportunityId, decision, rationale, requestHash, idempotencyKey, actorUserId],
      { tenantId, userId: actorUserId },
    );
    let row = inserted.rows[0];
    if (!row) {
      const raced = await this.database.query<DecisionRecord>(
        'SELECT id::text AS id, opportunity_id::text AS opportunity_id, decision, rationale, decided_by::text AS decided_by, ' +
        'created_at::text AS created_at, request_hash, idempotency_key FROM growth_opportunity_decisions ' +
        'WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3 LIMIT 1',
        [tenantId, factoryId, idempotencyKey], { tenantId, userId: actorUserId },
      );
      row = raced.rows[0];
      if (!row || row.request_hash !== requestHash) throw new ConflictException('Decision was concurrently recorded with conflicting content');
      return { idempotent: true, decision: this.mapDecision(row) };
    }
    await this.auditSafely({
      tenantId, factoryId, actorUserId, eventType: 'GROWTH_OPPORTUNITY_DECISION_RECORDED',
      action: 'RECORD_GROWTH_OPPORTUNITY_DECISION', resourceType: 'GROWTH_OPPORTUNITY_DECISION',
      resourceId: row.id,
      payload: { opportunityId, decision, rationaleSha256: this.sha256(rationale), opportunityVersion: opportunity.opportunityVersion },
    });
    return { idempotent: false, decision: this.mapDecision(row) };
  }

  async recordOutcome(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    opportunityId: string,
    input: RecordGrowthOpportunityOutcomeDto,
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);
    this.requiredUuid(opportunityId, 'opportunityId');
    await this.authorize(actorUserId, tenantId, 'growth.opportunities.outcomes.write', factoryId);
    const stage = this.requiredEnum(input?.measurement_stage, STAGE_SET, 'measurement_stage');
    const metricKey = this.requiredString(input?.metric_key, 'metric_key', 100);
    const metricUnit = this.requiredPattern(input?.metric_unit, 'metric_unit', /^[a-zA-Z0-9][a-zA-Z0-9._/%-]{0,39}$/);
    const actualValue = input?.actual_value;
    if (typeof actualValue !== 'number' || !Number.isFinite(actualValue) || Math.abs(actualValue) > 1_000_000_000_000_000) {
      throw new BadRequestException('actual_value must be a finite numeric measurement in the supported range');
    }
    const observedAt = this.requiredString(input?.observed_at, 'observed_at', 64);
    if (Number.isNaN(Date.parse(observedAt))) throw new BadRequestException('observed_at must be a valid timestamp');
    const sourceSystem = this.requiredEnum(input?.source_system, SOURCE_SET, 'source_system');
    const sourceRecordRef = this.requiredString(input?.source_record_ref, 'source_record_ref', 255);
    const snapshotHash = input?.source_snapshot_sha256 === undefined
      ? null
      : this.normalizeSha256(input.source_snapshot_sha256, 'source_snapshot_sha256');
    const idempotencyKey = this.normalizeIdempotencyKey(input?.idempotency_key);
    const opportunity = await this.findOpportunity(tenantId, factoryId, actorUserId, opportunityId);
    const requestHash = this.hashPayload({
      tenantId, factoryId, actorUserId, opportunityId, stage, metricKey, actualValue,
      metricUnit, observedAt, sourceSystem, sourceRecordRef, snapshotHash, idempotencyKey,
    });
    const priorResult = await this.database.query<OutcomeRecord>(
      'SELECT id::text AS id, opportunity_id::text AS opportunity_id, measurement_stage, metric_key, actual_value, metric_unit, ' +
      'observed_at::text AS observed_at, source_system, source_record_ref, source_snapshot_sha256, recorded_by::text AS recorded_by, ' +
      'created_at::text AS created_at, request_hash, idempotency_key FROM growth_opportunity_outcomes ' +
      'WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3 LIMIT 1',
      [tenantId, factoryId, idempotencyKey], { tenantId, userId: actorUserId },
    );
    const prior = priorResult.rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash) throw new ConflictException('Outcome idempotency key was reused for a different measurement');
      return { idempotent: true, outcome: this.mapOutcome(prior) };
    }

    if (stage === GrowthOutcomeStage.POST || stage === GrowthOutcomeStage.REALIZED) {
      const latestDecision = await this.database.query<QueryResultRow & { decision: GrowthOpportunityDecision }>(
        'SELECT decision FROM growth_opportunity_decisions WHERE tenant_id = $1 AND factory_id = $2 AND opportunity_id = $3 ' +
        'ORDER BY created_at DESC, id DESC LIMIT 1',
        [tenantId, factoryId, opportunityId], { tenantId, userId: actorUserId },
      );
      if (latestDecision.rows[0]?.decision !== GrowthOpportunityDecision.ACCEPTED) {
        throw new ConflictException('POST/REALIZED measurements require the latest opportunity decision to be ACCEPTED');
      }
    }

    const inserted = await this.database.query<OutcomeRecord>(
      'INSERT INTO growth_opportunity_outcomes (tenant_id, factory_id, opportunity_id, measurement_stage, metric_key, actual_value, ' +
      'metric_unit, observed_at, source_system, source_record_ref, source_snapshot_sha256, request_hash, idempotency_key, recorded_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING ' +
      'RETURNING id::text AS id, opportunity_id::text AS opportunity_id, measurement_stage, metric_key, actual_value, metric_unit, ' +
      'observed_at::text AS observed_at, source_system, source_record_ref, source_snapshot_sha256, recorded_by::text AS recorded_by, created_at::text AS created_at',
      [tenantId, factoryId, opportunityId, stage, metricKey, actualValue, metricUnit, observedAt, sourceSystem,
        sourceRecordRef, snapshotHash, requestHash, idempotencyKey, actorUserId],
      { tenantId, userId: actorUserId },
    );
    let row = inserted.rows[0];
    if (!row) {
      const raced = await this.database.query<OutcomeRecord>(
        'SELECT id::text AS id, opportunity_id::text AS opportunity_id, measurement_stage, metric_key, actual_value, metric_unit, ' +
        'observed_at::text AS observed_at, source_system, source_record_ref, source_snapshot_sha256, recorded_by::text AS recorded_by, ' +
        'created_at::text AS created_at, request_hash, idempotency_key FROM growth_opportunity_outcomes ' +
        'WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3 LIMIT 1',
        [tenantId, factoryId, idempotencyKey], { tenantId, userId: actorUserId },
      );
      row = raced.rows[0];
      if (!row || row.request_hash !== requestHash) throw new ConflictException('Outcome was concurrently recorded with conflicting content');
      return { idempotent: true, outcome: this.mapOutcome(row) };
    }
    await this.auditSafely({
      tenantId, factoryId, actorUserId, eventType: 'GROWTH_OPPORTUNITY_OUTCOME_RECORDED',
      action: 'RECORD_SOURCE_REFERENCED_MEASUREMENT', resourceType: 'GROWTH_OPPORTUNITY_OUTCOME',
      resourceId: row.id,
      payload: {
        opportunityId, measurementStage: stage, metricKey, metricUnit, sourceSystem,
        sourceRecordRefSha256: this.sha256(sourceRecordRef), sourceSnapshotSha256: snapshotHash,
        opportunityVersion: opportunity.opportunityVersion,
      },
    });
    return { idempotent: false, outcome: this.mapOutcome(row) };
  }

  private async findOpportunity(tenantId: string, factoryId: string, actorUserId: string, opportunityId: string) {
    const result = await this.database.query<OpportunityRecord>(
      'SELECT ' + OPPORTUNITY_COLUMNS + ' FROM growth_opportunity_registry ' +
      'WHERE tenant_id = $1 AND factory_id = $2 AND id = $3 LIMIT 1',
      [tenantId, factoryId, opportunityId], { tenantId, userId: actorUserId },
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Growth opportunity was not found in this factory');
    return this.mapOpportunity(row);
  }

  private async requireApprovedResearchEvidence(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    claimId: string,
    evidenceId: string,
    contentSha256: string,
  ) {
    this.requiredUuid(claimId, 'evidence.claim_id');
    this.requiredUuid(evidenceId, 'evidence.evidence_id');
    const hash = this.normalizeSha256(contentSha256, 'evidence.content_sha256');
    const result = await this.database.query<QueryResultRow>(
      'SELECT e.id FROM research_claim_registry c ' +
      'JOIN research_claim_evidence e ON e.claim_id = c.id AND e.tenant_id = c.tenant_id AND e.factory_id = c.factory_id ' +
      'JOIN research_source_registry s ON s.id = e.source_id AND s.tenant_id = e.tenant_id AND s.factory_id = e.factory_id ' +
      'JOIN research_source_text_content t ON t.id = e.content_id AND t.source_id = e.source_id AND t.tenant_id = e.tenant_id ' +
      'AND t.factory_id = e.factory_id AND t.content_sha256 = e.content_sha256 ' +
      'LEFT JOIN LATERAL (SELECT decision, content_sha256 FROM research_source_assessments ' +
      'WHERE tenant_id = e.tenant_id AND factory_id = e.factory_id AND source_id = e.source_id AND assessment_type = $6 ' +
      'ORDER BY created_at DESC, id DESC LIMIT 1) rights ON TRUE ' +
      'LEFT JOIN LATERAL (SELECT decision, content_sha256 FROM research_source_assessments ' +
      'WHERE tenant_id = e.tenant_id AND factory_id = e.factory_id AND source_id = e.source_id AND assessment_type = $7 ' +
      'ORDER BY created_at DESC, id DESC LIMIT 1) security ON TRUE ' +
      'LEFT JOIN LATERAL (SELECT verdict, reason_code, content_sha256, quote_sha256 FROM research_citation_validations ' +
      'WHERE tenant_id = e.tenant_id AND factory_id = e.factory_id AND claim_id = c.id AND evidence_id = e.id ' +
      'ORDER BY created_at DESC, id DESC LIMIT 1) v ON TRUE ' +
      'WHERE c.tenant_id = $1 AND c.factory_id = $2 AND c.id = $3 AND e.id = $4 AND e.content_sha256 = $5 ' +
      'AND s.registry_status = $8 AND s.rights_status = $9 AND s.allow_research IS TRUE ' +
      'AND rights.decision = $10 AND rights.content_sha256 = e.content_sha256 ' +
      'AND security.decision = $10 AND security.content_sha256 = e.content_sha256 ' +
      'AND v.verdict = $11 AND v.reason_code = $12 AND v.content_sha256 = e.content_sha256 AND v.quote_sha256 = e.quote_sha256 LIMIT 1',
      [tenantId, factoryId, claimId, evidenceId, hash, 'RIGHTS', 'SECURITY', 'REGISTERED', 'VERIFIED', 'APPROVED', 'VALID', 'QUOTE_MATCHED'],
      { tenantId, userId: actorUserId },
    );
    if (!result.rows[0]) {
      throw new BadRequestException('External research evidence must reference current, approved content with a latest VALID citation check in this factory');
    }
  }

  private normalizeOpportunity(input: CreateGrowthOpportunityDto): Record<string, unknown> {
    const category = this.normalizeCategory(input?.category);
    const opportunityKey = this.requiredPattern(input?.opportunity_key, 'opportunity_key', /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,179}$/);
    const opportunityVersion = this.requiredPattern(input?.opportunity_version, 'opportunity_version', /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,59}$/);
    const statement = this.requiredString(input?.statement, 'statement', 4000);
    if (!Array.isArray(input?.evidence) || input.evidence.length < 1 || input.evidence.length > 50) {
      throw new BadRequestException('evidence must contain 1-50 evidence records');
    }
    const evidence = input.evidence.map((item, index) => {
      if (!item || !Object.values(GrowthEvidenceKind).includes(item.kind)) {
        throw new BadRequestException('evidence[' + index + '].kind is invalid');
      }
      const label = this.requiredString(item.label, 'evidence label', 200);
      if (item.kind === GrowthEvidenceKind.EXTERNAL_RESEARCH) {
        return {
          kind: item.kind,
          label,
          claim_id: this.requiredUuid(item.claim_id, 'evidence.claim_id'),
          evidence_id: this.requiredUuid(item.evidence_id, 'evidence.evidence_id'),
          content_sha256: this.normalizeSha256(item.content_sha256, 'evidence.content_sha256'),
        };
      }
      return {
        kind: item.kind,
        label,
        reference_id: this.requiredString(item.reference_id, 'evidence.reference_id', 255),
      };
    });
    const assumptions = this.stringArray(input.assumptions, 'assumptions', 1, 100, 500);
    const affectedNodes = this.normalizeAffectedNodes(input.affected_nodes);
    const min = this.requiredFiniteNumber(input.expected_value_min, 'expected_value_min');
    const max = this.requiredFiniteNumber(input.expected_value_max, 'expected_value_max');
    if (min > max) throw new BadRequestException('expected_value_min must not exceed expected_value_max');
    const metric = this.requiredPattern(input.expected_value_metric, 'expected_value_metric', /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/);
    const unit = this.requiredPattern(input.expected_value_unit, 'expected_value_unit', /^[a-zA-Z0-9][a-zA-Z0-9._/%-]{0,39}$/);
    const currency = this.requiredPattern(input.expected_value_currency, 'expected_value_currency', /^[A-Z]{3}$/);
    const uncertainty = input.uncertainty;
    if (!uncertainty || !Object.values(['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN']).includes(uncertainty.level)) {
      throw new BadRequestException('uncertainty.level is invalid');
    }
    const normalizedUncertainty = {
      level: uncertainty.level,
      limitations: this.stringArray(uncertainty.limitations, 'uncertainty.limitations', 0, 50, 500),
      sensitivity_factors: this.stringArray(uncertainty.sensitivity_factors, 'uncertainty.sensitivity_factors', 0, 50, 200),
      evidence_gaps: this.stringArray(uncertainty.evidence_gaps, 'uncertainty.evidence_gaps', 0, 50, 500),
    };
    if (normalizedUncertainty.limitations.length === 0 && normalizedUncertainty.evidence_gaps.length === 0) {
      throw new BadRequestException('uncertainty must state at least one limitation or evidence gap');
    }
    const effort = this.requiredFiniteNumber(input.effort_estimate, 'effort_estimate');
    if (effort < 0 || effort > 100_000_000) throw new BadRequestException('effort_estimate is outside the supported range');
    const effortUnit = this.requiredEnum(input.effort_unit, new Set(['PERSON_HOURS', 'PERSON_DAYS', 'PERSON_WEEKS']), 'effort_unit');
    const dependencies = this.stringArray(input.dependencies ?? [], 'dependencies', 0, 100, 200);
    const timeToImpact = this.requiredEnum(input.time_to_impact, new Set(['IMMEDIATE', 'NEAR_TERM', 'STRATEGIC']), 'time_to_impact');
    const impactDate = input.impact_date_assumption === undefined || input.impact_date_assumption === null
      ? null
      : this.requiredPattern(input.impact_date_assumption, 'impact_date_assumption', /^\d{4}-\d{2}-\d{2}$/);
    const riskClass = this.requiredEnum(input.risk_class, new Set(['OPERATIONAL', 'FINANCIAL', 'COMPLIANCE', 'STRATEGIC']), 'risk_class');
    const validationPlan = this.requiredString(input.validation_plan, 'validation_plan', 4000);
    const decisionOwnerRole = this.requiredPattern(input.decision_owner_role, 'decision_owner_role', /^[A-Z][A-Z0-9_.:-]{1,99}$/);
    const idempotencyKey = this.normalizeIdempotencyKey(input.idempotency_key);
    return {
      opportunity_key: opportunityKey,
      opportunity_version: opportunityVersion,
      category,
      statement,
      evidence,
      assumptions,
      affected_nodes: affectedNodes,
      expected_value_min: min,
      expected_value_max: max,
      expected_value_metric: metric,
      expected_value_unit: unit,
      expected_value_currency: currency,
      uncertainty: normalizedUncertainty,
      effort_estimate: effort,
      effort_unit: effortUnit,
      dependencies,
      time_to_impact: timeToImpact,
      impact_date_assumption: impactDate,
      risk_class: riskClass,
      validation_plan: validationPlan,
      decision_owner_role: decisionOwnerRole,
      idempotency_key: idempotencyKey,
    };
  }

  private normalizeAffectedNodes(value: unknown) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
      throw new BadRequestException('affected_nodes must contain 1-100 nodes');
    }
    return value.map((node, index) => {
      if (!node || !['CBB_NODE', 'BUSINESS_MODEL', 'PROCESS', 'KPI'].includes(node.node_type)) {
        throw new BadRequestException('affected_nodes[' + index + '].node_type is invalid');
      }
      return {
        node_type: node.node_type,
        node_ref: this.requiredString(node.node_ref, 'affected_nodes.node_ref', 200),
        ...(node.label === undefined ? {} : { label: this.requiredString(node.label, 'affected_nodes.label', 200) }),
      };
    });
  }

  private assertDecisionTransition(prior: GrowthOpportunityDecision | null, next: GrowthOpportunityDecision) {
    if (!prior) {
      if (next === GrowthOpportunityDecision.WITHDRAWN) {
        throw new ConflictException('An opportunity cannot be withdrawn before it has a recorded decision');
      }
      return;
    }
    const allowed: Record<GrowthOpportunityDecision, GrowthOpportunityDecision[]> = {
      ACCEPTED: [GrowthOpportunityDecision.WITHDRAWN],
      REJECTED: [],
      DEFERRED: [GrowthOpportunityDecision.ACCEPTED, GrowthOpportunityDecision.REJECTED, GrowthOpportunityDecision.DEFERRED, GrowthOpportunityDecision.WITHDRAWN],
      WITHDRAWN: [],
    };
    if (!allowed[prior].includes(next)) {
      throw new ConflictException('Decision transition from ' + prior + ' to ' + next + ' is not allowed; register a new opportunity version when the hypothesis changes');
    }
  }

  private normalizeCategory(value: unknown): GrowthOpportunityCategory {
    return this.requiredEnum(value, CATEGORY_SET, 'category') as GrowthOpportunityCategory;
  }

  private requiredEnum(value: unknown, allowed: Set<string>, field: string) {
    if (typeof value !== 'string' || !allowed.has(value)) throw new BadRequestException(field + ' is invalid');
    return value;
  }

  private requiredFiniteNumber(value: unknown, field: string) {
    const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    if (!Number.isFinite(number) || Math.abs(number) > 1_000_000_000_000_000) {
      throw new BadRequestException(field + ' must be a finite number in the supported range');
    }
    return number;
  }

  private stringArray(value: unknown, field: string, minimum: number, maximum: number, maxLength: number) {
    if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
      throw new BadRequestException(field + ' must contain ' + minimum + '-' + maximum + ' values');
    }
    return value.map((item, index) => this.requiredString(item, field + '[' + index + ']', maxLength));
  }

  private requiredPattern(value: unknown, field: string, pattern: RegExp) {
    const normalized = this.requiredString(value, field, 255);
    if (!pattern.test(normalized)) throw new BadRequestException(field + ' contains unsupported characters');
    return normalized;
  }

  private requiredString(value: unknown, field: string, maxLength: number) {
    if (typeof value !== 'string') throw new BadRequestException(field + ' must be a string');
    const normalized = value.normalize('NFC').trim();
    if (!normalized || normalized.length > maxLength) {
      throw new BadRequestException(field + ' must contain 1-' + maxLength + ' characters');
    }
    return normalized;
  }

  private normalizeIdempotencyKey(value: unknown) {
    return this.requiredPattern(value, 'idempotency_key', /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
  }

  private normalizeSha256(value: unknown, field: string) {
    if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) {
      throw new BadRequestException(field + ' must be a 64-character SHA-256 digest');
    }
    return value.toLowerCase();
  }

  private requiredUuid(value: unknown, field: string) {
    if (typeof value !== 'string' || !isUUID(value)) throw new BadRequestException(field + ' must be a valid UUID');
    return value;
  }

  private validateScope(tenantId: string, factoryId: string, actorUserId: string) {
    if (!isUUID(tenantId) || !isUUID(factoryId) || !isUUID(actorUserId)) {
      throw new BadRequestException('Authenticated tenant, factory, and user UUIDs are required');
    }
  }

  private async authorize(userId: string, tenantId: string, permission: string, factoryId: string) {
    await this.iamService.authorize(userId, tenantId, permission, factoryId);
  }

  private mapOpportunity(row: OpportunityRecord) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      factoryId: row.factory_id,
      opportunityKey: row.opportunity_key,
      opportunityVersion: row.opportunity_version,
      category: row.category,
      statement: row.statement,
      evidence: row.evidence,
      assumptions: row.assumptions,
      affectedNodes: row.affected_nodes,
      expectedValue: {
        min: Number(row.expected_value_min),
        max: Number(row.expected_value_max),
        metric: row.expected_value_metric,
        unit: row.expected_value_unit,
        currency: row.expected_value_currency,
      },
      uncertainty: row.uncertainty,
      effort: { estimate: Number(row.effort_estimate), unit: row.effort_unit },
      dependencies: row.dependencies,
      timeToImpact: row.time_to_impact,
      impactDateAssumption: row.impact_date_assumption,
      riskClass: row.risk_class,
      validationPlan: row.validation_plan,
      decisionOwnerRole: row.decision_owner_role,
      createdBy: row.created_by,
      createdAt: row.created_at,
      valueSemantics: 'SCENARIO_RANGE_NOT_GUARANTEE',
    };
  }

  private mapDecision(row: DecisionRecord) {
    return {
      id: row.id,
      opportunityId: row.opportunity_id,
      decision: row.decision,
      rationale: row.rationale,
      decidedBy: row.decided_by,
      createdAt: row.created_at,
    };
  }

  private mapOutcome(row: OutcomeRecord) {
    return {
      id: row.id,
      opportunityId: row.opportunity_id,
      measurementStage: row.measurement_stage,
      metricKey: row.metric_key,
      actualValue: Number(row.actual_value),
      metricUnit: row.metric_unit,
      observedAt: row.observed_at,
      sourceSystem: row.source_system,
      sourceRecordRef: row.source_record_ref,
      sourceSnapshotSha256: row.source_snapshot_sha256,
      recordedBy: row.recorded_by,
      createdAt: row.created_at,
      semantics: 'SOURCE_REFERENCED_OBSERVATION_NOT_AUTOMATIC_CAUSAL_ATTRIBUTION',
    };
  }

  private sha256(value: string) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private hashPayload(value: Record<string, unknown>) {
    return this.sha256(JSON.stringify(value));
  }

  private async auditSafely(input: {
    tenantId: string; factoryId: string; actorUserId: string; eventType: string;
    action: string; resourceType: string; resourceId: string; payload: Record<string, unknown>;
  }) {
    try {
      await this.auditService.record({
        tenantId: input.tenantId, factoryId: input.factoryId, actorUserId: input.actorUserId,
        eventType: input.eventType, action: input.action, resourceType: input.resourceType,
        resourceId: input.resourceId, dataClass: 'INTERNAL', payload: input.payload,
      });
    } catch {
      // The domain ledger remains authoritative if audit delivery is temporarily unavailable.
    }
  }
}
