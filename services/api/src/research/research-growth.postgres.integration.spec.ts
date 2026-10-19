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
      tenantId: string; userId: string; decisionUserId: string; factoryId: string; sourceId: string; claimId: string;
    }) => Promise<void>,
  ) {
    const tenantId = randomUUID();
    const userId = randomUUID();
    const decisionUserId = randomUUID();
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
        await client.query(
          'INSERT INTO users (id, external_subject, email, display_name, status) VALUES ($1, $2, $3, $4, $5)',
          [decisionUserId, 'rg-' + decisionUserId, 'rg-' + decisionUserId + '@factoryos.test', 'Growth decision owner', 'ACTIVE'],
        );
        await client.query(
          "INSERT INTO tenant_memberships (tenant_id, user_id, status) VALUES ($1, $2, 'ACTIVE')",
          [tenantId, userId],
        );
        await client.query(
          "INSERT INTO tenant_memberships (tenant_id, user_id, status) VALUES ($1, $2, 'ACTIVE')",
          [tenantId, decisionUserId],
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
            topic_tags, provenance_ref, status, created_by
          )
          VALUES ($1, 'TENANT', $2, 'A research claim supported by a cited paper.',
            'B', 'MODERATE', '["quality"]'::jsonb, '{"section":"Results","page":4}'::jsonb,
            'PROPOSED', $3)
          RETURNING id::text AS id
          `,
          [tenantId, sourceId, userId],
        );
        const fixtureClaimId = claim.rows[0].id;
        await client.query(
          `INSERT INTO research_evidence_assessments (
             tenant_id, claim_id, source_id, source_revision, rights_version,
             claim_fingerprint, rubric_version, evidence_score, suggested_grade, grade_factors,
             citation_status, citation_findings, citation_verification_level,
             safety_status, safety_flags, evidence_snapshot, assessed_by
           )
           SELECT c.tenant_id, c.id, s.id, s.source_revision, s.rights_version,
             repeat('a',64), 'research-evidence-rubric.v1', 45, 'D',
             jsonb_build_object(
               'citation', jsonb_build_object('score',25,'max',25,'explanation','The fixture uses a precise locator and registered source identity.'),
               'source_identity', jsonb_build_object('score',15,'max',15,'explanation','A source title and DOI or URL are registered.'),
               'authors_and_date', jsonb_build_object('score',5,'max',10,'explanation','Authorship is known but publication date is not supplied.'),
               'methodology', jsonb_build_object('score',0,'max',15,'explanation','No methodology description is recorded.'),
               'dataset_description', jsonb_build_object('score',0,'max',15,'explanation','No dataset description is recorded.'),
               'limitations', jsonb_build_object('score',0,'max',10,'explanation','No limitations are recorded.'),
               'practical_implication', jsonb_build_object('score',0,'max',5,'explanation','No practical implication is recorded.'),
               'independent_corroboration', jsonb_build_object('score',0,'max',5,'explanation','No independent corroborating source is linked.')
             ),
             'CONSISTENT', '[]'::jsonb, 'METADATA_ONLY', 'CLEAR', '[]'::jsonb,
             jsonb_build_object(
               'claimId', c.id::text, 'sourceId', s.id::text,
               'claimTextSha256', encode(sha256(convert_to(c.claim_text,'UTF8')),'hex'),
               'methodologySha256', encode(sha256(convert_to(COALESCE(c.methodology,''),'UTF8')),'hex'),
               'datasetDescriptionSha256', encode(sha256(convert_to(COALESCE(c.dataset_description,''),'UTF8')),'hex'),
               'limitationsSha256', encode(sha256(convert_to(COALESCE(c.limitations,''),'UTF8')),'hex'),
               'practicalImplicationSha256', encode(sha256(convert_to(COALESCE(c.practical_implication,''),'UTF8')),'hex'),
               'storedExcerptSha256', encode(sha256(convert_to(COALESCE(c.stored_excerpt,''),'UTF8')),'hex'),
               'provenanceRef', c.provenance_ref, 'topicTags', c.topic_tags,
               'evidenceGrade', c.evidence_grade, 'evidenceStrength', c.evidence_strength,
               'sourceTitle', s.title, 'sourceDoi', s.doi, 'sourceUrl', s.source_url,
               'sourceAuthors', s.authors, 'publicationDate', s.publication_date::text,
               'sourceRevision', s.source_revision, 'rightsVersion', s.rights_version
             ), $3
           FROM research_claims c
           JOIN research_sources s ON s.id=c.source_id AND s.tenant_id=c.tenant_id
           WHERE c.id=$1 AND c.tenant_id=$2`,
          [fixtureClaimId, tenantId, userId],
        );
        await client.query(
          `UPDATE research_claims
           SET status='APPROVED', reviewed_by=$1, reviewed_at=clock_timestamp(),
               review_reason='Fixture claim approved after metadata assessment'
           WHERE id=$2 AND tenant_id=$3`,
          [userId, fixtureClaimId, tenantId],
        );

        await test(client, { tenantId, userId, decisionUserId, factoryId, sourceId, claimId: fixtureClaimId });
        throw new Error(ROLLBACK_MARKER);
      },
    )).rejects.toThrow(ROLLBACK_MARKER);
  }

  it('registers every permission required by the Research and Growth controllers', async () => {
    const required = [
      'research.read', 'research.write', 'research.review',
      'growth.read', 'growth.write', 'growth.review',
    ];
    const result = await database.query<{ code: string }>(
      'SELECT code FROM permissions WHERE code = ANY($1::text[]) ORDER BY code',
      [required],
    );
    expect(result.rows.map(row => row.code).sort()).toEqual([...required].sort());
  });

  it('forces RLS on every research and growth data surface', async () => {
    const names = [
      'research_sources', 'research_claims', 'research_claim_links', 'research_knowledge_releases', 'research_release_evaluations', 'research_topic_watchlists',
      'research_evidence_assessments', 'research_evidence_safety_reviews',
      'research_relevance_mappings', 'growth_opportunities', 'growth_opportunity_evidence', 'growth_validation_unknowns',
      'growth_opportunity_assumptions', 'growth_opportunity_assumption_decisions', 'growth_opportunity_constraints',
      'growth_opportunity_evidence_gaps', 'growth_opportunity_evidence_gap_events',
      'growth_opportunity_decision_owners', 'growth_opportunity_decision_history',
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

  it('enforces the tenant watchlist lifecycle and retains retired configuration history', async () => {
    await withFixture(async (client, f) => {
      const watchlist = await client.query<{ id: string }>(
        `
        INSERT INTO research_topic_watchlists (
          tenant_id, watchlist_key, title, topic_type, description,
          topic_terms, inclusion_terms, exclusion_terms, source_types, created_by
        )
        VALUES ($1, 'textile-quality', 'Textile quality technologies', 'TECHNOLOGY',
          'Track quality improvements', '["fabric inspection", "defect detection"]'::jsonb,
          '["manufacturing"]'::jsonb, '["consumer reviews"]'::jsonb,
          '["DOI_METADATA","OPEN_ACCESS_REPOSITORY"]'::jsonb, $2)
        RETURNING id::text AS id
        `,
        [f.tenantId, f.userId],
      );
      await client.query(
        'UPDATE research_topic_watchlists SET status = $1, status_reason = $2, updated_by = $3 WHERE id = $4',
        ['PAUSED', 'Pause while source scope is reviewed', f.userId, watchlist.rows[0].id],
      );
      const paused = await client.query<{ status: string }>(
        'SELECT status FROM research_topic_watchlists WHERE id = $1',
        [watchlist.rows[0].id],
      );
      expect(paused.rows[0].status).toBe('PAUSED');

      await client.query(
        'UPDATE research_topic_watchlists SET status = $1, status_reason = $2, updated_by = $3 WHERE id = $4',
        ['RETIRED', 'Replace with a revised topic query', f.userId, watchlist.rows[0].id],
      );
      await client.query('SAVEPOINT reject_retired_watchlist_mutation');
      await expect(client.query(
        'UPDATE research_topic_watchlists SET status = $1, status_reason = $2, updated_by = $3 WHERE id = $4',
        ['ACTIVE', 'reactivation attempt', f.userId, watchlist.rows[0].id],
      )).rejects.toMatchObject({ code: '55000' });
      await client.query('ROLLBACK TO SAVEPOINT reject_retired_watchlist_mutation');

      const replacement = await client.query<{ id: string }>(
        `
        INSERT INTO research_topic_watchlists (
          tenant_id, watchlist_key, title, topic_type, topic_terms, source_types, created_by
        )
        VALUES ($1, 'textile-quality', 'Revised textile quality watchlist', 'TECHNOLOGY',
          '["fabric metrology"]'::jsonb, '["PUBLISHER_FEED"]'::jsonb, $2)
        RETURNING id::text AS id
        `,
        [f.tenantId, f.userId],
      );
      expect(replacement.rows[0].id).not.toBe(watchlist.rows[0].id);

      await client.query('SAVEPOINT protect_watchlist_definition');
      await expect(client.query(
        'UPDATE research_topic_watchlists SET title = $1 WHERE id = $2',
        ['tampered', replacement.rows[0].id],
      )).rejects.toMatchObject({ code: '55000' });
      await client.query('ROLLBACK TO SAVEPOINT protect_watchlist_definition');
    });
  });

  it('keeps evidence assessments and safety reviews append-only and tenant-isolated', async () => {
    await withFixture(async (client, f) => {
      const assessment = await client.query<{
        id: string; evidence_score: number; suggested_grade: string;
        claim_fingerprint: string; expected_fingerprint: string;
      }>(
        `SELECT id::text AS id, evidence_score, suggested_grade, claim_fingerprint,
            encode(sha256(convert_to(evidence_snapshot::text, 'UTF8')), 'hex') AS expected_fingerprint
         FROM research_evidence_assessments
         WHERE tenant_id=$1 AND claim_id=$2 ORDER BY created_at DESC LIMIT 1`,
        [f.tenantId, f.claimId],
      );
      expect(assessment.rows).toHaveLength(1);
      expect(assessment.rows[0].evidence_score).toBe(45);
      expect(assessment.rows[0].suggested_grade).toBe('D');
      expect(assessment.rows[0].claim_fingerprint).toBe(assessment.rows[0].expected_fingerprint);

      await client.query('SAVEPOINT protect_evidence_assessment');
      await expect(client.query(
        'UPDATE research_evidence_assessments SET evidence_score=99 WHERE id=$1',
        [assessment.rows[0].id],
      )).rejects.toMatchObject({ code: '55000' });
      await client.query('ROLLBACK TO SAVEPOINT protect_evidence_assessment');

      await client.query('SAVEPOINT protect_evidence_assessment_delete');
      await expect(client.query(
        'DELETE FROM research_evidence_assessments WHERE id=$1',
        [assessment.rows[0].id],
      )).rejects.toMatchObject({ code: '55000' });
      await client.query('ROLLBACK TO SAVEPOINT protect_evidence_assessment_delete');

      const rls = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_class WHERE oid='public.research_evidence_assessments'::regclass`,
      );
      expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    });
  });

  it('increments the source revision and blocks queued jobs when source metadata changes', async () => {
    await withFixture(async (client, f) => {
      const job = await client.query<{ id: string }>(
        `
        INSERT INTO research_ingestion_jobs (
          tenant_id, namespace, source_id, mode, status, stage, progress_percent,
          attempt_count, max_attempts, idempotency_key, request_hash,
          source_revision, rights_version, rights_fingerprint, rights_snapshot,
          source_snapshot, resume_checkpoint, created_by
        )
        VALUES ($1, 'TENANT', $2, 'METADATA_ONLY', 'QUEUED', 'QUEUED', 0,
          0, 3, $3, $4, 1, 1, $5, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $6)
        RETURNING id::text AS id
        `,
        [f.tenantId, f.sourceId, 'revision-' + randomUUID(), 'a'.repeat(64), 'b'.repeat(64), f.userId],
      );

      await client.query(
        'UPDATE research_sources SET title = title || $1 WHERE id = $2 AND tenant_id = $3',
        [' revised', f.sourceId, f.tenantId],
      );

      const source = await client.query<{ source_revision: number; rights_version: number }>(
        'SELECT source_revision, rights_version FROM research_sources WHERE id = $1 AND tenant_id = $2',
        [f.sourceId, f.tenantId],
      );
      expect(Number(source.rows[0].source_revision)).toBe(2);
      expect(Number(source.rows[0].rights_version)).toBe(1);

      const jobState = await client.query<{ status: string; version: number; last_error_code: string }>(
        'SELECT status, version, last_error_code FROM research_ingestion_jobs WHERE id = $1 AND tenant_id = $2',
        [job.rows[0].id, f.tenantId],
      );
      expect(jobState.rows[0]).toMatchObject({
        status: 'BLOCKED_SOURCE_CHANGED',
        version: 2,
        last_error_code: 'SOURCE_REVISION_CHANGED',
      });

      const history = await client.query<{ action: string; source_revision: number }>(
        'SELECT action, source_revision FROM research_source_rights_history WHERE source_id = $1 AND tenant_id = $2',
        [f.sourceId, f.tenantId],
      );
      expect(history.rows).toContainEqual({ action: 'SOURCE_CHANGED', source_revision: 2 });

      const event = await client.query<{ from_status: string; to_status: string }>(
        `SELECT from_status,to_status FROM research_ingestion_events
         WHERE tenant_id=$1 AND job_id=$2 AND event_type='JOB_BLOCKED_SOURCE_CHANGE'`,
        [f.tenantId, job.rows[0].id],
      );
      expect(event.rows).toEqual([{ from_status: 'QUEUED', to_status: 'BLOCKED_SOURCE_CHANGED' }]);
    });
  });

  it('increments the rights version and revokes a running worker lease atomically', async () => {
    await withFixture(async (client, f) => {
      const job = await client.query<{ id: string }>(
        `
        INSERT INTO research_ingestion_jobs (
          tenant_id, namespace, source_id, mode, status, stage, progress_percent,
          attempt_count, max_attempts, version, idempotency_key, request_hash,
          source_revision, rights_version, rights_fingerprint, rights_snapshot,
          source_snapshot, resume_checkpoint, lease_owner, lease_expires_at, created_by
        )
        VALUES ($1, 'TENANT', $2, 'METADATA_ONLY', 'QUEUED', 'QUEUED', 0,
          0, 3, 1, $3, $4, 1, 1, $5, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, NULL, NULL, $6)
        RETURNING id::text AS id
        `,
        [f.tenantId, f.sourceId, 'rights-' + randomUUID(), 'c'.repeat(64), 'd'.repeat(64), f.userId],
      );
      await client.query(
        `UPDATE research_ingestion_jobs
         SET status='RUNNING',stage='FETCH_METADATA',progress_percent=20,attempt_count=1,
             lease_owner=$1,lease_expires_at=clock_timestamp()+INTERVAL '5 minutes',
             version=version+1
         WHERE id=$2 AND tenant_id=$3`,
        [f.userId, job.rows[0].id, f.tenantId],
      );

      await client.query(
        `UPDATE research_sources
         SET access_status='REVOKED',reviewed_by=$1,reviewed_at=clock_timestamp(),
             review_reason='Rights withdrawn by source owner'
         WHERE id=$2 AND tenant_id=$3`,
        [f.userId, f.sourceId, f.tenantId],
      );

      const source = await client.query<{ source_revision: number; rights_version: number; access_status: string }>(
        'SELECT source_revision,rights_version,access_status FROM research_sources WHERE id=$1 AND tenant_id=$2',
        [f.sourceId, f.tenantId],
      );
      expect(source.rows[0]).toMatchObject({ source_revision: 1, rights_version: 2, access_status: 'REVOKED' });

      const jobState = await client.query<{ status: string; lease_owner: string | null; lease_expires_at: string | null; last_error_code: string }>(
        'SELECT status,lease_owner::text AS lease_owner,lease_expires_at::text AS lease_expires_at,last_error_code FROM research_ingestion_jobs WHERE id=$1 AND tenant_id=$2',
        [job.rows[0].id, f.tenantId],
      );
      expect(jobState.rows[0]).toMatchObject({
        status: 'BLOCKED_RIGHTS',
        lease_owner: null,
        lease_expires_at: null,
        last_error_code: 'SOURCE_RIGHTS_CHANGED',
      });

      const event = await client.query<{ from_status: string; to_status: string }>(
        `SELECT from_status,to_status FROM research_ingestion_events
         WHERE tenant_id=$1 AND job_id=$2 AND event_type='JOB_BLOCKED_SOURCE_CHANGE'`,
        [f.tenantId, job.rows[0].id],
      );
      expect(event.rows).toEqual([{ from_status: 'RUNNING', to_status: 'BLOCKED_RIGHTS' }]);

      const history = await client.query<{ action: string; rights_version: number }>(
        'SELECT action,rights_version FROM research_source_rights_history WHERE source_id=$1 AND tenant_id=$2 ORDER BY created_at DESC',
        [f.sourceId, f.tenantId],
      );
      expect(history.rows[0]).toMatchObject({ action: 'ACCESS_REVOKED', rights_version: 2 });
    });
  });

  it('requires an immutable item review before an extracted claim can become approved', async () => {
    await withFixture(async (client, f) => {
      const job = await client.query<{ id: string }>(
        `
        INSERT INTO research_ingestion_jobs (
          tenant_id,namespace,source_id,mode,status,stage,progress_percent,
          attempt_count,max_attempts,version,idempotency_key,request_hash,
          source_revision,rights_version,rights_fingerprint,rights_snapshot,
          source_snapshot,resume_checkpoint,created_by,completed_at
        )
        VALUES ($1,'TENANT',$2,'METADATA_ONLY','QUEUED','QUEUED',0,
          0,3,1,$3,$4,1,1,$5,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$6,NULL)
        RETURNING id::text AS id
        `,
        [f.tenantId, f.sourceId, 'extract-' + randomUUID(), 'e'.repeat(64), 'f'.repeat(64), f.userId],
      );
      await client.query(
        `UPDATE research_ingestion_jobs
         SET status='RUNNING',stage='EXTRACT_CLAIMS',progress_percent=70,attempt_count=1,
             lease_owner=$1,lease_expires_at=clock_timestamp()+INTERVAL '5 minutes',
             version=version+1
         WHERE id=$2 AND tenant_id=$3`,
        [f.userId, job.rows[0].id, f.tenantId],
      );
      await client.query(
        `UPDATE research_ingestion_jobs
         SET status='SUCCEEDED',stage='COMPLETE',progress_percent=100,
             lease_owner=NULL,lease_expires_at=NULL,completed_at=clock_timestamp(),version=version+1
         WHERE id=$1 AND tenant_id=$2`,
        [job.rows[0].id, f.tenantId],
      );
      const run = await client.query<{ id: string }>(
        `
        INSERT INTO research_extraction_runs (
          tenant_id,job_id,source_id,extractor_name,extractor_version,schema_version,
          input_sha256,output_sha256,source_revision,rights_version,rights_fingerprint,
          source_snapshot,rights_snapshot,safety_result,safety_findings,claim_count,
          untrusted_input,full_text_persisted,created_by
        )
        VALUES ($1,$2,$3,'test-extractor','1.0','claim/1',$4,$5,1,1,$6,
          '{}'::jsonb,'{}'::jsonb,'PASS','[]'::jsonb,1,TRUE,FALSE,$7)
        RETURNING id::text AS id
        `,
        [f.tenantId, job.rows[0].id, f.sourceId, '1'.repeat(64), '2'.repeat(64), '3'.repeat(64), f.userId],
      );
      const item = await client.query<{ id: string }>(
        `
        INSERT INTO research_extraction_items (
          tenant_id,extraction_run_id,item_key,source_locator,claim_text_sha256,
          safety_flags,review_status
        )
        VALUES ($1,$2,'test-claim','{"page":7,"section":"Results"}'::jsonb,$3,'[]'::jsonb,'PROPOSED')
        RETURNING id::text AS id
        `,
        [f.tenantId, run.rows[0].id, '4'.repeat(64)],
      );
      const claim = await client.query<{ id: string }>(
        `
        INSERT INTO research_claims (
          tenant_id,namespace,source_id,extraction_item_id,claim_text,evidence_grade,
          evidence_strength,topic_tags,provenance_ref,status,created_by
        )
        VALUES ($1,'TENANT',$2,$3,'Candidate extracted research claim','B','MODERATE',
          '["quality"]'::jsonb,'{"locator":{"page":7},"extraction":{"runId":"fixture"}}'::jsonb,
          'PROPOSED',$4)
        RETURNING id::text AS id
        `,
        [f.tenantId, f.sourceId, item.rows[0].id, f.userId],
      );

      await client.query('SAVEPOINT reject_unreviewed_extraction');
      await expect(client.query(
        `UPDATE research_claims
         SET status='APPROVED',reviewed_by=$1,reviewed_at=clock_timestamp(),review_reason='Attempt without item review'
         WHERE id=$2 AND tenant_id=$3`,
        [f.userId, claim.rows[0].id, f.tenantId],
      )).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT reject_unreviewed_extraction');

      await client.query(
        `
        INSERT INTO research_extraction_item_reviews (
          tenant_id,extraction_item_id,source_revision,rights_version,output_sha256,
          decision,reason,safety_flags,reviewed_by
        )
        VALUES ($1,$2,1,1,$3,'APPROVE',
          'Reviewer checked source location and extraction safety.','[]'::jsonb,$4)
        `,
        [f.tenantId, item.rows[0].id, '2'.repeat(64), f.userId],
      );
      await client.query(
        `
        INSERT INTO research_evidence_assessments (
          tenant_id,claim_id,source_id,source_revision,rights_version,
          claim_fingerprint,rubric_version,evidence_score,suggested_grade,grade_factors,
          citation_status,citation_findings,citation_verification_level,
          safety_status,safety_flags,evidence_snapshot,assessed_by
        )
        SELECT c.tenant_id,c.id,s.id,s.source_revision,s.rights_version,
          repeat('0',64),'research-evidence-rubric.v1',45,'D',
          jsonb_build_object(
            'citation',jsonb_build_object('score',25,'max',25,'explanation','Precise locator and registered identity'),
            'source_identity',jsonb_build_object('score',15,'max',15,'explanation','Registered source title and identifier'),
            'authors_and_date',jsonb_build_object('score',5,'max',10,'explanation','Source author is recorded but publication date is absent'),
            'methodology',jsonb_build_object('score',0,'max',15,'explanation','Methodology not recorded'),
            'dataset_description',jsonb_build_object('score',0,'max',15,'explanation','Dataset description not recorded'),
            'limitations',jsonb_build_object('score',0,'max',10,'explanation','Limitations not recorded'),
            'practical_implication',jsonb_build_object('score',0,'max',5,'explanation','Practical implication not recorded'),
            'independent_corroboration',jsonb_build_object('score',0,'max',5,'explanation','Independent corroboration not linked')
          ),
          'CONSISTENT','[]'::jsonb,'METADATA_ONLY','CLEAR','[]'::jsonb,
          jsonb_build_object(
            'claimId',c.id::text,'sourceId',s.id::text,
            'claimTextSha256',encode(sha256(convert_to(c.claim_text,'UTF8')),'hex'),
            'methodologySha256',encode(sha256(convert_to(COALESCE(c.methodology,''),'UTF8')),'hex'),
            'datasetDescriptionSha256',encode(sha256(convert_to(COALESCE(c.dataset_description,''),'UTF8')),'hex'),
            'limitationsSha256',encode(sha256(convert_to(COALESCE(c.limitations,''),'UTF8')),'hex'),
            'practicalImplicationSha256',encode(sha256(convert_to(COALESCE(c.practical_implication,''),'UTF8')),'hex'),
            'storedExcerptSha256',encode(sha256(convert_to(COALESCE(c.stored_excerpt,''),'UTF8')),'hex'),
            'provenanceRef',c.provenance_ref,'topicTags',c.topic_tags,
            'evidenceGrade',c.evidence_grade,'evidenceStrength',c.evidence_strength,
            'sourceTitle',s.title,'sourceDoi',s.doi,'sourceUrl',s.source_url,
            'sourceAuthors',s.authors,'publicationDate',s.publication_date::text,
            'sourceRevision',s.source_revision,'rightsVersion',s.rights_version
          ),$3
        FROM research_claims c
        JOIN research_sources s ON s.id=c.source_id AND s.tenant_id=c.tenant_id
        WHERE c.id=$1 AND c.tenant_id=$2
        `,
        [claim.rows[0].id, f.tenantId, f.userId],
      );

      await client.query(
        `UPDATE research_claims
         SET status='APPROVED',reviewed_by=$1,reviewed_at=clock_timestamp(),
             review_reason='Extraction item explicitly approved'
         WHERE id=$2 AND tenant_id=$3`,
        [f.userId, claim.rows[0].id, f.tenantId],
      );
      const final = await client.query<{ status: string }>(
        'SELECT status FROM research_claims WHERE id=$1 AND tenant_id=$2',
        [claim.rows[0].id, f.tenantId],
      );
      expect(final.rows[0].status).toBe('APPROVED');

      await client.query('SAVEPOINT reject_review_rewrite');
      await expect(client.query(
        `UPDATE research_extraction_item_reviews SET reason='rewritten review decision'
         WHERE extraction_item_id=$1 AND tenant_id=$2`,
        [item.rows[0].id, f.tenantId],
      )).rejects.toMatchObject({ code: 'P0001' });
      await client.query('ROLLBACK TO SAVEPOINT reject_review_rewrite');
    });
  });

  it('purges stored source excerpts on rights revocation but retains a verifiable digest audit', async () => {
    await withFixture(async (client, f) => {
      await client.query(
        'UPDATE research_sources SET full_text_storage_allowed=TRUE WHERE id=$1 AND tenant_id=$2',
        [f.sourceId, f.tenantId],
      );
      const excerpt = 'A licensed paper passage that must be erased when permission is withdrawn.';
      const claim = await client.query<{ id: string }>(
        `
        INSERT INTO research_claims (
          tenant_id,namespace,source_id,claim_text,evidence_grade,evidence_strength,
          topic_tags,provenance_ref,stored_excerpt,status,created_by
        )
        VALUES ($1,'TENANT',$2,'Claim with a licensed excerpt','B','MODERATE',
          '["rights"]'::jsonb,'{"page":7,"section":"Results"}'::jsonb,$3,'PROPOSED',$4)
        RETURNING id::text AS id
        `,
        [f.tenantId, f.sourceId, excerpt, f.userId],
      );
      const expectedDigest = await client.query<{ digest: string }>(
        "SELECT encode(sha256(convert_to($1,'UTF8')),'hex') AS digest",
        [excerpt],
      );

      await client.query(
        `UPDATE research_sources
         SET access_status='REVOKED',reviewed_by=$1,reviewed_at=clock_timestamp(),
             review_reason='Rights withdrawn by source owner'
         WHERE id=$2 AND tenant_id=$3`,
        [f.userId, f.sourceId, f.tenantId],
      );

      const stored = await client.query<{ stored_excerpt: string | null; provenance_ref: Record<string, unknown> }>(
        'SELECT stored_excerpt,provenance_ref FROM research_claims WHERE id=$1 AND tenant_id=$2',
        [claim.rows[0].id, f.tenantId],
      );
      expect(stored.rows[0].stored_excerpt).toBeNull();
      const revokedSource = await client.query<{ full_text_storage_allowed: boolean }>(
        'SELECT full_text_storage_allowed FROM research_sources WHERE id=$1 AND tenant_id=$2',
        [f.sourceId, f.tenantId],
      );
      expect(revokedSource.rows[0].full_text_storage_allowed).toBe(false);
      expect(stored.rows[0].provenance_ref).toMatchObject({
        page: 7,
        section: 'Results',
        storedExcerptPurged: true,
        storedExcerptSha256: expectedDigest.rows[0].digest,
        storedExcerptPurgeReason: 'SOURCE_ACCESS_REVOKED',
      });
      expect(stored.rows[0].provenance_ref.storedExcerptPurgedAt).toBeTruthy();

      const purge = await client.query<{
        source_revision: number; rights_version: number; excerpt_sha256: string;
        purge_reason: string; actor_user_id: string;
      }>(
        `SELECT source_revision,rights_version,excerpt_sha256,purge_reason,actor_user_id::text AS actor_user_id
         FROM research_source_content_purges WHERE tenant_id=$1 AND source_id=$2 AND claim_id=$3`,
        [f.tenantId, f.sourceId, claim.rows[0].id],
      );
      expect(purge.rows).toEqual([{
        source_revision: 1,
        rights_version: 3,
        excerpt_sha256: expectedDigest.rows[0].digest,
        purge_reason: 'SOURCE_ACCESS_REVOKED',
        actor_user_id: f.userId,
      }]);

      await client.query('SAVEPOINT reject_purge_audit_rewrite');
      await expect(client.query(
        'UPDATE research_source_content_purges SET purge_reason=$1 WHERE source_id=$2 AND claim_id=$3',
        ['LICENSE_RESTRICTED', f.sourceId, claim.rows[0].id],
      )).rejects.toMatchObject({ code: 'P0001' });
      await client.query('ROLLBACK TO SAVEPOINT reject_purge_audit_rewrite');
    });
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

  it('stops exposing a promoted release after a linked source right is revoked', async () => {
    await withFixture(async (client, f) => {
      const release = await client.query<{ id: string }>(
        `
        INSERT INTO research_knowledge_releases (
          tenant_id, namespace, release_key, version, title, claim_ids,
          source_list, evidence_grade, owner_user_id, validation_report
        )
        VALUES ($1, 'TENANT', $2, 1, 'Revocation visibility test', $3::jsonb,
          '[]'::jsonb, 'B', $4, '{}'::jsonb)
        RETURNING id::text AS id
        `,
        [f.tenantId, 'rights-' + randomUUID().slice(0, 8), JSON.stringify([f.claimId]), f.userId],
      );
      const evaluation = await client.query<{ id: string }>(
        `
        INSERT INTO research_release_evaluations (
          tenant_id, namespace, release_id, evaluation_version, status,
          content_fingerprint, results, evaluated_by
        )
        VALUES ($1, 'TENANT', $2, 'research-release-contract.v2', 'PASSED', $3,
          '{"consistencyPassed":true,"citationCoveragePassed":true,"rightsPassed":true,"safetyPassed":true}'::jsonb,
          $4)
        RETURNING id::text AS id
        `,
        [f.tenantId, release.rows[0].id, 'c'.repeat(64), f.userId],
      );
      await client.query(
        `
        UPDATE research_knowledge_releases
        SET evaluation_id = $1, status = 'PROMOTED',
          validation_report = '{"consistencyPassed":true,"citationCoveragePassed":true,"rightsPassed":true,"safetyPassed":true,"safetyReviewed":true}'::jsonb,
          regression_evidence_ref = 'external-regression:rights-visibility',
          reviewed_by = $2, reviewed_at = clock_timestamp(), effective_at = clock_timestamp()
        WHERE id = $3
        `,
        [evaluation.rows[0].id, f.userId, release.rows[0].id],
      );

      const visibleBeforeRevocation = await client.query<{ id: string }>(
        `
        SELECT r.id::text AS id
        FROM research_knowledge_releases r
        WHERE (r.tenant_id = $1 OR (r.tenant_id IS NULL AND r.status = 'PROMOTED'))
          AND (
            r.status <> 'PROMOTED'
            OR NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(r.claim_ids) AS release_claim(claim_id)
              WHERE NOT EXISTS (
                SELECT 1
                FROM research_claims c
                JOIN research_sources s ON s.id = c.source_id AND s.namespace = c.namespace
                WHERE c.id::text = release_claim.claim_id
                  AND c.status = 'APPROVED'
                  AND (c.tenant_id = $1 OR c.tenant_id IS NULL)
                  AND s.access_status = 'APPROVED'
                  AND s.license_status IN ('OPEN_ACCESS', 'LICENSED', 'USER_PROVIDED_AUTHORIZED')
                  AND NULLIF(BTRIM(s.rights_basis), '') IS NOT NULL
              )
            )
          )
          AND r.id = $2
        `,
        [f.tenantId, release.rows[0].id],
      );
      expect(visibleBeforeRevocation.rows).toHaveLength(1);

      await client.query(
        'UPDATE research_sources SET access_status = $1, review_reason = $2, reviewed_by = $3, reviewed_at = clock_timestamp() WHERE id = $4',
        ['REVOKED', 'Source license withdrawn by rights holder', f.userId, f.sourceId],
      );
      const visibleAfterRevocation = await client.query<{ id: string }>(
        `
        SELECT r.id::text AS id
        FROM research_knowledge_releases r
        WHERE (r.tenant_id = $1 OR (r.tenant_id IS NULL AND r.status = 'PROMOTED'))
          AND (
            r.status <> 'PROMOTED'
            OR NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(r.claim_ids) AS release_claim(claim_id)
              WHERE NOT EXISTS (
                SELECT 1
                FROM research_claims c
                JOIN research_sources s ON s.id = c.source_id AND s.namespace = c.namespace
                WHERE c.id::text = release_claim.claim_id
                  AND c.status = 'APPROVED'
                  AND (c.tenant_id = $1 OR c.tenant_id IS NULL)
                  AND s.access_status = 'APPROVED'
                  AND s.license_status IN ('OPEN_ACCESS', 'LICENSED', 'USER_PROVIDED_AUTHORIZED')
                  AND NULLIF(BTRIM(s.rights_basis), '') IS NOT NULL
              )
            )
          )
          AND r.id = $2
        `,
        [f.tenantId, release.rows[0].id],
      );
      expect(visibleAfterRevocation.rows).toHaveLength(0);
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
          $1, 'TENANT', $2, 'research-release-contract.v2', 'PASSED', $3,
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
      await client.query(
        `INSERT INTO growth_opportunity_decision_owners
           (tenant_id, factory_id, opportunity_id, role_code, owner_user_id, rationale, assigned_by)
         VALUES ($1, $2, $3, 'DECISION_OWNER', $4,
           'Independent owner assigned for the acceptance contract test', $5)`,
        [f.tenantId, f.factoryId, opportunity.rows[0].id, f.decisionUserId, f.userId],
      );
      await client.query("SELECT set_config('app.user_id', $1, true)", [f.decisionUserId]);
      await client.query('SAVEPOINT require_evidence');
      await expect(client.query(
        `
        UPDATE growth_opportunities
        SET status = 'ACCEPTED', decided_by = $1, decided_at = clock_timestamp(), decision_reason = 'approve'
        WHERE id = $2
        `,
        [f.decisionUserId, opportunity.rows[0].id],
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
      const seededAssumption = await client.query<{ id: string }>(
        'SELECT id::text AS id FROM growth_opportunity_assumptions WHERE opportunity_id = $1 AND tenant_id = $2 AND factory_id = $3 ORDER BY created_at, id LIMIT 1',
        [opportunityId, f.tenantId, f.factoryId],
      );
      expect(seededAssumption.rows[0]).toBeDefined();
      await client.query(
        `INSERT INTO growth_opportunity_assumption_decisions
           (tenant_id, factory_id, opportunity_id, assumption_id, decision, reason, evidence_refs, decided_by)
         VALUES ($1,$2,$3,$4,'VALIDATED',
           'Baseline assumption verified against monthly quality evidence',
           '["quality-report:monthly-scrap"]'::jsonb,$5)`,
        [f.tenantId, f.factoryId, opportunityId, seededAssumption.rows[0].id, f.userId],
      );
      for (const dimension of ['CAPACITY', 'QUALITY', 'CASH', 'DELIVERY']) {
        await client.query(
          `INSERT INTO growth_opportunity_constraints
             (tenant_id, factory_id, opportunity_id, dimension, applicability, constraint_name,
              rationale, owner_user_id, created_by)
           VALUES ($1,$2,$3,$4,'NOT_APPLICABLE',$5,
             'Reviewed and explicitly judged non-blocking for the narrow scenario fixture',
             $6,$6)`,
          [f.tenantId, f.factoryId, opportunityId, dimension, dimension + ' reviewed for fixture', f.userId],
        );
      }
      await client.query(
        `INSERT INTO growth_opportunity_decision_owners
           (tenant_id, factory_id, opportunity_id, role_code, owner_user_id, rationale, assigned_by)
         VALUES ($1, $2, $3, 'DECISION_OWNER', $4,
           'Independent owner assigned after evidence and constraints were reviewed', $5)`,
        [f.tenantId, f.factoryId, opportunityId, f.decisionUserId, f.userId],
      );
      await client.query("SELECT set_config('app.user_id', $1, true)", [f.decisionUserId]);
      await client.query(
        `
        UPDATE growth_opportunities
        SET status = 'ACCEPTED', decided_by = $1, decided_at = clock_timestamp(), decision_reason = 'approved with evidence'
        WHERE id = $2
        `,
        [f.decisionUserId, opportunityId],
      );
      await client.query("SELECT set_config('app.user_id', $1, true)", [f.userId]);
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


  it('binds an experiment result to its original opportunity and prevents duplicate realized outcomes', async () => {
    await withFixture(async (client, f) => {
      const opportunityInsert = `
        INSERT INTO growth_opportunities (
          tenant_id, factory_id, title, category, opportunity_statement, success_hypothesis,
          assumptions, constraints_snapshot, affected_business_nodes, expected_value_low,
          expected_value_high, currency, uncertainty_pct, effort, time_to_impact_days,
          implementation_risk, owner_user_id, status, created_by
        )
        VALUES ($1, $2, $3, 'COST_REDUCTION', 'Test opportunity result linkage',
          'The pilot outcome reflects the original hypothesis', '["baseline is current"]'::jsonb,
          '{}'::jsonb, '[]'::jsonb, 0, 100, 'BDT', 20, 'SMALL', 14, 'LOW', $4,
          'PROPOSED', $4)
        RETURNING id::text AS id
      `;
      const original = await client.query<{ id: string }>(
        opportunityInsert,
        [f.tenantId, f.factoryId, 'Original opportunity', f.userId],
      );
      const unrelated = await client.query<{ id: string }>(
        opportunityInsert,
        [f.tenantId, f.factoryId, 'Unrelated opportunity', f.userId],
      );

      const experiment = await client.query<{ id: string }>(
        `
        INSERT INTO growth_experiments (
          tenant_id, factory_id, opportunity_id, name, objective, hypothesis,
          leading_indicators, duration_days, owner_user_id, baseline_measurements,
          stop_conditions, created_by
        )
        VALUES ($1, $2, $3, 'Original pilot', 'Validate scrap reduction',
          'Scrap will decline without reducing quality', '["scrap_rate"]'::jsonb,
          14, $4, '{"scrap_rate":8.5}'::jsonb, '["quality yield falls"]'::jsonb, $4)
        RETURNING id::text AS id
        `,
        [f.tenantId, f.factoryId, original.rows[0].id, f.userId],
      );
      const result = await client.query<{ id: string }>(
        `
        INSERT INTO growth_experiment_results (
          tenant_id, factory_id, experiment_id, pre_measurements, post_measurements,
          assessment, stop_condition_triggered, evidence_refs, observed_at, recorded_by
        )
        VALUES ($1, $2, $3, '{"scrap_rate":8.5}'::jsonb, '{"scrap_rate":6.2}'::jsonb,
          'POSITIVE', FALSE, '["pilot-report:17"]'::jsonb, clock_timestamp(), $4)
        RETURNING id::text AS id
        `,
        [f.tenantId, f.factoryId, experiment.rows[0].id, f.userId],
      );

      await client.query('SAVEPOINT reject_cross_opportunity_result');
      await expect(client.query(
        `
        INSERT INTO growth_opportunity_outcomes (
          tenant_id, factory_id, opportunity_id, experiment_result_id, assessment,
          realized_metrics, evidence_refs, observed_at, recorded_by
        )
        VALUES ($1, $2, $3, $4, 'POSITIVE', '{"scrap_rate_delta_pct":-2.3}'::jsonb,
          '["pilot-report:17"]'::jsonb, clock_timestamp(), $5)
        `,
        [f.tenantId, f.factoryId, unrelated.rows[0].id, result.rows[0].id, f.userId],
      )).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT reject_cross_opportunity_result');

      await client.query(
        `
        INSERT INTO growth_opportunity_outcomes (
          tenant_id, factory_id, opportunity_id, experiment_result_id, assessment,
          realized_metrics, evidence_refs, observed_at, recorded_by
        )
        VALUES ($1, $2, $3, $4, 'POSITIVE', '{"scrap_rate_delta_pct":-2.3}'::jsonb,
          '["pilot-report:17"]'::jsonb, clock_timestamp(), $5)
        `,
        [f.tenantId, f.factoryId, original.rows[0].id, result.rows[0].id, f.userId],
      );

      await client.query('SAVEPOINT reject_duplicate_result_link');
      await expect(client.query(
        `
        INSERT INTO growth_opportunity_outcomes (
          tenant_id, factory_id, opportunity_id, experiment_result_id, assessment,
          realized_metrics, evidence_refs, observed_at, recorded_by
        )
        VALUES ($1, $2, $3, $4, 'POSITIVE', '{"scrap_rate_delta_pct":-2.3}'::jsonb,
          '["pilot-report:17"]'::jsonb, clock_timestamp(), $5)
        `,
        [f.tenantId, f.factoryId, original.rows[0].id, result.rows[0].id, f.userId],
      )).rejects.toMatchObject({ code: '23505' });
      await client.query('ROLLBACK TO SAVEPOINT reject_duplicate_result_link');
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
        .rejects.toMatchObject({ code: 'P0001' });
      await client.query('ROLLBACK TO SAVEPOINT protect_growth_learning_signal');
    });
  });

});
