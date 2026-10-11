import { randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';
import { Pool, type PoolClient } from 'pg';

import { GrowthOpportunityService } from './growth-opportunity.service';

interface ScopeRow {
  tenant_id: string;
  factory_id: string;
  user_id: string;
}

describe('GrowthOpportunityService PostgreSQL integration', () => {
  let pool!: Pool;
  let client!: PoolClient;
  let service!: GrowthOpportunityService;
  let tenantId!: string;
  let factoryId!: string;
  let userId!: string;

  beforeAll(async () => {
    const connectionString = process.env.TEST_ADMIN_DATABASE_URL;
    if (!connectionString) throw new Error('TEST_ADMIN_DATABASE_URL is required for growth opportunity integration tests.');
    pool = new Pool({ connectionString });
    client = await pool.connect();
    await client.query('BEGIN');

    const scope = await client.query<ScopeRow>(
      "SELECT t.id::text AS tenant_id, f.id::text AS factory_id, u.id::text AS user_id " +
      "FROM tenants t JOIN factories f ON f.tenant_id = t.id " +
      "JOIN tenant_memberships tm ON tm.tenant_id = t.id AND tm.status = 'ACTIVE' " +
      "JOIN users u ON u.id = tm.user_id AND u.status = 'ACTIVE' " +
      "WHERE t.status = 'ACTIVE' AND f.status = 'ACTIVE' ORDER BY t.created_at, f.created_at, u.created_at LIMIT 1",
    );
    const row = scope.rows[0];
    if (!row) throw new Error('No active tenant/factory/user exists in the PostgreSQL fixture.');
    tenantId = row.tenant_id;
    factoryId = row.factory_id;
    userId = row.user_id;

    service = new GrowthOpportunityService(
      { query: (sql: string, values?: unknown[]) => client.query(sql, values) } as never,
      { authorize: jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined) } as never,
      { record: jest.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue('audit-id') } as never,
    );
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    if (pool) await pool.end();
  });

  it('persists an opportunity, an explicit decision and source-referenced outcomes without mutating the hypothesis', async () => {
    const nonce = randomUUID();
    const opportunity = await service.createOpportunity(tenantId, factoryId, userId, {
      opportunity_key: 'integration.capacity.' + nonce,
      opportunity_version: 'v1',
      category: 'CAPACITY_UNLOCK' as never,
      statement: 'Reduce changeover loss with a controlled maintenance-window trial.',
      evidence: [{
        kind: 'PRIVATE_OPERATIONAL' as never,
        label: 'MES trial snapshot',
        reference_id: 'MES:integration:' + nonce,
      }],
      assumptions: ['The scheduled order mix is representative.'],
      affected_nodes: [{ node_type: 'KPI' as never, node_ref: 'production.changeover_minutes' }],
      expected_value_min: 10,
      expected_value_max: 25,
      expected_value_metric: 'changeover_minutes_saved',
      expected_value_unit: 'minutes',
      expected_value_currency: 'BDT',
      uncertainty: {
        level: 'MEDIUM' as never,
        limitations: ['The result may vary by product mix.'],
        sensitivity_factors: ['Operator shift'],
        evidence_gaps: ['More than one product family'],
      },
      effort_estimate: 8,
      effort_unit: 'PERSON_HOURS' as never,
      dependencies: ['planned-maintenance-window'],
      time_to_impact: 'NEAR_TERM' as never,
      impact_date_assumption: '2026-12-15',
      risk_class: 'OPERATIONAL' as never,
      validation_plan: 'Compare changeover minutes across ten matched production runs.',
      decision_owner_role: 'OPERATIONS_MANAGER',
      idempotency_key: 'growth-opportunity-' + nonce,
    } as never);
    const opportunityId = opportunity.opportunity.id as string;

    const decision = await service.recordDecision(tenantId, factoryId, userId, opportunityId, {
      decision: 'ACCEPTED' as never,
      rationale: 'The scoped trial is bounded and can be safely measured.',
      idempotency_key: 'growth-decision-' + nonce,
    } as never);
    expect(decision.decision.decision).toBe('ACCEPTED');

    const outcome = await service.recordOutcome(tenantId, factoryId, userId, opportunityId, {
      measurement_stage: 'REALIZED' as never,
      metric_key: 'changeover_minutes_saved',
      actual_value: 14.5,
      metric_unit: 'minutes',
      observed_at: '2026-10-10T12:00:00.000Z',
      source_system: 'MES' as never,
      source_record_ref: 'MES:integration:observed:' + nonce,
      idempotency_key: 'growth-outcome-' + nonce,
    } as never);
    expect(outcome.outcome.actualValue).toBe(14.5);
    expect(outcome.outcome.semantics).toBe('SOURCE_REFERENCED_OBSERVATION_NOT_AUTOMATIC_CAUSAL_ATTRIBUTION');

    const graph = await service.getOpportunity(tenantId, factoryId, userId, opportunityId);
    expect(graph.opportunity.id).toBe(opportunityId);
    expect(graph.decisions).toHaveLength(1);
    expect(graph.outcomes).toHaveLength(1);
    expect(graph.governance.expectedValueIsScenarioNotGuarantee).toBe(true);

    await client.query('SAVEPOINT growth_immutability_check');
    await expect(
      client.query('UPDATE growth_opportunity_registry SET statement = $1 WHERE id = $2', ['silently changed', opportunityId]),
    ).rejects.toThrow('Growth opportunity versions are immutable');
    await client.query('ROLLBACK TO SAVEPOINT growth_immutability_check');
  });

  it('requires an accepted latest decision before POST or REALIZED outcome capture', async () => {
    const nonce = randomUUID();
    const created = await service.createOpportunity(tenantId, factoryId, userId, {
      opportunity_key: 'integration.pending.' + nonce,
      opportunity_version: 'v1',
      category: 'COST_REDUCTION' as never,
      statement: 'Evaluate a bounded packaging waste reduction hypothesis.',
      evidence: [{ kind: 'PRIVATE_OPERATIONAL' as never, label: 'Waste snapshot', reference_id: 'MES:waste:' + nonce }],
      assumptions: ['Measured waste includes rework.'],
      affected_nodes: [{ node_type: 'KPI' as never, node_ref: 'quality.packaging_waste' }],
      expected_value_min: 1,
      expected_value_max: 5,
      expected_value_metric: 'kg_saved',
      expected_value_unit: 'kg',
      expected_value_currency: 'BDT',
      uncertainty: { level: 'UNKNOWN' as never, limitations: ['No treatment data yet.'], sensitivity_factors: [], evidence_gaps: ['Baseline study'] },
      effort_estimate: 4,
      effort_unit: 'PERSON_HOURS' as never,
      dependencies: [],
      time_to_impact: 'IMMEDIATE' as never,
      risk_class: 'OPERATIONAL' as never,
      validation_plan: 'Capture the packaging waste baseline before any live adjustment.',
      decision_owner_role: 'QUALITY_MANAGER',
      idempotency_key: 'growth-pending-' + nonce,
    } as never);

    await expect(
      service.recordOutcome(tenantId, factoryId, userId, created.opportunity.id, {
        measurement_stage: 'REALIZED' as never,
        metric_key: 'kg_saved',
        actual_value: 1,
        metric_unit: 'kg',
        observed_at: '2026-10-10T12:00:00.000Z',
        source_system: 'QUALITY' as never,
        source_record_ref: 'QUALITY:measurement:' + nonce,
        idempotency_key: 'outcome-pending-' + nonce,
      } as never),
    ).rejects.toThrow('require the latest opportunity decision to be ACCEPTED');
  });
});
