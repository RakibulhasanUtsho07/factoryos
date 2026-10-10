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

import { CreateResearchClaimDto, ResearchClaimType } from './dto/create-research-claim.dto';
import { CreateResearchClaimEvidenceDto } from './dto/create-research-claim-evidence.dto';
import { ValidateResearchCitationDto } from './dto/validate-research-citation.dto';

type Verdict = 'VALID' | 'INVALID' | 'REVIEW_REQUIRED';
type Reason =
  | 'QUOTE_MATCHED'
  | 'QUOTE_MISMATCH'
  | 'QUOTE_HASH_MISMATCH'
  | 'RIGHTS_NOT_APPROVED'
  | 'SECURITY_NOT_APPROVED'
  | 'SOURCE_RIGHTS_RESTRICTED';

interface ClaimRow extends QueryResultRow {
  id: string; tenant_id: string; factory_id: string; claim_key: string;
  claim_version: string; claim_type: ResearchClaimType; statement: string;
  statement_sha256: string; request_hash: string; idempotency_key: string;
  created_by: string; created_at: string;
}
interface EvidenceRow extends QueryResultRow {
  id: string; tenant_id: string; factory_id: string; claim_id: string;
  source_id: string; content_id: string; content_sha256: string;
  quote_text: string; quote_sha256: string; start_offset: number; end_offset: number;
  locator: string | null; request_hash: string; idempotency_key: string;
  created_by: string; created_at: string;
}
interface ValidationInput extends QueryResultRow {
  claim_id: string; claim_key: string; claim_version: string; statement_sha256: string;
  evidence_id: string; source_id: string; content_id: string; content_sha256: string;
  canonical_text: string; quote_text: string; quote_sha256: string;
  start_offset: number; end_offset: number; source_rights_status: string;
  allow_research: boolean; latest_rights_decision: string | null; latest_rights_hash: string | null;
  latest_security_decision: string | null; latest_security_hash: string | null;
}

@Injectable()
export class ResearchClaimEvidenceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
  ) {}

  async createClaim(tenantId: string, factoryId: string, actorUserId: string, input: CreateResearchClaimDto) {
    this.validateScope(tenantId, factoryId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'research.claims.write', factoryId);
    const claimKey = this.requiredString(input.claim_key, 'claim_key', 200);
    const claimVersion = this.requiredString(input.claim_version, 'claim_version', 60);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(claimKey)) {
      throw new BadRequestException('claim_key contains unsupported characters');
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,59}$/.test(claimVersion)) {
      throw new BadRequestException('claim_version contains unsupported characters');
    }
    if (!Object.values(ResearchClaimType).includes(input.claim_type)) {
      throw new BadRequestException('claim_type is invalid');
    }
    const statement = this.normalizeStatement(input.statement);
    const idempotencyKey = this.normalizeIdempotencyKey(input.idempotency_key);
    const statementSha256 = this.sha256(statement);
    const requestHash = this.hashPayload({
      tenantId, factoryId, actorUserId, claimKey, claimVersion,
      claimType: input.claim_type, statement, statementSha256, idempotencyKey,
    });

    const query = 'SELECT id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id, ' +
      'claim_key, claim_version, claim_type, statement, statement_sha256, request_hash, idempotency_key, ' +
      'created_by::text AS created_by, created_at::text AS created_at ' +
      'FROM research_claim_registry WHERE tenant_id = $1 AND factory_id = $2 ' +
      'AND ((claim_key = $3 AND claim_version = $4) OR idempotency_key = $5) LIMIT 1';
    const priorResult = await this.database.query<ClaimRow>(
      query, [tenantId, factoryId, claimKey, claimVersion, idempotencyKey],
      { tenantId, userId: actorUserId },
    );
    const prior = priorResult.rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash) {
        throw new ConflictException('Claim key/version or idempotency key was already used for different content');
      }
      return { idempotent: true, claim: this.mapClaim(prior) };
    }

    const inserted = await this.database.query<ClaimRow>(
      'INSERT INTO research_claim_registry (id, tenant_id, factory_id, claim_key, claim_version, claim_type, ' +
      'statement, statement_sha256, request_hash, idempotency_key, created_by) ' +
      'VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING ' +
      'RETURNING id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id, ' +
      'claim_key, claim_version, claim_type, statement, statement_sha256, request_hash, idempotency_key, ' +
      'created_by::text AS created_by, created_at::text AS created_at',
      [tenantId, factoryId, claimKey, claimVersion, input.claim_type, statement, statementSha256, requestHash, idempotencyKey, actorUserId],
      { tenantId, userId: actorUserId },
    );
    let row = inserted.rows[0];
    if (!row) {
      const raced = await this.database.query<ClaimRow>(
        query, [tenantId, factoryId, claimKey, claimVersion, idempotencyKey],
        { tenantId, userId: actorUserId },
      );
      row = raced.rows[0];
      if (!row || row.request_hash !== requestHash) {
        throw new ConflictException('Claim was concurrently registered with conflicting content');
      }
      return { idempotent: true, claim: this.mapClaim(row) };
    }
    await this.auditSafely({
      tenantId, factoryId, actorUserId, eventType: 'RESEARCH_CLAIM_REGISTERED',
      action: 'REGISTER_IMMUTABLE_CLAIM', resourceType: 'RESEARCH_CLAIM', resourceId: row.id,
      payload: { claimKey, claimVersion, claimType: row.claim_type, statementSha256 },
    });
    return { idempotent: false, claim: this.mapClaim(row) };
  }

  async listClaims(tenantId: string, factoryId: string, actorUserId: string, filters: { claimKey?: string; limit?: number } = {}) {
    this.validateScope(tenantId, factoryId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'research.claims.read', factoryId);
    const limit = filters.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }
    const key = filters.claimKey ? this.requiredString(filters.claimKey, 'claim_key', 200) : null;
    const result = await this.database.query<ClaimRow>(
      'SELECT id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id, ' +
      'claim_key, claim_version, claim_type, statement, statement_sha256, request_hash, idempotency_key, ' +
      'created_by::text AS created_by, created_at::text AS created_at FROM research_claim_registry ' +
      'WHERE tenant_id = $1 AND factory_id = $2 AND ($3::varchar IS NULL OR claim_key = $3) ' +
      'ORDER BY created_at DESC, id DESC LIMIT $4',
      [tenantId, factoryId, key, limit], { tenantId, userId: actorUserId },
    );
    return { limit, claims: result.rows.map((row) => this.mapClaim(row)) };
  }

  async linkEvidence(
    tenantId: string, factoryId: string, actorUserId: string, claimId: string,
    input: CreateResearchClaimEvidenceDto,
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);
    this.requiredUuid(claimId, 'claimId');
    this.requiredUuid(input.source_id, 'source_id');
    await this.authorize(actorUserId, tenantId, 'research.claims.evidence.write', factoryId);

    const contentSha256 = this.normalizeSha256(input.content_sha256, 'content_sha256');
    const quoteText = this.normalizeQuote(input.quote_text);
    const quoteSha256 = this.sha256(quoteText);
    const startOffset = input.start_offset;
    const endOffset = input.end_offset;
    if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset) ||
        startOffset < 0 || endOffset <= startOffset || endOffset - startOffset > 4000) {
      throw new BadRequestException('Offsets must be a valid zero-based Unicode code-point range of 1-4000 characters');
    }
    const locator = input.locator === undefined ? null : this.requiredString(input.locator, 'locator', 300);
    const idempotencyKey = this.normalizeIdempotencyKey(input.idempotency_key);

    const claimResult = await this.database.query<QueryResultRow & { id: string }>(
      'SELECT id::text AS id FROM research_claim_registry WHERE tenant_id = $1 AND factory_id = $2 AND id = $3 LIMIT 1',
      [tenantId, factoryId, claimId], { tenantId, userId: actorUserId },
    );
    if (!claimResult.rows[0]) throw new NotFoundException('Research claim was not found in this factory');

    const sourceResult = await this.database.query<QueryResultRow & {
      content_id: string; canonical_text: string; registered_hash: string | null;
      source_format: string; original_file_sha256: string | null;
    }>(
      'SELECT t.id::text AS content_id, t.canonical_text, s.content_sha256 AS registered_hash, ' +
      't.source_format, t.original_file_sha256 FROM research_source_text_content t ' +
      'JOIN research_source_registry s ON s.id = t.source_id AND s.tenant_id = t.tenant_id AND s.factory_id = t.factory_id ' +
      'WHERE t.tenant_id = $1 AND t.factory_id = $2 AND t.source_id = $3 AND t.content_sha256 = $4 LIMIT 1',
      [tenantId, factoryId, input.source_id, contentSha256], { tenantId, userId: actorUserId },
    );
    const source = sourceResult.rows[0];
    if (!source) throw new NotFoundException('The requested source content hash was not ingested in this factory');
    const registeredHashMatches = source.registered_hash === null ||
      (source.source_format === 'PLAIN_TEXT' && source.registered_hash === contentSha256) ||
      (source.source_format !== 'PLAIN_TEXT' && source.registered_hash === source.original_file_sha256);
    if (!registeredHashMatches) throw new ConflictException('Source registry digest does not match this content version');
    if (endOffset > Array.from(source.canonical_text).length) {
      throw new BadRequestException('Evidence offsets exceed the extracted text length');
    }

    const requestHash = this.hashPayload({
      tenantId, factoryId, actorUserId, claimId, sourceId: input.source_id,
      contentId: source.content_id, contentSha256, quoteText, quoteSha256,
      startOffset, endOffset, locator, idempotencyKey,
    });
    const select = 'SELECT id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id, ' +
      'claim_id::text AS claim_id, source_id::text AS source_id, content_id::text AS content_id, ' +
      'content_sha256, quote_text, quote_sha256, start_offset, end_offset, locator, request_hash, ' +
      'idempotency_key, created_by::text AS created_by, created_at::text AS created_at ' +
      'FROM research_claim_evidence WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3 LIMIT 1';
    const priorResult = await this.database.query<EvidenceRow>(
      select, [tenantId, factoryId, idempotencyKey], { tenantId, userId: actorUserId },
    );
    const prior = priorResult.rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash) throw new ConflictException('Evidence idempotency key was reused for a different link');
      return { idempotent: true, evidence: this.mapEvidence(prior) };
    }

    const inserted = await this.database.query<EvidenceRow>(
      'INSERT INTO research_claim_evidence (id, tenant_id, factory_id, claim_id, source_id, content_id, content_sha256, ' +
      'quote_text, quote_sha256, start_offset, end_offset, locator, request_hash, idempotency_key, created_by) ' +
      'VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) ' +
      'ON CONFLICT DO NOTHING RETURNING id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id, ' +
      'claim_id::text AS claim_id, source_id::text AS source_id, content_id::text AS content_id, content_sha256, ' +
      'quote_text, quote_sha256, start_offset, end_offset, locator, request_hash, idempotency_key, ' +
      'created_by::text AS created_by, created_at::text AS created_at',
      [tenantId, factoryId, claimId, input.source_id, source.content_id, contentSha256, quoteText, quoteSha256,
        startOffset, endOffset, locator, requestHash, idempotencyKey, actorUserId],
      { tenantId, userId: actorUserId },
    );
    let row = inserted.rows[0];
    if (!row) {
      const raced = await this.database.query<EvidenceRow>(select, [tenantId, factoryId, idempotencyKey], { tenantId, userId: actorUserId });
      row = raced.rows[0];
      if (!row || row.request_hash !== requestHash) throw new ConflictException('Evidence link was concurrently recorded differently');
      return { idempotent: true, evidence: this.mapEvidence(row) };
    }
    await this.auditSafely({
      tenantId, factoryId, actorUserId, eventType: 'RESEARCH_CLAIM_EVIDENCE_LINKED',
      action: 'LINK_CLAIM_TO_SOURCE_QUOTE', resourceType: 'RESEARCH_CLAIM_EVIDENCE', resourceId: row.id,
      payload: {
        claimId, sourceId: row.source_id, contentSha256: row.content_sha256,
        quoteSha256: row.quote_sha256, startOffset: row.start_offset, endOffset: row.end_offset, locator: row.locator,
      },
    });
    return { idempotent: false, evidence: this.mapEvidence(row) };
  }

  async validateCitation(
    tenantId: string, factoryId: string, actorUserId: string, claimId: string,
    evidenceId: string, input: ValidateResearchCitationDto,
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);
    this.requiredUuid(claimId, 'claimId');
    this.requiredUuid(evidenceId, 'evidenceId');
    await this.authorize(actorUserId, tenantId, 'research.claims.validate', factoryId);
    const idempotencyKey = this.normalizeIdempotencyKey(input.idempotency_key);

    const sql = 'SELECT c.id::text AS claim_id, c.claim_key, c.claim_version, c.statement_sha256, ' +
      'e.id::text AS evidence_id, e.source_id::text AS source_id, e.content_id::text AS content_id, ' +
      'e.content_sha256, t.canonical_text, e.quote_text, e.quote_sha256, e.start_offset, e.end_offset, ' +
      's.rights_status AS source_rights_status, s.allow_research, ra.decision AS latest_rights_decision, ' +
      'ra.content_sha256 AS latest_rights_hash, sa.decision AS latest_security_decision, sa.content_sha256 AS latest_security_hash ' +
      'FROM research_claim_registry c JOIN research_claim_evidence e ON e.claim_id = c.id AND e.tenant_id = c.tenant_id AND e.factory_id = c.factory_id ' +
      'JOIN research_source_text_content t ON t.id = e.content_id AND t.source_id = e.source_id AND t.tenant_id = e.tenant_id AND t.factory_id = e.factory_id AND t.content_sha256 = e.content_sha256 ' +
      'JOIN research_source_registry s ON s.id = e.source_id AND s.tenant_id = e.tenant_id AND s.factory_id = e.factory_id ' +
      'LEFT JOIN LATERAL (SELECT decision, content_sha256 FROM research_source_assessments WHERE tenant_id = e.tenant_id AND factory_id = e.factory_id AND source_id = e.source_id AND assessment_type = $5 ORDER BY created_at DESC, id DESC LIMIT 1) ra ON TRUE ' +
      'LEFT JOIN LATERAL (SELECT decision, content_sha256 FROM research_source_assessments WHERE tenant_id = e.tenant_id AND factory_id = e.factory_id AND source_id = e.source_id AND assessment_type = $6 ORDER BY created_at DESC, id DESC LIMIT 1) sa ON TRUE ' +
      'WHERE c.tenant_id = $1 AND c.factory_id = $2 AND c.id = $3 AND e.id = $4 LIMIT 1';
    const result = await this.database.query<ValidationInput>(
      sql, [tenantId, factoryId, claimId, evidenceId, 'RIGHTS', 'SECURITY'],
      { tenantId, userId: actorUserId },
    );
    const evidence = result.rows[0];
    if (!evidence) throw new NotFoundException('Claim/evidence link was not found in this factory');

    const expectedQuoteHash = this.sha256(evidence.quote_text);
    const text = Array.from(evidence.canonical_text).slice(evidence.start_offset, evidence.end_offset).join('');
    let verdict: Verdict;
    let reasonCode: Reason;
    if (expectedQuoteHash !== evidence.quote_sha256) {
      verdict = 'INVALID'; reasonCode = 'QUOTE_HASH_MISMATCH';
    } else if (text !== evidence.quote_text) {
      verdict = 'INVALID'; reasonCode = 'QUOTE_MISMATCH';
    } else if (evidence.source_rights_status !== 'VERIFIED' || evidence.allow_research !== true) {
      verdict = 'REVIEW_REQUIRED'; reasonCode = 'SOURCE_RIGHTS_RESTRICTED';
    } else if (evidence.latest_rights_decision !== 'APPROVED' || evidence.latest_rights_hash !== evidence.content_sha256) {
      verdict = 'REVIEW_REQUIRED'; reasonCode = 'RIGHTS_NOT_APPROVED';
    } else if (evidence.latest_security_decision !== 'APPROVED' || evidence.latest_security_hash !== evidence.content_sha256) {
      verdict = 'REVIEW_REQUIRED'; reasonCode = 'SECURITY_NOT_APPROVED';
    } else {
      verdict = 'VALID'; reasonCode = 'QUOTE_MATCHED';
    }

    const requestHash = this.hashPayload({
      tenantId, factoryId, actorUserId, claimId, evidenceId, verdict, reasonCode,
      contentSha256: evidence.content_sha256, quoteSha256: evidence.quote_sha256, idempotencyKey,
    });
    const priorResult = await this.database.query<QueryResultRow & {
      id: string; request_hash: string; verdict: Verdict; reason_code: Reason; created_at: string;
    }>(
      'SELECT id::text AS id, request_hash, verdict, reason_code, created_at::text AS created_at ' +
      'FROM research_citation_validations WHERE tenant_id = $1 AND factory_id = $2 AND evidence_id = $3 AND idempotency_key = $4 LIMIT 1',
      [tenantId, factoryId, evidenceId, idempotencyKey], { tenantId, userId: actorUserId },
    );
    const prior = priorResult.rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash) throw new ConflictException('Validation idempotency key was used for a different validation outcome');
      return { idempotent: true, validation: this.mapValidation(prior, claimId, evidenceId) };
    }

    const inserted = await this.database.query<QueryResultRow & { id: string; created_at: string }>(
      'INSERT INTO research_citation_validations (id, tenant_id, factory_id, claim_id, evidence_id, verdict, reason_code, ' +
      'algorithm_version, content_sha256, quote_sha256, request_hash, idempotency_key, validated_by) ' +
      'VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT DO NOTHING ' +
      'RETURNING id::text AS id, created_at::text AS created_at',
      [tenantId, factoryId, claimId, evidenceId, verdict, reasonCode, 'factoryos-citation-check-v1',
        evidence.content_sha256, evidence.quote_sha256, requestHash, idempotencyKey, actorUserId],
      { tenantId, userId: actorUserId },
    );
    let validation = inserted.rows[0];
    if (!validation) {
      const raced = await this.database.query<QueryResultRow & { id: string; request_hash: string; created_at: string }>(
        'SELECT id::text AS id, request_hash, created_at::text AS created_at FROM research_citation_validations ' +
        'WHERE tenant_id = $1 AND factory_id = $2 AND evidence_id = $3 AND idempotency_key = $4 LIMIT 1',
        [tenantId, factoryId, evidenceId, idempotencyKey], { tenantId, userId: actorUserId },
      );
      const found = raced.rows[0];
      if (!found || found.request_hash !== requestHash) throw new ConflictException('Validation was concurrently recorded differently');
      validation = { id: found.id, created_at: found.created_at };
      return { idempotent: true, validation: { id: validation.id, claimId, evidenceId, verdict, reasonCode,
        algorithmVersion: 'factoryos-citation-check-v1', establishesClaimTruth: false,
        note: 'Citation traceability does not establish that the claim itself is true.', createdAt: validation.created_at } };
    }
    await this.auditSafely({
      tenantId, factoryId, actorUserId, eventType: 'RESEARCH_CITATION_VALIDATED',
      action: 'CHECK_QUOTE_TRACEABILITY', resourceType: 'RESEARCH_CITATION_VALIDATION',
      resourceId: validation.id,
      payload: { claimId, evidenceId, sourceId: evidence.source_id, contentSha256: evidence.content_sha256,
        quoteSha256: evidence.quote_sha256, verdict, reasonCode, algorithmVersion: 'factoryos-citation-check-v1' },
    });
    return { idempotent: false, validation: { id: validation.id, claimId, evidenceId, verdict, reasonCode,
      algorithmVersion: 'factoryos-citation-check-v1', establishesClaimTruth: false,
      note: 'Citation traceability does not establish that the claim itself is true.', createdAt: validation.created_at } };
  }

  async getClaimGraph(tenantId: string, factoryId: string, actorUserId: string, claimId: string) {
    this.validateScope(tenantId, factoryId, actorUserId);
    this.requiredUuid(claimId, 'claimId');
    await this.authorize(actorUserId, tenantId, 'research.claims.read', factoryId);
    const claimResult = await this.database.query<ClaimRow>(
      'SELECT id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id, claim_key, claim_version, ' +
      'claim_type, statement, statement_sha256, request_hash, idempotency_key, created_by::text AS created_by, created_at::text AS created_at ' +
      'FROM research_claim_registry WHERE tenant_id = $1 AND factory_id = $2 AND id = $3 LIMIT 1',
      [tenantId, factoryId, claimId], { tenantId, userId: actorUserId },
    );
    const claim = claimResult.rows[0];
    if (!claim) throw new NotFoundException('Research claim was not found in this factory');

    const evidenceResult = await this.database.query<EvidenceRow & {
      source_key: string; source_version: string; source_title: string; canonical_uri: string | null;
      latest_verdict: Verdict | null; latest_reason_code: Reason | null;
      latest_validation_id: string | null; latest_validation_at: string | null;
    }>(
      'SELECT e.id::text AS id, e.tenant_id::text AS tenant_id, e.factory_id::text AS factory_id, e.claim_id::text AS claim_id, ' +
      'e.source_id::text AS source_id, e.content_id::text AS content_id, e.content_sha256, e.quote_text, e.quote_sha256, ' +
      'e.start_offset, e.end_offset, e.locator, e.request_hash, e.idempotency_key, e.created_by::text AS created_by, e.created_at::text AS created_at, ' +
      's.source_key, s.source_version, s.title AS source_title, s.canonical_uri, v.verdict AS latest_verdict, v.reason_code AS latest_reason_code, ' +
      'v.id::text AS latest_validation_id, v.created_at::text AS latest_validation_at ' +
      'FROM research_claim_evidence e JOIN research_source_registry s ON s.id = e.source_id AND s.tenant_id = e.tenant_id AND s.factory_id = e.factory_id ' +
      'LEFT JOIN LATERAL (SELECT id, verdict, reason_code, created_at FROM research_citation_validations WHERE tenant_id = e.tenant_id ' +
      'AND factory_id = e.factory_id AND evidence_id = e.id ORDER BY created_at DESC, id DESC LIMIT 1) v ON TRUE ' +
      'WHERE e.tenant_id = $1 AND e.factory_id = $2 AND e.claim_id = $3 ORDER BY e.created_at, e.id',
      [tenantId, factoryId, claimId], { tenantId, userId: actorUserId },
    );
    return {
      claim: this.mapClaim(claim),
      evidence: evidenceResult.rows.map((row) => ({
        ...this.mapEvidence(row),
        source: { id: row.source_id, key: row.source_key, version: row.source_version, title: row.source_title, canonicalUri: row.canonical_uri },
        latestCitationValidation: row.latest_verdict ? {
          id: row.latest_validation_id, verdict: row.latest_verdict, reasonCode: row.latest_reason_code,
          createdAt: row.latest_validation_at, establishesClaimTruth: false,
        } : null,
      })),
    };
  }

  private mapClaim(row: ClaimRow) {
    return {
      id: row.id, tenantId: row.tenant_id, factoryId: row.factory_id, claimKey: row.claim_key,
      claimVersion: row.claim_version, claimType: row.claim_type, statement: row.statement,
      statementSha256: row.statement_sha256, createdBy: row.created_by, createdAt: row.created_at,
    };
  }
  private mapEvidence(row: EvidenceRow) {
    return {
      id: row.id, claimId: row.claim_id, sourceId: row.source_id, contentId: row.content_id,
      contentSha256: row.content_sha256, quoteText: row.quote_text, quoteSha256: row.quote_sha256,
      startOffset: row.start_offset, endOffset: row.end_offset, locator: row.locator,
      createdBy: row.created_by, createdAt: row.created_at,
    };
  }
  private mapValidation(
    row: { id: string; verdict: Verdict; reason_code: Reason; created_at: string },
    claimId: string, evidenceId: string,
  ) {
    return {
      id: row.id, claimId, evidenceId, verdict: row.verdict, reasonCode: row.reason_code,
      algorithmVersion: 'factoryos-citation-check-v1', establishesClaimTruth: false,
      note: 'Citation traceability does not establish that the claim itself is true.',
      createdAt: row.created_at,
    };
  }
  private async authorize(userId: string, tenantId: string, permission: string, factoryId: string) {
    await this.iamService.authorize(userId, tenantId, permission, factoryId);
  }
  private validateScope(tenantId: string, factoryId: string, actorUserId: string) {
    if (!isUUID(tenantId) || !isUUID(factoryId) || !isUUID(actorUserId)) {
      throw new BadRequestException('Authenticated tenant, factory, and user UUIDs are required');
    }
  }
  private requiredUuid(value: string, field: string) {
    if (typeof value !== 'string' || !isUUID(value)) throw new BadRequestException(field + ' must be a valid UUID');
    return value;
  }
  private requiredString(value: unknown, field: string, maxLength: number) {
    if (typeof value !== 'string') throw new BadRequestException(field + ' must be a string');
    const normalized = value.normalize('NFC').trim();
    if (!normalized || normalized.length > maxLength) {
      throw new BadRequestException(field + ' must contain 1-' + maxLength + ' characters');
    }
    return normalized;
  }
  private normalizeStatement(value: unknown) {
    const text = this.requiredString(value, 'statement', 4000);
    if (this.hasUnsupportedControls(text)) throw new BadRequestException('statement contains unsupported control characters');
    return text;
  }
  private normalizeQuote(value: unknown) {
    if (typeof value !== 'string') throw new BadRequestException('quote_text must be a string');
    const quote = value.normalize('NFC');
    if (!quote.trim() || Array.from(quote).length > 4000) throw new BadRequestException('quote_text must contain 1-4000 characters');
    if (this.hasUnsupportedControls(quote)) throw new BadRequestException('quote_text contains unsupported control characters');
    return quote;
  }
  private hasUnsupportedControls(value: string) {
    return Array.from(value).some((character) => {
      const cp = character.codePointAt(0) ?? 0;
      return cp <= 0x08 || cp === 0x0b || cp === 0x0c ||
        (cp >= 0x0e && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f);
    });
  }
  private normalizeIdempotencyKey(value: unknown) {
    const key = this.requiredString(value, 'idempotency_key', 128);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(key)) throw new BadRequestException('idempotency_key contains unsupported characters');
    return key;
  }
  private normalizeSha256(value: unknown, field: string) {
    if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) {
      throw new BadRequestException(field + ' must be a 64-character SHA-256 hex digest');
    }
    return value.toLowerCase();
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
      // Claim/evidence writes remain authoritative if audit delivery fails.
    }
  }
}
