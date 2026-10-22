import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient } from 'pg';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import {
  parseResearchDocument,
  RESEARCH_DOCUMENT_PARSER_VERSION,
  researchTextSignatureSimilarity,
} from './research-source-document-parser';
import {
  ResearchSourceAdapterService,
  type ResearchAuthenticityEvidence,
  type ResearchSourceIdentity,
} from './research-source-adapters';

type DbRow = Record<string, any>;
type QueryResult = { rows: DbRow[] };

export interface UploadedResearchFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

const PERMITTED_LICENSES = ['OPEN_ACCESS', 'LICENSED', 'USER_PROVIDED_AUTHORIZED'];
const DOCUMENT_IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

@Injectable()
export class ResearchSourceProductionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly adapters: ResearchSourceAdapterService,
  ) {}

  async verifySourceAuthenticity(
    userId: string,
    tenantId: string,
    sourceId: string,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, sourceId);
    const selected = await this.database.query<DbRow>(
      `SELECT id::text AS id,source_type,title,doi,source_url,source_metadata,
          source_revision,rights_version,license_status,access_status,rights_basis,
          full_text_storage_allowed
       FROM research_sources
       WHERE id=$1 AND tenant_id=$2 AND namespace='TENANT'`,
      [sourceId, tenantId],
      { tenantId, userId },
    );
    const source = selected.rows[0];
    if (!source) throw new NotFoundException('Tenant research source not found');

    const checkedRevision = Number(source.source_revision);
    const checkedRightsVersion = Number(source.rights_version);
    const evidence = await this.adapters.verify({
      doi: source.doi,
      title: source.title,
      source_url: source.source_url,
      source_metadata: source.source_metadata,
    } satisfies ResearchSourceIdentity);

    return this.database.transaction({ tenantId, userId }, async (client: PoolClient) => {
      const currentResult = await client.query<DbRow>(
        `SELECT source_revision,rights_version FROM research_sources
         WHERE id=$1 AND tenant_id=$2 AND namespace='TENANT' FOR UPDATE`,
        [sourceId, tenantId],
      );
      const current = currentResult.rows[0];
      if (!current) throw new NotFoundException('Tenant research source not found');
      if (Number(current.source_revision) !== checkedRevision
          || Number(current.rights_version) !== checkedRightsVersion) {
        throw new ConflictException({
          code: 'RESEARCH_SOURCE_CHANGED_DURING_AUTHENTICITY_CHECK',
          message: 'Source or rights changed while the provider request was in flight; run a new check',
        });
      }

      const inserted = await client.query<DbRow>(
        `INSERT INTO research_source_authenticity_checks (
           tenant_id,source_id,source_revision,rights_version,provider,verification_status,
           provider_record_id,canonical_doi,canonical_url,provider_title,title_similarity,
           response_sha256,reason_code,evidence,checked_by,checked_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16::timestamptz)
         RETURNING id::text AS id,tenant_id::text AS tenant_id,source_id::text AS source_id,
           source_revision,rights_version,provider,verification_status,provider_record_id,
           canonical_doi,canonical_url,provider_title,title_similarity,response_sha256,
           reason_code,checked_by::text AS checked_by,checked_at::text AS checked_at`,
        [
          tenantId, sourceId, checkedRevision, checkedRightsVersion, evidence.provider,
          evidence.status, evidence.provider_record_id, evidence.canonical_doi, evidence.canonical_url,
          evidence.provider_title, evidence.title_similarity, evidence.response_sha256,
          evidence.reason_code, JSON.stringify(this.safeEvidence(evidence)), userId, evidence.checked_at,
        ],
      );
      const check = inserted.rows[0];
      if (!check) throw new Error('RESEARCH_SOURCE_AUTHENTICITY_CHECK_INSERT_FAILED');
      await this.auditInTransaction(client, {
        tenantId,
        userId,
        action: 'RESEARCH_SOURCE_AUTHENTICITY_CHECKED',
        resourceType: 'RESEARCH_SOURCE_AUTHENTICITY_CHECK',
        resourceId: String(check.id),
        requestId,
        traceId,
        payload: {
          sourceId,
          provider: evidence.provider,
          verificationStatus: evidence.status,
          sourceRevision: checkedRevision,
          rightsVersion: checkedRightsVersion,
          reasonCode: evidence.reason_code,
          responseSha256: evidence.response_sha256,
        },
      });
      return {
        check,
        nextStep: evidence.status === 'VERIFIED'
          ? 'A different research.review user must ACCEPT or REJECT this provider match.'
          : 'Resolve the identity mismatch or record a human REJECT decision; non-verified evidence cannot be accepted.',
      };
    });
  }

  async decideAuthenticity(
    userId: string,
    tenantId: string,
    sourceId: string,
    checkId: string,
    decision: 'ACCEPT' | 'REJECT',
    reasonInput: string,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, sourceId);
    this.assertUuid(checkId, 'checkId');
    if (!['ACCEPT', 'REJECT'].includes(decision)) {
      throw new BadRequestException('Authenticity decision must be ACCEPT or REJECT');
    }
    const reason = this.requiredText(reasonInput, 'reason', 2000);
    if (reason.length < 10) throw new BadRequestException('Authenticity review reason must contain at least 10 characters');

    return this.database.transaction({ tenantId, userId }, async (client: PoolClient) => {
      const selected = await client.query<DbRow>(
        `SELECT c.id::text AS id,c.source_id::text AS source_id,c.tenant_id::text AS tenant_id,
            c.source_revision,c.rights_version,c.verification_status,c.checked_by::text AS checked_by,
            s.source_revision AS current_source_revision,s.rights_version AS current_rights_version
         FROM research_source_authenticity_checks c
         JOIN research_sources s ON s.id=c.source_id AND s.tenant_id=c.tenant_id
         WHERE c.id=$1 AND c.source_id=$2 AND c.tenant_id=$3
         FOR UPDATE OF c,s`,
        [checkId, sourceId, tenantId],
      );
      const check = selected.rows[0];
      if (!check) throw new NotFoundException('Source authenticity check not found for this tenant/source');
      if (String(check.checked_by) === userId) {
        throw new ForbiddenException('A different reviewer must decide the authenticity check');
      }
      if (Number(check.source_revision) !== Number(check.current_source_revision)
          || Number(check.rights_version) !== Number(check.current_rights_version)) {
        throw new ConflictException({
          code: 'RESEARCH_SOURCE_AUTHENTICITY_REVIEW_STALE',
          message: 'Source or rights changed after provider verification; run a new check',
        });
      }
      if (decision === 'ACCEPT' && check.verification_status !== 'VERIFIED') {
        throw new ConflictException({
          code: 'RESEARCH_SOURCE_AUTHENTICITY_ACCEPT_REQUIRES_VERIFIED',
          message: 'Only an exact provider identifier and sufficiently matching title can be accepted',
        });
      }

      const inserted = await client.query<DbRow>(
        `INSERT INTO research_source_authenticity_reviews (
           tenant_id,source_id,authenticity_check_id,source_revision,rights_version,
           decision,reason,reviewed_by
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id::text AS id,source_id::text AS source_id,
           authenticity_check_id::text AS authenticity_check_id,source_revision,rights_version,
           decision,reason,reviewed_by::text AS reviewed_by,reviewed_at::text AS reviewed_at`,
        [
          tenantId, sourceId, checkId, Number(check.source_revision), Number(check.rights_version),
          decision, reason, userId,
        ],
      );
      const review = inserted.rows[0];
      if (!review) throw new Error('RESEARCH_SOURCE_AUTHENTICITY_REVIEW_INSERT_FAILED');
      await this.auditInTransaction(client, {
        tenantId,
        userId,
        action: 'RESEARCH_SOURCE_AUTHENTICITY_REVIEWED',
        resourceType: 'RESEARCH_SOURCE_AUTHENTICITY_CHECK',
        resourceId: checkId,
        requestId,
        traceId,
        payload: { sourceId, checkId, decision, sourceRevision: Number(check.source_revision), rightsVersion: Number(check.rights_version), reason },
      });
      return review;
    });
  }

  async listAuthenticityHistory(userId: string, tenantId: string, sourceId: string, limit = 100) {
    this.validateScope(userId, tenantId, sourceId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new BadRequestException('limit must be between 1 and 200');
    }
    const result = await this.database.query<DbRow>(
      `SELECT c.id::text AS id,c.source_revision,c.rights_version,c.provider,c.verification_status,
          c.provider_record_id,c.canonical_doi,c.canonical_url,c.provider_title,c.title_similarity,
          c.response_sha256,c.reason_code,c.evidence,c.checked_by::text AS checked_by,
          c.checked_at::text AS checked_at,r.id::text AS review_id,r.decision AS review_decision,
          r.reason AS review_reason,r.reviewed_by::text AS reviewed_by,r.reviewed_at::text AS reviewed_at
       FROM research_source_authenticity_checks c
       LEFT JOIN research_source_authenticity_reviews r
         ON r.authenticity_check_id=c.id AND r.tenant_id=c.tenant_id
       WHERE c.source_id=$1 AND c.tenant_id=$2
       ORDER BY c.checked_at DESC,c.id DESC LIMIT $3`,
      [sourceId, tenantId, limit],
      { tenantId, userId },
    );
    return result.rows;
  }

  async uploadDocument(
    userId: string,
    tenantId: string,
    sourceId: string,
    idempotencyKeyInput: string | null,
    file: UploadedResearchFile,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, sourceId);
    const idempotencyKey = String(idempotencyKeyInput ?? '').trim();
    if (!DOCUMENT_IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
      throw new BadRequestException('A valid Idempotency-Key header is required for customer-file ingestion');
    }
    if (!file?.buffer || !Buffer.isBuffer(file.buffer)) {
      throw new BadRequestException('Multipart field "file" is required');
    }
    if (file.size !== file.buffer.length) {
      throw new BadRequestException('Uploaded file size did not match the received byte count');
    }

    let parsed: ReturnType<typeof parseResearchDocument>;
    try {
      parsed = parseResearchDocument(file.buffer, file.mimetype);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'RESEARCH_DOCUMENT_PARSE_FAILED';
      throw new BadRequestException({ code, message: 'The upload is not an allowed, bounded text document' });
    }
    const originalFilename = this.safeFilename(file.originalname);
    const requestHash = this.hash({
      sourceId,
      idempotencyKey,
      originalFilename,
      mediaType: parsed.mediaType,
      contentSha256: parsed.contentSha256,
      normalizedTextSha256: parsed.normalizedTextSha256,
    });

    return this.database.transaction({ tenantId, userId }, async (client: PoolClient) => {
      const sourceResult = await client.query<DbRow>(
        `SELECT id::text AS id,source_type,source_revision,rights_version,license_status,
            access_status,rights_basis,full_text_storage_allowed
         FROM research_sources
         WHERE id=$1 AND tenant_id=$2 AND namespace='TENANT' FOR UPDATE`,
        [sourceId, tenantId],
      );
      const source = sourceResult.rows[0];
      if (!source) throw new NotFoundException('Tenant research source not found');
      this.assertUploadRights(source);

      const existingResult = await client.query<DbRow>(
        `SELECT id::text AS id,request_hash,storage_status,content_sha256,normalized_text_sha256,
            duplicate_of_document_id::text AS duplicate_of_document_id,similarity_score,
            source_revision,rights_version
         FROM research_source_documents
         WHERE tenant_id=$1 AND source_id=$2 AND idempotency_key=$3 FOR SHARE`,
        [tenantId, sourceId, idempotencyKey],
      );
      const existing = existingResult.rows[0];
      if (existing) {
        if (String(existing.request_hash) !== requestHash) {
          throw new ConflictException({
            code: 'RESEARCH_SOURCE_DOCUMENT_IDEMPOTENCY_CONFLICT',
            message: 'This Idempotency-Key was already used for different customer-file bytes or metadata',
          });
        }
        return { document: this.safeDocument(existing), idempotentReplay: true };
      }

      const candidates = await client.query<DbRow>(
        `SELECT id::text AS id,content_sha256,normalized_text_sha256,text_signature
         FROM research_source_documents
         WHERE tenant_id=$1 AND storage_status='STORED'
         ORDER BY created_at DESC LIMIT 200`,
        [tenantId],
      );
      let duplicate: { id: string; similarity: number } | null = null;
      for (const candidate of candidates.rows) {
        const score = String(candidate.content_sha256) === parsed.contentSha256
          || String(candidate.normalized_text_sha256) === parsed.normalizedTextSha256
          ? 1
          : researchTextSignatureSimilarity(candidate.text_signature, parsed.textSignature);
        if (score >= 0.9 && (!duplicate || score > duplicate.similarity)) {
          duplicate = { id: String(candidate.id), similarity: score };
        }
      }

      const revision = Number(source.source_revision);
      const rightsVersion = Number(source.rights_version);
      const inserted = await client.query<DbRow>(
        `INSERT INTO research_source_documents (
           tenant_id,source_id,source_revision,rights_version,idempotency_key,request_hash,
           original_filename,media_type,byte_size,content_sha256,extracted_text_sha256,
           normalized_text_sha256,text_signature,parser_version,duplicate_of_document_id,
           similarity_score,created_by
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17)
         RETURNING id::text AS id,source_id::text AS source_id,source_revision,rights_version,
           idempotency_key,original_filename,media_type,byte_size,content_sha256,extracted_text_sha256,
           normalized_text_sha256,parser_version,duplicate_of_document_id::text AS duplicate_of_document_id,
           similarity_score,storage_status,created_by::text AS created_by,created_at::text AS created_at,
           purged_at,purge_reason`,
        [
          tenantId, sourceId, revision, rightsVersion, idempotencyKey, requestHash,
          originalFilename, parsed.mediaType, file.buffer.length, parsed.contentSha256,
          parsed.extractedTextSha256, parsed.normalizedTextSha256, JSON.stringify(parsed.textSignature),
          RESEARCH_DOCUMENT_PARSER_VERSION, duplicate?.id ?? null, duplicate?.similarity ?? 0, userId,
        ],
      );
      const document = inserted.rows[0];
      if (!document) throw new Error('RESEARCH_SOURCE_DOCUMENT_INSERT_FAILED');
      await client.query(
        `INSERT INTO research_source_document_content (document_id,tenant_id,raw_content,extracted_text)
         VALUES ($1,$2,$3,$4)`,
        [String(document.id), tenantId, file.buffer, parsed.extractedText],
      );
      await this.auditInTransaction(client, {
        tenantId,
        userId,
        action: 'RESEARCH_SOURCE_DOCUMENT_UPLOADED',
        resourceType: 'RESEARCH_SOURCE_DOCUMENT',
        resourceId: String(document.id),
        requestId,
        traceId,
        payload: {
          sourceId,
          documentId: String(document.id),
          sourceRevision: revision,
          rightsVersion,
          mediaType: parsed.mediaType,
          byteSize: file.buffer.length,
          contentSha256: parsed.contentSha256,
          extractedTextSha256: parsed.extractedTextSha256,
          duplicateOfDocumentId: duplicate?.id ?? null,
          duplicateSimilarity: duplicate?.similarity ?? 0,
          parserVersion: RESEARCH_DOCUMENT_PARSER_VERSION,
        },
      });
      return {
        document: this.safeDocument(document),
        idempotentReplay: false,
        duplicateCandidate: duplicate,
        duplicatePolicy: 'A similarity match is a review hint only; documents and provenance are not automatically merged.',
      };
    });
  }

  async listDocuments(userId: string, tenantId: string, sourceId: string, limit = 100) {
    this.validateScope(userId, tenantId, sourceId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new BadRequestException('limit must be between 1 and 200');
    }
    const result = await this.database.query<DbRow>(
      `SELECT id::text AS id,source_id::text AS source_id,source_revision,rights_version,
          original_filename,media_type,byte_size,content_sha256,extracted_text_sha256,
          normalized_text_sha256,parser_version,duplicate_of_document_id::text AS duplicate_of_document_id,
          similarity_score,storage_status,created_by::text AS created_by,created_at::text AS created_at,
          purged_at::text AS purged_at,purge_reason
       FROM research_source_documents
       WHERE source_id=$1 AND tenant_id=$2
       ORDER BY created_at DESC,id DESC LIMIT $3`,
      [sourceId, tenantId, limit],
      { tenantId, userId },
    );
    return result.rows;
  }

  async readDocumentText(userId: string, tenantId: string, sourceId: string, documentId: string) {
    this.validateScope(userId, tenantId, sourceId);
    this.assertUuid(documentId, 'documentId');
    const result = await this.database.query<DbRow>(
      `SELECT d.id::text AS id,d.source_revision,d.rights_version,d.content_sha256,
          d.extracted_text_sha256,d.normalized_text_sha256,d.parser_version,d.storage_status,
          s.source_revision AS current_source_revision,s.rights_version AS current_rights_version,
          s.access_status,s.license_status,s.rights_basis,s.full_text_storage_allowed,
          c.extracted_text
       FROM research_source_documents d
       JOIN research_sources s ON s.id=d.source_id AND s.tenant_id=d.tenant_id
       LEFT JOIN research_source_document_content c
         ON c.document_id=d.id AND c.tenant_id=d.tenant_id
       WHERE d.id=$1 AND d.source_id=$2 AND d.tenant_id=$3`,
      [documentId, sourceId, tenantId],
      { tenantId, userId },
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Customer research document not found');
    this.assertReadRights(row);
    if (Number(row.source_revision) !== Number(row.current_source_revision)
        || Number(row.rights_version) !== Number(row.current_rights_version)) {
      throw new ConflictException({
        code: 'RESEARCH_SOURCE_DOCUMENT_SOURCE_SNAPSHOT_STALE',
        message: 'Source or rights changed after upload; re-upload under the current source revision before extraction',
      });
    }
    if (row.storage_status !== 'STORED' || typeof row.extracted_text !== 'string') {
      throw new NotFoundException('Research document content has been purged');
    }
    return {
      documentId: String(row.id),
      sourceRevision: Number(row.source_revision),
      rightsVersion: Number(row.rights_version),
      contentSha256: String(row.content_sha256),
      extractedTextSha256: String(row.extracted_text_sha256),
      normalizedTextSha256: String(row.normalized_text_sha256),
      parserVersion: String(row.parser_version),
      untrustedInput: true,
      extractedText: String(row.extracted_text),
    };
  }

  private validateScope(userId: string, tenantId: string, sourceId: string) {
    if (!isUUID(userId) || !isUUID(tenantId)) {
      throw new BadRequestException('Authenticated user and tenant UUIDs are required');
    }
    this.assertUuid(sourceId, 'sourceId');
  }

  private assertUuid(value: string, field: string) {
    if (!isUUID(value)) throw new BadRequestException(`${field} must be a UUID`);
  }

  private requiredText(value: string, field: string, maximum: number): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) {
      throw new BadRequestException(`${field} must contain between 1 and ${maximum} characters`);
    }
    return value.trim();
  }

  private safeFilename(input: string): string {
    const basename = String(input ?? '').split(/[\\/]/).pop() ?? '';
    const cleaned = basename.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
    if (!cleaned || cleaned === '.' || cleaned === '..') {
      throw new BadRequestException('Uploaded filename is invalid');
    }
    return cleaned;
  }

  private assertUploadRights(source: DbRow) {
    if (source.source_type !== 'CUSTOMER_PROVIDED') {
      throw new ForbiddenException('Customer-file uploads require a CUSTOMER_PROVIDED research source');
    }
    if (source.access_status !== 'APPROVED'
      || !PERMITTED_LICENSES.includes(String(source.license_status))
      || !String(source.rights_basis ?? '').trim()
      || source.full_text_storage_allowed !== true) {
      throw new ForbiddenException('Current reviewed source rights do not permit full-text customer-file storage');
    }
  }

  private assertReadRights(row: DbRow) {
    if (row.access_status !== 'APPROVED'
      || !PERMITTED_LICENSES.includes(String(row.license_status))
      || !String(row.rights_basis ?? '').trim()
      || row.full_text_storage_allowed !== true) {
      throw new ForbiddenException('Current source rights do not permit access to stored customer-file text');
    }
  }

  private safeEvidence(evidence: ResearchAuthenticityEvidence) {
    return {
      provider: evidence.provider,
      status: evidence.status,
      providerRecordId: evidence.provider_record_id,
      canonicalDoi: evidence.canonical_doi,
      canonicalUrl: evidence.canonical_url,
      providerTitle: evidence.provider_title,
      titleSimilarity: evidence.title_similarity,
      responseSha256: evidence.response_sha256,
      reasonCode: evidence.reason_code,
      checkedAt: evidence.checked_at,
      verificationScope: 'Metadata identity only; does not prove cited-passage entailment or legal rights.',
    };
  }

  private safeDocument(row: DbRow) {
    return {
      id: row.id,
      source_id: row.source_id,
      source_revision: row.source_revision,
      rights_version: row.rights_version,
      original_filename: row.original_filename,
      media_type: row.media_type,
      byte_size: row.byte_size,
      content_sha256: row.content_sha256,
      extracted_text_sha256: row.extracted_text_sha256,
      normalized_text_sha256: row.normalized_text_sha256,
      parser_version: row.parser_version,
      duplicate_of_document_id: row.duplicate_of_document_id ?? null,
      similarity_score: Number(row.similarity_score ?? 0),
      storage_status: row.storage_status,
      created_by: row.created_by,
      created_at: row.created_at,
      purged_at: row.purged_at ?? null,
      purge_reason: row.purge_reason ?? null,
    };
  }

  private async auditInTransaction(
    client: PoolClient,
    input: {
      tenantId: string;
      userId: string;
      action: string;
      resourceType: string;
      resourceId: string;
      requestId: string | null;
      traceId: string | null;
      payload: Record<string, unknown>;
    },
  ) {
    await this.audit.recordWithClient(client, {
      tenantId: input.tenantId,
      factoryId: null,
      actorUserId: input.userId,
      eventType: 'RESEARCH_SOURCE_PRODUCTION',
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      correlationId: this.uuidOrNull(input.traceId) ?? this.uuidOrNull(input.requestId),
      payload: input.payload,
    });
  }

  private uuidOrNull(value: string | null): string | null {
    return value && isUUID(value) ? value : null;
  }

  private hash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
  }
}
