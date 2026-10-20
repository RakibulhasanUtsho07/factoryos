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
import { CreateGrowthScenarioSetDto } from './dto/create-growth-scenario-set.dto';
import { DecideGrowthOpportunityDto } from './dto/decide-growth-opportunity.dto';
import { RecordGrowthExperimentResultDto } from './dto/record-growth-experiment-result.dto';
import { RecordGrowthOpportunityOutcomeDto } from './dto/record-growth-opportunity-outcome.dto';
import { RecordGrowthForecastEvaluationDto } from './dto/record-growth-forecast-evaluation.dto';
import {
  evaluateGrowthForecast,
  GROWTH_FORECAST_EVALUATION_VERSION,
  GROWTH_FORECAST_CALIBRATION_MIN_SAMPLE_SIZE,
  summarizeGrowthForecastCalibration,
  type GrowthForecastCalibrationObservation,
  type GrowthForecastEvaluationMetrics,
} from './growth-forecast-evaluation';
import { CreateGrowthAssumptionDto } from './dto/create-growth-assumption.dto';
import { DecideGrowthAssumptionDto } from './dto/decide-growth-assumption.dto';
import { CreateGrowthConstraintDto } from './dto/create-growth-constraint.dto';
import { CreateGrowthEvidenceGapDto } from './dto/create-growth-evidence-gap.dto';
import { DecideGrowthEvidenceGapDto } from './dto/decide-growth-evidence-gap.dto';
import { AssignGrowthDecisionOwnerDto } from './dto/assign-growth-decision-owner.dto';
import { evaluateGrowthGovernanceReadiness } from './growth-governance';
import {
  buildGrowthScenarioPlan,
  canonicalizeGrowthScenarioInput,
  GROWTH_SCENARIO_CANONICALIZATION_VERSION,
} from './growth-scenario-engine';
import type {
  GrowthScenarioPlanEntry,
  GrowthScenarioProfilesInput,
  GrowthScenarioProfileInput,
  GrowthScenarioSensitivityAxisInput,
} from './growth-scenario-engine';

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
      || dto.assumptions.some(value => !value.trim() || value.trim().length < 5)) {
      throw new BadRequestException('Every growth opportunity assumption must contain at least 5 non-whitespace characters');
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

  async listScenarioSets(tenantId: string, factoryId: string, opportunityId: string) {
    this.validateReadScope(tenantId, factoryId);
    this.validateUuid(opportunityId, 'opportunityId');
    const opportunity = await this.database.query<{ id: string }>(
      'SELECT id::text AS id FROM growth_opportunities WHERE id = $1 AND tenant_id = $2 AND factory_id = $3',
      [opportunityId, tenantId, factoryId],
      { tenantId },
    );
    if (!opportunity.rows[0]) throw new NotFoundException('Growth opportunity not found');

    const result = await this.database.query<{
      id: string;
      set_name: string;
      set_version: number;
      expected_scenario_count: number;
      model_version: string;
      data_vintage: string;
      baseline_source_ref: string;
      inputs: Record<string, unknown>;
      input_hash: string;
      scenario_count: number;
      scenario_types: string[];
      decision_ready: boolean;
      sensitivity_decision_ready: boolean;
      created_by: string;
      created_at: string;
    }>(
      `
      SELECT s.id::text AS id, s.set_name, s.set_version, s.expected_scenario_count, s.model_version,
        s.data_vintage::text AS data_vintage, s.baseline_source_ref, s.inputs,
        s.input_hash, s.created_by::text AS created_by, s.created_at::text AS created_at,
        (SELECT COUNT(*)::int FROM growth_scenario_set_members m
          WHERE m.scenario_set_id = s.id AND m.tenant_id = s.tenant_id
            AND m.factory_id = s.factory_id AND m.opportunity_id = s.opportunity_id) AS scenario_count,
        COALESCE((SELECT array_agg(DISTINCT m.scenario_type::text ORDER BY m.scenario_type::text)
          FROM growth_scenario_set_members m
          WHERE m.scenario_set_id = s.id AND m.tenant_id = s.tenant_id
            AND m.factory_id = s.factory_id AND m.opportunity_id = s.opportunity_id),
          ARRAY[]::text[]) AS scenario_types,
        COALESCE((SELECT
            COUNT(DISTINCT m.scenario_type) = 4 AND COALESCE(bool_and(sc.decision_ready), FALSE)
          FROM growth_scenario_set_members m
          JOIN growth_scenarios sc ON sc.id = m.scenario_id
            AND sc.tenant_id = m.tenant_id AND sc.factory_id = m.factory_id
            AND sc.opportunity_id = m.opportunity_id
          WHERE m.scenario_set_id = s.id AND m.tenant_id = s.tenant_id
            AND m.factory_id = s.factory_id AND m.opportunity_id = s.opportunity_id
            AND m.scenario_type IN ('BASE','UPSIDE','DOWNSIDE','STRESS')), FALSE) AS decision_ready,
        COALESCE((SELECT bool_and(sc.decision_ready)
          FROM growth_scenario_set_members m
          JOIN growth_scenarios sc ON sc.id = m.scenario_id
            AND sc.tenant_id = m.tenant_id AND sc.factory_id = m.factory_id
            AND sc.opportunity_id = m.opportunity_id
          WHERE m.scenario_set_id = s.id AND m.tenant_id = s.tenant_id
            AND m.factory_id = s.factory_id AND m.opportunity_id = s.opportunity_id
            AND m.scenario_type = 'CUSTOM'
          HAVING COUNT(*) > 0), FALSE) AS sensitivity_decision_ready
      FROM growth_scenario_sets s
      WHERE s.opportunity_id = $1 AND s.tenant_id = $2 AND s.factory_id = $3
      ORDER BY s.set_version DESC
      LIMIT 50
      `,
      [opportunityId, tenantId, factoryId],
      { tenantId },
    );
    return result.rows;
  }

  async getScenarioSet(
    tenantId: string,
    factoryId: string,
    opportunityId: string,
    scenarioSetId: string,
  ) {
    this.validateReadScope(tenantId, factoryId);
    this.validateUuid(opportunityId, 'opportunityId');
    this.validateUuid(scenarioSetId, 'scenarioSetId');
    const setResult = await this.database.query<{
      id: string;
      set_name: string;
      set_version: number;
      expected_scenario_count: number;
      model_version: string;
      data_vintage: string;
      baseline_source_ref: string;
      inputs: Record<string, unknown>;
      input_hash: string;
      created_by: string;
      created_at: string;
    }>(
      `
      SELECT id::text AS id, set_name, set_version, expected_scenario_count, model_version,
        data_vintage::text AS data_vintage, baseline_source_ref, inputs, input_hash,
        created_by::text AS created_by, created_at::text AS created_at
      FROM growth_scenario_sets
      WHERE id = $1 AND opportunity_id = $2 AND tenant_id = $3 AND factory_id = $4
      `,
      [scenarioSetId, opportunityId, tenantId, factoryId],
      { tenantId },
    );
    const scenarioSet = setResult.rows[0];
    if (!scenarioSet) throw new NotFoundException('Growth scenario set not found');

    const memberResult = await this.database.query<{
      scenario_key: string;
      scenario_type: string;
      sensitivity_parameter: string | null;
      sensitivity_value: string | null;
      position: number;
      id: string;
      scenario_name: string;
      model_version: string;
      data_vintage: string;
      baseline_source_ref: string;
      inputs: Record<string, unknown>;
      output_snapshot: Record<string, unknown>;
      input_hash: string;
      decision_ready: boolean;
      created_at: string;
    }>(
      `
      SELECT m.scenario_key, m.scenario_type, m.sensitivity_parameter,
        m.sensitivity_value::text AS sensitivity_value, m.position,
        sc.id::text AS id, sc.scenario_name, sc.model_version,
        sc.data_vintage::text AS data_vintage, sc.baseline_source_ref,
        sc.inputs, sc.output_snapshot, sc.input_hash, sc.decision_ready,
        sc.created_at::text AS created_at
      FROM growth_scenario_set_members m
      JOIN growth_scenarios sc ON sc.id = m.scenario_id
        AND sc.tenant_id = m.tenant_id AND sc.factory_id = m.factory_id
        AND sc.opportunity_id = m.opportunity_id
      WHERE m.scenario_set_id = $1 AND m.opportunity_id = $2
        AND m.tenant_id = $3 AND m.factory_id = $4
      ORDER BY m.position
      `,
      [scenarioSetId, opportunityId, tenantId, factoryId],
      { tenantId },
    );
    const scenarios = memberResult.rows;
    const requiredTypes = ['BASE', 'UPSIDE', 'DOWNSIDE', 'STRESS'];
    const presentTypes = requiredTypes.filter(type => scenarios.some(row => row.scenario_type === type));
    const standardScenarios = scenarios.filter(row => requiredTypes.includes(row.scenario_type));
    const sensitivityScenarios = scenarios.filter(row => row.scenario_type === 'CUSTOM');
    return {
      ...scenarioSet,
      scenario_count: scenarios.length,
      decision_ready: presentTypes.length === requiredTypes.length
        && standardScenarios.length === requiredTypes.length
        && standardScenarios.every(row => row.decision_ready),
      sensitivity_decision_ready: sensitivityScenarios.length > 0
        && sensitivityScenarios.every(row => row.decision_ready),
      scenario_type_coverage: {
        required: requiredTypes,
        present: presentTypes,
        missing: requiredTypes.filter(type => !presentTypes.includes(type)),
      },
      scenarios,
    };
  }

  async compareScenarios(tenantId: string, factoryId: string, opportunityId: string) {
    this.validateReadScope(tenantId, factoryId);
    this.validateUuid(opportunityId, 'opportunityId');
    const opportunityResult = await this.database.query<{
      id: string; status: string; currency: string;
    }>(
      'SELECT id::text AS id, status, currency FROM growth_opportunities WHERE id = $1 AND tenant_id = $2 AND factory_id = $3',
      [opportunityId, tenantId, factoryId],
      { tenantId },
    );
    const opportunity = opportunityResult.rows[0];
    if (!opportunity) throw new NotFoundException('Growth opportunity not found');

    const query = await this.database.query<{
      id: string;
      scenario_name: string;
      scenario_type: string;
      model_version: string;
      data_vintage: string;
      baseline_source_ref: string;
      inputs: Record<string, unknown>;
      output_snapshot: Record<string, unknown>;
      input_hash: string;
      decision_ready: boolean;
      created_at: string;
    }>(
      `
      SELECT id::text AS id, scenario_name, scenario_type, model_version,
        data_vintage::text AS data_vintage, baseline_source_ref, inputs,
        output_snapshot, input_hash, decision_ready, created_at::text AS created_at
      FROM growth_scenarios
      WHERE opportunity_id = $1 AND tenant_id = $2 AND factory_id = $3
      ORDER BY created_at DESC
      LIMIT 100
      `,
      [opportunityId, tenantId, factoryId],
      { tenantId },
    );

    const scenarios = query.rows.map(row => {
      const output = row.output_snapshot && typeof row.output_snapshot === 'object'
        ? row.output_snapshot : {};
      const impactValue = output.impact && typeof output.impact === 'object'
        ? output.impact as Record<string, unknown> : {};
      const gateValue = output.constraintGate && typeof output.constraintGate === 'object'
        ? output.constraintGate as Record<string, unknown> : {};
      const inputValues = row.inputs && typeof row.inputs === 'object'
        ? row.inputs as Record<string, unknown> : {};
      const finiteNumber = (value: unknown) =>
        typeof value === 'number' && Number.isFinite(value) ? value : null;
      const baselineValue = (key: string) => finiteNumber(inputValues[key]);
      const baseline = {
        revenue: baselineValue('baseline_revenue'),
        variableCost: baselineValue('baseline_variable_cost'),
        fixedCost: baselineValue('baseline_fixed_cost'),
      };
      return {
        id: row.id,
        baseline,
        scenario_name: row.scenario_name,
        scenario_type: row.scenario_type,
        model_version: row.model_version,
        data_vintage: row.data_vintage,
        baseline_source_ref: row.baseline_source_ref,
        input_hash: row.input_hash,
        created_at: row.created_at,
        method: typeof output.method === 'string' ? output.method : 'unknown',
        impact: {
          netImpactPoint: finiteNumber(impactValue.netImpactPoint),
          lowerBound: finiteNumber(impactValue.lowerBound),
          upperBound: finiteNumber(impactValue.upperBound),
          investment: finiteNumber(impactValue.investment),
        },
        constraintGate: {
          status: typeof gateValue.status === 'string' ? gateValue.status : 'REVIEW_REQUIRED',
          decisionReady: row.decision_ready === true,
          violations: Array.isArray(gateValue.violations) ? gateValue.violations : [],
          missingConstraints: Array.isArray(gateValue.missingConstraints) ? gateValue.missingConstraints : [],
          missingProjectedMetrics: Array.isArray(gateValue.missingProjectedMetrics) ? gateValue.missingProjectedMetrics : [],
        },
      };
    });

    const uniqueValues = (values: string[]) => [...new Set(values)];
    const modelVersions = uniqueValues(scenarios.map(s => s.model_version));
    const baselineSources = uniqueValues(scenarios.map(s => s.baseline_source_ref));
    const dataVintages = uniqueValues(scenarios.map(s => s.data_vintage));
    const comparabilityReasons: string[] = [];
    if (scenarios.length < 2) comparabilityReasons.push('AT_LEAST_TWO_SCENARIOS_REQUIRED');
    if (modelVersions.length > 1) comparabilityReasons.push('MODEL_VERSION_MISMATCH');
    if (baselineSources.length > 1) comparabilityReasons.push('BASELINE_SOURCE_MISMATCH');
    if (dataVintages.length > 1) comparabilityReasons.push('DATA_VINTAGE_MISMATCH');
    const baselineFingerprints = scenarios.map(scenario => {
      const values = [
        scenario.baseline.revenue,
        scenario.baseline.variableCost,
        scenario.baseline.fixedCost,
      ];
      return values.every(value => value !== null) ? JSON.stringify(values) : null;
    });
    if (baselineFingerprints.some(value => value === null)) {
      comparabilityReasons.push('BASELINE_INPUTS_MISSING');
    }
    if (new Set(baselineFingerprints.filter((value): value is string => value !== null)).size > 1) {
      comparabilityReasons.push('BASELINE_INPUTS_MISMATCH');
    }

    const rankingBlockers = scenarios.some(s => !s.constraintGate.decisionReady)
      ? ['SCENARIO_NOT_DECISION_READY'] : [];
    const rankingEnabled = comparabilityReasons.length === 0 && rankingBlockers.length === 0;
    const score = (scenario: typeof scenarios[number]) =>
      scenario.impact.netImpactPoint ?? Number.NEGATIVE_INFINITY;
    const ranked = [...scenarios].sort((a, b) => score(b) - score(a));
    const ranks = new Map<string, number>();
    if (rankingEnabled) ranked.forEach((scenario, index) => ranks.set(scenario.id, index + 1));

    const scenarioTypes = ['BASE', 'UPSIDE', 'DOWNSIDE', 'STRESS'] as const;
    const availableTypes = new Set(scenarios.map(s => s.scenario_type));
    return {
      opportunity: {
        id: opportunity.id,
        status: opportunity.status,
        currency: opportunity.currency,
      },
      comparison_method: 'deterministic_sensitivity_side_by_side',
      comparable: comparabilityReasons.length === 0,
      comparability_reasons: comparabilityReasons,
      ranking_enabled: rankingEnabled,
      ranking_blockers: rankingBlockers,
      model_versions: modelVersions,
      baseline_sources: baselineSources,
      data_vintages: dataVintages,
      scenario_type_coverage: {
        required: [...scenarioTypes],
        present: scenarioTypes.filter(type => availableTypes.has(type)),
        missing: scenarioTypes.filter(type => !availableTypes.has(type)),
      },
      ranking_basis: rankingEnabled
        ? 'netImpactPoint descending from the same deterministic sensitivity model; not a forecast or causal estimate'
        : null,
      scenarios: scenarios.map(scenario => ({
        ...scenario,
        impact_rank: ranks.get(scenario.id) ?? null,
      })),
    };
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
    const [evidence, scenarios, experiments, experimentResults, experimentResultKpis, outcomes, outcomeKpis, unknowns] = await Promise.all([
      this.database.query(
        'SELECT id::text AS id, evidence_type, origin_class, research_claim_id::text AS research_claim_id, business_entity_id::text AS business_entity_id, reference_ref, citation_url, description, confidence::text AS confidence, evidence_snapshot, captured_at::text AS captured_at FROM growth_opportunity_evidence WHERE opportunity_id = $1 AND tenant_id = $2 AND factory_id = $3 ORDER BY captured_at',
        [opportunityId, tenantId, factoryId], { tenantId },
      ),
      this.database.query(
        'SELECT id::text AS id, scenario_name, scenario_type, model_version, data_vintage::text AS data_vintage, baseline_source_ref, inputs, output_snapshot, input_hash, decision_ready, created_at::text AS created_at FROM growth_scenarios WHERE opportunity_id = $1 AND tenant_id = $2 AND factory_id = $3 ORDER BY created_at DESC',
        [opportunityId, tenantId, factoryId], { tenantId },
      ),
      this.database.query(
        'SELECT id::text AS id, name, objective, hypothesis, leading_indicators, duration_days, owner_user_id::text AS owner_user_id, baseline_measurements, stop_conditions, status, started_at::text AS started_at, ended_at::text AS ended_at, created_at::text AS created_at FROM growth_experiments WHERE opportunity_id = $1 AND tenant_id = $2 AND factory_id = $3 ORDER BY created_at DESC',
        [opportunityId, tenantId, factoryId], { tenantId },
      ),
      this.database.query<{
        id: string; experiment_id: string; assessment: string; stop_condition_triggered: boolean;
        pre_measurements: Record<string, unknown>; post_measurements: Record<string, unknown>;
        evidence_refs: string[]; result_notes: string | null; observed_at: string; created_at: string;
      }>(
        `SELECT r.id::text AS id, r.experiment_id::text AS experiment_id, r.assessment,
          r.stop_condition_triggered, r.pre_measurements, r.post_measurements, r.evidence_refs,
          r.result_notes, r.observed_at::text AS observed_at, r.created_at::text AS created_at
         FROM growth_experiment_results r
         JOIN growth_experiments e ON e.id = r.experiment_id AND e.tenant_id = r.tenant_id AND e.factory_id = r.factory_id
         WHERE e.opportunity_id = $1 AND r.tenant_id = $2 AND r.factory_id = $3
         ORDER BY r.observed_at DESC`,
        [opportunityId, tenantId, factoryId], { tenantId },
      ),
      this.database.query<{
        id: string; experiment_result_id: string; metric_key: string; baseline_value: string;
        actual_value: string; target_value: string | null; unit: string; direction: string;
        evidence_ref: string; created_at: string;
      }>(
        `SELECT id::text AS id, experiment_result_id::text AS experiment_result_id,
          metric_key, baseline_value::text AS baseline_value, actual_value::text AS actual_value,
          target_value::text AS target_value, unit, direction, evidence_ref, created_at::text AS created_at
         FROM growth_experiment_result_kpis
         WHERE opportunity_id = $1 AND tenant_id = $2 AND factory_id = $3
         ORDER BY experiment_result_id, metric_key`,
        [opportunityId, tenantId, factoryId], { tenantId },
      ),
      this.database.query<{
        id: string; experiment_result_id: string | null; assessment: string;
        realized_metrics: Record<string, unknown>; evidence_refs: string[]; notes: string | null;
        observed_at: string; created_at: string;
      }>(
        'SELECT id::text AS id, experiment_result_id::text AS experiment_result_id, assessment, realized_metrics, evidence_refs, notes, observed_at::text AS observed_at, created_at::text AS created_at FROM growth_opportunity_outcomes WHERE opportunity_id = $1 AND tenant_id = $2 AND factory_id = $3 ORDER BY observed_at DESC',
        [opportunityId, tenantId, factoryId], { tenantId },
      ),
      this.database.query<{
        id: string; outcome_id: string; source_experiment_kpi_id: string | null;
        metric_key: string; baseline_value: string; actual_value: string; target_value: string | null;
        unit: string; direction: string; evidence_ref: string; created_at: string;
      }>(
        `SELECT id::text AS id, outcome_id::text AS outcome_id,
          source_experiment_kpi_id::text AS source_experiment_kpi_id, metric_key,
          baseline_value::text AS baseline_value, actual_value::text AS actual_value,
          target_value::text AS target_value, unit, direction, evidence_ref, created_at::text AS created_at
         FROM growth_outcome_kpi_measurements
         WHERE opportunity_id = $1 AND tenant_id = $2 AND factory_id = $3
         ORDER BY outcome_id, metric_key`,
        [opportunityId, tenantId, factoryId], { tenantId },
      ),
      this.database.query(
        'SELECT id::text AS id, question, decision_variable, impact_if_wrong::text AS impact_if_wrong, probability_unknown::text AS probability_unknown, validation_effort::text AS validation_effort, priority_score::text AS priority_score, validation_method, owner_user_id::text AS owner_user_id, status, resolution_evidence_ref, resolution_notes, resolved_at::text AS resolved_at, created_at::text AS created_at FROM growth_validation_unknowns WHERE opportunity_id = $1 AND tenant_id = $2 AND factory_id = $3 ORDER BY CASE WHEN status IN (\'RESOLVED\', \'NOT_MATERIAL\') THEN 1 ELSE 0 END, priority_score DESC, created_at',
        [opportunityId, tenantId, factoryId], { tenantId },
      ),
    ]);
    const resultsWithKpis = experimentResults.rows.map(result => ({
      ...result,
      kpi_measurements: experimentResultKpis.rows.filter(kpi => kpi.experiment_result_id === result.id),
    }));
    const outcomesWithKpis = outcomes.rows.map(outcome => ({
      ...outcome,
      kpi_measurements: outcomeKpis.rows.filter(kpi => kpi.outcome_id === outcome.id),
    }));
    const experimentsWithResults = experiments.rows.map(experiment => ({
      ...experiment,
      results: resultsWithKpis.filter(result => result.experiment_id === experiment.id),
    }));
    return {
      ...row,
      evidence: evidence.rows,
      scenarios: scenarios.rows,
      experiments: experimentsWithResults,
      experiment_results: resultsWithKpis,
      outcomes: outcomesWithKpis,
      validation_unknowns: unknowns.rows,
    };
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
      LIMIT 100
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
        const decisionOwner = await client.query<{ id: string; owner_user_id: string }>(
          `SELECT id::text AS id, owner_user_id::text AS owner_user_id
             FROM growth_opportunity_decision_owners
            WHERE opportunity_id = $1 AND tenant_id = $2 AND factory_id = $3
              AND role_code = 'DECISION_OWNER' AND active_to IS NULL
            FOR SHARE`,
          [opportunityId, tenantId, factoryId],
        );
        if (!decisionOwner.rows[0]) {
          throw new ConflictException('Assign a named DECISION_OWNER before making the opportunity decision');
        }
        if (decisionOwner.rows[0].owner_user_id !== userId) {
          throw new ForbiddenException('Only the currently assigned decision owner may accept or reject this opportunity');
        }
        let readinessSnapshot: Record<string, unknown> = { readiness_required: false, reason: 'rejected' };
        if (dto.decision === 'ACCEPT') {
          const gate = await client.query<{ ready: boolean }>(
            'SELECT factoryos_growth_opportunity_governance_ready($1, $2, $3) AS ready',
            [tenantId, factoryId, opportunityId],
          );
          if (gate.rows[0]?.ready !== true) {
            throw new ConflictException('Growth governance is incomplete. Review /opportunities/:id/governance for assumptions, constraints, and evidence gaps.');
          }
          const governanceSnapshot = await client.query<{ snapshot: Record<string, unknown> }>(
            `SELECT jsonb_build_object(
               'contract_version', 'growth-opportunity-governance.v1',
               'decision_owner_assignment_id', $4::text,
               'decision_owner_user_id', $5::text,
               'assumptions', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                   'id', a.id::text,
                   'statement', a.statement,
                   'rationale', a.rationale,
                   'risk_if_false', a.risk_if_false,
                   'confidence_pct', a.confidence_pct::text,
                   'validation_method', a.validation_method,
                   'owner_user_id', a.owner_user_id::text,
                   'blocks_decision', a.blocks_decision,
                   'latest_decision', last_decision.decision,
                   'evidence_refs', COALESCE(last_decision.evidence_refs, '[]'::jsonb),
                   'decided_at', last_decision.decided_at
                 ) ORDER BY a.created_at, a.id)
                 FROM growth_opportunity_assumptions a
                 LEFT JOIN LATERAL (
                   SELECT d.decision, d.evidence_refs, d.decided_at
                     FROM growth_opportunity_assumption_decisions d
                    WHERE d.assumption_id = a.id AND d.tenant_id = a.tenant_id
                      AND d.factory_id = a.factory_id AND d.opportunity_id = a.opportunity_id
                    ORDER BY d.decided_at DESC, d.id DESC LIMIT 1
                 ) last_decision ON TRUE
                 WHERE a.opportunity_id = $3 AND a.tenant_id = $1 AND a.factory_id = $2
               ), '[]'::jsonb),
               'latest_constraints', COALESCE((
                 SELECT jsonb_agg(to_jsonb(c) ORDER BY c.dimension)
                   FROM (
                     SELECT DISTINCT ON (dimension)
                       id::text AS id, dimension, applicability, constraint_name, limit_operator,
                       threshold_value::text AS threshold_value, observed_value::text AS observed_value,
                       unit, source_evidence_ref, source_as_of::text AS source_as_of, rationale
                       FROM growth_opportunity_constraints
                      WHERE opportunity_id = $3 AND tenant_id = $1 AND factory_id = $2
                      ORDER BY dimension, created_at DESC, id DESC
                   ) c
               ), '[]'::jsonb),
               'blocking_evidence_gaps', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                   'id', g.id::text, 'question', g.question, 'required_evidence', g.required_evidence,
                   'impact', g.impact, 'latest_decision', last_event.decision,
                   'evidence_refs', COALESCE(last_event.evidence_refs, '[]'::jsonb),
                   'decision_reason', last_event.reason
                 ) ORDER BY g.created_at, g.id)
                   FROM growth_opportunity_evidence_gaps g
                   LEFT JOIN LATERAL (
                     SELECT e.decision, e.evidence_refs, e.reason
                       FROM growth_opportunity_evidence_gap_events e
                      WHERE e.evidence_gap_id = g.id AND e.tenant_id = g.tenant_id
                        AND e.factory_id = g.factory_id AND e.opportunity_id = g.opportunity_id
                      ORDER BY e.created_at DESC, e.id DESC LIMIT 1
                   ) last_event ON TRUE
                  WHERE g.opportunity_id = $3 AND g.tenant_id = $1 AND g.factory_id = $2
                    AND g.blocks_decision
               ), '[]'::jsonb),
               'evidence_count', (
                 SELECT COUNT(*)::int FROM growth_opportunity_evidence
                  WHERE opportunity_id = $3 AND tenant_id = $1 AND factory_id = $2
               ),
               'evidence_items', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                   'id', e.id::text, 'evidence_type', e.evidence_type,
                   'origin_class', e.origin_class, 'reference_ref', e.reference_ref,
                   'citation_url', e.citation_url, 'description', e.description,
                   'confidence', e.confidence::text, 'captured_at', e.captured_at
                 ) ORDER BY e.captured_at, e.id)
                   FROM growth_opportunity_evidence e
                  WHERE e.opportunity_id = $3 AND e.tenant_id = $1 AND e.factory_id = $2
               ), '[]'::jsonb)
             ) AS snapshot`,
            [tenantId, factoryId, opportunityId, decisionOwner.rows[0].id, decisionOwner.rows[0].owner_user_id],
          );
          const readinessDetails = governanceSnapshot.rows[0]?.snapshot;
          if (!readinessDetails) throw new Error('GROWTH_GOVERNANCE_DECISION_SNAPSHOT_FAILED');
          readinessSnapshot = {
            readiness_required: true,
            ready: true,
            assessed_at: new Date().toISOString(),
            ...readinessDetails,
          };
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
        await client.query(
          `INSERT INTO growth_opportunity_decision_history
             (tenant_id, factory_id, opportunity_id, decision, actor_user_id,
              owner_assignment_id, reason, readiness_snapshot, request_id, trace_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::uuid,$10::uuid)`,
          [tenantId, factoryId, opportunityId, dto.decision, userId, decisionOwner.rows[0].id,
            reason, JSON.stringify(readinessSnapshot), this.uuidOrNull(requestId), this.uuidOrNull(traceId)],
        );
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
        const evidenceResult = await client.query<{ reference_ref: string | null; citation_url: string | null }>(
          'SELECT reference_ref, citation_url FROM growth_opportunity_evidence WHERE opportunity_id = $1 AND tenant_id = $2 AND factory_id = $3',
          [opportunityId, tenantId, factoryId],
        );
        const evidenceReferences = new Set(
          evidenceResult.rows.flatMap(item => [item.reference_ref, item.citation_url])
            .filter((ref): ref is string => typeof ref === 'string' && ref.trim().length > 0)
            .map(ref => ref.trim()),
        );
        const constraintGate = this.evaluateConstraintGate(
          opportunity.rows[0].constraints_snapshot,
          dto.projected_constraint_metrics as unknown as Record<string, unknown> | undefined,
          evidenceReferences,
        );
        const snapshotOutput = { ...output, constraintGate };
        const fullInputs = {
          canonicalization_version: GROWTH_SCENARIO_CANONICALIZATION_VERSION,
          ...inputs,
          projected_constraint_metrics: dto.projected_constraint_metrics ?? null,
          constraints_snapshot: opportunity.rows[0].constraints_snapshot ?? {},
        };
        inputHash = createHash('sha256').update(canonicalizeGrowthScenarioInput({
          canonicalization_version: GROWTH_SCENARIO_CANONICALIZATION_VERSION,
          model_version: modelVersion,
          data_vintage: vintage.toISOString(),
          baseline_source_ref: dto.baseline_source_ref.trim(),
          inputs: fullInputs,
          constraints_snapshot: opportunity.rows[0].constraints_snapshot ?? {},
          constraint_gate: constraintGate,
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

  async createScenarioSet(
    userId: string,
    tenantId: string,
    factoryId: string,
    opportunityId: string,
    dto: CreateGrowthScenarioSetDto,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(opportunityId, 'opportunityId');
    const setName = typeof dto.set_name === 'string' ? dto.set_name.trim() : '';
    const baselineSourceRef = typeof dto.baseline_source_ref === 'string' ? dto.baseline_source_ref.trim() : '';
    if (!setName || setName.length > 140) {
      throw new BadRequestException('set_name must contain 1–140 non-whitespace characters');
    }
    if (!baselineSourceRef) throw new BadRequestException('A traceable baseline_source_ref is required');
    const vintage = new Date(dto.data_vintage);
    if (!Number.isFinite(vintage.getTime())) throw new BadRequestException('data_vintage must be a valid timestamp');
    if (vintage.getTime() > Date.now() + 5 * 60 * 1000) {
      throw new BadRequestException('data_vintage cannot be in the future');
    }
    const baseline = {
      baseline_revenue: dto.baseline?.baseline_revenue,
      baseline_variable_cost: dto.baseline?.baseline_variable_cost,
      baseline_fixed_cost: dto.baseline?.baseline_fixed_cost,
    };
    if (
      !Number.isFinite(baseline.baseline_revenue) || baseline.baseline_revenue <= 0
      || baseline.baseline_revenue > 1_000_000_000_000
      || !Number.isFinite(baseline.baseline_variable_cost) || baseline.baseline_variable_cost < 0
      || baseline.baseline_variable_cost > 1_000_000_000_000
      || !Number.isFinite(baseline.baseline_fixed_cost) || baseline.baseline_fixed_cost < 0
      || baseline.baseline_fixed_cost > 1_000_000_000_000
    ) {
      throw new BadRequestException('Scenario baseline values must be finite and within supported non-negative bounds');
    }

    let plan: GrowthScenarioPlanEntry[];
    try {
      plan = buildGrowthScenarioPlan(
        dto.profiles as unknown as GrowthScenarioProfilesInput,
        dto.sensitivity as GrowthScenarioSensitivityAxisInput[],
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'SCENARIO_PLAN_INVALID';
      throw new BadRequestException(reason);
    }
    const modelVersion = 'factoryos.growth.financial-sensitivity.v1';
    const profileSnapshot = (profile: GrowthScenarioProfileInput) => ({
      price_change_pct: profile.price_change_pct,
      volume_change_pct: profile.volume_change_pct,
      variable_cost_change_pct: profile.variable_cost_change_pct,
      fixed_cost_change_pct: profile.fixed_cost_change_pct,
      investment: profile.investment,
      uncertainty_pct: profile.uncertainty_pct,
      projected_constraint_metrics: profile.projected_constraint_metrics ?? null,
    });
    let inputHash = '';

    const result = await this.database.transaction(
      { tenantId, userId },
      async client => {
        const opportunityResult = await client.query<{
          status: string;
          constraints_snapshot: Record<string, unknown> | null;
        }>(
          'SELECT status, constraints_snapshot FROM growth_opportunities WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 FOR UPDATE',
          [opportunityId, tenantId, factoryId],
        );
        const opportunity = opportunityResult.rows[0];
        if (!opportunity) throw new NotFoundException('Growth opportunity not found');
        if (!['ACCEPTED', 'IN_PROGRESS'].includes(opportunity.status)) {
          throw new ConflictException('Scenario sets may only be run against accepted or in-progress hypotheses');
        }
        const constraintsSnapshot = opportunity.constraints_snapshot ?? {};
        const evidenceResult = await client.query<{ reference_ref: string | null; citation_url: string | null }>(
          'SELECT reference_ref, citation_url FROM growth_opportunity_evidence WHERE opportunity_id = $1 AND tenant_id = $2 AND factory_id = $3',
          [opportunityId, tenantId, factoryId],
        );
        const evidenceReferences = new Set(
          evidenceResult.rows.flatMap(item => [item.reference_ref, item.citation_url])
            .filter((ref): ref is string => typeof ref === 'string' && ref.trim().length > 0)
            .map(ref => ref.trim()),
        );
        if (!evidenceReferences.has(baselineSourceRef)) {
          throw new BadRequestException(
            'baseline_source_ref must match a reference_ref or citation_url attached to this opportunity',
          );
        }
        const versionResult = await client.query<{ next_version: number | string }>(
          `SELECT COALESCE(MAX(set_version), 0) + 1 AS next_version
             FROM growth_scenario_sets
            WHERE tenant_id = $1 AND factory_id = $2 AND opportunity_id = $3`,
          [tenantId, factoryId, opportunityId],
        );
        const setVersion = Number(versionResult.rows[0]?.next_version ?? 1);
        if (!Number.isInteger(setVersion) || setVersion < 1) {
          throw new ConflictException('Unable to allocate a monotonic scenario-set version');
        }
        const normalizedInputs = {
          schema_version: 1,
          canonicalization_version: GROWTH_SCENARIO_CANONICALIZATION_VERSION,
          model_version: modelVersion,
          set_name: setName,
          baseline,
          profiles: {
            base: profileSnapshot(dto.profiles.base as unknown as GrowthScenarioProfileInput),
            upside: profileSnapshot(dto.profiles.upside as unknown as GrowthScenarioProfileInput),
            downside: profileSnapshot(dto.profiles.downside as unknown as GrowthScenarioProfileInput),
            stress: profileSnapshot(dto.profiles.stress as unknown as GrowthScenarioProfileInput),
          },
          sensitivity: dto.sensitivity.map(axis => ({
            parameter: axis.parameter,
            low_value: axis.low_value,
            high_value: axis.high_value,
            points: axis.points,
            projected_constraint_metrics: axis.projected_constraint_metrics ?? null,
          })),
          constraints_snapshot: constraintsSnapshot,
        };
        inputHash = createHash('sha256').update(canonicalizeGrowthScenarioInput({
          canonicalization_version: GROWTH_SCENARIO_CANONICALIZATION_VERSION,
          data_vintage: vintage.toISOString(),
          baseline_source_ref: baselineSourceRef,
          inputs: normalizedInputs,
        })).digest('hex');

        const setInsert = await client.query<{
          id: string;
          set_name: string;
          set_version: number;
          model_version: string;
          data_vintage: string;
          baseline_source_ref: string;
          inputs: Record<string, unknown>;
          input_hash: string;
          created_by: string;
          created_at: string;
        }>(
          `
          INSERT INTO growth_scenario_sets (
            tenant_id, factory_id, opportunity_id, set_name, set_version,
            expected_scenario_count, model_version, data_vintage, baseline_source_ref,
            inputs, input_hash, created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10::jsonb, $11, $12)
          RETURNING id::text AS id, set_name, set_version, expected_scenario_count, model_version,
            data_vintage::text AS data_vintage, baseline_source_ref, inputs, input_hash,
            created_by::text AS created_by, created_at::text AS created_at
          `,
          [
            tenantId, factoryId, opportunityId, setName, setVersion, plan.length, modelVersion,
            vintage.toISOString(), baselineSourceRef, JSON.stringify(normalizedInputs), inputHash, userId,
          ],
        );
        const scenarioSet = setInsert.rows[0];
        if (!scenarioSet) throw new Error('GROWTH_SCENARIO_SET_INSERT_FAILED');
        const createdScenarios: Array<Record<string, unknown>> = [];

        for (const entry of plan) {
          const profile = entry.profile;
          const financialInputs = {
            ...baseline,
            price_change_pct: profile.price_change_pct,
            volume_change_pct: profile.volume_change_pct,
            variable_cost_change_pct: profile.variable_cost_change_pct,
            fixed_cost_change_pct: profile.fixed_cost_change_pct,
            investment: profile.investment,
            uncertainty_pct: profile.uncertainty_pct,
          };
          const constraintGate = this.evaluateConstraintGate(
            constraintsSnapshot,
            profile.projected_constraint_metrics as unknown as Record<string, unknown> | undefined,
            evidenceReferences,
          );
          const outputSnapshot = { ...this.runSensitivityModel(financialInputs), constraintGate };
          const fullInputs = {
            canonicalization_version: GROWTH_SCENARIO_CANONICALIZATION_VERSION,
            ...financialInputs,
            projected_constraint_metrics: profile.projected_constraint_metrics ?? null,
            constraints_snapshot: constraintsSnapshot,
            scenario_set: { id: scenarioSet.id, version: setVersion, input_hash: inputHash },
            sensitivity: entry.sensitivity_parameter
              ? { parameter: entry.sensitivity_parameter, value: entry.sensitivity_value }
              : null,
          };
          const scenarioInputHash = createHash('sha256').update(canonicalizeGrowthScenarioInput({
            canonicalization_version: GROWTH_SCENARIO_CANONICALIZATION_VERSION,
            model_version: modelVersion,
            scenario_key: entry.scenario_key,
            data_vintage: vintage.toISOString(),
            baseline_source_ref: baselineSourceRef,
            inputs: fullInputs,
            output_snapshot: outputSnapshot,
          })).digest('hex');
          const scenarioInsert = await client.query<{
            id: string;
            scenario_name: string;
            scenario_type: string;
            model_version: string;
            data_vintage: string;
            baseline_source_ref: string;
            inputs: Record<string, unknown>;
            output_snapshot: Record<string, unknown>;
            input_hash: string;
            decision_ready: boolean;
            created_at: string;
          }>(
            `
            INSERT INTO growth_scenarios (
              tenant_id, factory_id, opportunity_id, scenario_name, scenario_type,
              model_version, data_vintage, baseline_source_ref, inputs, output_snapshot, input_hash, created_by
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9::jsonb, $10::jsonb, $11, $12)
            RETURNING id::text AS id, scenario_name, scenario_type, model_version,
              data_vintage::text AS data_vintage, baseline_source_ref, inputs, output_snapshot,
              input_hash, decision_ready, created_at::text AS created_at
            `,
            [
              tenantId, factoryId, opportunityId, `${entry.display_name} (set v${setVersion})`,
              entry.scenario_type, modelVersion, vintage.toISOString(), baselineSourceRef,
              JSON.stringify(fullInputs), JSON.stringify(outputSnapshot), scenarioInputHash, userId,
            ],
          );
          const scenario = scenarioInsert.rows[0];
          if (!scenario) throw new Error('GROWTH_SCENARIO_SET_MEMBER_INSERT_FAILED');
          await client.query(
            `
            INSERT INTO growth_scenario_set_members (
              tenant_id, factory_id, opportunity_id, scenario_set_id, scenario_id,
              scenario_key, scenario_type, sensitivity_parameter, sensitivity_value, position
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `,
            [
              tenantId, factoryId, opportunityId, scenarioSet.id, scenario.id,
              entry.scenario_key, entry.scenario_type, entry.sensitivity_parameter,
              entry.sensitivity_value, entry.position,
            ],
          );
          createdScenarios.push({
            ...scenario,
            scenario_key: entry.scenario_key,
            position: entry.position,
            sensitivity_parameter: entry.sensitivity_parameter,
            sensitivity_value: entry.sensitivity_value,
          });
        }

        await this.insertOutbox(client, {
          tenantId, factoryId, userId, aggregateType: 'GROWTH_SCENARIO_SET',
          aggregateId: scenarioSet.id, eventType: 'GROWTH.SCENARIO_SET_CREATED',
          correlationId: this.correlationId(requestId, traceId),
          payload: {
            scenario_set_id: scenarioSet.id, opportunity_id: opportunityId,
            set_version: setVersion, input_hash: inputHash, scenario_count: createdScenarios.length,
          },
        });
        return { scenarioSet, scenarios: createdScenarios };
      },
    );

    const requiredTypes = ['BASE', 'UPSIDE', 'DOWNSIDE', 'STRESS'];
    const presentTypes = requiredTypes.filter(type =>
      result.scenarios.some(scenario => scenario.scenario_type === type),
    );
    const standardScenarios = result.scenarios.filter(scenario =>
      requiredTypes.includes(String(scenario.scenario_type)),
    );
    const sensitivityScenarios = result.scenarios.filter(scenario => scenario.scenario_type === 'CUSTOM');
    const standardDecisionReady = presentTypes.length === requiredTypes.length
      && standardScenarios.length === requiredTypes.length
      && standardScenarios.every(scenario => scenario.decision_ready === true);
    const sensitivityDecisionReady = sensitivityScenarios.length > 0
      && sensitivityScenarios.every(scenario => scenario.decision_ready === true);

    await this.auditSafely({
      tenantId, factoryId, userId, action: 'SCENARIO_SET_RUN',
      resourceId: result.scenarioSet.id, requestId, traceId,
      payload: {
        opportunityId, setVersion: result.scenarioSet.set_version,
        inputHash: result.scenarioSet.input_hash, scenarioCount: result.scenarios.length,
        modelVersion, decisionReady: standardDecisionReady,
        sensitivityDecisionReady,
        missingStandardScenarioTypes: requiredTypes.filter(type => !presentTypes.includes(type)),
      },
    });
    return {
      ...result.scenarioSet,
      scenario_count: result.scenarios.length,
      decision_ready: standardDecisionReady,
      sensitivity_decision_ready: sensitivityDecisionReady,
      scenario_type_coverage: {
        required: requiredTypes,
        present: presentTypes,
        missing: requiredTypes.filter(type => !presentTypes.includes(type)),
      },
      scenarios: result.scenarios,
    };
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
    userId: string, tenantId: string, factoryId: string, experimentId: string,
    dto: RecordGrowthExperimentResultDto, requestId: string | null, traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(experimentId, 'experimentId');
    if (!Array.isArray(dto.evidence_refs) || !dto.evidence_refs.length) throw new BadRequestException('Experiment outcomes require evidence references');
    const evidenceRefs = dto.evidence_refs.map(value => typeof value === 'string' ? value.trim() : '');
    if (evidenceRefs.some(value => !value) || new Set(evidenceRefs).size !== evidenceRefs.length) throw new BadRequestException('Experiment evidence references must be non-empty and unique');
    if (!dto.pre_measurements || typeof dto.pre_measurements !== 'object' || Array.isArray(dto.pre_measurements)
      || !dto.post_measurements || typeof dto.post_measurements !== 'object' || Array.isArray(dto.post_measurements)) throw new BadRequestException('Experiment pre/post measurements must be JSON objects');
    if (!Array.isArray(dto.kpi_measurements) || dto.kpi_measurements.length < 1 || dto.kpi_measurements.length > 100) throw new BadRequestException('Experiment results require 1–100 explicit KPI measurements');
    const keys = new Set<string>();
    const kpis = dto.kpi_measurements.map(item => {
      const metricKey = typeof item.metric_key === 'string' ? item.metric_key.trim() : '';
      if (!/^[a-z][a-z0-9_.-]{0,99}$/.test(metricKey) || keys.has(metricKey)) throw new BadRequestException('KPI metric keys must be unique lowercase identifiers');
      keys.add(metricKey);
      const unit = typeof item.unit === 'string' ? item.unit.trim() : '';
      if (!unit || unit.length > 40) throw new BadRequestException('Every KPI requires a unit');
      if (!['INCREASE', 'DECREASE', 'TARGET'].includes(item.direction)) throw new BadRequestException('KPI direction must be INCREASE, DECREASE or TARGET');
      const evidenceRef = typeof item.evidence_ref === 'string' ? item.evidence_ref.trim() : '';
      if (!evidenceRef || !evidenceRefs.includes(evidenceRef)) throw new BadRequestException('Each KPI evidence_ref must be included in experiment result evidence_refs');
      const baselineValue = dto.pre_measurements[metricKey], actualValue = dto.post_measurements[metricKey];
      if (typeof baselineValue !== 'number' || !Number.isFinite(baselineValue) || Math.abs(baselineValue) > 1e12
        || typeof actualValue !== 'number' || !Number.isFinite(actualValue) || Math.abs(actualValue) > 1e12) throw new BadRequestException('Each KPI metric_key must identify finite numeric values in both pre_measurements and post_measurements');
      const targetValue = item.target_value ?? null;
      if (targetValue !== null && (!Number.isFinite(targetValue) || Math.abs(targetValue) > 1e12)) throw new BadRequestException('KPI target_value must be finite and within supported numeric bounds');
      return { metricKey, unit, direction: item.direction, baselineValue, actualValue, targetValue, evidenceRef };
    });
    const observedAt = new Date(dto.observed_at);
    if (!Number.isFinite(observedAt.getTime())) throw new BadRequestException('observed_at must be a valid timestamp');

    const result = await this.database.transaction({ tenantId, userId }, async client => {
      const current = await client.query<{ id: string; opportunity_id: string; status: string }>(
        'SELECT id::text AS id, opportunity_id::text AS opportunity_id, status FROM growth_experiments WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 FOR UPDATE',
        [experimentId, tenantId, factoryId],
      );
      const experiment = current.rows[0];
      if (!experiment) throw new NotFoundException('Growth experiment not found');
      if (experiment.status !== 'RUNNING') throw new ConflictException('Experiment results can only be recorded while the experiment is running');
      const inserted = await client.query(
        `INSERT INTO growth_experiment_results (
          tenant_id, factory_id, experiment_id, pre_measurements, post_measurements,
          assessment, stop_condition_triggered, result_notes, evidence_refs, observed_at, recorded_by
        ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9::jsonb, $10::timestamptz, $11)
        RETURNING id::text AS id, experiment_id::text AS experiment_id, assessment,
          stop_condition_triggered, pre_measurements, post_measurements, evidence_refs,
          observed_at::text AS observed_at, created_at::text AS created_at`,
        [tenantId, factoryId, experimentId, JSON.stringify(dto.pre_measurements), JSON.stringify(dto.post_measurements),
          dto.assessment, dto.stop_condition_triggered, dto.result_notes?.trim() || null,
          JSON.stringify(evidenceRefs), observedAt.toISOString(), userId],
      );
      const insertedRow = inserted.rows[0];
      if (!insertedRow) throw new Error('GROWTH_EXPERIMENT_RESULT_INSERT_FAILED');
      const savedKpis: Array<Record<string, unknown>> = [];
      for (const kpi of kpis) {
        const saved = await client.query(
          `INSERT INTO growth_experiment_result_kpis (
            tenant_id, factory_id, opportunity_id, experiment_id, experiment_result_id,
            metric_key, baseline_value, actual_value, target_value, unit, direction, evidence_ref, recorded_by
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          RETURNING id::text AS id, metric_key, baseline_value::text AS baseline_value,
            actual_value::text AS actual_value, target_value::text AS target_value,
            unit, direction, evidence_ref, created_at::text AS created_at`,
          [tenantId, factoryId, experiment.opportunity_id, experimentId, insertedRow.id, kpi.metricKey,
            kpi.baselineValue, kpi.actualValue, kpi.targetValue, kpi.unit, kpi.direction, kpi.evidenceRef, userId],
        );
        if (!saved.rows[0]) throw new Error('GROWTH_EXPERIMENT_KPI_INSERT_FAILED');
        savedKpis.push(saved.rows[0]);
      }
      const nextStatus = dto.stop_condition_triggered ? 'STOPPED' : 'COMPLETED';
      await client.query(
        'UPDATE growth_experiments SET status = $1, ended_at = clock_timestamp() WHERE id = $2 AND tenant_id = $3 AND factory_id = $4 AND status = $5',
        [nextStatus, experimentId, tenantId, factoryId, 'RUNNING'],
      );
      await this.insertOutbox(client, {
        tenantId, factoryId, userId, aggregateType: 'GROWTH_EXPERIMENT_RESULT',
        aggregateId: insertedRow.id, eventType: 'GROWTH.EXPERIMENT_RESULT_RECORDED',
        correlationId: this.correlationId(requestId, traceId),
        payload: { result_id: insertedRow.id, experiment_id: experimentId, status: nextStatus,
          assessment: dto.assessment, kpi_keys: kpis.map(item => item.metricKey), evidence_ref_count: evidenceRefs.length },
      });
      return { ...insertedRow, kpi_measurements: savedKpis, experiment_status: nextStatus, opportunity_id: experiment.opportunity_id };
    });
    await this.auditSafely({
      tenantId, factoryId, userId, action: 'EXPERIMENT_RESULT', resourceId: result.id, requestId, traceId,
      payload: { experimentId, assessment: dto.assessment, stopConditionTriggered: dto.stop_condition_triggered, kpiKeys: kpis.map(item => item.metricKey) },
    });
    return result;
  }

  async recordForecastEvaluation(
    userId: string, tenantId: string, factoryId: string, opportunityId: string,
    dto: RecordGrowthForecastEvaluationDto, requestId: string | null, traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(opportunityId, 'opportunityId');
    this.validateUuid(dto.outcome_id, 'outcome_id');

    const modelVersion = typeof dto.model_version === 'string' ? dto.model_version.trim() : '';
    const metricKey = typeof dto.metric_key === 'string' ? dto.metric_key.trim() : '';
    const unit = typeof dto.unit === 'string' ? dto.unit.trim() : '';
    const sourceRef = typeof dto.forecast_source_ref === 'string' ? dto.forecast_source_ref.trim() : '';
    const idempotencyKey = typeof dto.idempotency_key === 'string' ? dto.idempotency_key.trim() : '';
    const origin = new Date(dto.forecast_origin_at);
    if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(dto.forecast_origin_at)) {
      throw new BadRequestException('forecast_origin_at must include an explicit time zone offset');
    }
    if (Number.isFinite(origin.getTime()) && origin.getTime() > Date.now()) {
      throw new BadRequestException('forecast_origin_at cannot be in the future');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(modelVersion)) throw new BadRequestException('model_version must be a stable identifier of at most 128 characters');
    if (!/^[a-z][a-z0-9_.-]{0,99}$/.test(metricKey)) throw new BadRequestException('metric_key must be a stable lowercase identifier');
    if (!unit || unit.length > 40) throw new BadRequestException('unit is required and must be <= 40 characters');
    if (!sourceRef || sourceRef.length > 2000) throw new BadRequestException('forecast_source_ref must be non-empty');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)) throw new BadRequestException('idempotency_key is invalid');
    if (!Number.isFinite(origin.getTime())) throw new BadRequestException('forecast_origin_at must be a valid timestamp');
    if (![dto.forecast_value, ...(dto.lower_bound === undefined ? [] : [dto.lower_bound]),
      ...(dto.upper_bound === undefined ? [] : [dto.upper_bound]),
      ...(dto.nominal_coverage_pct === undefined ? [] : [dto.nominal_coverage_pct])].every(Number.isFinite)) {
      throw new BadRequestException('Forecast values must be finite numbers');
    }

    const transactionResult = await this.database.transaction({ tenantId, userId }, async client => {
      const source = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM growth_opportunity_evidence
         WHERE opportunity_id = $1 AND tenant_id = $2 AND factory_id = $3
           AND (btrim(COALESCE(reference_ref, '')) = $4 OR btrim(COALESCE(citation_url, '')) = $4)
           AND captured_at <= $5::timestamptz
         ORDER BY captured_at DESC, id DESC
         LIMIT 1`,
        [opportunityId, tenantId, factoryId, sourceRef, origin.toISOString()],
      );
      if (!source.rows[0]) {
        throw new BadRequestException('forecast_source_ref must match evidence attached to this opportunity no later than forecast_origin_at');
      }

      const actual = await client.query<{
        id: string; measurement_id: string; observed_at: string; actual_value: string; unit: string; evidence_ref: string;
      }>(
        `SELECT o.id::text AS id, k.id::text AS measurement_id, o.observed_at::text AS observed_at,
            k.actual_value::text AS actual_value, k.unit, k.evidence_ref
         FROM growth_opportunity_outcomes o
         JOIN growth_outcome_kpi_measurements k
           ON k.outcome_id = o.id AND k.tenant_id = o.tenant_id
          AND k.factory_id = o.factory_id AND k.opportunity_id = o.opportunity_id
         WHERE o.id = $1 AND o.opportunity_id = $2 AND o.tenant_id = $3 AND o.factory_id = $4
           AND k.metric_key = $5
         FOR SHARE OF o, k`,
        [dto.outcome_id, opportunityId, tenantId, factoryId, metricKey],
      );
      const actualRow = actual.rows[0];
      if (!actualRow) throw new NotFoundException('A matching realized outcome KPI was not found in this opportunity');
      if (actualRow.unit !== unit) throw new ConflictException('Forecast unit must exactly match the realized KPI unit');
      const observedAt = new Date(actualRow.observed_at);
      if (!Number.isFinite(observedAt.getTime()) || origin.getTime() >= observedAt.getTime()) {
        throw new BadRequestException('A forecast origin must be strictly earlier than its observed outcome');
      }

      let metrics: GrowthForecastEvaluationMetrics;
      try {
        metrics = evaluateGrowthForecast({
          forecast_value: dto.forecast_value,
          actual_value: actualRow.actual_value,
          lower_bound: dto.lower_bound ?? null,
          upper_bound: dto.upper_bound ?? null,
          nominal_coverage_pct: dto.nominal_coverage_pct ?? null,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'FORECAST_EVALUATION_INVALID';
        throw new BadRequestException(reason);
      }

      const snapshot = {
        schema_version: 1,
        canonicalization_version: GROWTH_SCENARIO_CANONICALIZATION_VERSION,
        model_version: modelVersion,
        metric_key: metricKey,
        unit,
        forecast_origin_at: origin.toISOString(),
        forecast_source_ref: sourceRef,
        forecast_source_evidence_id: source.rows[0].id,
        outcome_id: actualRow.id,
        outcome_kpi_measurement_id: actualRow.measurement_id,
        actual_evidence_ref: actualRow.evidence_ref,
        outcome_observed_at: observedAt.toISOString(),
        recorded_by: userId,
        ...metrics,
      };
      const requestHash = createHash('sha256')
        .update(canonicalizeGrowthScenarioInput(snapshot))
        .digest('hex');

      const prior = await client.query<{ id: string; request_hash: string }>(
        `SELECT id::text AS id, input_hash AS request_hash FROM growth_forecast_evaluations
         WHERE tenant_id = $1 AND factory_id = $2 AND opportunity_id = $3 AND idempotency_key = $4
         FOR UPDATE`,
        [tenantId, factoryId, opportunityId, idempotencyKey],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash) {
          throw new ConflictException('Forecast evaluation idempotency key was reused with a different request');
        }
        const replay = await client.query(
          `SELECT id::text AS id, model_version, metric_key, unit, forecast_origin_at::text AS forecast_origin_at,
              forecast_source_ref, forecast_source_evidence_id::text AS forecast_source_evidence_id,
           outcome_id::text AS outcome_id, outcome_kpi_measurement_id::text AS outcome_kpi_measurement_id,
           actual_evidence_ref, forecast_value::text AS forecast_value,
              actual_value::text AS actual_value, signed_error::text AS signed_error,
              absolute_error::text AS absolute_error, squared_error::text AS squared_error,
              absolute_percentage_error::text AS absolute_percentage_error,
              symmetric_percentage_error::text AS symmetric_percentage_error,
              lower_bound::text AS lower_bound, upper_bound::text AS upper_bound,
              nominal_coverage_pct::text AS nominal_coverage_pct, interval_hit, interval_width::text AS interval_width,
              interval_semantics, method_version, input_hash, idempotency_key, evaluated_at::text AS evaluated_at
           FROM growth_forecast_evaluations WHERE id = $1 AND tenant_id = $2 AND factory_id = $3`,
          [prior.rows[0].id, tenantId, factoryId],
        );
        if (!replay.rows[0]) throw new ConflictException('The original forecast evaluation is no longer readable in this scope');
        return { evaluation: replay.rows[0], created: false };
      }

      const inserted = await client.query(
        `INSERT INTO growth_forecast_evaluations (
           tenant_id, factory_id, opportunity_id, outcome_id, outcome_kpi_measurement_id, model_version, metric_key, unit,
           forecast_origin_at, forecast_source_ref, forecast_source_evidence_id,
           forecast_value, actual_value, actual_evidence_ref, lower_bound, upper_bound,
           nominal_coverage_pct, signed_error, absolute_error, squared_error, absolute_percentage_error,
           symmetric_percentage_error, interval_hit, interval_width, interval_semantics, method_version,
           input_hash, idempotency_key, recorded_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10, $11, $12::numeric,
           $13::numeric, $14, $15::numeric, $16::numeric, $17::numeric, $18::numeric,
           $19::numeric, $20::numeric, $21, $22, $23::numeric, $24, $25, $26, $27, $28, $29
         ) ON CONFLICT DO NOTHING
         RETURNING id::text AS id, model_version, metric_key, unit, forecast_origin_at::text AS forecast_origin_at,
           forecast_source_ref, forecast_source_evidence_id::text AS forecast_source_evidence_id,
           outcome_id::text AS outcome_id, outcome_kpi_measurement_id::text AS outcome_kpi_measurement_id,
           actual_evidence_ref, forecast_value::text AS forecast_value,
           actual_value::text AS actual_value, signed_error::text AS signed_error,
           absolute_error::text AS absolute_error, squared_error::text AS squared_error,
           absolute_percentage_error::text AS absolute_percentage_error,
           symmetric_percentage_error::text AS symmetric_percentage_error,
           lower_bound::text AS lower_bound, upper_bound::text AS upper_bound,
           nominal_coverage_pct::text AS nominal_coverage_pct, interval_hit, interval_width::text AS interval_width,
           interval_semantics, method_version, input_hash, idempotency_key, evaluated_at::text AS evaluated_at`,
        [
          tenantId, factoryId, opportunityId, actualRow.id, actualRow.measurement_id, modelVersion, metricKey, unit,
          origin.toISOString(), sourceRef, source.rows[0].id, metrics.forecast_value, metrics.actual_value,
          actualRow.evidence_ref, metrics.lower_bound, metrics.upper_bound, metrics.nominal_coverage_pct,
          metrics.signed_error, metrics.absolute_error, metrics.squared_error, metrics.absolute_percentage_error,
          metrics.symmetric_percentage_error, metrics.interval_hit, metrics.interval_width,
          metrics.interval_semantics, metrics.method_version, requestHash, idempotencyKey, userId,
        ],
      );

      if (!inserted.rows[0]) {
        const raced = await client.query<{ id: string; request_hash: string }>(
          `SELECT id::text AS id, input_hash AS request_hash FROM growth_forecast_evaluations
           WHERE tenant_id = $1 AND factory_id = $2 AND opportunity_id = $3 AND idempotency_key = $4`,
          [tenantId, factoryId, opportunityId, idempotencyKey],
        );
        if (raced.rows[0]?.request_hash === requestHash) {
          const replay = await client.query(
            `SELECT id::text AS id, model_version, metric_key, unit, forecast_origin_at::text AS forecast_origin_at,
                forecast_source_ref, forecast_source_evidence_id::text AS forecast_source_evidence_id,
           outcome_id::text AS outcome_id, outcome_kpi_measurement_id::text AS outcome_kpi_measurement_id,
           actual_evidence_ref, forecast_value::text AS forecast_value,
                actual_value::text AS actual_value, signed_error::text AS signed_error,
                absolute_error::text AS absolute_error, squared_error::text AS squared_error,
                absolute_percentage_error::text AS absolute_percentage_error,
                symmetric_percentage_error::text AS symmetric_percentage_error,
                lower_bound::text AS lower_bound, upper_bound::text AS upper_bound,
                nominal_coverage_pct::text AS nominal_coverage_pct, interval_hit, interval_width::text AS interval_width,
                interval_semantics, method_version, input_hash, idempotency_key, evaluated_at::text AS evaluated_at
             FROM growth_forecast_evaluations WHERE id = $1 AND tenant_id = $2 AND factory_id = $3`,
            [raced.rows[0].id, tenantId, factoryId],
          );
          if (replay.rows[0]) return { evaluation: replay.rows[0], created: false };
        }
        throw new ConflictException('A forecast evaluation already exists for this model, metric and outcome');
      }

      await this.insertOutbox(client, {
        tenantId, factoryId, userId, aggregateType: 'GROWTH_FORECAST_EVALUATION',
        aggregateId: inserted.rows[0].id, eventType: 'GROWTH.FORECAST_EVALUATED',
        correlationId: this.correlationId(requestId, traceId),
        payload: {
          forecast_evaluation_id: inserted.rows[0].id, opportunity_id: opportunityId,
          outcome_id: actualRow.id, outcome_kpi_measurement_id: actualRow.measurement_id,
          forecast_source_evidence_id: source.rows[0].id, model_version: modelVersion,
          metric_key: metricKey, method_version: metrics.method_version, input_hash: requestHash,
        },
      });
      return { evaluation: inserted.rows[0], created: true };
    });

    if (transactionResult.created) {
      await this.auditSafely({
        tenantId, factoryId, userId, action: 'GROWTH_FORECAST_EVALUATED',
        resourceId: String(transactionResult.evaluation.id), requestId, traceId,
        payload: {
          opportunityId, outcomeId: dto.outcome_id, modelVersion, metricKey,
          methodVersion: GROWTH_FORECAST_EVALUATION_VERSION,
          inputHash: transactionResult.evaluation.input_hash,
        },
      });
    }
    return { ...transactionResult.evaluation, replayed: !transactionResult.created };
  }

  async getForecastCalibration(tenantId: string, factoryId: string, opportunityId: string) {
    this.validateReadScope(tenantId, factoryId);
    this.validateUuid(opportunityId, 'opportunityId');
    const result = await this.database.query<GrowthForecastCalibrationObservation & {
      evaluated_at: string; total_count: string;
    }>(
      `SELECT model_version, metric_key, unit, forecast_value::text AS forecast_value,
          actual_value::text AS actual_value, signed_error::text AS signed_error,
          absolute_error::text AS absolute_error, squared_error::text AS squared_error,
          symmetric_percentage_error::text AS symmetric_percentage_error, interval_hit,
          nominal_coverage_pct::text AS nominal_coverage_pct,
          evaluated_at::text AS evaluated_at, COUNT(*) OVER ()::text AS total_count
       FROM growth_forecast_evaluations
       WHERE tenant_id = $1 AND factory_id = $2 AND opportunity_id = $3
       ORDER BY evaluated_at DESC, id DESC LIMIT 10000`,
      [tenantId, factoryId, opportunityId],
      { tenantId },
    );
    const totalCount = Number(result.rows[0]?.total_count ?? 0);
    const observations = result.rows.map(({ total_count: _totalCount, evaluated_at: _evaluatedAt, ...row }) => row);
    return {
      method_version: GROWTH_FORECAST_EVALUATION_VERSION,
      minimum_calibration_sample_size: GROWTH_FORECAST_CALIBRATION_MIN_SAMPLE_SIZE,
      observations_included: observations.length,
      total_observations: totalCount,
      sample_window_truncated: totalCount > observations.length,
      interpretation: 'Observed out-of-sample errors and declared interval coverage only. No model is auto-refit; a heuristic range without nominal coverage is not labelled a calibrated prediction interval.',
      calibration: summarizeGrowthForecastCalibration(observations),
    };
  }

  async recordOpportunityOutcome(
    userId: string, tenantId: string, factoryId: string, opportunityId: string,
    dto: RecordGrowthOpportunityOutcomeDto, requestId: string | null, traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(opportunityId, 'opportunityId');
    const observedAt = new Date(dto.observed_at);
    if (!Number.isFinite(observedAt.getTime())) throw new BadRequestException('observed_at must be a valid timestamp');
    if (!Array.isArray(dto.evidence_refs) || !dto.evidence_refs.length) throw new BadRequestException('Realized outcomes require evidence references');
    const evidenceRefs = dto.evidence_refs.map(value => typeof value === 'string' ? value.trim() : '');
    if (evidenceRefs.some(value => !value) || new Set(evidenceRefs).size !== evidenceRefs.length) throw new BadRequestException('Outcome evidence references must be non-empty and unique');
    if (!dto.realized_metrics || typeof dto.realized_metrics !== 'object' || Array.isArray(dto.realized_metrics)) throw new BadRequestException('realized_metrics must be a JSON object');
    if (!Array.isArray(dto.kpi_measurements) || dto.kpi_measurements.length < 1 || dto.kpi_measurements.length > 100) throw new BadRequestException('Realized outcomes require 1–100 explicit KPI measurements');
    const keys = new Set<string>();
    const kpis = dto.kpi_measurements.map(item => {
      const metricKey = typeof item.metric_key === 'string' ? item.metric_key.trim() : '';
      if (!/^[a-z][a-z0-9_.-]{0,99}$/.test(metricKey) || keys.has(metricKey)) throw new BadRequestException('Outcome KPI metric keys must be unique lowercase identifiers');
      keys.add(metricKey);
      const unit = typeof item.unit === 'string' ? item.unit.trim() : '';
      if (!unit || unit.length > 40) throw new BadRequestException('Every realized KPI requires a unit');
      if (!['INCREASE', 'DECREASE', 'TARGET'].includes(item.direction)) throw new BadRequestException('Invalid KPI direction');
      const evidenceRef = typeof item.evidence_ref === 'string' ? item.evidence_ref.trim() : '';
      if (!evidenceRef || !evidenceRefs.includes(evidenceRef)) throw new BadRequestException('Each KPI evidence_ref must be included in outcome evidence_refs');
      const baselineValue = item.baseline_value, actualValue = item.actual_value, targetValue = item.target_value ?? null;
      if (![baselineValue, actualValue, ...(targetValue === null ? [] : [targetValue])].every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e12)) {
        throw new BadRequestException('KPI baseline, actual and target values must be finite and within supported numeric bounds');
      }
      if (typeof dto.realized_metrics[metricKey] !== 'number' || !Number.isFinite(dto.realized_metrics[metricKey] as number)
        || dto.realized_metrics[metricKey] !== actualValue) throw new BadRequestException('Each KPI actual_value must match realized_metrics at the same metric_key');
      return { metricKey, unit, direction: item.direction, baselineValue, actualValue, targetValue, evidenceRef };
    });

    const outcome = await this.database.transaction({ tenantId, userId }, async client => {
      const opportunity = await client.query<{ id: string; status: string }>(
        'SELECT id::text AS id, status FROM growth_opportunities WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 FOR UPDATE',
        [opportunityId, tenantId, factoryId],
      );
      const op = opportunity.rows[0];
      if (!op) throw new NotFoundException('Growth opportunity not found');
      if (!['ACCEPTED', 'IN_PROGRESS', 'REALIZED'].includes(op.status)) throw new ConflictException('Outcomes require an accepted or in-progress opportunity');
      const sourceKpis = new Map<string, Record<string, unknown>>();
      if (dto.experiment_result_id) {
        const sourceResult = await client.query<{ id: string }>(
          `SELECT r.id::text AS id FROM growth_experiment_results r
           JOIN growth_experiments e ON e.id = r.experiment_id AND e.tenant_id = r.tenant_id AND e.factory_id = r.factory_id
           WHERE r.id = $1 AND e.opportunity_id = $2 AND r.tenant_id = $3 AND r.factory_id = $4`,
          [dto.experiment_result_id, opportunityId, tenantId, factoryId],
        );
        if (!sourceResult.rows[0]) throw new BadRequestException('Experiment result must belong to this opportunity');
        const existing = await client.query<{ id: string }>(
          'SELECT id::text AS id FROM growth_opportunity_outcomes WHERE experiment_result_id = $1 AND tenant_id = $2 AND factory_id = $3 LIMIT 1',
          [dto.experiment_result_id, tenantId, factoryId],
        );
        if (existing.rows[0]) throw new ConflictException('An experiment result can only be linked to one realized growth outcome');
        const sourceRows = await client.query<{ id: string; metric_key: string; unit: string; direction: string; baseline_value: string; target_value: string | null }>(
          `SELECT id::text AS id, metric_key, unit, direction, baseline_value::text AS baseline_value, target_value::text AS target_value
           FROM growth_experiment_result_kpis
           WHERE experiment_result_id = $1 AND tenant_id = $2 AND factory_id = $3 AND opportunity_id = $4
           ORDER BY metric_key`,
          [dto.experiment_result_id, tenantId, factoryId, opportunityId],
        );
        if (!sourceRows.rows.length) throw new ConflictException('The experiment result has no normalized KPI measurements to link');
        if (sourceRows.rows.length !== kpis.length) throw new BadRequestException('A realized outcome linked to an experiment must carry every KPI from that result');
        for (const sourceKpi of sourceRows.rows) {
          const input = kpis.find(item => item.metricKey === sourceKpi.metric_key);
          if (!input || input.unit !== sourceKpi.unit || input.direction !== sourceKpi.direction
            || input.baselineValue !== Number(sourceKpi.baseline_value)
            || input.targetValue !== (sourceKpi.target_value === null ? null : Number(sourceKpi.target_value))) {
            throw new BadRequestException('Outcome KPI key, unit, baseline, target and direction must match its linked experiment result');
          }
          sourceKpis.set(sourceKpi.metric_key, sourceKpi);
        }
      }

      const inserted = await client.query(
        `INSERT INTO growth_opportunity_outcomes (
          tenant_id, factory_id, opportunity_id, experiment_result_id, assessment,
          realized_metrics, evidence_refs, notes, observed_at, recorded_by
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::timestamptz, $10)
        RETURNING id::text AS id, opportunity_id::text AS opportunity_id,
          experiment_result_id::text AS experiment_result_id, assessment, realized_metrics,
          evidence_refs, notes, observed_at::text AS observed_at, created_at::text AS created_at`,
        [tenantId, factoryId, opportunityId, dto.experiment_result_id ?? null, dto.assessment,
          JSON.stringify(dto.realized_metrics), JSON.stringify(evidenceRefs), dto.notes?.trim() || null, observedAt.toISOString(), userId],
      );
      const result = inserted.rows[0];
      if (!result) throw new Error('GROWTH_OPPORTUNITY_OUTCOME_INSERT_FAILED');
      const savedKpis: Array<Record<string, unknown>> = [];
      for (const kpi of kpis) {
        const sourceKpi = sourceKpis.get(kpi.metricKey);
        const saved = await client.query(
          `INSERT INTO growth_outcome_kpi_measurements (
            tenant_id, factory_id, opportunity_id, outcome_id, source_experiment_kpi_id,
            metric_key, baseline_value, actual_value, target_value, unit, direction, evidence_ref, recorded_by
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          RETURNING id::text AS id, metric_key, baseline_value::text AS baseline_value,
            actual_value::text AS actual_value, target_value::text AS target_value,
            unit, direction, evidence_ref, source_experiment_kpi_id::text AS source_experiment_kpi_id,
            created_at::text AS created_at`,
          [tenantId, factoryId, opportunityId, result.id, sourceKpi?.id ?? null, kpi.metricKey,
            kpi.baselineValue, kpi.actualValue, kpi.targetValue, kpi.unit, kpi.direction, kpi.evidenceRef, userId],
        );
        if (!saved.rows[0]) throw new Error('GROWTH_OUTCOME_KPI_INSERT_FAILED');
        savedKpis.push(saved.rows[0]);
      }
      if (op.status === 'ACCEPTED') await client.query(
        'UPDATE growth_opportunities SET status = $1, updated_at = clock_timestamp() WHERE id = $2 AND tenant_id = $3 AND factory_id = $4 AND status = $5',
        ['IN_PROGRESS', opportunityId, tenantId, factoryId, 'ACCEPTED'],
      );
      if (op.status !== 'REALIZED') await client.query(
        'UPDATE growth_opportunities SET status = $1, updated_at = clock_timestamp() WHERE id = $2 AND tenant_id = $3 AND factory_id = $4 AND status = $5',
        ['REALIZED', opportunityId, tenantId, factoryId, 'IN_PROGRESS'],
      );
      const signal = await client.query<{ id: string }>(
        `INSERT INTO ai_learning_signals (
          tenant_id, factory_id, source_decision_id, source_outcome_id, source_execution_id,
          source_growth_outcome_id, signal_type, label, confidence, tenant_scope, payload, created_by
        ) VALUES ($1, $2, NULL, NULL, NULL, $3, 'GROWTH_OUTCOME_ASSESSMENT', $4, $5, 'FACTORY', $6::jsonb, $7)
        RETURNING id::text AS id`,
        [tenantId, factoryId, result.id, 'Growth outcome recorded: ' + dto.assessment, dto.confidence ?? 0.5,
          JSON.stringify({ source: 'GROWTH_OUTCOME', opportunityId, experimentResultId: dto.experiment_result_id ?? null,
            assessment: dto.assessment, realizedMetrics: dto.realized_metrics, kpiMeasurements: savedKpis,
            evidenceRefs, observedAt: observedAt.toISOString(),
            confidenceMeaning: 'Confidence recorded by the outcome submitter; not a calibrated probability of causal effect.' }), userId],
      );
      const learningSignal = signal.rows[0];
      if (!learningSignal) throw new Error('GROWTH_OUTCOME_LEARNING_SIGNAL_INSERT_FAILED');
      await this.insertOutbox(client, {
        tenantId, factoryId, userId, aggregateType: 'GROWTH_OUTCOME', aggregateId: result.id,
        eventType: 'GROWTH.OPPORTUNITY_OUTCOME_RECORDED', correlationId: this.correlationId(requestId, traceId),
        payload: { outcome_id: result.id, opportunity_id: opportunityId, assessment: dto.assessment,
          learning_signal_id: learningSignal.id, kpi_count: savedKpis.length, experiment_result_id: dto.experiment_result_id ?? null },
      });
      await this.insertOutbox(client, {
        tenantId, factoryId, userId, aggregateType: 'AI_LEARNING_SIGNAL', aggregateId: learningSignal.id,
        eventType: 'AI.LEARNING_SIGNAL_RECORDED', correlationId: this.correlationId(requestId, traceId),
        payload: { signal_id: learningSignal.id, source_growth_outcome_id: result.id,
          tenant_scope: 'FACTORY', signal_type: 'GROWTH_OUTCOME_ASSESSMENT' },
      });
      return { ...result, kpi_measurements: savedKpis, learning_signal_id: learningSignal.id };
    });
    await this.auditSafely({
      tenantId, factoryId, userId, action: 'OPPORTUNITY_OUTCOME', resourceId: outcome.id, requestId, traceId,
      payload: { opportunityId, assessment: dto.assessment, experimentResultId: dto.experiment_result_id ?? null, kpiKeys: kpis.map(item => item.metricKey) },
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
    evidenceReferences: Set<string> = new Set<string>(),
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
      return Boolean(sourceRef) && evidenceReferences.has(sourceRef!) && Number.isFinite(time) && time <= Date.now() + 5 * 60 * 1000;
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

    const projectedValues = projected as Record<string, unknown>;
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

    const maxUtilizationValue = maxUtilization as number;
    const minYieldValue = minYield as number;
    const minCashValue = minCash as number;
    const maxBacklogValue = maxBacklog as number;

    const capacityActual = numeric(projectedValues, 'capacity_utilization_pct')!;
    const qualityActual = numeric(projectedValues, 'quality_yield_pct')!;
    const cashActual = numeric(projectedValues, 'cash_after_investment')!;
    const cashCurrency = text(projectedValues, 'cash_currency')!.toUpperCase();
    const backlogActual = numeric(projectedValues, 'delivery_backlog_days')!;
    const expectedCurrency = text(cash, 'currency')!.toUpperCase();

    checks.push({
      dimension: 'capacity',
      passed: capacityActual <= maxUtilizationValue,
      projected: capacityActual,
      maximumAllowed: maxUtilizationValue,
      sourceRef: text(capacity, 'source_ref'),
      asOf: text(capacity, 'as_of'),
    });
    checks.push({
      dimension: 'quality',
      passed: qualityActual >= minYieldValue,
      projected: qualityActual,
      minimumAllowed: minYieldValue,
      sourceRef: text(quality, 'source_ref'),
      asOf: text(quality, 'as_of'),
    });
    checks.push({
      dimension: 'cash',
      passed: cashActual >= minCashValue && cashCurrency === expectedCurrency,
      projected: cashActual,
      minimumReserve: minCashValue,
      currency: cashCurrency,
      expectedCurrency,
      sourceRef: text(cash, 'source_ref'),
      asOf: text(cash, 'as_of'),
    });
    checks.push({
      dimension: 'delivery',
      passed: backlogActual <= maxBacklogValue,
      projected: backlogActual,
      maximumAllowed: maxBacklogValue,
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


  async getOpportunityGovernance(tenantId: string, factoryId: string, opportunityId: string) {
    this.validateReadScope(tenantId, factoryId);
    this.validateUuid(opportunityId, 'opportunityId');
    const scoped = await this.database.query<{ id: string; created_by: string }>(
      'SELECT id::text AS id, created_by::text AS created_by FROM growth_opportunities WHERE id = $1 AND tenant_id = $2 AND factory_id = $3',
      [opportunityId, tenantId, factoryId],
      { tenantId },
    );
    if (!scoped.rows[0]) throw new NotFoundException('Growth opportunity not found');

    const [assumptions, constraints, evidenceGaps, owners, evidence] = await Promise.all([
      this.database.query(
        `SELECT a.id::text AS id, a.statement, a.rationale, a.risk_if_false,
                a.confidence_pct::text AS confidence_pct, a.validation_method,
                a.initial_evidence_refs, a.owner_user_id::text AS owner_user_id,
                a.blocks_decision, a.created_by::text AS created_by, a.created_at::text AS created_at,
                last_decision.decision AS latest_decision,
                COALESCE(last_decision.evidence_refs, '[]'::jsonb) AS evidence_refs,
                last_decision.reason AS decision_reason,
                last_decision.decided_by::text AS decision_owner_user_id,
                last_decision.decided_at::text AS decided_at
           FROM growth_opportunity_assumptions a
           LEFT JOIN LATERAL (
             SELECT d.decision, d.evidence_refs, d.reason, d.decided_by, d.decided_at
               FROM growth_opportunity_assumption_decisions d
              WHERE d.assumption_id = a.id AND d.tenant_id = a.tenant_id
                AND d.factory_id = a.factory_id AND d.opportunity_id = a.opportunity_id
              ORDER BY d.decided_at DESC, d.id DESC LIMIT 1
           ) last_decision ON TRUE
          WHERE a.opportunity_id = $1 AND a.tenant_id = $2 AND a.factory_id = $3
          ORDER BY a.created_at, a.id`,
        [opportunityId, tenantId, factoryId],
        { tenantId },
      ),
      this.database.query(
        `SELECT DISTINCT ON (c.dimension)
                c.id::text AS id, c.dimension, c.applicability, c.constraint_name,
                c.limit_operator, c.threshold_value::text AS threshold_value,
                c.observed_value::text AS observed_value, c.unit, c.source_evidence_ref,
                c.source_as_of::text AS source_as_of, c.rationale,
                c.owner_user_id::text AS owner_user_id, c.created_by::text AS created_by,
                c.created_at::text AS created_at
           FROM growth_opportunity_constraints c
          WHERE c.opportunity_id = $1 AND c.tenant_id = $2 AND c.factory_id = $3
          ORDER BY c.dimension, c.created_at DESC, c.id DESC`,
        [opportunityId, tenantId, factoryId],
        { tenantId },
      ),
      this.database.query(
        `SELECT g.id::text AS id, g.question, g.required_evidence, g.impact,
                g.owner_user_id::text AS owner_user_id, g.due_at::text AS due_at,
                g.blocks_decision, g.created_by::text AS created_by, g.created_at::text AS created_at,
                COALESCE(last_event.decision, 'OPEN') AS latest_decision,
                COALESCE(last_event.evidence_refs, '[]'::jsonb) AS evidence_refs,
                last_event.reason AS decision_reason,
                last_event.actor_user_id::text AS last_actor_user_id,
                last_event.created_at::text AS last_decision_at
           FROM growth_opportunity_evidence_gaps g
           LEFT JOIN LATERAL (
             SELECT e.decision, e.evidence_refs, e.reason, e.actor_user_id, e.created_at
               FROM growth_opportunity_evidence_gap_events e
              WHERE e.evidence_gap_id = g.id AND e.tenant_id = g.tenant_id
                AND e.factory_id = g.factory_id AND e.opportunity_id = g.opportunity_id
              ORDER BY e.created_at DESC, e.id DESC LIMIT 1
           ) last_event ON TRUE
          WHERE g.opportunity_id = $1 AND g.tenant_id = $2 AND g.factory_id = $3
          ORDER BY CASE WHEN COALESCE(last_event.decision, 'OPEN') IN ('RESOLVED','WAIVED') THEN 1 ELSE 0 END,
                   CASE g.impact WHEN 'CRITICAL' THEN 4 WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 ELSE 1 END DESC,
                   g.created_at`,
        [opportunityId, tenantId, factoryId],
        { tenantId },
      ),
      this.database.query(
        `SELECT own.id::text AS id, own.role_code, own.owner_user_id::text AS owner_user_id,
                own.rationale, own.assigned_by::text AS assigned_by, own.assigned_at::text AS assigned_at,
                own.active_to::text AS active_to,
                (u.status = 'ACTIVE' AND EXISTS (
                  SELECT 1 FROM tenant_memberships tm
                   WHERE tm.user_id = own.owner_user_id AND tm.tenant_id = own.tenant_id
                     AND tm.status = 'ACTIVE'
                )) AS owner_active
           FROM growth_opportunity_decision_owners own
           JOIN users u ON u.id = own.owner_user_id
          WHERE own.opportunity_id = $1 AND own.tenant_id = $2 AND own.factory_id = $3
          ORDER BY CASE WHEN own.active_to IS NULL THEN 0 ELSE 1 END, own.assigned_at DESC, own.id DESC`,
        [opportunityId, tenantId, factoryId],
        { tenantId },
      ),
      this.database.query<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM growth_opportunity_evidence WHERE opportunity_id = $1 AND tenant_id = $2 AND factory_id = $3',
        [opportunityId, tenantId, factoryId],
        { tenantId },
      ),
    ]);

    const constraintRows = constraints.rows as Array<{
      id: string; dimension: string; applicability: string; limit_operator: string | null;
      threshold_value: string | null; observed_value: string | null; unit: string | null;
      source_evidence_ref: string | null; rationale: string;
    }>;
    const assumptionRows = assumptions.rows as Array<{
      id: string; statement: string; blocks_decision: boolean; latest_decision: string | null; evidence_refs: unknown;
    }>;
    const gapRows = evidenceGaps.rows as Array<{
      id: string; question: string; impact: string; blocks_decision: boolean;
      latest_decision: string | null; evidence_refs: unknown;
    }>;
    const ownerRows = owners.rows as Array<{ role_code: string; owner_user_id: string; active_to: string | null; owner_active: boolean }>;
    const readiness = evaluateGrowthGovernanceReadiness({
      evidence_count: evidence.rows[0]?.count ?? 0,
      decision_owner_assigned: ownerRows.some(owner => owner.role_code === 'DECISION_OWNER' && owner.active_to === null
        && owner.owner_active && owner.owner_user_id !== scoped.rows[0]?.created_by),
      assumptions: assumptionRows,
      constraints: constraintRows,
      evidence_gaps: gapRows,
    });
    return {
      opportunity_id: opportunityId,
      assumptions: assumptions.rows,
      constraints: constraintRows,
      evidence_gaps: evidenceGaps.rows,
      decision_owners: owners.rows,
      readiness,
      interpretation: 'Deterministic completeness checklist. READY is not an approval, forecast, or causal conclusion.',
    };
  }

  async addOpportunityAssumption(
    userId: string, tenantId: string, factoryId: string, opportunityId: string,
    dto: CreateGrowthAssumptionDto, requestId: string | null, traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(opportunityId, 'opportunityId');
    const refs = dto.evidence_refs ?? [];
    return this.database.transaction({ tenantId, userId }, async client => {
      const opportunity = await client.query<{ status: string }>(
        'SELECT status FROM growth_opportunities WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 FOR UPDATE',
        [opportunityId, tenantId, factoryId],
      );
      if (!opportunity.rows[0]) throw new NotFoundException('Growth opportunity not found');
      if (!['PROPOSED', 'ACCEPTED', 'IN_PROGRESS'].includes(opportunity.rows[0].status)) {
        throw new ConflictException('Assumptions can only be added while an opportunity is open');
      }
      const ownerUserId = dto.owner_user_id ?? userId;
      await this.assertActiveTenantUser(client, tenantId, ownerUserId);
      await this.assertOpportunityEvidenceRefs(client, tenantId, factoryId, opportunityId, refs);
      const inserted = await client.query(
        `INSERT INTO growth_opportunity_assumptions
           (tenant_id, factory_id, opportunity_id, statement, rationale, risk_if_false,
            confidence_pct, validation_method, initial_evidence_refs, owner_user_id,
            blocks_decision, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)
         RETURNING id::text AS id, statement, risk_if_false, confidence_pct::text AS confidence_pct,
                   owner_user_id::text AS owner_user_id, blocks_decision, created_at::text AS created_at`,
        [tenantId, factoryId, opportunityId, dto.statement.trim(), dto.rationale?.trim() ?? '',
          dto.risk_if_false, dto.confidence_pct, dto.validation_method.trim(), JSON.stringify(refs),
          ownerUserId, dto.blocks_decision ?? true, userId],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('GROWTH_ASSUMPTION_INSERT_FAILED');
      await this.insertOutbox(client, {
        tenantId, factoryId, userId, aggregateType: 'GROWTH_OPPORTUNITY',
        aggregateId: opportunityId, eventType: 'GROWTH.OPPORTUNITY_ASSUMPTION_ADDED',
        correlationId: this.correlationId(requestId, traceId),
        payload: { opportunity_id: opportunityId, assumption_id: row.id, blocks_decision: dto.blocks_decision ?? true },
      });
      await this.auditSafely({
        tenantId, factoryId, userId, action: 'GROWTH_ASSUMPTION_ADD',
        resourceId: String(row.id), requestId, traceId, payload: { opportunityId, risk: dto.risk_if_false },
      });
      return row;
    });
  }

  async decideOpportunityAssumption(
    userId: string, tenantId: string, factoryId: string, opportunityId: string, assumptionId: string,
    dto: DecideGrowthAssumptionDto, requestId: string | null, traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(opportunityId, 'opportunityId');
    this.validateUuid(assumptionId, 'assumptionId');
    const refs = dto.evidence_refs ?? [];
    if (['VALIDATED', 'REFUTED', 'WAIVED'].includes(dto.decision) && refs.length === 0) {
      throw new BadRequestException('VALIDATED, REFUTED and WAIVED assumption decisions require evidence references');
    }
    return this.database.transaction({ tenantId, userId }, async client => {
      const opportunity = await client.query<{ status: string }>(
        'SELECT status FROM growth_opportunities WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 FOR SHARE',
        [opportunityId, tenantId, factoryId],
      );
      if (!opportunity.rows[0]) throw new NotFoundException('Growth opportunity not found');
      if (!['PROPOSED', 'ACCEPTED', 'IN_PROGRESS'].includes(opportunity.rows[0].status)) {
        throw new ConflictException('Assumptions can only be reviewed while the opportunity is open');
      }
      const assumption = await client.query<{ id: string }>(
        'SELECT id::text AS id FROM growth_opportunity_assumptions WHERE id = $1 AND opportunity_id = $2 AND tenant_id = $3 AND factory_id = $4',
        [assumptionId, opportunityId, tenantId, factoryId],
      );
      if (!assumption.rows[0]) throw new NotFoundException('Growth assumption not found in this opportunity');
      await this.assertOpportunityEvidenceRefs(client, tenantId, factoryId, opportunityId, refs);
      const inserted = await client.query(
        `INSERT INTO growth_opportunity_assumption_decisions
           (tenant_id, factory_id, opportunity_id, assumption_id, decision, reason, evidence_refs,
            decided_by, request_id, trace_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::uuid,$10::uuid)
         RETURNING id::text AS id, assumption_id::text AS assumption_id, decision, reason,
                   evidence_refs, decided_by::text AS decided_by, decided_at::text AS decided_at`,
        [tenantId, factoryId, opportunityId, assumptionId, dto.decision, dto.reason.trim(),
          JSON.stringify(refs), userId, this.uuidOrNull(requestId), this.uuidOrNull(traceId)],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('GROWTH_ASSUMPTION_DECISION_INSERT_FAILED');
      await this.insertOutbox(client, {
        tenantId, factoryId, userId, aggregateType: 'GROWTH_OPPORTUNITY',
        aggregateId: opportunityId, eventType: 'GROWTH.OPPORTUNITY_ASSUMPTION_DECIDED',
        correlationId: this.correlationId(requestId, traceId),
        payload: { opportunity_id: opportunityId, assumption_id: assumptionId, decision: dto.decision },
      });
      await this.auditSafely({
        tenantId, factoryId, userId, action: 'GROWTH_ASSUMPTION_DECIDE',
        resourceId: assumptionId, requestId, traceId,
        payload: { opportunityId, decision: dto.decision, evidenceCount: refs.length },
      });
      return row;
    });
  }

  async addOpportunityConstraint(
    userId: string, tenantId: string, factoryId: string, opportunityId: string,
    dto: CreateGrowthConstraintDto, requestId: string | null, traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(opportunityId, 'opportunityId');
    if (dto.applicability === 'APPLICABLE') {
      if (dto.limit_operator === undefined || dto.threshold_value === undefined
        || dto.observed_value === undefined || !dto.unit?.trim()
        || !dto.source_evidence_ref?.trim() || !dto.source_as_of) {
        throw new BadRequestException('Applicable constraints require a limit, observed value, unit, evidence reference and source vintage');
      }
      const date = new Date(dto.source_as_of);
      if (!Number.isFinite(date.getTime()) || date.getTime() > Date.now() + 5 * 60 * 1000) {
        throw new BadRequestException('source_as_of must be a valid non-future timestamp');
      }
    }
    if (dto.applicability === 'NOT_APPLICABLE' && dto.rationale.trim().length < 10) {
      throw new BadRequestException('Not-applicable constraints require a reasoned explanation of at least 10 characters');
    }
    return this.database.transaction({ tenantId, userId }, async client => {
      const opportunity = await client.query<{ status: string }>(
        'SELECT status FROM growth_opportunities WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 FOR UPDATE',
        [opportunityId, tenantId, factoryId],
      );
      if (!opportunity.rows[0]) throw new NotFoundException('Growth opportunity not found');
      if (!['PROPOSED', 'ACCEPTED', 'IN_PROGRESS'].includes(opportunity.rows[0].status)) {
        throw new ConflictException('Constraints can only be recorded while an opportunity is open');
      }
      const ownerUserId = dto.owner_user_id ?? userId;
      await this.assertActiveTenantUser(client, tenantId, ownerUserId);
      if (dto.applicability === 'APPLICABLE') {
        await this.assertOpportunityEvidenceRefs(client, tenantId, factoryId, opportunityId, [dto.source_evidence_ref!]);
      }
      const inserted = await client.query(
        `INSERT INTO growth_opportunity_constraints
           (tenant_id, factory_id, opportunity_id, dimension, applicability, constraint_name,
            limit_operator, threshold_value, observed_value, unit, source_evidence_ref, source_as_of,
            rationale, owner_user_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13,$14,$15)
         RETURNING id::text AS id, dimension, applicability, constraint_name, limit_operator,
                   threshold_value::text AS threshold_value, observed_value::text AS observed_value,
                   unit, source_evidence_ref, source_as_of::text AS source_as_of, rationale,
                   owner_user_id::text AS owner_user_id, created_at::text AS created_at`,
        [tenantId, factoryId, opportunityId, dto.dimension, dto.applicability, dto.constraint_name.trim(),
          dto.limit_operator ?? null, dto.threshold_value ?? null, dto.observed_value ?? null,
          dto.unit?.trim() ?? null, dto.source_evidence_ref?.trim() ?? null, dto.source_as_of ?? null,
          dto.rationale.trim(), ownerUserId, userId],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('GROWTH_CONSTRAINT_INSERT_FAILED');
      await this.insertOutbox(client, {
        tenantId, factoryId, userId, aggregateType: 'GROWTH_OPPORTUNITY',
        aggregateId: opportunityId, eventType: 'GROWTH.OPPORTUNITY_CONSTRAINT_RECORDED',
        correlationId: this.correlationId(requestId, traceId),
        payload: { opportunity_id: opportunityId, constraint_id: row.id, dimension: dto.dimension, applicability: dto.applicability },
      });
      await this.auditSafely({
        tenantId, factoryId, userId, action: 'GROWTH_CONSTRAINT_RECORD',
        resourceId: String(row.id), requestId, traceId,
        payload: { opportunityId, dimension: dto.dimension, applicability: dto.applicability },
      });
      return row;
    });
  }

  async addOpportunityEvidenceGap(
    userId: string, tenantId: string, factoryId: string, opportunityId: string,
    dto: CreateGrowthEvidenceGapDto, requestId: string | null, traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(opportunityId, 'opportunityId');
    if (dto.due_at && !Number.isFinite(new Date(dto.due_at).getTime())) {
      throw new BadRequestException('due_at must be a valid timestamp');
    }
    return this.database.transaction({ tenantId, userId }, async client => {
      const opportunity = await client.query<{ status: string }>(
        'SELECT status FROM growth_opportunities WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 FOR UPDATE',
        [opportunityId, tenantId, factoryId],
      );
      if (!opportunity.rows[0]) throw new NotFoundException('Growth opportunity not found');
      if (!['PROPOSED', 'ACCEPTED', 'IN_PROGRESS'].includes(opportunity.rows[0].status)) {
        throw new ConflictException('Evidence gaps can only be added while an opportunity is open');
      }
      const ownerUserId = dto.owner_user_id ?? userId;
      await this.assertActiveTenantUser(client, tenantId, ownerUserId);
      const inserted = await client.query(
        `INSERT INTO growth_opportunity_evidence_gaps
           (tenant_id, factory_id, opportunity_id, question, required_evidence, impact,
            owner_user_id, due_at, blocks_decision, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9,$10)
         RETURNING id::text AS id, question, required_evidence, impact,
                   owner_user_id::text AS owner_user_id, due_at::text AS due_at,
                   blocks_decision, created_at::text AS created_at`,
        [tenantId, factoryId, opportunityId, dto.question.trim(), dto.required_evidence.trim(),
          dto.impact, ownerUserId, dto.due_at ?? null, dto.blocks_decision ?? true, userId],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('GROWTH_EVIDENCE_GAP_INSERT_FAILED');
      await this.insertOutbox(client, {
        tenantId, factoryId, userId, aggregateType: 'GROWTH_OPPORTUNITY',
        aggregateId: opportunityId, eventType: 'GROWTH.OPPORTUNITY_EVIDENCE_GAP_ADDED',
        correlationId: this.correlationId(requestId, traceId),
        payload: { opportunity_id: opportunityId, evidence_gap_id: row.id, impact: dto.impact, blocks_decision: dto.blocks_decision ?? true },
      });
      await this.auditSafely({
        tenantId, factoryId, userId, action: 'GROWTH_EVIDENCE_GAP_ADD',
        resourceId: String(row.id), requestId, traceId, payload: { opportunityId, impact: dto.impact },
      });
      return row;
    });
  }

  async decideOpportunityEvidenceGap(
    userId: string, tenantId: string, factoryId: string, opportunityId: string, gapId: string,
    dto: DecideGrowthEvidenceGapDto, requestId: string | null, traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(opportunityId, 'opportunityId');
    this.validateUuid(gapId, 'gapId');
    const refs = dto.evidence_refs ?? [];
    if (dto.decision === 'RESOLVED' && refs.length === 0) {
      throw new BadRequestException('Resolving an evidence gap requires evidence references');
    }
    return this.database.transaction({ tenantId, userId }, async client => {
      const gap = await client.query<{ id: string }>(
        'SELECT id::text AS id FROM growth_opportunity_evidence_gaps WHERE id = $1 AND opportunity_id = $2 AND tenant_id = $3 AND factory_id = $4',
        [gapId, opportunityId, tenantId, factoryId],
      );
      if (!gap.rows[0]) throw new NotFoundException('Evidence gap not found in this opportunity');
      if (dto.decision === 'RESOLVED') {
        await this.assertOpportunityEvidenceRefs(client, tenantId, factoryId, opportunityId, refs);
      }
      const inserted = await client.query(
        `INSERT INTO growth_opportunity_evidence_gap_events
           (tenant_id, factory_id, opportunity_id, evidence_gap_id, decision, reason,
            evidence_refs, actor_user_id, request_id, trace_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::uuid,$10::uuid)
         RETURNING id::text AS id, evidence_gap_id::text AS evidence_gap_id, decision, reason,
                   evidence_refs, actor_user_id::text AS actor_user_id, created_at::text AS created_at`,
        [tenantId, factoryId, opportunityId, gapId, dto.decision, dto.reason.trim(),
          JSON.stringify(refs), userId, this.uuidOrNull(requestId), this.uuidOrNull(traceId)],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('GROWTH_EVIDENCE_GAP_EVENT_INSERT_FAILED');
      await this.insertOutbox(client, {
        tenantId, factoryId, userId, aggregateType: 'GROWTH_OPPORTUNITY',
        aggregateId: opportunityId, eventType: 'GROWTH.OPPORTUNITY_EVIDENCE_GAP_' + dto.decision,
        correlationId: this.correlationId(requestId, traceId),
        payload: { opportunity_id: opportunityId, evidence_gap_id: gapId, decision: dto.decision },
      });
      await this.auditSafely({
        tenantId, factoryId, userId, action: 'GROWTH_EVIDENCE_GAP_' + dto.decision,
        resourceId: gapId, requestId, traceId, payload: { opportunityId, evidenceCount: refs.length },
      });
      return row;
    });
  }

  async assignOpportunityDecisionOwner(
    userId: string, tenantId: string, factoryId: string, opportunityId: string,
    dto: AssignGrowthDecisionOwnerDto, requestId: string | null, traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(opportunityId, 'opportunityId');
    return this.database.transaction({ tenantId, userId }, async client => {
      const opportunity = await client.query<{ created_by: string; status: string }>(
        'SELECT created_by::text AS created_by, status FROM growth_opportunities WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 FOR UPDATE',
        [opportunityId, tenantId, factoryId],
      );
      if (!opportunity.rows[0]) throw new NotFoundException('Growth opportunity not found');
      if (['REJECTED', 'REALIZED', 'CLOSED'].includes(opportunity.rows[0].status)) {
        throw new ConflictException('Decision ownership cannot be reassigned after the opportunity is closed');
      }
      await this.assertActiveTenantUser(client, tenantId, dto.owner_user_id);
      if (dto.role_code === 'DECISION_OWNER' && dto.owner_user_id === opportunity.rows[0].created_by) {
        throw new BadRequestException('The decision owner must be different from the opportunity creator');
      }
      await client.query(
        `UPDATE growth_opportunity_decision_owners SET active_to = clock_timestamp()
          WHERE opportunity_id = $1 AND tenant_id = $2 AND factory_id = $3
            AND role_code = $4 AND active_to IS NULL`,
        [opportunityId, tenantId, factoryId, dto.role_code],
      );
      const inserted = await client.query(
        `INSERT INTO growth_opportunity_decision_owners
           (tenant_id, factory_id, opportunity_id, role_code, owner_user_id, rationale, assigned_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id::text AS id, role_code, owner_user_id::text AS owner_user_id,
                   rationale, assigned_by::text AS assigned_by, assigned_at::text AS assigned_at`,
        [tenantId, factoryId, opportunityId, dto.role_code, dto.owner_user_id, dto.rationale.trim(), userId],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('GROWTH_DECISION_OWNER_ASSIGNMENT_FAILED');
      await this.insertOutbox(client, {
        tenantId, factoryId, userId, aggregateType: 'GROWTH_OPPORTUNITY',
        aggregateId: opportunityId, eventType: 'GROWTH.OPPORTUNITY_OWNER_ASSIGNED',
        correlationId: this.correlationId(requestId, traceId),
        payload: { opportunity_id: opportunityId, role_code: dto.role_code, owner_user_id: dto.owner_user_id },
      });
      await this.auditSafely({
        tenantId, factoryId, userId, action: 'GROWTH_OPPORTUNITY_OWNER_ASSIGN',
        resourceId: String(row.id), requestId, traceId, payload: { opportunityId, role: dto.role_code, ownerId: dto.owner_user_id },
      });
      return row;
    });
  }

  private async assertOpportunityEvidenceRefs(
    client: PoolClient, tenantId: string, factoryId: string, opportunityId: string, refs: string[],
  ) {
    for (const ref of refs) {
      if (typeof ref !== 'string' || !ref.trim()) throw new BadRequestException('Evidence references cannot be blank');
      const found = await client.query<{ exists: boolean }>(
        'SELECT factoryos_growth_opportunity_evidence_ref_exists($1, $2, $3, $4) AS exists',
        [tenantId, factoryId, opportunityId, ref.trim()],
      );
      if (found.rows[0]?.exists !== true) {
        throw new BadRequestException('Evidence reference is not attached to this opportunity: ' + ref);
      }
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

  private uuidOrNull(value: string | null): string | null {
    return value && isUUID(value) ? value : null;
  }

  private correlationId(requestId: string | null, traceId: string | null) {
    if (traceId && isUUID(traceId)) return traceId;
    if (requestId && isUUID(requestId)) return requestId;
    return randomUUID();
  }
}
