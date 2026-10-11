import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { CreateGrowthExperimentDto } from './dto/create-growth-experiment.dto';
import { CreateGrowthValidationUnknownDto } from './dto/create-growth-validation-unknown.dto';
import { DecideGrowthValidationUnknownDto } from './dto/decide-growth-validation-unknown.dto';
import { CreateGrowthOpportunityDto } from './dto/create-growth-opportunity.dto';
import { CreateGrowthScenarioDto } from './dto/create-growth-scenario.dto';
import { DecideGrowthOpportunityDto } from './dto/decide-growth-opportunity.dto';
import { RecordGrowthExperimentResultDto } from './dto/record-growth-experiment-result.dto';
import { RecordGrowthOpportunityOutcomeDto } from './dto/record-growth-opportunity-outcome.dto';

interface OpportunityRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  title: string;
  category: string;
  opportunity_statement: string;
  success_hypothesis: string;
  assumptions: string[];
  constraints_snapshot: Record<string, unknown>;
  affected_business_nodes: string[];
  expected_value_low: string;
  expected_value_high: string;
  currency: string;
  uncertainty_pct: string;
  effort: string;
  time_to_impact_days: number;
  implementation_risk: string;
  owner_user_id: string;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface EvidenceInput {
  evidence_type: 'RESEARCH_CLAIM' | 'CBB_ENTITY' | 'OPERATIONAL_METRIC' | 'MARKET_SIGNAL' | 'CLIENT_DOCUMENT';
  description: string;
  research_claim_id?: string;
  business_entity_id?: string;
  reference_ref?: string;
  citation_url?: string;
  confidence?: number;
  evidence_snapshot?: Record<string, unknown>;
}

@Injectable()
export class GrowthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async createOpportunity(
    userId: string,
    tenantId: string,
    factoryId: string,
    dto: CreateGrowthOpportunityDto,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    if (!dto.evidence?.length) throw new BadRequestException('An opportunity must cite at least one evidence item');
    if (dto.expected_value_low > dto.expected_value_high) {
      throw new BadRequestException('expected_value_low cannot exceed expected_value_high');
    }
    const currency = (dto.currency ?? 'BDT').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new BadRequestException('currency must be a 3-letter currency code');
    if (!Array.isArray(dto.assumptions) || !dto.assumptions.length
      || dto.assumptions.some(value => !value.trim())) {
      throw new BadRequestException('Every growth opportunity must state its assumptions');
    }
    const affectedNodes = [...new Set((dto.affected_business_nodes ?? []).map(id => id.toLowerCase()))];
    if (affectedNodes.length !== (dto.affected_business_nodes ?? []).length) {
      throw new BadRequestException('affected_business_nodes must not contain duplicates');
    }

    let opportunity: OpportunityRow;
    opportunity = await this.database.transaction(
      { tenantId, userId },
      async client => {
        const factory = await client.query<{ id: string }>(
          'SELECT id::text AS id FROM factories WHERE id = $1 AND tenant_id = $2 AND status = $3',
          [factoryId, tenantId, 'ACTIVE'],
        );
        if (!factory.rows[0]) throw new ForbiddenException('Factory is not active or is outside the tenant');
        for (const nodeId of affectedNodes) {
          const node = await client.query<{ id: string }>(
            `
            SELECT id::text AS id FROM business_entities
            WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
              AND state IN ('VERIFIED', 'INFERRED')
            `,
            [nodeId, tenantId, factoryId],
          );
          if (!node.rows[0]) throw new BadRequestException('Every affected business-model node must be visible in this factory and verified/inferred');
        }

        const ownerUserId = dto.owner_user_id ?? userId;
        await this.assertActiveTenantUser(client, tenantId, ownerUserId);
        const inserted = await client.query<OpportunityRow>(
          `
          INSERT INTO growth_opportunities (
            tenant_id, factory_id, title, category, opportunity_statement, success_hypothesis,
            assumptions, constraints_snapshot, affected_business_nodes, expected_value_low,
            expected_value_high, currency, uncertainty_pct, effort, time_to_impact_days,
            implementation_risk, owner_user_id, status, created_by
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11,
            $12, $13, $14, $15, $16, $17, 'PROPOSED', $18
          )
          RETURNING
            id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id,
            title, category, opportunity_statement, success_hypothesis, assumptions,
            constraints_snapshot, affected_business_nodes, expected_value_low::text AS expected_value_low,
            expected_value_high::text AS expected_value_high, currency, uncertainty_pct::text AS uncertainty_pct,
            effort, time_to_impact_days, implementation_risk, owner_user_id::text AS owner_user_id,
            status, created_by::text AS created_by, created_at::text AS created_at, updated_at::text AS updated_at
          `,
          [
            tenantId, factoryId, dto.title.trim(), dto.category, dto.opportunity_statement.trim(),
            dto.success_hypothesis.trim(), JSON.stringify(dto.assumptions.map(a => a.trim())),
            JSON.stringify(dto.constraints_snapshot ?? {}), JSON.stringify(affectedNodes),
            dto.expected_value_low, dto.expected_value_high, currency, dto.uncertainty_pct,
            dto.effort, dto.time_to_impact_days, dto.implementation_risk,
            ownerUserId, userId,
          ],
        );
        const created = inserted.rows[0];
        if (!created) throw new Error('GROWTH_OPPORTUNITY_INSERT_FAILED');

        for (const evidence of dto.evidence as EvidenceInput[]) {
          await this.validateAndInsertEvidence(client, {
            userId, tenantId, factoryId, opportunityId: created.id, evidence,
          });
        }
        await this.insertOutbox(client, {
          tenantId, factoryId, userId, aggregateType: 'GROWTH_OPPORTUNITY',
          aggregateId: created.id, eventType: 'GROWTH.OPPORTUNITY_PROPOSED',
          correlationId: this.correlationId(requestId, traceId),
          payload: { opportunity_id: created.id, category: created.category, status: created.status },
        });
        return created;
      },
    );
    await this.auditSafely({
      tenantId, factoryId, userId, action: 'OPPORTUNITY_PROPOSE',
      resourceId: opportunity.id, requestId, traceId,
      payload: { category: opportunity.category, evidenceCount: dto.evidence.length, status: opportunity.status },
    });
    return this.getOpportunity(tenantId, factoryId, opportunity.id);
  }

  async listOpportunities(
    tenantId: string,
    factoryId: string,
    query: { status?: string; category?: string; limit?: number },
  ) {
    this.validateReadScope(tenantId, factoryId);
    const result = await this.database.query<OpportunityRow>(
      `
      SELECT
        id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id,
        title, category, opportunity_statement, success_hypothesis, assumptions,
        constraints_snapshot, affected_business_nodes, expected_value_low::text AS expected_value_low,
        expected_value_high::text AS expected_value_high, currency, uncertainty_pct::text AS uncertainty_pct,
        effort, time_to_impact_days, implementation_risk, owner_user_id::text AS owner_user_id,
        status, created_by::text AS created_by, created_at::text AS created_at, updated_at::text AS updated_at
      FROM growth_opportunities
      WHERE tenant_id = $1 AND factory_id = $2
        AND ($3::text IS NULL OR status = $3)
        AND ($4::text IS NULL OR category = $4)
      ORDER BY created_at DESC
      LIMIT $5
      `,
      [tenantId, factoryId, query.status ?? null, query.category ?? null, this.limit(query.limit)],
      { tenantId },
    );
    return result.rows;
  }

  async getOpportunity(tenantId: string, factoryId: string, opportunityId: string) {
    this.validateReadScope(tenantId, factoryId);
    this.validateUuid(opportunityId, 'opportunityId');
    const opportunity = await this.database.query<OpportunityRow>(
      `
      SELECT
        id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id,
        title, category, opportunity_statement, success_hypothesis, assumptions,
        constraints_snapshot, affected_business_nodes, expected_value_low::text AS expected_value_low,
        expected_value_high::text AS expected_value_high, currency, uncertainty_pct::text AS uncertainty_pct,
        effort, time_to_impact_days, implementation_risk, owner_user_id::text AS owner_user_id,
        status, created_by::text AS created_by, created_at::text AS created_at, updated_at::text AS updated_at
      FROM growth_opportunities WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
      `,
      [opportunityId, tenantId, factoryId],
      { tenantId },
    );
    const row = opportunity.rows[0];
    if (!row) throw new NotFoundException('Growth opportunity not found');
    const [evidence, scenarios, experiments, outcomes, unknowns] = await Promise.all([
      this.database.query(
        'SELECT id::text AS id, evidence_type, origin_class, research_claim_id::text AS research_claim_id, business_entity_id::text AS business_entity_id, reference_ref, citation_url, description, confidence::text AS confidence, evidence_snapshot, captured_at::text AS captured_at FROM growth_opportunity_evidence WHERE opportunity_id = $1 AND tenant_id = $2 AND factory_id = $3 ORDER BY captured_at',
        [opportunityId, tenantId, factoryId],
        { tenantId },
      ),
      this.database.query(
        'SELECT id::text AS id, scenario_name, scenario_type, model_version, data_vintage::text AS data_vintage, baseline_source_ref, inputs, output_snapshot, input_hash, created_at::text AS created_at FROM growth_scenarios WHERE opportunity_id = $1 AND tenant_id = $2 AND factory_id = $3 ORDER BY created_at DESC',
        [opportunityId, tenantId, factoryId],
        { tenantId },
      ),
      this.database.query(
        'SELECT id::text AS id, name, objective, hypothesis, leading_indicators, duration_days, owner_user_id::text AS owner_user_id, baseline_measurements, stop_conditions, status, started_at::text AS started_at, ended_at::text AS ended_at, created_at::text AS created_at FROM growth_experiments WHERE opportunity_id = $1 AND tenant_id = $2 AND factory_id = $3 ORDER BY created_at DESC',
        [opportunityId, tenantId, factoryId],
        { tenantId },
      ),
      this.database.query(
        'SELECT id::text AS id, experiment_result_id::text AS experiment_result_id, assessment, realized_metrics, evidence_refs, notes, observed_at::text AS observed_at, created_at::text AS created_at FROM growth_opportunity_outcomes WHERE opportunity_id = $1 AND tenant_id = $2 AND factory_id = $3 ORDER BY observed_at DESC',
        [opportunityId, tenantId, factoryId],
        { tenantId },
      ),
      this.database.query(
        'SELECT id::text AS id, question, decision_variable, impact_if_wrong::text AS impact_if_wrong, probability_unknown::text AS probability_unknown, validation_effort::text AS validation_effort, priority_score::text AS priority_score, validation_method, owner_user_id::text AS owner_user_id, status, resolution_evidence_ref, resolution_notes, resolved_at::text AS resolved_at, created_at::text AS created_at FROM growth_validation_unknowns WHERE opportunity_id = $1 AND tenant_id = $2 AND factory_id = $3 ORDER BY CASE WHEN status IN (\'RESOLVED\', \'NOT_MATERIAL\') THEN 1 ELSE 0 END, priority_score DESC, created_at',
        [opportunityId, tenantId, factoryId],
        { tenantId },
      ),
    ]);
    return { ...row, evidence: evidence.rows, scenarios: scenarios.rows, experiments: experiments.rows, outcomes: outcomes.rows, validation_unknowns: unknowns.rows };
  }

  async createValidationUnknown(
    userId: string,
    tenantId: string,
    factoryId: string,
    opportunityId: string,
    dto: CreateGrowthValidationUnknownDto,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(opportunityId, 'opportunityId');
    if (!dto.question.trim() || !dto.decision_variable.trim()) {
      throw new BadRequestException('A growth unknown needs a question and the decision variable it affects');
    }
    if (!Number.isFinite(dto.impact_if_wrong) || dto.impact_if_wrong < 0 || dto.impact_if_wrong > 100
      || !Number.isFinite(dto.probability_unknown) || dto.probability_unknown < 0 || dto.probability_unknown > 1
      || !Number.isFinite(dto.validation_effort) || dto.validation_effort <= 0 || dto.validation_effort > 100) {
      throw new BadRequestException('Unknown impact, probability and validation effort are outside supported bounds');
    }

    const unknown = await this.database.transaction(
      { tenantId, userId },
      async client => {
        const opportunity = await client.query<{ status: string }>(
          'SELECT status FROM growth_opportunities WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 FOR SHARE',
          [opportunityId, tenantId, factoryId],
        );
        if (!opportunity.rows[0]) throw new NotFoundException('Growth opportunity not found');
        if (!['PROPOSED', 'ACCEPTED', 'IN_PROGRESS'].includes(opportunity.rows[0].status)) {
          throw new ConflictException('Validation unknowns can only be added to an open growth hypothesis');
        }
        const ownerUserId = dto.owner_user_id ?? userId;
        await this.assertActiveTenantUser(client, tenantId, ownerUserId);
        const inserted = await client.query(
          `
          INSERT INTO growth_validation_unknowns (
            tenant_id, factory_id, opportunity_id, question, decision_variable,
            impact_if_wrong, probability_unknown, validation_effort, validation_method,
            owner_user_id, created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          RETURNING id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id,
            opportunity_id::text AS opportunity_id, question, decision_variable,
            impact_if_wrong::text AS impact_if_wrong, probability_unknown::text AS probability_unknown,
            validation_effort::text AS validation_effort, priority_score::text AS priority_score,
            validation_method, owner_user_id::text AS owner_user_id, status,
            created_by::text AS created_by, created_at::text AS created_at
          `,
          [
            tenantId, factoryId, opportunityId, dto.question.trim(), dto.decision_variable.trim(),
            dto.impact_if_wrong, dto.probability_unknown, dto.validation_effort,
            dto.validation_method, ownerUserId, userId,
          ],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error('GROWTH_VALIDATION_UNKNOWN_INSERT_FAILED');
        await this.insertOutbox(client, {
          tenantId, factoryId, userId, aggregateType: 'GROWTH_VALIDATION_UNKNOWN',
          aggregateId: row.id, eventType: 'GROWTH.UNKNOWN_OPENED',
          correlationId: this.correlationId(requestId, traceId),
          payload: {
            unknown_id: row.id, opportunity_id: opportunityId,
            decision_variable: row.decision_variable, priority_score: row.priority_score,
            validation_method: row.validation_method,
          },
        });
        return row;
      },
    );
    await this.auditSafely({
      tenantId, factoryId, userId, action: 'UNKNOWN_OPEN',
      resourceId: unknown.id, requestId, traceId,
      payload: {
        opportunityId, decisionVariable: unknown.decision_variable,
        priorityScore: unknown.priority_score, validationMethod: unknown.validation_method,
      },
    });
    return unknown;
  }

  async listValidationUnknowns(
    tenantId: string,
    factoryId: string,
    opportunityId: string,
    includeResolved = false,
  ) {
    this.validateReadScope(tenantId, factoryId);
    this.validateUuid(opportunityId, 'opportunityId');
    const result = await this.database.query(
      `
      SELECT id::text AS id, question, decision_variable,
        impact_if_wrong::text AS impact_if_wrong,
        probability_unknown::text AS probability_unknown,
        validation_effort::text AS validation_effort,
        priority_score::text AS priority_score, validation_method,
        owner_user_id::text AS owner_user_id, status,
        resolution_evidence_ref, resolution_notes, resolved_at::text AS resolved_at,
        created_at::text AS created_at, updated_at::text AS updated_at
      FROM growth_validation_unknowns
      WHERE opportunity_id = $1 AND tenant_id = $2 AND factory_id = $3
        AND ($4::boolean OR status NOT IN ('RESOLVED', 'NOT_MATERIAL'))
      ORDER BY CASE WHEN status IN ('RESOLVED', 'NOT_MATERIAL') THEN 1 ELSE 0 END,
        priority_score DESC, created_at
      `,
      [opportunityId, tenantId, factoryId, includeResolved],
      { tenantId },
    );
    return result.rows;
  }

  async decideValidationUnknown(
    userId: string,
    tenantId: string,
    factoryId: string,
    unknownId: string,
    dto: DecideGrowthValidationUnknownDto,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(unknownId, 'unknownId');
    const next = dto.decision === 'START_VALIDATING' ? 'VALIDATING'
      : dto.decision === 'RESOLVE' ? 'RESOLVED' : 'NOT_MATERIAL';
    const evidenceRef = dto.resolution_evidence_ref?.trim() || null;
    const notes = dto.resolution_notes?.trim() || null;
    if (next === 'RESOLVED' || next === 'NOT_MATERIAL') {
      if (!evidenceRef) throw new BadRequestException('Closing a material uncertainty requires a traceable evidence reference');
    }

    const result = await this.database.transaction(
      { tenantId, userId },
      async client => {
        const current = await client.query<{ status: string; opportunity_id: string }>(
          'SELECT status, opportunity_id::text AS opportunity_id FROM growth_validation_unknowns WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 FOR UPDATE',
          [unknownId, tenantId, factoryId],
        );
        const row = current.rows[0];
        if (!row) throw new NotFoundException('Growth validation unknown not found');
        const transitions: Record<string, string[]> = {
          OPEN: ['VALIDATING', 'RESOLVED', 'NOT_MATERIAL'],
          VALIDATING: ['RESOLVED', 'NOT_MATERIAL'],
        };
        if (!(transitions[row.status] ?? []).includes(next)) {
          throw new ConflictException('Invalid or terminal growth unknown transition');
        }
        const updated = await client.query(
          `
          UPDATE growth_validation_unknowns
          SET status = $1, resolution_evidence_ref = $2, resolution_notes = $3,
              updated_by = $4
          WHERE id = $5 AND tenant_id = $6 AND factory_id = $7
          RETURNING id::text AS id, opportunity_id::text AS opportunity_id,
            question, decision_variable, priority_score::text AS priority_score,
            status, resolution_evidence_ref, resolution_notes,
            resolved_at::text AS resolved_at, updated_at::text AS updated_at
          `,
          [next, next === 'VALIDATING' ? null : evidenceRef,
            next === 'VALIDATING' ? null : notes, userId, unknownId, tenantId, factoryId],
        );
        const updatedRow = updated.rows[0];
        if (!updatedRow) throw new ConflictException('Growth unknown decision lost a concurrent update');
        await this.insertOutbox(client, {
          tenantId, factoryId, userId, aggregateType: 'GROWTH_VALIDATION_UNKNOWN',
          aggregateId: unknownId, eventType: 'GROWTH.UNKNOWN_' + next,
          correlationId: this.correlationId(requestId, traceId),
          payload: {
            unknown_id: unknownId, opportunity_id: row.opportunity_id,
            status: next, evidence_ref: evidenceRef,
          },
        });
        return updatedRow;
      },
    );
    await this.auditSafely({
      tenantId, factoryId, userId, action: 'UNKNOWN_' + next,
      resourceId: unknownId, requestId, traceId,
      payload: { status: next, evidenceRef, priorityScore: result.priority_score },
    });
    return result;
  }

  async decideOpportunity(
    userId: string,
    tenantId: string,
    factoryId: string,
    opportunityId: string,
    dto: DecideGrowthOpportunityDto,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(opportunityId, 'opportunityId');
    const reason = dto.reason.trim();
    const next = dto.decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED';
    const row = await this.database.transaction(
      { tenantId, userId },
      async client => {
        const current = await client.query<{ id: string; status: string }>(
          'SELECT id::text AS id, status FROM growth_opportunities WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 FOR UPDATE',
          [opportunityId, tenantId, factoryId],
        );
        if (!current.rows[0]) throw new NotFoundException('Growth opportunity not found');
        if (current.rows[0].status !== 'PROPOSED') throw new ConflictException('Only proposed growth opportunities can be accepted or rejected');
        if (dto.decision === 'ACCEPT') {
          const evidence = await client.query<{ count: number }>(
            'SELECT COUNT(*)::int AS count FROM growth_opportunity_evidence WHERE opportunity_id = $1 AND tenant_id = $2 AND factory_id = $3',
            [opportunityId, tenantId, factoryId],
          );
          if (!evidence.rows[0] || evidence.rows[0].count < 1) {
            throw new ConflictException('An opportunity requires visible evidence before acceptance');
          }
        }
        const updated = await client.query<OpportunityRow>(
          `
          UPDATE growth_opportunities
          SET status = $1, decided_by = $2, decided_at = clock_timestamp(),
              decision_reason = $3, updated_at = clock_timestamp()
          WHERE id = $4 AND tenant_id = $5 AND factory_id = $6 AND status = 'PROPOSED'
          RETURNING id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id,
            title, category, opportunity_statement, success_hypothesis, assumptions,
            constraints_snapshot, affected_business_nodes, expected_value_low::text AS expected_value_low,
            expected_value_high::text AS expected_value_high, currency, uncertainty_pct::text AS uncertainty_pct,
            effort, time_to_impact_days, implementation_risk, owner_user_id::text AS owner_user_id,
            status, created_by::text AS created_by, created_at::text AS created_at, updated_at::text AS updated_at
          `,
          [next, userId, reason, opportunityId, tenantId, factoryId],
        );
        const result = updated.rows[0];
        if (!result) throw new ConflictException('Opportunity decision lost a concurrent update');
        await this.insertOutbox(client, {
          tenantId, factoryId, userId, aggregateType: 'GROWTH_OPPORTUNITY',
          aggregateId: opportunityId, eventType: 'GROWTH.OPPORTUNITY_' + next,
          correlationId: this.correlationId(requestId, traceId),
          payload: { opportunity_id: opportunityId, status: next, reason },
        });
        return result;
      },
    );
    await this.auditSafely({
      tenantId, factoryId, userId, action: 'OPPORTUNITY_' + next,
      resourceId: opportunityId, requestId, traceId, payload: { reason },
    });
    return row;
  }

  async createScenario(
    userId: string,
    tenantId: string,
    factoryId: string,
    opportunityId: string,
    dto: CreateGrowthScenarioDto,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(opportunityId, 'opportunityId');
    const vintage = new Date(dto.data_vintage);
    if (!Number.isFinite(vintage.getTime())) throw new BadRequestException('data_vintage must be a valid timestamp');
    if (vintage.getTime() > Date.now() + 5 * 60 * 1000) throw new BadRequestException('data_vintage cannot be in the future');
    if (!dto.baseline_source_ref.trim()) throw new BadRequestException('A traceable baseline_source_ref is required');
    const numericInputs = [
      dto.baseline_revenue, dto.baseline_variable_cost, dto.baseline_fixed_cost,
      dto.price_change_pct, dto.volume_change_pct, dto.variable_cost_change_pct,
      dto.fixed_cost_change_pct, dto.investment, dto.uncertainty_pct,
    ];
    if (numericInputs.some(n => !Number.isFinite(n)) || numericInputs.some(n => Math.abs(n) > 1e12)) {
      throw new BadRequestException('Scenario inputs must be finite and within supported numeric bounds');
    }

    const inputs = {
      baseline_revenue: dto.baseline_revenue,
      baseline_variable_cost: dto.baseline_variable_cost,
      baseline_fixed_cost: dto.baseline_fixed_cost,
      price_change_pct: dto.price_change_pct,
      volume_change_pct: dto.volume_change_pct,
      variable_cost_change_pct: dto.variable_cost_change_pct,
      fixed_cost_change_pct: dto.fixed_cost_change_pct,
      investment: dto.investment,
      uncertainty_pct: dto.uncertainty_pct,
    };
    const modelVersion = 'factoryos.growth.financial-sensitivity.v1';
    const output = this.runSensitivityModel(inputs);
    let inputHash = '';

    const result = await this.database.transaction(
      { tenantId, userId },
      async client => {
        const opportunity = await client.query<{ status: string; constraints_snapshot: Record<string, unknown> }>(
          'SELECT status, constraints_snapshot FROM growth_opportunities WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 FOR SHARE',
          [opportunityId, tenantId, factoryId],
        );
        if (!opportunity.rows[0]) throw new NotFoundException('Growth opportunity not found');
        if (!['ACCEPTED', 'IN_PROGRESS'].includes(opportunity.rows[0].status)) {
          throw new ConflictException('Scenarios may only be run against accepted or in-progress hypotheses');
        }
        const constraintGate = this.evaluateConstraintGate(
          opportunity.rows[0].constraints_snapshot,
          dto.projected_constraint_metrics as unknown as Record<string, unknown> | undefined,
        );
        const snapshotOutput = { ...output, constraintGate };
        const fullInputs = {
          ...inputs,
          projected_constraint_metrics: dto.projected_constraint_metrics ?? null,
        };
        inputHash = createHash('sha256').update(JSON.stringify({
          modelVersion, dataVintage: vintage.toISOString(),
          baselineSourceRef: dto.baseline_source_ref.trim(),
          inputs: fullInputs,
          constraintsSnapshot: opportunity.rows[0].constraints_snapshot ?? {},
          constraintGate,
        })).digest('hex');
        const inserted = await client.query(
          `
          INSERT INTO growth_scenarios (
            tenant_id, factory_id, opportunity_id, scenario_name, scenario_type,
            model_version, data_vintage, baseline_source_ref, inputs, output_snapshot, input_hash, created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9::jsonb, $10::jsonb, $11, $12)
          RETURNING id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id,
            opportunity_id::text AS opportunity_id, scenario_name, scenario_type, model_version,
            data_vintage::text AS data_vintage, baseline_source_ref, inputs, output_snapshot,
            input_hash, decision_ready, created_by::text AS created_by, created_at::text AS created_at
          `,
          [
            tenantId, factoryId, opportunityId, dto.scenario_name.trim(), dto.scenario_type,
            modelVersion, vintage.toISOString(), dto.baseline_source_ref.trim(),
            JSON.stringify(fullInputs), JSON.stringify(snapshotOutput), inputHash, userId,
          ],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error('GROWTH_SCENARIO_INSERT_FAILED');
        await this.insertOutbox(client, {
          tenantId, factoryId, userId, aggregateType: 'GROWTH_SCENARIO',
          aggregateId: row.id, eventType: 'GROWTH.SCENARIO_SNAPSHOTTED',
          correlationId: this.correlationId(requestId, traceId),
          payload: { scenario_id: row.id, opportunity_id: opportunityId, model_version: modelVersion, input_hash: inputHash },
        });
        return row;
      },
    );
    await this.auditSafely({
      tenantId, factoryId, userId, action: 'SCENARIO_RUN',
      resourceId: result.id, requestId, traceId,
      payload: { opportunityId, scenarioType: dto.scenario_type, modelVersion, inputHash, decisionReady: result.decision_ready, constraintGate: (result.output_snapshot as Record<string, unknown>)?.constraintGate },
    });
    return result;
  }

  async createExperiment(
    userId: string,
    tenantId: string,
    factoryId: string,
    opportunityId: string,
    dto: CreateGrowthExperimentDto,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(opportunityId, 'opportunityId');
    if (!dto.leading_indicators.length || !dto.stop_conditions.length) {
      throw new BadRequestException('Experiments require leading indicators and stop conditions');
    }
    const experiment = await this.database.transaction(
      { tenantId, userId },
      async client => {
        const opportunity = await client.query<{ status: string }>(
          'SELECT status FROM growth_opportunities WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 FOR SHARE',
          [opportunityId, tenantId, factoryId],
        );
        if (!opportunity.rows[0]) throw new NotFoundException('Growth opportunity not found');
        if (!['ACCEPTED', 'IN_PROGRESS'].includes(opportunity.rows[0].status)) {
          throw new ConflictException('Experiments require an accepted or in-progress growth opportunity');
        }
        const ownerUserId = dto.owner_user_id ?? userId;
        await this.assertActiveTenantUser(client, tenantId, ownerUserId);
        const inserted = await client.query(
          `
          INSERT INTO growth_experiments (
            tenant_id, factory_id, opportunity_id, name, objective, hypothesis,
            leading_indicators, duration_days, owner_user_id, baseline_measurements,
            stop_conditions, created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11::jsonb, $12)
          RETURNING id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id,
            opportunity_id::text AS opportunity_id, name, objective, hypothesis,
            leading_indicators, duration_days, owner_user_id::text AS owner_user_id,
            baseline_measurements, stop_conditions, status, created_by::text AS created_by,
            created_at::text AS created_at
          `,
          [
            tenantId, factoryId, opportunityId, dto.name.trim(), dto.objective.trim(),
            dto.hypothesis.trim(), JSON.stringify(dto.leading_indicators.map(v => v.trim())),
            dto.duration_days, ownerUserId, JSON.stringify(dto.baseline_measurements),
            JSON.stringify(dto.stop_conditions.map(v => v.trim())), userId,
          ],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error('GROWTH_EXPERIMENT_INSERT_FAILED');
        await this.insertOutbox(client, {
          tenantId, factoryId, userId, aggregateType: 'GROWTH_EXPERIMENT',
          aggregateId: row.id, eventType: 'GROWTH.EXPERIMENT_PLANNED',
          correlationId: this.correlationId(requestId, traceId),
          payload: { experiment_id: row.id, opportunity_id: opportunityId, status: row.status },
        });
        return row;
      },
    );
    await this.auditSafely({
      tenantId, factoryId, userId, action: 'EXPERIMENT_PLAN',
      resourceId: experiment.id, requestId, traceId,
      payload: { opportunityId, durationDays: dto.duration_days },
    });
    return experiment;
  }

  async startExperiment(
    userId: string,
    tenantId: string,
    factoryId: string,
    experimentId: string,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(experimentId, 'experimentId');
    const row = await this.database.transaction(
      { tenantId, userId },
      async client => {
        const updated = await client.query(
          `
          UPDATE growth_experiments SET status = 'RUNNING', started_at = clock_timestamp()
          WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 AND status = 'PLANNED'
          RETURNING id::text AS id, opportunity_id::text AS opportunity_id, status,
            started_at::text AS started_at
          `,
          [experimentId, tenantId, factoryId],
        );
        const result = updated.rows[0];
        if (!result) throw new ConflictException('Only a planned experiment can be started');
        await this.insertOutbox(client, {
          tenantId, factoryId, userId, aggregateType: 'GROWTH_EXPERIMENT',
          aggregateId: experimentId, eventType: 'GROWTH.EXPERIMENT_STARTED',
          correlationId: this.correlationId(requestId, traceId),
          payload: { experiment_id: experimentId, status: result.status },
        });
        return result;
      },
    );
    await this.auditSafely({
      tenantId, factoryId, userId, action: 'EXPERIMENT_START',
      resourceId: experimentId, requestId, traceId, payload: { status: row.status },
    });
    return row;
  }

  async recordExperimentResult(
    userId: string,
    tenantId: string,
    factoryId: string,
    experimentId: string,
    dto: RecordGrowthExperimentResultDto,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(experimentId, 'experimentId');
    if (!dto.evidence_refs.length) throw new BadRequestException('Experiment outcomes require evidence references');
    const observedAt = new Date(dto.observed_at);
    if (!Number.isFinite(observedAt.getTime())) throw new BadRequestException('observed_at must be a valid timestamp');
    const result = await this.database.transaction(
      { tenantId, userId },
      async client => {
        const current = await client.query<{ id: string; opportunity_id: string; status: string }>(
          'SELECT id::text AS id, opportunity_id::text AS opportunity_id, status FROM growth_experiments WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 FOR UPDATE',
          [experimentId, tenantId, factoryId],
        );
        const experiment = current.rows[0];
        if (!experiment) throw new NotFoundException('Growth experiment not found');
        if (experiment.status !== 'RUNNING') throw new ConflictException('Experiment results can only be recorded while the experiment is running');
        const inserted = await client.query(
          `
          INSERT INTO growth_experiment_results (
            tenant_id, factory_id, experiment_id, pre_measurements, post_measurements,
            assessment, stop_condition_triggered, result_notes, evidence_refs,
            observed_at, recorded_by
          )
          VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9::jsonb, $10::timestamptz, $11)
          RETURNING id::text AS id, experiment_id::text AS experiment_id, assessment,
            stop_condition_triggered, pre_measurements, post_measurements, evidence_refs,
            observed_at::text AS observed_at, created_at::text AS created_at
          `,
          [
            tenantId, factoryId, experimentId, JSON.stringify(dto.pre_measurements),
            JSON.stringify(dto.post_measurements), dto.assessment, dto.stop_condition_triggered,
            dto.result_notes?.trim() || null, JSON.stringify(dto.evidence_refs.map(v => v.trim())),
            observedAt.toISOString(), userId,
          ],
        );
        const insertedRow = inserted.rows[0];
        if (!insertedRow) throw new Error('GROWTH_EXPERIMENT_RESULT_INSERT_FAILED');
        const nextStatus = dto.stop_condition_triggered ? 'STOPPED' : 'COMPLETED';
        await client.query(
          'UPDATE growth_experiments SET status = $1, ended_at = clock_timestamp() WHERE id = $2 AND tenant_id = $3 AND factory_id = $4 AND status = $5',
          [nextStatus, experimentId, tenantId, factoryId, 'RUNNING'],
        );
        await this.insertOutbox(client, {
          tenantId, factoryId, userId, aggregateType: 'GROWTH_EXPERIMENT_RESULT',
          aggregateId: insertedRow.id, eventType: 'GROWTH.EXPERIMENT_RESULT_RECORDED',
          correlationId: this.correlationId(requestId, traceId),
          payload: { result_id: insertedRow.id, experiment_id: experimentId, status: nextStatus, assessment: dto.assessment },
        });
        return { ...insertedRow, experiment_status: nextStatus, opportunity_id: experiment.opportunity_id };
      },
    );
    await this.auditSafely({
      tenantId, factoryId, userId, action: 'EXPERIMENT_RESULT',
      resourceId: result.id, requestId, traceId,
      payload: { experimentId, assessment: dto.assessment, stopConditionTriggered: dto.stop_condition_triggered },
    });
    return result;
  }

  async recordOpportunityOutcome(
    userId: string,
    tenantId: string,
    factoryId: string,
    opportunityId: string,
    dto: RecordGrowthOpportunityOutcomeDto,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(opportunityId, 'opportunityId');
    const observedAt = new Date(dto.observed_at);
    if (!Number.isFinite(observedAt.getTime())) throw new BadRequestException('observed_at must be a valid timestamp');
    if (!dto.evidence_refs.length) throw new BadRequestException('Realized outcomes require evidence references');

    const outcome = await this.database.transaction(
      { tenantId, userId },
      async client => {
        const opportunity = await client.query<{ id: string; status: string }>(
          'SELECT id::text AS id, status FROM growth_opportunities WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 FOR UPDATE',
          [opportunityId, tenantId, factoryId],
        );
        const op = opportunity.rows[0];
        if (!op) throw new NotFoundException('Growth opportunity not found');
        if (!['ACCEPTED', 'IN_PROGRESS', 'REALIZED'].includes(op.status)) {
          throw new ConflictException('Outcomes require an accepted or in-progress opportunity');
        }
        if (dto.experiment_result_id) {
          const experimentResult = await client.query<{ id: string }>(
            `
            SELECT r.id::text AS id
            FROM growth_experiment_results r
            JOIN growth_experiments e
              ON e.id = r.experiment_id AND e.tenant_id = r.tenant_id AND e.factory_id = r.factory_id
            WHERE r.id = $1 AND e.opportunity_id = $2
              AND r.tenant_id = $3 AND r.factory_id = $4
            `,
            [dto.experiment_result_id, opportunityId, tenantId, factoryId],
          );
          if (!experimentResult.rows[0]) throw new BadRequestException('Experiment result must belong to this opportunity');
        }
        const inserted = await client.query(
          `
          INSERT INTO growth_opportunity_outcomes (
            tenant_id, factory_id, opportunity_id, experiment_result_id, assessment,
            realized_metrics, evidence_refs, notes, observed_at, recorded_by
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::timestamptz, $10)
          RETURNING id::text AS id, opportunity_id::text AS opportunity_id,
            experiment_result_id::text AS experiment_result_id, assessment, realized_metrics,
            evidence_refs, notes, observed_at::text AS observed_at, created_at::text AS created_at
          `,
          [
            tenantId, factoryId, opportunityId, dto.experiment_result_id ?? null, dto.assessment,
            JSON.stringify(dto.realized_metrics), JSON.stringify(dto.evidence_refs.map(v => v.trim())),
            dto.notes?.trim() || null, observedAt.toISOString(), userId,
          ],
        );
        const result = inserted.rows[0];
        if (!result) throw new Error('GROWTH_OPPORTUNITY_OUTCOME_INSERT_FAILED');
        if (op.status === 'ACCEPTED') {
          await client.query(
            'UPDATE growth_opportunities SET status = $1, updated_at = clock_timestamp() WHERE id = $2 AND tenant_id = $3 AND factory_id = $4 AND status = $5',
            ['IN_PROGRESS', opportunityId, tenantId, factoryId, 'ACCEPTED'],
          );
        }
        if (op.status !== 'REALIZED') {
          await client.query(
            'UPDATE growth_opportunities SET status = $1, updated_at = clock_timestamp() WHERE id = $2 AND tenant_id = $3 AND factory_id = $4 AND status = $5',
            ['REALIZED', opportunityId, tenantId, factoryId, 'IN_PROGRESS'],
          );
        }
        await this.insertOutbox(client, {
          tenantId, factoryId, userId, aggregateType: 'GROWTH_OUTCOME',
          aggregateId: result.id, eventType: 'GROWTH.OPPORTUNITY_OUTCOME_RECORDED',
          correlationId: this.correlationId(requestId, traceId),
          payload: { outcome_id: result.id, opportunity_id: opportunityId, assessment: dto.assessment },
        });
        return result;
      },
    );
    await this.auditSafely({
      tenantId, factoryId, userId, action: 'OPPORTUNITY_OUTCOME',
      resourceId: outcome.id, requestId, traceId, payload: { opportunityId, assessment: dto.assessment },
    });
    return outcome;
  }

  private async validateAndInsertEvidence(
    client: PoolClient,
    input: {
      userId: string; tenantId: string; factoryId: string; opportunityId: string;
      evidence: EvidenceInput;
    },
  ) {
    const e = input.evidence;
    const description = e.description?.trim();
    if (!description) throw new BadRequestException('Evidence descriptions cannot be empty');
    const confidence = e.confidence ?? 0.5;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new BadRequestException('Evidence confidence must be between 0 and 1');
    }
    let originClass: string;
    if (e.evidence_type === 'RESEARCH_CLAIM') {
      originClass = 'EXTERNAL_RESEARCH';
      if (!e.research_claim_id || e.business_entity_id) {
        throw new BadRequestException('Research evidence requires research_claim_id only');
      }
      const claim = await client.query<{ id: string; claim_text: string; provenance_ref: Record<string, unknown>; source_id: string }>(
        `
        SELECT c.id::text AS id, c.claim_text, c.provenance_ref, c.source_id::text AS source_id
        FROM research_claims c
        JOIN research_sources s ON s.id = c.source_id AND s.namespace = c.namespace
        WHERE c.id = $1 AND c.status = 'APPROVED' AND s.access_status = 'APPROVED'
          AND (c.tenant_id = $2 OR c.tenant_id IS NULL)
        `,
        [e.research_claim_id, input.tenantId],
      );
      if (!claim.rows[0]) throw new ForbiddenException('Growth opportunities may only reference approved, rights-cleared research claims visible to this tenant');
      if (!Object.keys(claim.rows[0].provenance_ref ?? {}).length) {
        throw new ConflictException('Research evidence is missing its citation locator');
      }
    } else if (e.evidence_type === 'CBB_ENTITY') {
      originClass = 'CLIENT_PRIVATE';
      if (!e.business_entity_id || e.research_claim_id) {
        throw new BadRequestException('CBB evidence requires business_entity_id only');
      }
      const node = await client.query<{ id: string; state: string }>(
        'SELECT id::text AS id, state FROM business_entities WHERE id = $1 AND tenant_id = $2 AND factory_id = $3',
        [e.business_entity_id, input.tenantId, input.factoryId],
      );
      if (!node.rows[0] || !['VERIFIED', 'INFERRED'].includes(node.rows[0].state)) {
        throw new ForbiddenException('Growth evidence may only reference a verified/inferred business-model node in this factory');
      }
    } else if (e.evidence_type === 'OPERATIONAL_METRIC') {
      originClass = 'OPERATIONAL';
      if (!e.reference_ref?.trim()) throw new BadRequestException('Operational metrics require a record/report reference');
    } else if (e.evidence_type === 'MARKET_SIGNAL') {
      originClass = 'MARKET';
      if (!e.reference_ref?.trim() && !e.citation_url) throw new BadRequestException('Market signals require a source reference or citation URL');
    } else {
      originClass = 'CLIENT_PRIVATE';
      if (!e.reference_ref?.trim()) throw new BadRequestException('Customer documents require a tenant-private evidence reference');
    }

    const result = await client.query(
      `
      INSERT INTO growth_opportunity_evidence (
        tenant_id, factory_id, opportunity_id, evidence_type, origin_class,
        research_claim_id, business_entity_id, reference_ref, citation_url,
        description, confidence, evidence_snapshot, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
      RETURNING id
      `,
      [
        input.tenantId, input.factoryId, input.opportunityId, e.evidence_type, originClass,
        e.research_claim_id ?? null, e.business_entity_id ?? null,
        e.reference_ref?.trim() || null, e.citation_url?.trim() || null,
        description, confidence, JSON.stringify(e.evidence_snapshot ?? {}), input.userId,
      ],
    );
    return result.rows[0];
  }

  private runSensitivityModel(input: {
    baseline_revenue: number;
    baseline_variable_cost: number;
    baseline_fixed_cost: number;
    price_change_pct: number;
    volume_change_pct: number;
    variable_cost_change_pct: number;
    fixed_cost_change_pct: number;
    investment: number;
    uncertainty_pct: number;
  }) {
    const revenue = input.baseline_revenue;
    const variableCost = input.baseline_variable_cost;
    const fixedCost = input.baseline_fixed_cost;
    const baseOperatingCost = variableCost + fixedCost;
    const baseOperatingProfit = revenue - baseOperatingCost;

    const proposedRevenue = revenue
      * (1 + input.price_change_pct / 100)
      * (1 + input.volume_change_pct / 100);
    const proposedVariableCost = variableCost
      * (1 + input.volume_change_pct / 100)
      * (1 + input.variable_cost_change_pct / 100);
    const proposedFixedCost = fixedCost * (1 + input.fixed_cost_change_pct / 100);
    const proposedOperatingCost = proposedVariableCost + proposedFixedCost;
    const proposedOperatingProfit = proposedRevenue - proposedOperatingCost;
    const operatingProfitDelta = proposedOperatingProfit - baseOperatingProfit;
    const uncertainty = Math.abs(operatingProfitDelta) * input.uncertainty_pct / 100;
    const low = operatingProfitDelta - uncertainty - input.investment;
    const high = operatingProfitDelta + uncertainty - input.investment;

    const round = (value: number) => {
      if (!Number.isFinite(value) || Math.abs(value) > 1e16) {
        throw new BadRequestException('Scenario outputs exceed supported numeric bounds');
      }
      return Number(value.toFixed(4));
    };

    return {
      model: 'factoryos.growth.financial-sensitivity.v1',
      method: 'deterministic_sensitivity_not_a_forecast',
      baseline: {
        revenue: round(revenue),
        variableCost: round(variableCost),
        fixedCost: round(fixedCost),
        operatingCost: round(baseOperatingCost),
        operatingProfit: round(baseOperatingProfit),
      },
      proposed: {
        revenue: round(proposedRevenue),
        variableCost: round(proposedVariableCost),
        fixedCost: round(proposedFixedCost),
        operatingCost: round(proposedOperatingCost),
        operatingProfit: round(proposedOperatingProfit),
      },
      impact: {
        operatingProfitDeltaBeforeInvestment: round(operatingProfitDelta),
        investment: round(input.investment),
        netImpactPoint: round(operatingProfitDelta - input.investment),
        lowerBound: round(low),
        upperBound: round(high),
        uncertaintyPct: input.uncertainty_pct,
      },
      assumptions: [
        'Revenue changes multiplicatively with the supplied price and volume percentage changes.',
        'Variable cost changes multiplicatively with the supplied volume and variable-cost percentage changes.',
        'Fixed cost applies the supplied percentage change.',
        'No causal inference, tax, working-capital, capacity, quality, delivery or accounting integration is implied.',
        'The input baseline is accepted as supplied and must be independently reconciled against the named baseline source.',
      ],
    };
  }

  private evaluateConstraintGate(
    snapshot: Record<string, unknown> | null | undefined,
    projected: Record<string, unknown> | undefined,
  ) {
    const required = [
      'capacity', 'quality', 'cash', 'delivery',
    ] as const;
    const missingConstraints: string[] = [];
    const missingProjectedMetrics: string[] = [];
    const violations: string[] = [];
    const checks: Array<Record<string, unknown>> = [];
    const root = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
      ? snapshot as Record<string, unknown> : {};

    const numeric = (obj: Record<string, unknown>, key: string) =>
      typeof obj[key] === 'number' && Number.isFinite(obj[key]) ? obj[key] as number : null;
    const text = (obj: Record<string, unknown>, key: string) =>
      typeof obj[key] === 'string' && (obj[key] as string).trim() ? (obj[key] as string).trim() : null;
    const validSource = (obj: Record<string, unknown>) => {
      const sourceRef = text(obj, 'source_ref');
      const asOf = text(obj, 'as_of');
      const time = asOf ? new Date(asOf).getTime() : Number.NaN;
      return Boolean(sourceRef) && Number.isFinite(time) && time <= Date.now() + 5 * 60 * 1000;
    };

    for (const key of required) {
      const value = root[key];
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        missingConstraints.push(key);
        continue;
      }
      if (!validSource(value as Record<string, unknown>)) {
        missingConstraints.push(key);
      }
    }

    if (!projected || typeof projected !== 'object' || Array.isArray(projected)) {
      missingProjectedMetrics.push('capacity_utilization_pct', 'quality_yield_pct', 'cash_after_investment', 'cash_currency', 'delivery_backlog_days');
    } else {
      for (const key of ['capacity_utilization_pct', 'quality_yield_pct', 'cash_after_investment', 'cash_currency', 'delivery_backlog_days']) {
        const value = projected[key];
        if ((typeof value === 'number' && Number.isFinite(value)) || (key === 'cash_currency' && typeof value === 'string' && /^[A-Za-z]{3}$/.test(value))) continue;
        missingProjectedMetrics.push(key);
      }
    }

    if (missingConstraints.length || missingProjectedMetrics.length) {
      return {
        status: 'REVIEW_REQUIRED',
        decisionReady: false,
        missingConstraints: [...new Set(missingConstraints)],
        missingProjectedMetrics: [...new Set(missingProjectedMetrics)],
        violations,
        checks,
        explanation: 'Scenario output is exploratory only until source-backed capacity, quality, cash and delivery constraints plus projected metrics are supplied.',
      };
    }

    const capacity = root.capacity as Record<string, unknown>;
    const quality = root.quality as Record<string, unknown>;
    const cash = root.cash as Record<string, unknown>;
    const delivery = root.delivery as Record<string, unknown>;

    const maxUtilization = numeric(capacity, 'max_utilization_pct');
    const minYield = numeric(quality, 'min_yield_pct');
    const minCash = numeric(cash, 'minimum_reserve');
    const maxBacklog = numeric(delivery, 'max_backlog_days');
    if (maxUtilization === null || maxUtilization < 0 || maxUtilization > 1000) missingConstraints.push('capacity.max_utilization_pct');
    if (minYield === null || minYield < 0 || minYield > 100) missingConstraints.push('quality.min_yield_pct');
    if (minCash === null || minCash < 0) missingConstraints.push('cash.minimum_reserve');
    if (!text(cash, 'currency') || !/^[A-Za-z]{3}$/.test(text(cash, 'currency') ?? '')) missingConstraints.push('cash.currency');
    if (maxBacklog === null || maxBacklog < 0) missingConstraints.push('delivery.max_backlog_days');
    if (missingConstraints.length) {
      return {
        status: 'REVIEW_REQUIRED', decisionReady: false,
        missingConstraints: [...new Set(missingConstraints)],
        missingProjectedMetrics: [], violations, checks,
        explanation: 'Constraint snapshot is missing a valid limit or currency.',
      };
    }

    const capacityActual = numeric(projected, 'capacity_utilization_pct')!;
    const qualityActual = numeric(projected, 'quality_yield_pct')!;
    const cashActual = numeric(projected, 'cash_after_investment')!;
    const cashCurrency = text(projected, 'cash_currency')!.toUpperCase();
    const backlogActual = numeric(projected, 'delivery_backlog_days')!;
    const expectedCurrency = text(cash, 'currency')!.toUpperCase();

    checks.push({
      dimension: 'capacity',
      passed: capacityActual <= maxUtilization,
      projected: capacityActual,
      maximumAllowed: maxUtilization,
      sourceRef: text(capacity, 'source_ref'),
      asOf: text(capacity, 'as_of'),
    });
    checks.push({
      dimension: 'quality',
      passed: qualityActual >= minYield,
      projected: qualityActual,
      minimumAllowed: minYield,
      sourceRef: text(quality, 'source_ref'),
      asOf: text(quality, 'as_of'),
    });
    checks.push({
      dimension: 'cash',
      passed: cashActual >= minCash && cashCurrency === expectedCurrency,
      projected: cashActual,
      minimumReserve: minCash,
      currency: cashCurrency,
      expectedCurrency,
      sourceRef: text(cash, 'source_ref'),
      asOf: text(cash, 'as_of'),
    });
    checks.push({
      dimension: 'delivery',
      passed: backlogActual <= maxBacklog,
      projected: backlogActual,
      maximumAllowed: maxBacklog,
      sourceRef: text(delivery, 'source_ref'),
      asOf: text(delivery, 'as_of'),
    });
    for (const check of checks) if (check.passed !== true) violations.push(String(check.dimension));

    const status = violations.length ? 'BLOCKED' : 'PASS';
    return {
      status,
      decisionReady: status === 'PASS',
      missingConstraints: [],
      missingProjectedMetrics: [],
      violations,
      checks,
      explanation: status === 'PASS'
        ? 'All four projected constraint checks passed against the supplied source-backed snapshot.'
        : 'At least one projected constraint is outside its declared limit; this scenario must not be presented as decision-ready.',
    };
  }

  private async assertActiveTenantUser(
    client: PoolClient,
    tenantId: string,
    userId: string,
  ) {
    const membership = await client.query<{ user_id: string }>(
      'SELECT u.id::text AS user_id FROM users u JOIN tenant_memberships tm ON tm.user_id = u.id WHERE u.id = $1 AND tm.tenant_id = $2 AND tm.status = $3 AND u.status = $4 LIMIT 1',
      [userId, tenantId, 'ACTIVE', 'ACTIVE'],
    );
    if (!membership.rows[0]) {
      throw new ForbiddenException('Owner must be an active user in the current tenant');
    }
  }

  private async insertOutbox(
    client: PoolClient,
    input: {
      tenantId: string; factoryId: string; userId: string;
      aggregateType: string; aggregateId: string; eventType: string;
      correlationId: string; payload: Record<string, unknown>;
    },
  ) {
    await client.query(
      `
      INSERT INTO outbox_events (
        tenant_id, factory_id, aggregate_type, aggregate_id, event_type,
        event_version, occurred_at, correlation_id, causation_id, actor, source, payload
      )
      VALUES ($1, $2, $3, $4, $5, 1, clock_timestamp(), $6::uuid, NULL, $7::jsonb, $8::jsonb, $9::jsonb)
      `,
      [
        input.tenantId, input.factoryId, input.aggregateType, input.aggregateId, input.eventType,
        input.correlationId, JSON.stringify({ type: 'user', id: input.userId }),
        JSON.stringify({ system: 'FactoryOS', connector: 'growth-service', version: process.env.APP_VERSION ?? '0.1.0' }),
        JSON.stringify(input.payload),
      ],
    );
  }

  private async auditSafely(input: {
    tenantId: string; factoryId: string; userId: string; action: string;
    resourceId: string; requestId: string | null; traceId: string | null;
    payload: Record<string, unknown>;
  }) {
    try {
      await this.audit.record({
        tenantId: input.tenantId, factoryId: input.factoryId, actorUserId: input.userId,
        eventType: 'GROWTH', action: input.action, resourceType: 'GROWTH',
        resourceId: input.resourceId,
        requestId: input.requestId && isUUID(input.requestId) ? input.requestId : null,
        correlationId: input.traceId && isUUID(input.traceId) ? input.traceId : null,
        dataClass: 'INTERNAL', payload: input.payload,
      });
    } catch {
      // Every business mutation also stores a transactional outbox event.
    }
  }

  private validateScope(userId: string, tenantId: string, factoryId: string) {
    this.validateUuid(userId, 'userId');
    this.validateReadScope(tenantId, factoryId);
  }

  private validateReadScope(tenantId: string, factoryId: string) {
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');
  }

  private validateUuid(value: string, field: string) {
    if (!isUUID(value)) throw new BadRequestException(field + ' must be a valid UUID');
  }

  private limit(value?: number) {
    const limit = value ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be between 1 and 100');
    }
    return limit;
  }

  private correlationId(requestId: string | null, traceId: string | null) {
    if (traceId && isUUID(traceId)) return traceId;
    if (requestId && isUUID(requestId)) return requestId;
    return randomUUID();
  }
}
