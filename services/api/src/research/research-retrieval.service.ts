import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { isUUID } from 'class-validator';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { IamService } from '../iam/iam.service';

import { ResearchRetrievalDto } from './dto/research-retrieval.dto';

interface ResearchRetrievalRow extends QueryResultRow {
  claim_id: string;
  claim_key: string;
  claim_version: string;
  claim_type: 'FACT' | 'INFERENCE' | 'RECOMMENDATION' | 'OPINION';
  statement: string;
  statement_sha256: string;
  evidence_id: string;
  source_id: string;
  content_id: string;
  content_sha256: string;
  quote_text: string;
  quote_sha256: string;
  start_offset: number;
  end_offset: number;
  locator: string | null;
  evidence_created_at: string;
  source_key: string;
  source_version: string;
  source_type: string;
  source_title: string;
  canonical_uri: string | null;
  validation_id: string;
  validation_verdict: 'VALID';
  validation_reason_code: 'QUOTE_MATCHED';
  validation_created_at: string;
  relevance_score: number | string;
}

const RETRIEVAL_SQL =
  'SELECT c.id::text AS claim_id, c.claim_key, c.claim_version, c.claim_type, c.statement, c.statement_sha256, ' +
  'e.id::text AS evidence_id, e.source_id::text AS source_id, e.content_id::text AS content_id, ' +
  'e.content_sha256, e.quote_text, e.quote_sha256, e.start_offset, e.end_offset, e.locator, ' +
  'e.created_at::text AS evidence_created_at, s.source_key, s.source_version, s.source_type, ' +
  's.title AS source_title, s.canonical_uri, v.id::text AS validation_id, v.verdict AS validation_verdict, ' +
  'v.reason_code AS validation_reason_code, v.created_at::text AS validation_created_at, ' +
  '(ts_rank_cd(to_tsvector(\\'simple\\', c.statement), q.tsq) + ' +
  '0.75 * ts_rank_cd(to_tsvector(\\'simple\\', e.quote_text), q.tsq) + ' +
  '0.25 * ts_rank_cd(to_tsvector(\\'simple\\', s.title || \\' \\' || s.source_key), q.tsq))::float8 AS relevance_score ' +
  'FROM research_claim_registry c ' +
  'JOIN research_claim_evidence e ON e.claim_id = c.id AND e.tenant_id = c.tenant_id AND e.factory_id = c.factory_id ' +
  'JOIN research_source_registry s ON s.id = e.source_id AND s.tenant_id = e.tenant_id AND s.factory_id = e.factory_id ' +
  'JOIN research_source_text_content t ON t.id = e.content_id AND t.source_id = e.source_id ' +
  'AND t.tenant_id = e.tenant_id AND t.factory_id = e.factory_id AND t.content_sha256 = e.content_sha256 ' +
  'CROSS JOIN (SELECT plainto_tsquery(\\'simple\\', $3::text) AS tsq) q ' +
  'LEFT JOIN LATERAL (SELECT decision, content_sha256 FROM research_source_assessments ' +
  'WHERE tenant_id = e.tenant_id AND factory_id = e.factory_id AND source_id = e.source_id ' +
  'AND assessment_type = \\'RIGHTS\\' ORDER BY created_at DESC, id DESC LIMIT 1) rights ON TRUE ' +
  'LEFT JOIN LATERAL (SELECT decision, content_sha256 FROM research_source_assessments ' +
  'WHERE tenant_id = e.tenant_id AND factory_id = e.factory_id AND source_id = e.source_id ' +
  'AND assessment_type = \\'SECURITY\\' ORDER BY created_at DESC, id DESC LIMIT 1) security ON TRUE ' +
  'LEFT JOIN LATERAL (SELECT id, verdict, reason_code, content_sha256, quote_sha256, created_at ' +
  'FROM research_citation_validations WHERE tenant_id = e.tenant_id AND factory_id = e.factory_id ' +
  'AND claim_id = c.id AND evidence_id = e.id ORDER BY created_at DESC, id DESC LIMIT 1) v ON TRUE ' +
  'WHERE c.tenant_id = $1 AND c.factory_id = $2 ' +
  'AND (to_tsvector(\\'simple\\', c.statement) @@ q.tsq ' +
  'OR to_tsvector(\\'simple\\', e.quote_text) @@ q.tsq ' +
  'OR to_tsvector(\\'simple\\', s.title || \\' \\' || s.source_key) @@ q.tsq) ' +
  'AND s.registry_status = \\'REGISTERED\\' AND s.rights_status = \\'VERIFIED\\' AND s.allow_research IS TRUE ' +
  'AND rights.decision = \\'APPROVED\\' AND rights.content_sha256 = e.content_sha256 ' +
  'AND security.decision = \\'APPROVED\\' AND security.content_sha256 = e.content_sha256 ' +
  'AND v.verdict = \\'VALID\\' AND v.reason_code = \\'QUOTE_MATCHED\\' ' +
  'AND v.content_sha256 = e.content_sha256 AND v.quote_sha256 = e.quote_sha256 ' +
  'ORDER BY relevance_score DESC, c.created_at DESC, e.created_at DESC, e.id ' +
  'LIMIT $4';

@Injectable()
export class ResearchRetrievalService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
  ) {}

  async search(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    input: ResearchRetrievalDto,
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);
    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'research.retrieval.search',
      factoryId,
    );

    const query = this.normalizeQuery(input?.query);
    const limit = input?.limit === undefined ? 10 : input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new BadRequestException('limit must be an integer between 1 and 20');
    }

    const found = await this.database.query<ResearchRetrievalRow>(
      RETRIEVAL_SQL,
      [tenantId, factoryId, query, limit],
      { tenantId, userId: actorUserId },
    );

    const querySha256 = this.sha256(query);
    await this.auditSafely({
      tenantId,
      factoryId,
      actorUserId,
      querySha256,
      limit,
      resultCount: found.rows.length,
    });

    return {
      query,
      limit,
      resultCount: found.rows.length,
      retrievalMethod: 'postgresql-full-text-simple-v1',
      rankingSemantics: 'LEXICAL_RELEVANCE_ONLY',
      note: 'Results contain only evidence with current source approvals and a latest VALID citation check. Relevance is not confidence in the claim truth.',
      results: found.rows.map((row, index) => ({
        rank: index + 1,
        relevanceScore: this.score(row.relevance_score),
        claim: {
          id: row.claim_id,
          key: row.claim_key,
          version: row.claim_version,
          type: row.claim_type,
          statement: row.statement,
          statementSha256: row.statement_sha256,
        },
        citation: {
          evidenceId: row.evidence_id,
          quoteText: row.quote_text,
          quoteSha256: row.quote_sha256,
          startOffset: row.start_offset,
          endOffset: row.end_offset,
          locator: row.locator,
          contentId: row.content_id,
          contentSha256: row.content_sha256,
        },
        source: {
          id: row.source_id,
          key: row.source_key,
          version: row.source_version,
          type: row.source_type,
          title: row.source_title,
          canonicalUri: row.canonical_uri,
        },
        validation: {
          id: row.validation_id,
          verdict: row.validation_verdict,
          reasonCode: row.validation_reason_code,
          validatedAt: row.validation_created_at,
          establishesClaimTruth: false,
        },
      })),
    };
  }

  private validateScope(tenantId: string, factoryId: string, actorUserId: string) {
    if (!isUUID(tenantId) || !isUUID(factoryId) || !isUUID(actorUserId)) {
      throw new BadRequestException('Authenticated tenant, factory, and user UUIDs are required');
    }
  }

  private normalizeQuery(value: unknown) {
    if (typeof value !== 'string') {
      throw new BadRequestException('query must be a string');
    }
    const query = value.normalize('NFC').trim();
    if (query.length < 2 || query.length > 500) {
      throw new BadRequestException('query must contain 2-500 characters');
    }
    if (Array.from(query).some((character) => {
      const cp = character.codePointAt(0) ?? 0;
      return cp <= 0x08 || cp === 0x0b || cp === 0x0c ||
        (cp >= 0x0e && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f);
    })) {
      throw new BadRequestException('query contains unsupported control characters');
    }
    return query;
  }

  private score(value: number | string) {
    const score = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(score) && score >= 0 ? score : 0;
  }

  private sha256(value: string) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private async auditSafely(input: {
    tenantId: string;
    factoryId: string;
    actorUserId: string;
    querySha256: string;
    limit: number;
    resultCount: number;
  }) {
    try {
      await this.auditService.record({
        tenantId: input.tenantId,
        factoryId: input.factoryId,
        actorUserId: input.actorUserId,
        eventType: 'RESEARCH_RETRIEVAL_SEARCHED',
        action: 'SEARCH_APPROVED_RESEARCH_EVIDENCE',
        resourceType: 'RESEARCH_RETRIEVAL_QUERY',
        resourceId: input.factoryId,
        dataClass: 'INTERNAL',
        payload: {
          querySha256: input.querySha256,
          resultCount: input.resultCount,
          limit: input.limit,
          retrievalMethod: 'postgresql-full-text-simple-v1',
        },
      });
    } catch {
      // Retrieval results do not depend on best-effort audit delivery.
    }
  }
}
