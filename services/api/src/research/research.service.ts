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
import { CreateResearchClaimDto } from './dto/create-research-claim.dto';
import { CreateResearchClaimLinkDto } from './dto/create-research-claim-link.dto';
import { CreateResearchRelevanceDto } from './dto/create-research-relevance.dto';
import { CreateResearchReleaseDto } from './dto/create-research-release.dto';
import { CreateResearchSourceDto } from './dto/create-research-source.dto';
import { DecideResearchRelevanceDto } from './dto/decide-research-relevance.dto';
import { DecideResearchClaimDto } from './dto/decide-research-claim.dto';
import { DecideResearchSourceDto } from './dto/decide-research-source.dto';
import { PromoteResearchReleaseDto } from './dto/promote-research-release.dto';

interface ResearchSourceRow extends QueryResultRow {
  id: string;
  tenant_id: string | null;
  namespace: 'GLOBAL' | 'TENANT';
  source_type: string;
  title: string;
  authors: string[];
  publication_date: string | null;
  doi: string | null;
  venue: string | null;
  abstract: string | null;
  source_url: string | null;
  license_status: string;
  access_status: string;
  rights_basis: string | null;
  license_reference: string | null;
  full_text_storage_allowed: boolean;
  untrusted_content: boolean;
  source_metadata: Record<string, unknown>;
  ingested_at: string;
}

interface ResearchClaimRow extends QueryResultRow {
  id: string;
  tenant_id: string | null;
  namespace: 'GLOBAL' | 'TENANT';
  source_id: string;
  claim_text: string;
  methodology: string | null;
  dataset_description: string | null;
  limitations: string | null;
  practical_implication: string | null;
  evidence_grade: string;
  evidence_strength: string;
  topic_tags: string[];
  provenance_ref: Record<string, unknown>;
  status: string;
  source_title?: string;
  source_url?: string | null;
  doi?: string | null;
  license_status?: string;
  access_status?: string;
}

@Injectable()
export class ResearchService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async createSource(
    userId: string,
    tenantId: string,
    dto: CreateResearchSourceDto,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateUuid(userId, 'userId');
    this.validateUuid(tenantId, 'tenantId');
    const title = dto.title.trim();
    const doi = dto.doi?.trim() || null;
    const sourceUrl = dto.source_url?.trim() || null;
    if (!title || (!doi && !sourceUrl)) {
      throw new BadRequestException('A source title and DOI or source URL are required');
    }
    const rightsBasis = dto.rights_basis?.trim() || null;
    const fullTextAllowed = dto.full_text_storage_allowed ?? false;
    if (fullTextAllowed && (
      !['OPEN_ACCESS', 'LICENSED', 'USER_PROVIDED_AUTHORIZED'].includes(dto.license_status)
      || !rightsBasis
    )) {
      throw new BadRequestException('Full-text storage requires explicit permitted rights and a documented rights basis');
    }
    if (dto.source_type === 'CUSTOMER_PROVIDED' && dto.license_status !== 'USER_PROVIDED_AUTHORIZED') {
      throw new BadRequestException('Customer-provided research requires an explicit user-provided authorization basis');
    }
    if (dto.license_status === 'RESTRICTED' || dto.license_status === 'UNKNOWN') {
      if (fullTextAllowed) throw new BadRequestException('Restricted or unknown-license content cannot be stored as full text');
    }
    const authors = (dto.authors ?? []).map(a => a.trim()).filter(Boolean);
    if (authors.length > 100) throw new BadRequestException('At most 100 authors may be recorded');
    let source: ResearchSourceRow;
    try {
      source = await this.database.transaction(
        { tenantId, userId },
        async client => {
          const result = await client.query<ResearchSourceRow>(
            `
            INSERT INTO research_sources (
              tenant_id, namespace, source_type, title, authors, publication_date, doi,
              venue, abstract, source_url, license_status, rights_basis, license_reference,
              full_text_storage_allowed, untrusted_content, source_metadata, created_by
            )
            VALUES (
              $1, 'TENANT', $2, $3, $4::jsonb, $5::date, $6, $7, $8, $9, $10, $11, $12,
              $13, TRUE, $14::jsonb, $15
            )
            RETURNING
              id::text AS id, tenant_id::text AS tenant_id, namespace, source_type, title,
              authors, publication_date::text AS publication_date, doi, venue, abstract,
              source_url, license_status, access_status, rights_basis, license_reference,
              full_text_storage_allowed, untrusted_content, source_metadata,
              ingested_at::text AS ingested_at
            `,
            [
              tenantId, dto.source_type, title, JSON.stringify(authors),
              dto.publication_date ?? null, doi, dto.venue?.trim() || null,
              dto.abstract?.trim() || null, sourceUrl, dto.license_status,
              rightsBasis, dto.license_reference?.trim() || null, fullTextAllowed,
              JSON.stringify(dto.source_metadata ?? {}), userId,
            ],
          );
          const row = result.rows[0];
          if (!row) throw new Error('RESEARCH_SOURCE_INSERT_FAILED');
          await this.insertOutbox(client, {
            tenantId, factoryId: null, userId, aggregateType: 'RESEARCH_SOURCE',
            aggregateId: row.id, eventType: 'RESEARCH.SOURCE_REGISTERED',
            correlationId: this.correlationId(requestId, traceId),
            payload: { source_id: row.id, source_type: row.source_type, access_status: row.access_status },
          });
          return row;
        },
      );
    } catch (error) {
      if (this.errorCode(error) === '23505') {
        throw new ConflictException('This DOI is already registered in the current namespace');
      }
      throw error;
    }
    await this.auditSafely({
      tenantId, userId, factoryId: null, action: 'SOURCE_REGISTER',
      resourceId: source.id, requestId, traceId,
      payload: { sourceType: source.source_type, licenseStatus: source.license_status, accessStatus: source.access_status },
    });
    return source;
  }

  async listSources(tenantId: string, query: {
    search?: string; access_status?: string; limit?: number;
  }) {
    this.validateUuid(tenantId, 'tenantId');
    const limit = this.limit(query.limit);
    const result = await this.database.query<ResearchSourceRow>(
      `
      SELECT
        id::text AS id, tenant_id::text AS tenant_id, namespace, source_type, title,
        authors, publication_date::text AS publication_date, doi, venue, abstract,
        source_url, license_status, access_status, rights_basis, license_reference,
        full_text_storage_allowed, untrusted_content, source_metadata,
        ingested_at::text AS ingested_at
      FROM research_sources
      WHERE (tenant_id = $1 OR (tenant_id IS NULL AND access_status = 'APPROVED'))
        AND ($2::text IS NULL OR access_status = $2)
        AND ($3::text IS NULL OR title ILIKE $3 OR COALESCE(doi, '') ILIKE $3
             OR COALESCE(venue, '') ILIKE $3 OR COALESCE(abstract, '') ILIKE $3)
      ORDER BY CASE WHEN tenant_id IS NULL THEN 0 ELSE 1 END, ingested_at DESC
      LIMIT $4
      `,
      [tenantId, query.access_status ?? null, query.search?.trim() ? '%' + query.search.trim() + '%' : null, limit],
      { tenantId },
    );
    return result.rows;
  }

  async decideSource(
    actorUserId: string,
    tenantId: string,
    sourceId: string,
    dto: DecideResearchSourceDto,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateUuid(sourceId, 'sourceId');
    const reason = dto.reason.trim();
    if (!reason) throw new BadRequestException('A source review reason is required');
    const status = dto.decision === 'APPROVE' ? 'APPROVED'
      : dto.decision === 'REJECT' ? 'REJECTED' : 'REVOKED';
    const source = await this.database.transaction(
      { tenantId, userId: actorUserId },
      async client => {
        const current = await client.query<ResearchSourceRow>(
          `
          SELECT id::text AS id, tenant_id::text AS tenant_id, namespace, source_type,
            title, authors, publication_date::text AS publication_date, doi, venue,
            abstract, source_url, license_status, access_status, rights_basis,
            license_reference, full_text_storage_allowed, untrusted_content, source_metadata,
            ingested_at::text AS ingested_at
          FROM research_sources WHERE id = $1 AND tenant_id = $2 FOR UPDATE
          `,
          [sourceId, tenantId],
        );
        const row = current.rows[0];
        if (!row) throw new NotFoundException('Tenant research source not found');
        if (dto.decision === 'APPROVE' && (
          !['OPEN_ACCESS', 'LICENSED', 'USER_PROVIDED_AUTHORIZED'].includes(row.license_status)
          || !row.rights_basis?.trim()
        )) {
          throw new ForbiddenException('Research rights must be established before source approval');
        }
        if (dto.decision === 'APPROVE' && row.source_type === 'CUSTOMER_PROVIDED'
          && row.license_status !== 'USER_PROVIDED_AUTHORIZED') {
          throw new ForbiddenException('Customer-provided research requires explicit authorization');
        }
        if (row.access_status !== 'PENDING' && !(row.access_status === 'APPROVED' && status === 'REVOKED')) {
          throw new ConflictException('Research source has already been reviewed; only an approved source can be revoked');
        }
        const update = await client.query<ResearchSourceRow>(
          `
          UPDATE research_sources
          SET access_status = $1, reviewed_by = $2, reviewed_at = clock_timestamp(),
              review_reason = $3, updated_at = clock_timestamp()
          WHERE id = $4 AND tenant_id = $5
          RETURNING
            id::text AS id, tenant_id::text AS tenant_id, namespace, source_type, title,
            authors, publication_date::text AS publication_date, doi, venue, abstract,
            source_url, license_status, access_status, rights_basis, license_reference,
            full_text_storage_allowed, untrusted_content, source_metadata,
            ingested_at::text AS ingested_at
          `,
          [status, actorUserId, reason, sourceId, tenantId],
        );
        const reviewed = update.rows[0];
        if (!reviewed) throw new Error('RESEARCH_SOURCE_REVIEW_UPDATE_FAILED');
        await this.insertOutbox(client, {
          tenantId, factoryId: null, userId: actorUserId, aggregateType: 'RESEARCH_SOURCE',
          aggregateId: sourceId, eventType: 'RESEARCH.SOURCE_' + status,
          correlationId: this.correlationId(requestId, traceId),
          payload: { source_id: sourceId, status, reason },
        });
        return reviewed;
      },
    );
    await this.auditSafely({
      tenantId, userId: actorUserId, factoryId: null, action: 'SOURCE_' + status,
      resourceId: sourceId, requestId, traceId, payload: { reason },
    });
    return source;
  }

  async createClaim(
    userId: string,
    tenantId: string,
    sourceId: string,
    dto: CreateResearchClaimDto,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateUuid(sourceId, 'sourceId');
    this.validateUuid(userId, 'userId');
    const locator = dto.provenance_ref;
    if (!locator || !Object.keys(locator).some(k => {
      const v = (locator as Record<string, unknown>)[k];
      return v !== undefined && v !== null && String(v).trim() !== '';
    })) {
      throw new BadRequestException('A source page, section or passage locator is required for research claims');
    }
    if (dto.stored_excerpt && dto.stored_excerpt.length > 0) {
      const source = await this.database.query<{ full_text_storage_allowed: boolean }>(
        'SELECT full_text_storage_allowed FROM research_sources WHERE id = $1 AND tenant_id = $2 AND access_status = $3',
        [sourceId, tenantId, 'APPROVED'],
        { tenantId, userId },
      );
      if (!source.rows[0]) throw new NotFoundException('Approved tenant research source not found');
      if (!source.rows[0].full_text_storage_allowed) {
        throw new ForbiddenException('Source rights do not permit storing an excerpt; store a locator/citation instead');
      }
      if (dto.stored_excerpt.length > 4000) throw new BadRequestException('Stored excerpts are limited to 4000 characters');
    }
    let claim: ResearchClaimRow;
    claim = await this.database.transaction(
      { tenantId, userId },
      async client => {
        const source = await client.query<ResearchSourceRow>(
          `
          SELECT id::text AS id, tenant_id::text AS tenant_id, namespace, source_type,
            title, authors, publication_date::text AS publication_date, doi, venue,
            abstract, source_url, license_status, access_status, rights_basis,
            license_reference, full_text_storage_allowed, untrusted_content, source_metadata,
            ingested_at::text AS ingested_at
          FROM research_sources
          WHERE id = $1 AND tenant_id = $2 AND access_status = 'APPROVED'
          FOR SHARE
          `,
          [sourceId, tenantId],
        );
        if (!source.rows[0]) throw new NotFoundException('Approved tenant research source not found');
        const inserted = await client.query<ResearchClaimRow>(
          `
          INSERT INTO research_claims (
            tenant_id, namespace, source_id, claim_text, methodology, dataset_description,
            limitations, practical_implication, evidence_grade, evidence_strength,
            topic_tags, provenance_ref, stored_excerpt, created_by
          )
          VALUES ($1, 'TENANT', $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13)
          RETURNING
            id::text AS id, tenant_id::text AS tenant_id, namespace, source_id::text AS source_id,
            claim_text, methodology, dataset_description, limitations, practical_implication,
            evidence_grade, evidence_strength, topic_tags, provenance_ref, status
          `,
          [
            tenantId, sourceId, dto.claim_text.trim(), dto.methodology?.trim() || null,
            dto.dataset_description?.trim() || null, dto.limitations?.trim() || null,
            dto.practical_implication?.trim() || null, dto.evidence_grade ?? 'UNASSESSED',
            dto.evidence_strength ?? 'UNASSESSED', JSON.stringify(dto.topic_tags ?? []),
            JSON.stringify(locator), dto.stored_excerpt?.trim() || null, userId,
          ],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error('RESEARCH_CLAIM_INSERT_FAILED');
        await this.insertOutbox(client, {
          tenantId, factoryId: null, userId, aggregateType: 'RESEARCH_CLAIM',
          aggregateId: row.id, eventType: 'RESEARCH.CLAIM_PROPOSED',
          correlationId: this.correlationId(requestId, traceId),
          payload: { claim_id: row.id, source_id: sourceId, status: row.status },
        });
        return row;
      },
    );
    await this.auditSafely({
      tenantId, userId, factoryId: null, action: 'CLAIM_PROPOSE',
      resourceId: claim.id, requestId, traceId,
      payload: { sourceId, evidenceGrade: claim.evidence_grade, status: claim.status },
    });
    return claim;
  }

  async listClaims(tenantId: string, query: {
    status?: string; topic?: string; limit?: number;
  }) {
    this.validateUuid(tenantId, 'tenantId');
    const limit = this.limit(query.limit);
    const status = query.status ?? null;
    const result = await this.database.query<ResearchClaimRow>(
      `
      SELECT c.id::text AS id, c.tenant_id::text AS tenant_id, c.namespace,
        c.source_id::text AS source_id, c.claim_text, c.methodology, c.dataset_description,
        c.limitations, c.practical_implication, c.evidence_grade, c.evidence_strength,
        c.topic_tags, c.provenance_ref, c.status, s.title AS source_title,
        s.source_url, s.doi, s.license_status, s.access_status
      FROM research_claims c
      JOIN research_sources s ON s.id = c.source_id AND s.namespace = c.namespace
      WHERE (c.tenant_id = $1 OR (c.tenant_id IS NULL AND c.status = 'APPROVED' AND s.access_status = 'APPROVED'))
        AND ($2::text IS NULL OR c.status = $2)
        AND ($3::text IS NULL OR c.topic_tags @> jsonb_build_array($3::text))
      ORDER BY CASE WHEN c.tenant_id IS NULL THEN 0 ELSE 1 END, c.created_at DESC
      LIMIT $4
      `,
      [tenantId, status, query.topic?.trim() || null, limit],
      { tenantId },
    );
    return result.rows;
  }

  async decideClaim(
    actorUserId: string,
    tenantId: string,
    claimId: string,
    dto: DecideResearchClaimDto,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateUuid(claimId, 'claimId');
    const claim = await this.database.transaction(
      { tenantId, userId: actorUserId },
      async client => {
        const current = await client.query<ResearchClaimRow>(
          `
          SELECT c.id::text AS id, c.tenant_id::text AS tenant_id, c.namespace,
            c.source_id::text AS source_id, c.claim_text, c.methodology, c.dataset_description,
            c.limitations, c.practical_implication, c.evidence_grade, c.evidence_strength,
            c.topic_tags, c.provenance_ref, c.status
          FROM research_claims c
          WHERE c.id = $1 AND c.tenant_id = $2
          FOR UPDATE
          `,
          [claimId, tenantId],
        );
        const row = current.rows[0];
        if (!row) throw new NotFoundException('Tenant research claim not found');
        const transitions: Record<string, string[]> = {
          PROPOSED: ['APPROVED', 'REJECTED'],
          APPROVED: ['SUPERSEDED'],
        };
        const next = dto.decision === 'APPROVE' ? 'APPROVED'
          : dto.decision === 'REJECT' ? 'REJECTED' : 'SUPERSEDED';
        if (!(transitions[row.status] ?? []).includes(next)) {
          throw new ConflictException('Invalid research claim review transition');
        }
        if (next === 'APPROVED') {
          if (row.evidence_grade === 'UNASSESSED') {
            throw new BadRequestException('An evidence grade must be assigned before a claim is approved');
          }
          const sourceResult = await client.query<{
            access_status: string; license_status: string; full_text_storage_allowed: boolean;
          }>(
            'SELECT access_status, license_status, full_text_storage_allowed FROM research_sources WHERE id = $1 AND tenant_id = $2',
            [row.source_id, tenantId],
          );
          const source = sourceResult.rows[0];
          if (!source || source.access_status !== 'APPROVED'
            || !['OPEN_ACCESS', 'LICENSED', 'USER_PROVIDED_AUTHORIZED'].includes(source.license_status)) {
            throw new ForbiddenException('Claim source is not rights-approved');
          }
          if (!row.provenance_ref || !Object.keys(row.provenance_ref).length) {
            throw new BadRequestException('A claim must have source provenance before approval');
          }
        }
        const updated = await client.query<ResearchClaimRow>(
          `
          UPDATE research_claims SET status = $1, reviewed_by = $2,
            reviewed_at = clock_timestamp(), review_reason = $3, updated_at = clock_timestamp()
          WHERE id = $4 AND tenant_id = $5
          RETURNING id::text AS id, tenant_id::text AS tenant_id, namespace,
            source_id::text AS source_id, claim_text, methodology, dataset_description,
            limitations, practical_implication, evidence_grade, evidence_strength,
            topic_tags, provenance_ref, status
          `,
          [next, actorUserId, dto.reason.trim(), claimId, tenantId],
        );
        const result = updated.rows[0];
        if (!result) throw new Error('RESEARCH_CLAIM_REVIEW_UPDATE_FAILED');
        await this.insertOutbox(client, {
          tenantId, factoryId: null, userId: actorUserId, aggregateType: 'RESEARCH_CLAIM',
          aggregateId: claimId, eventType: 'RESEARCH.CLAIM_' + next,
          correlationId: this.correlationId(requestId, traceId),
          payload: { claim_id: claimId, status: next, reason: dto.reason.trim() },
        });
        return result;
      },
    );
    await this.auditSafely({
      tenantId, userId: actorUserId, factoryId: null, action: 'CLAIM_' + claim.status,
      resourceId: claimId, requestId, traceId, payload: { reason: dto.reason },
    });
    return claim;
  }

  async linkClaims(
    userId: string,
    tenantId: string,
    claimId: string,
    dto: CreateResearchClaimLinkDto,
  ) {
    this.validateUuid(claimId, 'claimId');
    this.validateUuid(dto.related_claim_id, 'related_claim_id');
    if (claimId === dto.related_claim_id) throw new BadRequestException('A claim cannot link to itself');
    return this.database.transaction(
      { tenantId, userId },
      async client => {
        const ids = [claimId, dto.related_claim_id];
        const rows = await client.query<{ id: string; status: string }>(
          `
          SELECT id::text AS id, status FROM research_claims
          WHERE id = ANY($1::uuid[]) AND tenant_id = $2
          `,
          [ids, tenantId],
        );
        if (rows.rows.length !== 2) throw new NotFoundException('Both claims must belong to this tenant');
        if (rows.rows.some(row => row.status !== 'APPROVED')) {
          throw new ConflictException('Only approved claims can be linked as competing evidence');
        }
        const inserted = await client.query(
          `
          INSERT INTO research_claim_links (
            tenant_id, namespace, claim_a_id, claim_b_id, relation_type, context, created_by
          )
          VALUES ($1, 'TENANT', $2, $3, $4, $5, $6)
          ON CONFLICT (claim_a_id, claim_b_id, relation_type) DO NOTHING
          RETURNING id::text AS id, tenant_id::text AS tenant_id, claim_a_id::text AS claim_a_id,
            claim_b_id::text AS claim_b_id, relation_type, context, created_at::text AS created_at
          `,
          [tenantId, claimId, dto.related_claim_id, dto.relation_type, dto.context.trim(), userId],
        );
        if (inserted.rows[0]) return inserted.rows[0];
        const existing = await client.query(
          'SELECT id::text AS id, tenant_id::text AS tenant_id, claim_a_id::text AS claim_a_id, claim_b_id::text AS claim_b_id, relation_type, context, created_at::text AS created_at FROM research_claim_links WHERE tenant_id = $1 AND claim_a_id = $2 AND claim_b_id = $3 AND relation_type = $4',
          [tenantId, claimId, dto.related_claim_id, dto.relation_type],
        );
        return existing.rows[0] ?? null;
      },
    );
  }

  async createRelease(
    userId: string,
    tenantId: string,
    dto: CreateResearchReleaseDto,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateUuid(userId, 'userId');
    const claimIds = [...new Set(dto.claim_ids.map(id => id.toLowerCase()))];
    if (claimIds.length === 0 || claimIds.length !== dto.claim_ids.length) {
      throw new BadRequestException('A release requires one or more unique claim IDs');
    }
    const report = await this.validateReleaseClaims(tenantId, claimIds);
    const created = await this.database.transaction(
      { tenantId, userId },
      async client => {
        const result = await client.query(
          `
          INSERT INTO research_knowledge_releases (
            tenant_id, namespace, release_key, version, title, claim_ids,
            source_list, evidence_grade, owner_user_id, validation_report
          )
          VALUES ($1, 'TENANT', $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9::jsonb)
          RETURNING id::text AS id, tenant_id::text AS tenant_id, namespace,
            release_key, version, title, claim_ids, source_list, evidence_grade,
            status, validation_report, created_at::text AS created_at
          `,
          [tenantId, dto.release_key.trim(), dto.version, dto.title.trim(),
            JSON.stringify(claimIds), JSON.stringify(report.sources), dto.evidence_grade,
            userId, JSON.stringify(report.validation)],
        );
        const row = result.rows[0];
        if (!row) throw new Error('RESEARCH_RELEASE_INSERT_FAILED');
        await this.insertOutbox(client, {
          tenantId, factoryId: null, userId, aggregateType: 'RESEARCH_RELEASE',
          aggregateId: row.id, eventType: 'RESEARCH.RELEASE_DRAFTED',
          correlationId: this.correlationId(requestId, traceId),
          payload: { release_id: row.id, release_key: row.release_key, version: row.version, status: row.status },
        });
        return row;
      },
    );
    await this.auditSafely({
      tenantId, userId, factoryId: null, action: 'RELEASE_DRAFT',
      resourceId: created.id, requestId, traceId,
      payload: { releaseKey: dto.release_key, version: dto.version, claimCount: claimIds.length },
    });
    return created;
  }

  async evaluateRelease(
    userId: string,
    tenantId: string,
    releaseId: string,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateUuid(userId, 'userId');
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(releaseId, 'releaseId');

    const lookup = await this.database.query<{
      id: string;
      namespace: 'GLOBAL' | 'TENANT';
      release_key: string;
      version: number;
      status: string;
      claim_ids: string[];
      source_list: Record<string, unknown>[];
    }>(
      `
      SELECT id::text AS id, namespace, release_key, version, status,
        claim_ids, source_list
      FROM research_knowledge_releases
      WHERE id = $1 AND tenant_id = $2
      `,
      [releaseId, tenantId],
      { tenantId, userId },
    );
    const release = lookup.rows[0];
    if (!release) throw new NotFoundException('Tenant research release not found');
    if (release.status !== 'DRAFT') {
      throw new ConflictException('Only draft research releases can be evaluated');
    }

    let status: 'PASSED' | 'FAILED' | 'REVIEW_REQUIRED' = 'FAILED';
    let validation: Record<string, unknown>;
    let sources: Record<string, unknown>[] = release.source_list ?? [];
    let contentFingerprint: string;

    try {
      const report = await this.validateReleaseClaims(tenantId, release.claim_ids);
      const safetyPassed = report.validation.safetyPassed === true;
      status = safetyPassed ? 'PASSED' : 'REVIEW_REQUIRED';
      validation = {
        ...report.validation,
        safetyPassed,
        safetyReviewed: false,
        automaticContractChecks: true,
        evaluationVersion: 'research-release-contract.v1',
      };
      sources = report.sources;
      contentFingerprint = report.contentFingerprint;
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : 'Research release validation failed';
      validation = {
        consistencyPassed: false,
        citationCoveragePassed: false,
        rightsPassed: false,
        safetyPassed: false,
        safetyReviewed: false,
        automaticContractChecks: true,
        evaluationVersion: 'research-release-contract.v1',
        claimCount: Array.isArray(release.claim_ids) ? release.claim_ids.length : 0,
        failureReason,
      };
      contentFingerprint = createHash('sha256')
        .update(JSON.stringify({
          releaseId,
          claimIds: release.claim_ids,
          evaluationVersion: 'research-release-contract.v1',
          failureReason,
        }))
        .digest('hex');
      status = 'FAILED';
    }

    const evaluation = await this.database.transaction(
      { tenantId, userId },
      async client => {
        const current = await client.query<{ status: string }>(
          'SELECT status FROM research_knowledge_releases WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
          [releaseId, tenantId],
        );
        if (!current.rows[0]) throw new NotFoundException('Tenant research release not found');
        if (current.rows[0].status !== 'DRAFT') {
          throw new ConflictException('Research release changed before evaluation could be saved');
        }

        const inserted = await client.query<{
          id: string;
          status: string;
          evaluation_version: string;
          content_fingerprint: string;
          results: Record<string, unknown>;
          evaluated_at: string;
        }>(
          `
          INSERT INTO research_release_evaluations (
            tenant_id, namespace, release_id, evaluation_version, status,
            content_fingerprint, results, evaluated_by
          )
          VALUES ($1, 'TENANT', $2, 'research-release-contract.v1', $3, $4, $5::jsonb, $6)
          RETURNING id::text AS id, status, evaluation_version, content_fingerprint,
            results, evaluated_at::text AS evaluated_at
          `,
          [tenantId, releaseId, status, contentFingerprint, JSON.stringify(validation), userId],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error('RESEARCH_RELEASE_EVALUATION_INSERT_FAILED');

        await client.query(
          `
          UPDATE research_knowledge_releases
          SET evaluation_id = $1, validation_report = $2::jsonb, source_list = $3::jsonb
          WHERE id = $4 AND tenant_id = $5 AND status = 'DRAFT'
          `,
          [row.id, JSON.stringify(validation), JSON.stringify(sources), releaseId, tenantId],
        );
        await this.insertOutbox(client, {
          tenantId, factoryId: null, userId, aggregateType: 'RESEARCH_RELEASE_EVALUATION',
          aggregateId: row.id, eventType: 'RESEARCH.RELEASE_EVALUATED',
          correlationId: this.correlationId(requestId, traceId),
          payload: {
            release_id: releaseId,
            evaluation_id: row.id,
            status: row.status,
            evaluation_version: row.evaluation_version,
            content_fingerprint: row.content_fingerprint,
          },
        });
        return { ...row, release_id: releaseId };
      },
    );

    await this.auditSafely({
      tenantId, userId, factoryId: null, action: 'RELEASE_EVALUATE',
      resourceId: releaseId, requestId, traceId,
      payload: {
        evaluationId: evaluation.id,
        status: evaluation.status,
        contentFingerprint: evaluation.content_fingerprint,
        evaluationVersion: evaluation.evaluation_version,
      },
    });
    return evaluation;
  }

  async listReleases(tenantId: string, limit?: number) {
    this.validateUuid(tenantId, 'tenantId');
    return (await this.database.query(
      `
      SELECT id::text AS id, tenant_id::text AS tenant_id, namespace, release_key, version,
        title, claim_ids, source_list, evidence_grade, status, validation_report,
        regression_evidence_ref, evaluation_id::text AS evaluation_id, reviewed_by::text AS reviewed_by, reviewed_at::text AS reviewed_at,
        effective_at::text AS effective_at, created_at::text AS created_at
      FROM research_knowledge_releases
      WHERE tenant_id = $1 OR (tenant_id IS NULL AND status = 'PROMOTED')
      ORDER BY CASE WHEN tenant_id IS NULL THEN 0 ELSE 1 END, version DESC, created_at DESC
      LIMIT $2
      `,
      [tenantId, this.limit(limit)],
      { tenantId },
    )).rows;
  }

  async promoteRelease(
    userId: string,
    tenantId: string,
    releaseId: string,
    dto: PromoteResearchReleaseDto,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateUuid(releaseId, 'releaseId');
    if (new Date(dto.effective_at).getTime() > Date.now() + 365 * 24 * 60 * 60 * 1000) {
      throw new BadRequestException('effective_at cannot be more than one year in the future');
    }
    const current = await this.database.query<{
      id: string; claim_ids: string[]; status: string; release_key: string; version: number;
      namespace: 'GLOBAL' | 'TENANT'; evaluation_id: string | null;
    }>(
      'SELECT id::text AS id, claim_ids, status, release_key, version, namespace, evaluation_id::text AS evaluation_id FROM research_knowledge_releases WHERE id = $1 AND tenant_id = $2',
      [releaseId, tenantId],
      { tenantId, userId },
    );
    const row = current.rows[0];
    if (!row) throw new NotFoundException('Tenant research release not found');
    if (row.status !== 'DRAFT') throw new ConflictException('Only draft research releases may be promoted');
    const claimIds = Array.isArray(row.claim_ids) ? row.claim_ids : [];
    const report = await this.validateReleaseClaims(tenantId, claimIds);
    if (!report.validation.consistencyPassed || !report.validation.citationCoveragePassed
      || !report.validation.rightsPassed || !report.validation.safetyPassed) {
      throw new ConflictException('Research release has failed consistency, citation, rights or content-safety checks');
    }
    if (!dto.evaluation_id || !isUUID(dto.evaluation_id)
      || row.evaluation_id !== dto.evaluation_id) {
      throw new ConflictException('A passing automated evaluation attached to the current draft is required before promotion');
    }
    const evaluationResult = await this.database.query<{
      id: string; status: string; content_fingerprint: string; results: Record<string, unknown>;
    }>(
      `
      SELECT id::text AS id, status, content_fingerprint, results
      FROM research_release_evaluations
      WHERE id = $1 AND release_id = $2 AND tenant_id = $3 AND namespace = $4
      `,
      [dto.evaluation_id, releaseId, tenantId, row.namespace],
      { tenantId, userId },
    );
    const evaluation = evaluationResult.rows[0];
    if (!evaluation || evaluation.status !== 'PASSED'
      || evaluation.content_fingerprint !== report.contentFingerprint) {
      throw new ConflictException('The attached research evaluation is absent, failed, or stale; evaluate the draft again');
    }
    const reviewSummary = dto.safety_review_summary.trim();
    const regressionRef = dto.regression_evidence_ref.trim();
    if (!reviewSummary || !regressionRef) {
      throw new BadRequestException('Safety review and regression evidence references are required');
    }
    const promoted = await this.database.transaction(
      { tenantId, userId },
      async client => {
        const updated = await client.query(
          `
          UPDATE research_knowledge_releases
          SET status = 'PROMOTED',
              source_list = $1::jsonb,
              validation_report = $2::jsonb,
              regression_evidence_ref = $3,
              reviewed_by = $4,
              reviewed_at = clock_timestamp(),
              effective_at = $5::timestamptz
          WHERE id = $6 AND tenant_id = $7 AND status = 'DRAFT'
          RETURNING id::text AS id, release_key, version, title, status, claim_ids,
            source_list, evidence_grade, validation_report, regression_evidence_ref,
            reviewed_by::text AS reviewed_by, reviewed_at::text AS reviewed_at,
            effective_at::text AS effective_at
          `,
          [
            JSON.stringify(report.sources),
            JSON.stringify({ ...report.validation, safetyPassed: true, safetyReviewed: true, safetyReviewSummary: reviewSummary, regressionEvidenceRef: regressionRef, evaluationId: dto.evaluation_id }),
            regressionRef, userId, dto.effective_at, releaseId, tenantId,
          ],
        );
        const result = updated.rows[0];
        if (!result) throw new ConflictException('Research release changed during promotion');
        await this.insertOutbox(client, {
          tenantId, factoryId: null, userId, aggregateType: 'RESEARCH_RELEASE',
          aggregateId: releaseId, eventType: 'RESEARCH.RELEASE_PROMOTED',
          correlationId: this.correlationId(requestId, traceId),
          payload: { release_id: releaseId, release_key: row.release_key, version: row.version, status: 'PROMOTED' },
        });
        return result;
      },
    );
    await this.auditSafely({
      tenantId, userId, factoryId: null, action: 'RELEASE_PROMOTE',
      resourceId: releaseId, requestId, traceId,
      payload: { releaseKey: row.release_key, version: row.version, safetyReviewSummary: reviewSummary, regressionEvidenceRef: regressionRef },
    });
    return promoted;
  }

  async createRelevance(
    userId: string,
    tenantId: string,
    factoryId: string,
    claimId: string,
    dto: CreateResearchRelevanceDto,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateUuid(claimId, 'claimId');
    this.validateFactoryScope(tenantId, factoryId);
    const claim = await this.database.query<{ id: string }>(
      `
      SELECT c.id::text AS id FROM research_claims c
      JOIN research_sources s ON s.id = c.source_id AND s.namespace = c.namespace
      WHERE c.id = $1 AND c.status = 'APPROVED'
        AND (c.tenant_id = $2 OR (c.tenant_id IS NULL AND s.access_status = 'APPROVED'))
        AND s.access_status = 'APPROVED'
      `,
      [claimId, tenantId],
      { tenantId, userId },
    );
    if (!claim.rows[0]) throw new NotFoundException('Approved research claim not found in this tenant/global knowledge scope');
    const entity = await this.database.query<{ id: string }>(
      `
      SELECT id::text AS id FROM business_entities
      WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
        AND state IN ('VERIFIED', 'INFERRED')
      LIMIT 1
      `,
      [dto.business_entity_id, tenantId, factoryId],
      { tenantId, userId },
    );
    if (!entity.rows[0]) throw new NotFoundException('Business-model node is not visible or is not eligible for research mapping');
    const result = await this.database.transaction(
      { tenantId, userId },
      async client => {
        const inserted = await client.query(
          `
          INSERT INTO research_relevance_mappings (
            tenant_id, factory_id, research_claim_id, business_entity_id,
            relevance_rationale, client_evidence, counter_evidence,
            applicability_assumptions, validation_plan, created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10)
          RETURNING id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id,
            research_claim_id::text AS research_claim_id, business_entity_id::text AS business_entity_id,
            relevance_rationale, client_evidence, counter_evidence, applicability_assumptions,
            validation_plan, status, created_at::text AS created_at
          `,
          [
            tenantId, factoryId, claimId, dto.business_entity_id,
            dto.relevance_rationale.trim(), JSON.stringify(dto.client_evidence ?? []),
            JSON.stringify(dto.counter_evidence ?? []), JSON.stringify(dto.applicability_assumptions ?? []),
            JSON.stringify(dto.validation_plan ?? {}), userId,
          ],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error('RESEARCH_RELEVANCE_INSERT_FAILED');
        await this.insertOutbox(client, {
          tenantId, factoryId, userId, aggregateType: 'RESEARCH_RELEVANCE',
          aggregateId: row.id, eventType: 'RESEARCH.RELEVANCE_PROPOSED',
          correlationId: this.correlationId(requestId, traceId),
          payload: { mapping_id: row.id, research_claim_id: claimId, business_entity_id: dto.business_entity_id, status: row.status },
        });
        return row;
      },
    );
    await this.auditSafely({
      tenantId, userId, factoryId, action: 'RELEVANCE_PROPOSE',
      resourceId: result.id, requestId, traceId,
      payload: { claimId, businessEntityId: dto.business_entity_id },
    });
    return result;
  }

  async decideRelevance(
    userId: string,
    tenantId: string,
    factoryId: string,
    mappingId: string,
    dto: DecideResearchRelevanceDto,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateUuid(mappingId, 'mappingId');
    this.validateFactoryScope(tenantId, factoryId);
    const next = dto.decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED';
    const reason = dto.reason.trim();
    const result = await this.database.transaction(
      { tenantId, userId },
      async client => {
        const updated = await client.query(
          `
          UPDATE research_relevance_mappings
          SET status = $1, reviewed_by = $2, reviewed_at = clock_timestamp(),
              review_reason = $3
          WHERE id = $4 AND tenant_id = $5 AND factory_id = $6 AND status = 'PROPOSED'
          RETURNING id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id,
            research_claim_id::text AS research_claim_id, business_entity_id::text AS business_entity_id,
            relevance_rationale, client_evidence, counter_evidence, applicability_assumptions,
            validation_plan, status, reviewed_by::text AS reviewed_by,
            reviewed_at::text AS reviewed_at, review_reason, created_at::text AS created_at
          `,
          [next, userId, reason, mappingId, tenantId, factoryId],
        );
        const row = updated.rows[0];
        if (!row) throw new ConflictException('Only proposed relevance mappings may be reviewed');
        await this.insertOutbox(client, {
          tenantId, factoryId, userId, aggregateType: 'RESEARCH_RELEVANCE',
          aggregateId: mappingId, eventType: 'RESEARCH.RELEVANCE_' + next,
          correlationId: this.correlationId(requestId, traceId),
          payload: { mapping_id: mappingId, status: next, reason },
        });
        return row;
      },
    );
    await this.auditSafely({
      tenantId, userId, factoryId, action: 'RELEVANCE_' + next,
      resourceId: mappingId, requestId, traceId, payload: { reason },
    });
    return result;
  }

  async listRelevance(tenantId: string, factoryId: string, limit?: number) {
    this.validateFactoryScope(tenantId, factoryId);
    return (await this.database.query(
      `
      SELECT id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id,
        research_claim_id::text AS research_claim_id, business_entity_id::text AS business_entity_id,
        relevance_rationale, client_evidence, counter_evidence, applicability_assumptions,
        validation_plan, status, created_at::text AS created_at
      FROM research_relevance_mappings
      WHERE tenant_id = $1 AND factory_id = $2
      ORDER BY created_at DESC LIMIT $3
      `,
      [tenantId, factoryId, this.limit(limit)],
      { tenantId },
    )).rows;
  }

  private async validateReleaseClaims(tenantId: string, claimIds: string[]) {
    if (!claimIds.length) throw new BadRequestException('A research release requires approved claims');
    const result = await this.database.query<ResearchClaimRow & {
      source_title: string;
      source_url: string | null;
      doi: string | null;
      license_status: string;
      access_status: string;
      rights_basis: string | null;
      source_id: string;
      stored_excerpt: string | null;
    }>(
      `
      SELECT c.id::text AS id, c.tenant_id::text AS tenant_id, c.namespace,
        c.source_id::text AS source_id, c.claim_text, c.methodology, c.dataset_description,
        c.limitations, c.practical_implication, c.evidence_grade, c.evidence_strength,
        c.topic_tags, c.provenance_ref, c.status, c.stored_excerpt,
        s.title AS source_title, s.source_url, s.doi,
        s.license_status, s.access_status, s.rights_basis
      FROM research_claims c
      JOIN research_sources s ON s.id = c.source_id AND s.namespace = c.namespace
      WHERE c.id = ANY($1::uuid[])
        AND c.status = 'APPROVED'
        AND s.access_status = 'APPROVED'
        AND (c.tenant_id = $2 OR c.tenant_id IS NULL)
      ORDER BY c.id ASC
      `,
      [claimIds, tenantId],
      { tenantId },
    );
    if (result.rows.length !== claimIds.length) {
      throw new ConflictException('Every knowledge-release claim must be approved and visible in the current tenant/global namespace');
    }

    const seen = new Set<string>();
    let consistencyPassed = true;
    let citationCoveragePassed = true;
    let rightsPassed = true;
    const sources = new Map<string, Record<string, unknown>>();
    const unsafePatterns = [
      /\bignore\s+(all|any|previous)\s+(system\s+)?instructions?\b/i,
      /\b(disregard|override)\s+(all\s+|the\s+)?(system|developer|previous)\s+(prompt|instructions?)\b/i,
      /\b(reveal|print|expose|exfiltrate)\s+(the\s+)?(system prompt|hidden instructions|secrets?)\b/i,
      /\byou are now (chatgpt|an assistant|the system)\b/i,
      /\bbegin\s+(system|developer)\s+prompt\b/i,
    ];
    const safetyFlags: string[] = [];
    for (const claim of result.rows) {
      const normalized = claim.claim_text.toLowerCase().replace(/\s+/g, ' ').trim();
      if (seen.has(normalized)) consistencyPassed = false;
      seen.add(normalized);
      const locator = claim.provenance_ref;
      if (!locator || !Object.keys(locator).some(key => {
        const value = locator[key];
        return value !== null && value !== undefined && String(value).trim() !== '';
      }) || (!claim.doi && !claim.source_url)) {
        citationCoveragePassed = false;
      }
      if (!['OPEN_ACCESS', 'LICENSED', 'USER_PROVIDED_AUTHORIZED'].includes(claim.license_status)
        || !claim.rights_basis?.trim()) {
        rightsPassed = false;
      }
      const untrustedText = claim.claim_text + '\n' + (claim.stored_excerpt ?? '');
      if (unsafePatterns.some(pattern => pattern.test(untrustedText))) safetyFlags.push(claim.id);
      sources.set(claim.source_id, {
        sourceId: claim.source_id,
        title: claim.source_title,
        doi: claim.doi,
        sourceUrl: claim.source_url,
      });
    }
    if (!rightsPassed) throw new ForbiddenException('A knowledge release cannot cite a source without approved reuse rights');
    if (!consistencyPassed) throw new ConflictException('Duplicate research claim text was found in this release');
    if (!citationCoveragePassed) throw new ConflictException('Every research claim needs a source locator and source URL or DOI');

    const claimsFingerprint = result.rows.map(claim => ({
      id: claim.id,
      namespace: claim.namespace,
      claimText: claim.claim_text,
      evidenceGrade: claim.evidence_grade,
      evidenceStrength: claim.evidence_strength,
      provenance: claim.provenance_ref,
      storedExcerpt: claim.stored_excerpt,
      sourceId: claim.source_id,
      sourceTitle: claim.source_title,
      sourceUrl: claim.source_url,
      doi: claim.doi,
      licenseStatus: claim.license_status,
      accessStatus: claim.access_status,
      rightsBasis: claim.rights_basis,
    }));
    const contentFingerprint = createHash('sha256')
      .update(JSON.stringify(claimsFingerprint))
      .digest('hex');

    return {
      sources: [...sources.values()],
      contentFingerprint,
      validation: {
        consistencyPassed,
        citationCoveragePassed,
        rightsPassed,
        safetyPassed: safetyFlags.length === 0,
        safetyFlags,
        safetyReviewRequired: safetyFlags.length > 0,
        safetyReviewed: false,
        automaticContractChecks: true,
        evaluationVersion: 'research-release-contract.v1',
        regressionRequired: true,
        claimCount: result.rows.length,
      },
    };
  }

  private async insertOutbox(
    client: PoolClient,
    input: {
      tenantId: string; factoryId: string | null; userId: string;
      aggregateType: string; aggregateId: string; eventType: string;
      correlationId: string; payload: Record<string, unknown>;
    },
  ) {
    await client.query(
      `
      INSERT INTO outbox_events (
        tenant_id, factory_id, aggregate_type, aggregate_id,
        event_type, event_version, occurred_at, correlation_id, causation_id,
        actor, source, payload
      )
      VALUES (
        $1, $2, $3, $4, $5, 1, clock_timestamp(), $6::uuid, NULL,
        $7::jsonb, $8::jsonb, $9::jsonb
      )
      `,
      [
        input.tenantId, input.factoryId, input.aggregateType, input.aggregateId,
        input.eventType, input.correlationId,
        JSON.stringify({ type: 'user', id: input.userId }),
        JSON.stringify({ system: 'FactoryOS', connector: 'research-service', version: process.env.APP_VERSION ?? '0.1.0' }),
        JSON.stringify(input.payload),
      ],
    );
  }

  private async auditSafely(input: {
    tenantId: string; userId: string; factoryId: string | null;
    action: string; resourceId: string; requestId: string | null;
    traceId: string | null; payload: Record<string, unknown>;
  }) {
    try {
      await this.audit.record({
        tenantId: input.tenantId,
        factoryId: input.factoryId,
        actorUserId: input.userId,
        eventType: 'RESEARCH',
        action: input.action,
        resourceType: 'RESEARCH',
        resourceId: input.resourceId,
        requestId: input.requestId && isUUID(input.requestId) ? input.requestId : null,
        correlationId: input.traceId && isUUID(input.traceId) ? input.traceId : null,
        dataClass: 'INTERNAL',
        payload: input.payload,
      });
    } catch {
      // The transaction already persisted the domain event; don't erase a business result on audit transport failure.
    }
  }

  private validateUuid(value: string, field: string) {
    if (!isUUID(value)) throw new BadRequestException(field + ' must be a valid UUID');
  }

  private validateFactoryScope(tenantId: string, factoryId: string) {
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');
  }

  private limit(value?: number): number {
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

  private errorCode(error: unknown): string | null {
    if (typeof error !== 'object' || error === null || !('code' in error)) return null;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
}
