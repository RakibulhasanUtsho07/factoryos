import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { DatabaseService } from '../database/database.service';

const postgresDescribe = process.env.TEST_ADMIN_DATABASE_URL ? describe : describe.skip;
const ROLLBACK_MARKER = 'RESEARCH_GROWTH_FIXTURE_ROLLBACK';

postgresDescribe('Research and Growth PostgreSQL invariants', () => {
  let database: DatabaseService;

  beforeAll(async () => {
    const config = {
      get: (key: string) => key === 'DATABASE_URL' ? process.env.DATABASE_URL : undefined,
    } as ConfigService;
    database = new DatabaseService(config);
    await database.onModuleInit();
  }, 60_000);

  afterAll(async () => {
    if (database) await database.onModuleDestroy();
  }, 60_000);

  async function withFixture(
    test: (client: PoolClient, fixture: {
      tenantId: string; userId: string; factoryId: string; sourceId: string; claimId: string;
    }) => Promise<void>,
  ) {
    const tenantId = randomUUID();
    const userId = randomUUID();
    await expect(database.transaction(
      { tenantId, userId },
      async client => {
        await client.query(
          'INSERT INTO tenants (id, slug, name, status) VALUES ($1, $2, $3, $4)',
          [tenantId, 'rg-' + tenantId.slice(0, 8), 'Research growth integration tenant', 'ACTIVE'],
        );
        await client.query(
          'INSERT INTO users (id, external_subject, email, display_name, status) VALUES ($1, $2, $3, $4, $5)',
          [userId, 'rg-' + userId, 'rg-' + userId + '@factoryos.test', 'Research growth actor', 'ACTIVE'],
        );
        const factory = await client.query<{ id: string }>(
          'INSERT INTO factories (tenant_id, code, name, status) VALUES ($1, $2, $3, $4) RETURNING id::text AS id',
          [tenantId, 'RG-' + randomUUID().slice(0, 8), 'Research growth factory', 'ACTIVE'],
        );
        const factoryId = factory.rows[0].id;
        const source = await client.query<{ id: string }>(
          `
          INSERT INTO research_sources (
            tenant_id, namespace, source_type, title, authors, doi, source_url,
            license_status, access_status, rights_basis, full_text_storage_allowed,
            untrusted_content, source_metadata, created_by, reviewed_by, reviewed_at, review_reason
          )
          VALUES ($1, 'TENANT', 'DOI_METADATA', 'Approved open research', '["A. Author"]'::jsonb,
            $2, 'https://example.org/paper', 'OPEN_ACCESS', 'APPROVED',
            'CC BY open-access terms', FALSE, TRUE, '{}'::jsonb, $3, $3, clock_timestamp(), 'license checked')
          RETURNING id::text AS id
          `,
          [tenantId, '10.9999/' + randomUUID(), userId],
        );
        const sourceId = source.rows[0].id;
        const claim = await client.query<{ id: string }>(
          `
          INSERT INTO research_claims (
            tenant_id, namespace, source_id, claim_text, evidence_grade, evidence_strength,
            topic_tags, provenance_ref, status, created_by, reviewed_by, reviewed_at, review_reason
          )
          VALUES ($1, 'TENANT', $2, 'A research claim supported by a cited paper.',
            'B', 'MODERATE', '["quality"]'::jsonb, '{"section":"Results","page":4}'::jsonb,
            'APPROVED', $3, $3, clock_timestamp(), 'evidence checked')
          RETURNING id::text AS id
          `,
          [tenantId, sourceId, userId],
        );

        await test(client, { tenantId, userId, factoryId, sourceId, claimId: claim.rows[0].id });
        throw new Error(ROLLBACK_MARKER);
      },
    )).rejects.toThrow(ROLLBACK_MARKER);
  }

  it('forces RLS on every research and growth data surface', async () => {
    const names = [
      'research_sources', 'research_claims', 'research_claim_links', 'research_knowledge_releases', 'research_release_evaluations',
      'research_relevance_mappings', 'growth_opportunities', 'growth_opportunity_evidence', 'growth_validation_unknowns',
      'growth_scenarios', 'growth_experiments', 'growth_experiment_results', 'growth_opportunity_outcomes',
    ];
    const result = await database.query<{
      relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean;
    }>(
      'SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) ORDER BY c.relname',
      ['public', names],
    );
    expect(result.rows).toHaveLength(names.length);
    for (const row of result.rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  it('prevents approving claims against a source whose rights are not approved', async () => {
    await withFixture(async (client, f) => {
      await client.query('SAVEPOINT rejected_claim_approval');
      const pending = await client.query<{ id: string }>(
        `
        INSERT INTO research_sources (
          tenant_id, namespace, source_type, title, authors, source_url,
          license_status, access_status, rights_basis, created_by
        )
        VALUES ($1, 'TENANT', 'CUSTOMER_PROVIDED', 'Pending customer source', '[]'::jsonb,
          'https://example.org/pending', 'USER_PROVIDED_AUTHORIZED', 'PENDING',
          'awaiting reviewer', $2)
        RETURNING id::text AS id
        `,
        [f.tenantId, f.userId],
      );
      await expect(client.query(
        `
        INSERT INTO research_claims (
          tenant_id, namespace, source_id, claim_text, evidence_grade, evidence_strength,
          topic_tags, provenance_ref, status, created_by, reviewed_by, reviewed_at, review_reason
        )
        VALUES ($1, 'TENANT', $2, 'Claim must not be trusted yet.', 'B', 'MODERATE',
          '[]'::jsonb, '{"section":"Summary"}'::jsonb, 'APPROVED', $3, $3, clock_timestamp(), 'attempt')
        `,
        [f.tenantId, pending.rows[0].id, f.userId],
      )).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT rejected_claim_approval');
    });
  });

  it('rejects release promotion containing a claim that is not approved and visible', async () => {
    await withFixture(async (client, f) => {
      const release = await client.query<{ id: string }>(
        `
        INSERT INTO research_knowledge_releases (
          tenant_id, namespace, release_key, version, title, claim_ids,
          source_list, evidence_grade, owner_user_id, validation_report
        )
        VALUES ($1, 'TENANT', $2, 1, 'Invalid release', $3::jsonb,
          '[]'::jsonb, 'B', $4, '{}'::jsonb)
        RETURNING id::text AS id
        `,
        [f.tenantId, 'invalid-' + randomUUID().slice(0, 8), JSON.stringify([randomUUID()]), f.userId],
      );
      await client.query('SAVEPOINT reject_invalid_release');
      await expect(client.query(
        `
        UPDATE research_knowledge_releases
        SET status = 'PROMOTED', validation_report = '{"consistencyPassed":true,"citationCoveragePassed":true,"rightsPassed":true,"safetyReviewed":true}'::jsonb,
          regression_evidence_ref = 'eval-run:research-regression-1', reviewed_by = $1,
          reviewed_at = clock_timestamp(), effective_at = clock_timestamp()
        WHERE id = $2
        `,
        [f.userId, release.rows[0].id],
      )).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT reject_invalid_release');
    });
  });

  it('keeps promoted knowledge releases immutable after the approval gate', async () => {
    await withFixture(async (client, f) => {
      const release = await client.query<{ id: string }>(
        `
        INSERT INTO research_knowledge_releases (
          tenant_id, namespace, release_key, version, title, claim_ids,
          source_list, evidence_grade, owner_user_id, validation_report
        )
        VALUES ($1, 'TENANT', $2, 1, 'Approved release', $3::jsonb,
          $4::jsonb, 'B', $5, '{}'::jsonb)
        RETURNING id::text AS id
        `,
        [f.tenantId, 'approved-' + randomUUID().slice(0, 8), JSON.stringify([f.claimId]),
          JSON.stringify([{ title: 'Approved open research', doi: 'DOI' }]), f.userId],
      );
      const evaluation = await client.query<{ id: string }>(
        `
        INSERT INTO research_release_evaluations (
          tenant_id, namespace, release_id, evaluation_version, status,
          content_fingerprint, results, evaluated_by
        )
        VALUES (
          $1, 'TENANT', $2, 'research-release-contract.v1', 'PASSED', $3,
          '{"consistencyPassed":true,"citationCoveragePassed":true,"rightsPassed":true,"safetyPassed":true}'::jsonb,
          $4
        )
        RETURNING id::text AS id
        `,
        [f.tenantId, release.rows[0].id, 'a'.repeat(64), f.userId],
      );
      await client.query('SAVEPOINT protect_release_evaluation');
      await expect(client.query(
        'UPDATE research_release_evaluations SET status = $1 WHERE id = $2',
        ['FAILED', evaluation.rows[0].id],
      )).rejects.toMatchObject({ code: '55000' });
      await client.query('ROLLBACK TO SAVEPOINT protect_release_evaluation');

      await client.query(
        `
        UPDATE research_knowledge_releases
        SET evaluation_id = $1,
          status = 'PROMOTED',
          validation_report = '{"consistencyPassed":true,"citationCoveragePassed":true,"rightsPassed":true,"safetyPassed":true,"safetyReviewed":true}'::jsonb,
          regression_evidence_ref = 'external-regression:research-regression-2',
          reviewed_by = $2, reviewed_at = clock_timestamp(), effective_at = clock_timestamp()
        WHERE id = $3
        `,
        [evaluation.rows[0].id, f.userId, release.rows[0].id],
      );
      await client.query('SAVEPOINT protect_promoted_release');
      await expect(client.query('UPDATE research_knowledge_releases SET title = $1 WHERE id = $2', ['tampered', release.rows[0].id]))
        .rejects.toMatchObject({ code: '55000' });
      await client.query('ROLLBACK TO SAVEPOINT protect_promoted_release');
    });
  });

  it('requires evidence before a growth opportunity can be accepted', async () => {
    await withFixture(async (client, f) => {
      const opportunity = await client.query<{ id: string }>(
        `
        INSERT INTO growth_opportunities (
          tenant_id, factory_id, title, category, opportunity_statement, success_hypothesis,
          assumptions, constraints_snapshot, affected_business_nodes, expected_value_low,
          expected_value_high, currency, uncertainty_pct, effort, time_to_impact_days,
          implementation_risk, owner_user_id, status, created_by
        )
        VALUES ($1, $2, 'Reduce scrap', 'COST_REDUCTION', 'Scrap rate is high',
          'A controlled process reduces scrap rate', '["baseline is current"]'::jsonb,
          '{}'::jsonb, '[]'::jsonb, 100, 400, 'BDT', 20, 'MEDIUM', 30,
          'MEDIUM', $3, 'PROPOSED', $3)
        RETURNING id::text AS id
        `,
        [f.tenantId, f.factoryId, f.userId],
      );
      await client.query('SAVEPOINT require_evidence');
      await expect(client.query(
        `
        UPDATE growth_opportunities
        SET status = 'ACCEPTED', decided_by = $1, decided_at = clock_timestamp(), decision_reason = 'approve'
        WHERE id = $2
        `,
        [f.userId, opportunity.rows[0].id],
      )).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT require_evidence');
    });
  });

  it('preserves scenario snapshots as immutable evidence', async () => {
    await withFixture(async (client, f) => {
      const opportunity = await client.query<{ id: string }>(
        `
        INSERT INTO growth_opportunities (
          tenant_id, factory_id, title, category, opportunity_statement, success_hypothesis,
          assumptions, constraints_snapshot, affected_business_nodes, expected_value_low,
          expected_value_high, currency, uncertainty_pct, effort, time_to_impact_days,
          implementation_risk, owner_user_id, status, created_by
        )
        VALUES ($1, $2, 'Improve margin', 'MARGIN_EXPANSION', 'Cost can be improved',
          'Pilot reduces costs without increasing defects', '["baseline matches ledger"]'::jsonb,
          '{}'::jsonb, '[]'::jsonb, 100, 400, 'BDT', 20, 'MEDIUM', 30,
          'MEDIUM', $3, 'PROPOSED', $3)
        RETURNING id::text AS id
        `,
        [f.tenantId, f.factoryId, f.userId],
      );
      const opportunityId = opportunity.rows[0].id;
      await client.query(
        `
        INSERT INTO growth_opportunity_evidence (
          tenant_id, factory_id, opportunity_id, evidence_type, origin_class,
          reference_ref, description, confidence, evidence_snapshot, created_by
        )
        VALUES ($1, $2, $3, 'OPERATIONAL_METRIC', 'OPERATIONAL',
          'quality-report:monthly-scrap', 'Tenant quality report baseline', 0.9, '{}'::jsonb, $4)
        `,
        [f.tenantId, f.factoryId, opportunityId, f.userId],
      );
      await client.query(
        `
        UPDATE growth_opportunities
        SET status = 'ACCEPTED', decided_by = $1, decided_at = clock_timestamp(), decision_reason = 'approved with evidence'
        WHERE id = $2
        `,
        [f.userId, opportunityId],
      );
      const scenario = await client.query<{ id: string; decision_ready: boolean }>(
        `
        INSERT INTO growth_scenarios (
          tenant_id, factory_id, opportunity_id, scenario_name, scenario_type, model_version,
          data_vintage, baseline_source_ref, inputs, output_snapshot, input_hash, created_by
        )
        VALUES ($1, $2, $3, 'Base case', 'BASE', 'factoryos.growth.financial-sensitivity.v1',
          clock_timestamp(), 'quality-report:monthly-scrap', '{"baseline_revenue":1000}'::jsonb,
          '{"netImpactPoint":100}'::jsonb, $4, $5)
        RETURNING id::text AS id, decision_ready
        `,
        [f.tenantId, f.factoryId, opportunityId, 'f'.repeat(64), f.userId],
      );
      expect(scenario.rows[0].decision_ready).toBe(false);
      await client.query('SAVEPOINT reject_forged_ready_scenario');
      await expect(client.query(
        `
        INSERT INTO growth_scenarios (
          tenant_id, factory_id, opportunity_id, scenario_name, scenario_type, model_version,
          data_vintage, baseline_source_ref, inputs, output_snapshot, input_hash, created_by
        )
        VALUES ($1, $2, $3, 'Forged ready scenario', 'BASE', 'factoryos.growth.financial-sensitivity.v1',
          clock_timestamp(), 'quality-report:monthly-scrap',
          '{"constraints_snapshot":{},"projected_constraint_metrics":{"capacity_utilization_pct":50,"quality_yield_pct":99,"cash_after_investment":100000,"cash_currency":"BDT","delivery_backlog_days":3}}'::jsonb,
          '{"constraintGate":{"status":"PASS","checks":[{"dimension":"capacity","passed":true,"projected":50},{"dimension":"quality","passed":true,"projected":99},{"dimension":"cash","passed":true,"projected":100000},{"dimension":"delivery","passed":true,"projected":3}]}}'::jsonb,
          $4, $5)
        `,
        [f.tenantId, f.factoryId, opportunityId, 'e'.repeat(64), f.userId],
      )).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT reject_forged_ready_scenario');
      await client.query('SAVEPOINT protect_scenario');
      await expect(client.query('UPDATE growth_scenarios SET scenario_name = $1 WHERE id = $2', ['tampered', scenario.rows[0].id]))
        .rejects.toMatchObject({ code: '55000' });
      await client.query('ROLLBACK TO SAVEPOINT protect_scenario');
    });
  });

  it('ranks material decision unknowns and prevents mutation of their definition', async () => {
    await withFixture(async (client, f) => {
      const opportunity = await client.query<{ id: string }>(
        `
        INSERT INTO growth_opportunities (
          tenant_id, factory_id, title, category, opportunity_statement, success_hypothesis,
          assumptions, constraints_snapshot, affected_business_nodes, expected_value_low,
          expected_value_high, currency, uncertainty_pct, effort, time_to_impact_days,
          implementation_risk, owner_user_id, status, created_by
        )
        VALUES ($1, $2, 'Test uncertainty', 'COST_REDUCTION', 'Unknown scrap root cause',
          'Validate root cause before investment', '["baseline may vary"]'::jsonb,
          '{}'::jsonb, '[]'::jsonb, 0, 1000, 'BDT', 40, 'SMALL', 7, 'LOW',
          $3, 'PROPOSED', $3)
        RETURNING id::text AS id
        `,
        [f.tenantId, f.factoryId, f.userId],
      );
      const unknown = await client.query<{ id: string; priority_score: string }>(
        `
        INSERT INTO growth_validation_unknowns (
          tenant_id, factory_id, opportunity_id, question, decision_variable,
          impact_if_wrong, probability_unknown, validation_effort, validation_method,
          owner_user_id, created_by
        )
        VALUES ($1, $2, $3, 'Will the supplier maintain 98% quality yield?',
          'quality_yield_pct', 80, 0.75, 4, 'SUPPLIER_QUOTE', $4, $4)
        RETURNING id::text AS id, priority_score::text AS priority_score
        `,
        [f.tenantId, f.factoryId, opportunity.rows[0].id, f.userId],
      );
      expect(Number(unknown.rows[0].priority_score)).toBe(15);

      await client.query('SAVEPOINT protect_unknown_definition');
      await expect(client.query(
        'UPDATE growth_validation_unknowns SET impact_if_wrong = 5 WHERE id = $1',
        [unknown.rows[0].id],
      )).rejects.toMatchObject({ code: '55000' });
      await client.query('ROLLBACK TO SAVEPOINT protect_unknown_definition');

      await client.query('SAVEPOINT require_unknown_evidence');
      await expect(client.query(
        'UPDATE growth_validation_unknowns SET status = $1, updated_by = $2 WHERE id = $3',
        ['RESOLVED', f.userId, unknown.rows[0].id],
      )).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT require_unknown_evidence');

      await client.query(
        'UPDATE growth_validation_unknowns SET status = $1, updated_by = $2 WHERE id = $3',
        ['VALIDATING', f.userId, unknown.rows[0].id],
      );
      await client.query(
        'UPDATE growth_validation_unknowns SET status = $1, updated_by = $2, resolution_evidence_ref = $3, resolution_notes = $4 WHERE id = $5',
        ['RESOLVED', f.userId, 'supplier-quote:2026-10', 'Minimum order quality terms confirmed', unknown.rows[0].id],
      );
      const resolved = await client.query<{ status: string; priority_score: string }>(
        'SELECT status, priority_score::text AS priority_score FROM growth_validation_unknowns WHERE id = $1',
        [unknown.rows[0].id],
      );
      expect(resolved.rows[0].status).toBe('RESOLVED');
      expect(Number(resolved.rows[0].priority_score)).toBe(15);
    });
  });


  it('links a realised growth outcome to an immutable factory-scoped learning signal', async () => {
    await withFixture(async (client, f) => {
      const opportunity = await client.query<{ id: string }>(
        `
        INSERT INTO growth_opportunities (
          tenant_id, factory_id, title, category, opportunity_statement, success_hypothesis,
          assumptions, constraints_snapshot, affected_business_nodes, expected_value_low,
          expected_value_high, currency, uncertainty_pct, effort, time_to_impact_days,
          implementation_risk, owner_user_id, status, created_by
        )
        VALUES ($1, $2, 'Outcome learning link', 'COST_REDUCTION', 'Baseline waste is measurable',
          'A controlled pilot can reduce waste', '["monthly baseline is representative"]'::jsonb,
          '{}'::jsonb, '[]'::jsonb, 50, 300, 'BDT', 30, 'SMALL', 21, 'LOW',
          $3, 'IN_PROGRESS', $3)
        RETURNING id::text AS id
        `,
        [f.tenantId, f.factoryId, f.userId],
      );
      const outcome = await client.query<{ id: string }>(
        `
        INSERT INTO growth_opportunity_outcomes (
          tenant_id, factory_id, opportunity_id, assessment, realized_metrics,
          evidence_refs, notes, observed_at, recorded_by
        )
        VALUES ($1, $2, $3, 'POSITIVE', '{"scrap_rate_delta_pct":-3.2}'::jsonb,
          '["quality-report:pilot-17"]'::jsonb, 'Recorded pilot result',
          clock_timestamp(), $4)
        RETURNING id::text AS id
        `,
        [f.tenantId, f.factoryId, opportunity.rows[0].id, f.userId],
      );
      const signal = await client.query<{ id: string; tenant_scope: string; confidence: string }>(
        `
        INSERT INTO ai_learning_signals (
          tenant_id, factory_id, source_decision_id, source_outcome_id, source_execution_id,
          source_growth_outcome_id, signal_type, label, confidence, tenant_scope, payload, created_by
        )
        VALUES ($1, $2, NULL, NULL, NULL, $3, 'GROWTH_OUTCOME_ASSESSMENT',
          'Growth outcome recorded: POSITIVE', 0.8, 'FACTORY',
          '{"assessment":"POSITIVE","source":"GROWTH_OUTCOME"}'::jsonb, $4)
        RETURNING id::text AS id, tenant_scope, confidence::text AS confidence
        `,
        [f.tenantId, f.factoryId, outcome.rows[0].id, f.userId],
      );
      expect(signal.rows[0].tenant_scope).toBe('FACTORY');
      expect(Number(signal.rows[0].confidence)).toBe(0.8);

      await client.query('SAVEPOINT reject_wrong_factory_learning_link');
      await expect(client.query(
        `
        INSERT INTO ai_learning_signals (
          tenant_id, factory_id, source_decision_id, source_outcome_id, source_execution_id,
          source_growth_outcome_id, signal_type, label, confidence, tenant_scope, payload, created_by
        )
        VALUES ($1, $2, NULL, NULL, NULL, $3, 'GROWTH_OUTCOME_ASSESSMENT',
          'Cross-factory signal', 0.8, 'FACTORY', '{}'::jsonb, $4)
        `,
        [f.tenantId, randomUUID(), outcome.rows[0].id, f.userId],
      )).rejects.toMatchObject({ code: '23503' });
      await client.query('ROLLBACK TO SAVEPOINT reject_wrong_factory_learning_link');

      await client.query('SAVEPOINT protect_growth_learning_signal');
      await expect(client.query('UPDATE ai_learning_signals SET confidence = 0.1 WHERE id = $1', [signal.rows[0].id]))
        .rejects.toMatchObject({ code: '55000' });
      await client.query('ROLLBACK TO SAVEPOINT protect_growth_learning_signal');
    });
  });

});
