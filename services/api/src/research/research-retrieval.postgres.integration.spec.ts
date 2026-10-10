import { createHash, randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';
import { Pool, type PoolClient } from 'pg';

import { ResearchRetrievalService } from './research-retrieval.service';

interface ScopeRow {
  tenant_id: string;
  factory_id: string;
  user_id: string;
}

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('Research retrieval PostgreSQL integration', () => {
  let pool!: Pool;
  let client!: PoolClient;
  let service!: ResearchRetrievalService;
  let tenantId!: string;
  let factoryId!: string;
  let userId!: string;

  beforeAll(async () => {
    const connectionString = process.env.TEST_ADMIN_DATABASE_URL;
    if (!connectionString) {
      throw new Error('TEST_ADMIN_DATABASE_URL is required for research retrieval integration tests.');
    }

    pool = new Pool({ connectionString });
    client = await pool.connect();
    await client.query('BEGIN');

    const scope = await client.query<ScopeRow>(
      `SELECT t.id::text AS tenant_id, f.id::text AS factory_id, u.id::text AS user_id
       FROM tenants t
       JOIN factories f ON f.tenant_id = t.id
       JOIN tenant_memberships tm ON tm.tenant_id = t.id AND tm.status = 'ACTIVE'
       JOIN users u ON u.id = tm.user_id AND u.status = 'ACTIVE'
       WHERE t.status = 'ACTIVE' AND f.status = 'ACTIVE'
       ORDER BY t.created_at, f.created_at, u.created_at
       LIMIT 1`,
    );
    const selected = scope.rows[0];
    if (!selected) throw new Error('No active tenant/factory/user exists in the PostgreSQL integration fixture.');
    tenantId = selected.tenant_id;
    factoryId = selected.factory_id;
    userId = selected.user_id;

    service = new ResearchRetrievalService(
      {
        query: (sql: string, values?: unknown[]) => client.query(sql, values),
      } as never,
      { authorize: jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined) } as never,
      { record: jest.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue('audit-id') } as never,
    );

    await createFixture({
      sourceType: 'DOCUMENT',
      claimType: 'FACT',
      statement: 'Yield achieved above 95 percent during inspection.',
      title: 'Quality yield report',
      quote: 'Yield achieved above 95 percent',
    });
    await createFixture({
      sourceType: 'INTERNAL',
      claimType: 'RECOMMENDATION',
      statement: 'Yield improvement recommendation for the next batch.',
      title: 'Yield improvement note',
      quote: 'Yield improvement recommendation',
    });
  }, 60_000);

  async function createFixture(input: {
    sourceType: 'DOCUMENT' | 'INTERNAL';
    claimType: 'FACT' | 'RECOMMENDATION';
    statement: string;
    title: string;
    quote: string;
  }) {
    const nonce = randomUUID();
    const sourceId = randomUUID();
    const claimId = randomUUID();
    const contentText = `Reference excerpt: ${input.quote}. Additional source context.`;
    const contentHash = sha256(contentText);
    const quoteHash = sha256(input.quote);
    const statementHash = sha256(input.statement);
    const requestHash = sha256(nonce);
    const startOffset = Array.from(contentText.slice(0, contentText.indexOf(input.quote))).length;
    const endOffset = startOffset + Array.from(input.quote).length;

    await client.query(
      `INSERT INTO research_source_registry (
         id, tenant_id, factory_id, source_key, source_version, source_type, title,
         content_sha256, rights_status, rights_basis, license_label, allow_research,
         allow_model_training, allow_redistribution, request_hash, created_by
       ) VALUES ($1,$2,$3,$4,'v1',$5,$6,$7,'VERIFIED','Approved for integration test','fixture-license',true,false,false,$8,$9)`,
      [sourceId, tenantId, factoryId, `retrieval.test.${nonce}`, input.sourceType, input.title, contentHash, requestHash, userId],
    );

    const content = await client.query<{ id: string }>(
      `INSERT INTO research_source_text_content (
         tenant_id, factory_id, source_id, content_sha256, canonical_text,
         character_count, line_count, parser_version, source_format, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,1,'factoryos-plain-text-v1','PLAIN_TEXT',$7)
       RETURNING id::text AS id`,
      [tenantId, factoryId, sourceId, contentHash, contentText, Array.from(contentText).length, userId],
    );
    const contentId = content.rows[0]?.id;
    if (!contentId) throw new Error('Research source text fixture was not inserted.');

    await client.query(
      `INSERT INTO research_claim_registry (
         id, tenant_id, factory_id, claim_key, claim_version, claim_type, statement,
         statement_sha256, request_hash, idempotency_key, created_by
       ) VALUES ($1,$2,$3,$4,'v1',$5,$6,$7,$8,$9,$10)`,
      [claimId, tenantId, factoryId, `retrieval.claim.${nonce}`, input.claimType, input.statement, statementHash, requestHash, `claim-${nonce}`, userId],
    );

    await client.query(
      `INSERT INTO research_claim_evidence (
         tenant_id, factory_id, claim_id, source_id, content_id, content_sha256,
         quote_text, quote_sha256, start_offset, end_offset, request_hash, idempotency_key, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [tenantId, factoryId, claimId, sourceId, contentId, contentHash, input.quote, quoteHash, startOffset, endOffset, requestHash, `evidence-${nonce}`, userId],
    );

    for (const assessmentType of ['RIGHTS', 'SECURITY']) {
      await client.query(
        `INSERT INTO research_source_assessments (
           tenant_id, factory_id, source_id, assessment_type, decision, assessment_method,
           content_sha256, assessment_basis, idempotency_key, request_hash, assessed_by
         ) VALUES ($1,$2,$3,$4,'APPROVED','MANUAL',$5,'Approved integration fixture',$6,$7,$8)`,
        [tenantId, factoryId, sourceId, assessmentType, contentHash, `${assessmentType.toLowerCase()}-${nonce}`, requestHash, userId],
      );
    }

    await client.query(
      `INSERT INTO research_citation_validations (
         tenant_id, factory_id, claim_id, evidence_id, verdict, reason_code,
         algorithm_version, content_sha256, quote_sha256, request_hash, idempotency_key, validated_by
       )
       SELECT $1,$2,$3,e.id,'VALID','QUOTE_MATCHED','factoryos-citation-check-v1',$4,$5,$6,$7,$8
       FROM research_claim_evidence e
       WHERE e.tenant_id=$1 AND e.factory_id=$2 AND e.claim_id=$3`,
      [tenantId, factoryId, claimId, contentHash, quoteHash, requestHash, `validation-${nonce}`, userId],
    );
  }

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    if (pool) await pool.end();
  });

  it('runs real PostgreSQL ranked retrieval with stable pagination and claim/source filters', async () => {
    const firstPage = await service.search(tenantId, factoryId, userId, {
      query: 'yield',
      limit: 1,
    });
    const secondPage = await service.search(tenantId, factoryId, userId, {
      query: 'yield',
      limit: 1,
      offset: 1,
    });

    expect(firstPage.resultCount).toBe(1);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextOffset).toBe(1);
    expect(secondPage.resultCount).toBe(1);
    expect(secondPage.results[0]?.rank).toBe(2);
    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.nextOffset).toBeNull();
    expect(firstPage.results[0]?.claim.id).not.toBe(secondPage.results[0]?.claim.id);

    const filtered = await service.search(tenantId, factoryId, userId, {
      query: 'yield',
      limit: 10,
      source_type: 'DOCUMENT' as never,
      claim_type: 'FACT' as never,
    });
    expect(filtered.resultCount).toBe(1);
    expect(filtered.results[0]?.source.type).toBe('DOCUMENT');
    expect(filtered.results[0]?.claim.type).toBe('FACT');
    expect(filtered.results[0]?.validation.verdict).toBe('VALID');
    expect(filtered.results[0]?.validation.establishesClaimTruth).toBe(false);
  });
});
