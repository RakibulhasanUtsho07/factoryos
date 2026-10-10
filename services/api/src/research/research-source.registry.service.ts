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

import {
  CreateResearchSourceDto,
  ResearchRightsStatus,
  ResearchSourceType,
} from './dto/create-research-source.dto';
import {
  CreateResearchSourceAssessmentDto,
  ResearchSourceAssessmentDecision,
  ResearchSourceAssessmentType,
} from './dto/create-research-source-assessment.dto';

interface ResearchSourceRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  source_key: string;
  source_version: string;
  source_type: ResearchSourceType;
  title: string;
  canonical_uri: string | null;
  content_sha256: string | null;
  rights_status: ResearchRightsStatus;
  rights_basis: string | null;
  license_label: string | null;
  allow_research: boolean;
  allow_model_training: boolean;
  allow_redistribution: boolean;
  prompt_injection_status: 'NOT_ASSESSED';
  registry_status: 'REGISTERED';
  request_hash: string;
  created_by: string;
  created_at: string;
}

interface ResearchSourceAssessmentRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  source_id: string;
  assessment_type: ResearchSourceAssessmentType;
  decision: ResearchSourceAssessmentDecision;
  assessment_method: 'MANUAL';
  content_sha256: string;
  assessment_basis: string;
  idempotency_key: string;
  request_hash: string;
  assessed_by: string;
  created_at: string;
}

interface NormalizedResearchSource {
  sourceKey: string;
  sourceVersion: string;
  sourceType: ResearchSourceType;
  title: string;
  canonicalUri: string | null;
  contentSha256: string | null;
  rightsStatus: ResearchRightsStatus;
  rightsBasis: string | null;
  licenseLabel: string | null;
  allowResearch: boolean;
  allowModelTraining: boolean;
  allowRedistribution: boolean;
}

const SOURCE_TYPES = new Set<string>(Object.values(ResearchSourceType));
const RIGHTS_STATUSES = new Set<string>(Object.values(ResearchRightsStatus));

@Injectable()
export class ResearchSourceRegistryService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
  ) {}

  async registerSource(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    input: CreateResearchSourceDto,
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'research.sources.write',
      factoryId,
    );

    const normalized = this.normalizeSource(input);
    const requestHash = this.requestHash({
      tenantId,
      factoryId,
      actorUserId,
      ...normalized,
    });

    const existingResult = await this.database.query<ResearchSourceRow>(
      this.selectSourceSql(`
        tenant_id = $1
        AND factory_id = $2
        AND source_key = $3
        AND source_version = $4
      `),
      [tenantId, factoryId, normalized.sourceKey, normalized.sourceVersion],
      { tenantId, userId: actorUserId },
    );

    const existing = existingResult.rows[0];
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new ConflictException(
          'The source version already exists with different metadata',
        );
      }
      return { idempotent: true, source: this.mapSource(existing) };
    }

    const inserted = await this.database.query<ResearchSourceRow>(
      `
      INSERT INTO research_source_registry (
        id,
        tenant_id,
        factory_id,
        source_key,
        source_version,
        source_type,
        title,
        canonical_uri,
        content_sha256,
        rights_status,
        rights_basis,
        license_label,
        allow_research,
        allow_model_training,
        allow_redistribution,
        prompt_injection_status,
        registry_status,
        request_hash,
        created_by
      )
      VALUES (
        gen_random_uuid(),
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        'NOT_ASSESSED', 'REGISTERED', $15, $16
      )
      ON CONFLICT (tenant_id, factory_id, source_key, source_version) DO NOTHING
      RETURNING
        id::text AS id,
        tenant_id::text AS tenant_id,
        factory_id::text AS factory_id,
        source_key,
        source_version,
        source_type,
        title,
        canonical_uri,
        content_sha256,
        rights_status,
        rights_basis,
        license_label,
        allow_research,
        allow_model_training,
        allow_redistribution,
        prompt_injection_status,
        registry_status,
        request_hash,
        created_by::text AS created_by,
        created_at::text AS created_at
      `,
      [
        tenantId,
        factoryId,
        normalized.sourceKey,
        normalized.sourceVersion,
        normalized.sourceType,
        normalized.title,
        normalized.canonicalUri,
        normalized.contentSha256,
        normalized.rightsStatus,
        normalized.rightsBasis,
        normalized.licenseLabel,
        normalized.allowResearch,
        normalized.allowModelTraining,
        normalized.allowRedistribution,
        requestHash,
        actorUserId,
      ],
      { tenantId, userId: actorUserId },
    );

    const row = inserted.rows[0];
    if (!row) {
      const racedResult = await this.database.query<ResearchSourceRow>(
        this.selectSourceSql(`
          tenant_id = $1
          AND factory_id = $2
          AND source_key = $3
          AND source_version = $4
        `),
        [tenantId, factoryId, normalized.sourceKey, normalized.sourceVersion],
        { tenantId, userId: actorUserId },
      );
      const raced = racedResult.rows[0];
      if (!raced || raced.request_hash !== requestHash) {
        throw new ConflictException(
          'The source version was concurrently registered with conflicting metadata',
        );
      }
      return { idempotent: true, source: this.mapSource(raced) };
    }

    await this.recordAuditSafely({
      tenantId,
      factoryId,
      actorUserId,
      resourceId: row.id,
      payload: {
        sourceKey: row.source_key,
        sourceVersion: row.source_version,
        sourceType: row.source_type,
        contentSha256: row.content_sha256,
        rightsStatus: row.rights_status,
        allowResearch: row.allow_research,
        allowModelTraining: row.allow_model_training,
        allowRedistribution: row.allow_redistribution,
        promptInjectionStatus: row.prompt_injection_status,
        registryStatus: row.registry_status,
      },
    });

    return { idempotent: false, source: this.mapSource(row) };
  }

  async listSources(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    filters: {
      sourceKey?: string;
      sourceType?: string;
      limit?: number;
    } = {},
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'research.sources.read',
      factoryId,
    );

    const sourceKey = filters.sourceKey
      ? this.requiredString(filters.sourceKey, 'source_key', 200)
      : null;
    let sourceType: ResearchSourceType | null = null;
    if (filters.sourceType !== undefined && filters.sourceType !== '') {
      if (
        typeof filters.sourceType !== 'string' ||
        !SOURCE_TYPES.has(filters.sourceType)
      ) {
        throw new BadRequestException(
          'source_type must be WEB, DOCUMENT, CONNECTOR, or INTERNAL',
        );
      }
      sourceType = filters.sourceType as ResearchSourceType;
    }

    const limit = filters.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }

    const result = await this.database.query<ResearchSourceRow>(
      `
      SELECT
        id::text AS id,
        tenant_id::text AS tenant_id,
        factory_id::text AS factory_id,
        source_key,
        source_version,
        source_type,
        title,
        canonical_uri,
        content_sha256,
        rights_status,
        rights_basis,
        license_label,
        allow_research,
        allow_model_training,
        allow_redistribution,
        prompt_injection_status,
        registry_status,
        request_hash,
        created_by::text AS created_by,
        created_at::text AS created_at
      FROM research_source_registry
      WHERE tenant_id = $1
        AND factory_id = $2
        AND ($3::varchar IS NULL OR source_key = $3)
        AND ($4::varchar IS NULL OR source_type = $4)
      ORDER BY created_at DESC, id DESC
      LIMIT $5
      `,
      [tenantId, factoryId, sourceKey, sourceType, limit],
      { tenantId, userId: actorUserId },
    );

    return {
      limit,
      sources: result.rows.map((row) => this.mapSource(row)),
    };
  }

  async createAssessment(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    sourceId: string,
    input: CreateResearchSourceAssessmentDto,
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);
    this.requiredUuid(sourceId, 'sourceId');

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'research.sources.assess',
      factoryId,
    );

    if (!Object.values(ResearchSourceAssessmentType).includes(input.assessment_type)) {
      throw new BadRequestException('assessment_type must be RIGHTS or SECURITY');
    }
    if (!Object.values(ResearchSourceAssessmentDecision).includes(input.decision)) {
      throw new BadRequestException(
        'decision must be APPROVED, REJECTED, or REVIEW_REQUIRED',
      );
    }

    const contentSha256 = this.requiredString(
      input.content_sha256,
      'content_sha256',
      64,
    ).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(contentSha256)) {
      throw new BadRequestException(
        'content_sha256 must be a 64-character SHA-256 hex digest',
      );
    }

    const assessmentBasis = this.requiredString(
      input.assessment_basis,
      'assessment_basis',
      4000,
    );
    const idempotencyKey = this.requiredString(
      input.idempotency_key,
      'idempotency_key',
      128,
    );
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(idempotencyKey)) {
      throw new BadRequestException('idempotency_key contains unsupported characters');
    }

    const sourceResult = await this.database.query<
      QueryResultRow & { id: string; content_sha256: string | null }
    >(
      `
      SELECT id::text AS id, content_sha256
      FROM research_source_registry
      WHERE tenant_id = $1 AND factory_id = $2 AND id = $3
      LIMIT 1
      `,
      [tenantId, factoryId, sourceId],
      { tenantId, userId: actorUserId },
    );
    const source = sourceResult.rows[0];
    if (!source) {
      throw new NotFoundException('Research source version was not found in this factory');
    }
    if (!source.content_sha256) {
      throw new BadRequestException(
        'A registered content_sha256 is required before a source can be assessed',
      );
    }
    if (source.content_sha256 !== contentSha256) {
      throw new ConflictException(
        'Assessment content_sha256 must match the registered source version',
      );
    }

    const requestHash = this.requestHash({
      tenantId,
      factoryId,
      actorUserId,
      sourceId,
      assessmentType: input.assessment_type,
      decision: input.decision,
      assessmentMethod: 'MANUAL',
      contentSha256,
      assessmentBasis,
      idempotencyKey,
    });

    const existingResult = await this.database.query<ResearchSourceAssessmentRow>(
      this.selectAssessmentSql(`
        tenant_id = $1
        AND factory_id = $2
        AND idempotency_key = $3
      `),
      [tenantId, factoryId, idempotencyKey],
      { tenantId, userId: actorUserId },
    );
    const existing = existingResult.rows[0];
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new ConflictException(
          'The idempotency_key was already used for a different assessment',
        );
      }
      return { idempotent: true, assessment: this.mapAssessment(existing) };
    }

    const inserted = await this.database.query<ResearchSourceAssessmentRow>(
      `
      INSERT INTO research_source_assessments (
        id, tenant_id, factory_id, source_id, assessment_type, decision,
        assessment_method, content_sha256, assessment_basis, idempotency_key,
        request_hash, assessed_by
      )
      VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, 'MANUAL', $6, $7, $8, $9, $10
      )
      ON CONFLICT (tenant_id, factory_id, idempotency_key) DO NOTHING
      RETURNING
        id::text AS id,
        tenant_id::text AS tenant_id,
        factory_id::text AS factory_id,
        source_id::text AS source_id,
        assessment_type,
        decision,
        assessment_method,
        content_sha256,
        assessment_basis,
        idempotency_key,
        request_hash,
        assessed_by::text AS assessed_by,
        created_at::text AS created_at
      `,
      [
        tenantId,
        factoryId,
        sourceId,
        input.assessment_type,
        input.decision,
        contentSha256,
        assessmentBasis,
        idempotencyKey,
        requestHash,
        actorUserId,
      ],
      { tenantId, userId: actorUserId },
    );

    const row = inserted.rows[0];
    if (!row) {
      const racedResult = await this.database.query<ResearchSourceAssessmentRow>(
        this.selectAssessmentSql(`
          tenant_id = $1
          AND factory_id = $2
          AND idempotency_key = $3
        `),
        [tenantId, factoryId, idempotencyKey],
        { tenantId, userId: actorUserId },
      );
      const raced = racedResult.rows[0];
      if (!raced || raced.request_hash !== requestHash) {
        throw new ConflictException(
          'The idempotency_key was concurrently used for a different assessment',
        );
      }
      return { idempotent: true, assessment: this.mapAssessment(raced) };
    }

    await this.recordAssessmentAuditSafely({
      tenantId,
      factoryId,
      actorUserId,
      assessmentId: row.id,
      sourceId,
      assessmentType: row.assessment_type,
      decision: row.decision,
      contentSha256: row.content_sha256,
    });

    return { idempotent: false, assessment: this.mapAssessment(row) };
  }

  async listAssessments(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    sourceId: string,
    limit = 25,
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);
    this.requiredUuid(sourceId, 'sourceId');

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'research.sources.read',
      factoryId,
    );

    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }

    const sourceResult = await this.database.query<
      QueryResultRow & { id: string }
    >(
      `
      SELECT id::text AS id
      FROM research_source_registry
      WHERE tenant_id = $1 AND factory_id = $2 AND id = $3
      LIMIT 1
      `,
      [tenantId, factoryId, sourceId],
      { tenantId, userId: actorUserId },
    );
    if (!sourceResult.rows[0]) {
      throw new NotFoundException('Research source version was not found in this factory');
    }

    const result = await this.database.query<ResearchSourceAssessmentRow>(
      this.selectAssessmentSql(`
        tenant_id = $1 AND factory_id = $2 AND source_id = $3
      `, 'ORDER BY created_at DESC, id DESC LIMIT $4'),
      [tenantId, factoryId, sourceId, limit],
      { tenantId, userId: actorUserId },
    );

    return {
      sourceId,
      limit,
      assessments: result.rows.map((row) => this.mapAssessment(row)),
    };
  }

  private selectAssessmentSql(whereClause: string, ordering = 'LIMIT 1'): string {
    return `
      SELECT
        id::text AS id,
        tenant_id::text AS tenant_id,
        factory_id::text AS factory_id,
        source_id::text AS source_id,
        assessment_type,
        decision,
        assessment_method,
        content_sha256,
        assessment_basis,
        idempotency_key,
        request_hash,
        assessed_by::text AS assessed_by,
        created_at::text AS created_at
      FROM research_source_assessments
      WHERE ${whereClause}
      ${ordering}
    `;
  }

  private mapAssessment(row: ResearchSourceAssessmentRow) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      factoryId: row.factory_id,
      sourceId: row.source_id,
      assessmentType: row.assessment_type,
      decision: row.decision,
      assessmentMethod: row.assessment_method,
      contentSha256: row.content_sha256,
      assessmentBasis: row.assessment_basis,
      idempotencyKey: row.idempotency_key,
      assessedBy: row.assessed_by,
      createdAt: row.created_at,
    };
  }

  private normalizeSource(input: CreateResearchSourceDto): NormalizedResearchSource {
    const sourceKey = this.requiredString(input.source_key, 'source_key', 200);
    const sourceVersion = this.requiredString(
      input.source_version,
      'source_version',
      60,
    );
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(sourceKey)) {
      throw new BadRequestException('source_key contains unsupported characters');
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(sourceVersion)) {
      throw new BadRequestException('source_version contains unsupported characters');
    }

    if (typeof input.source_type !== 'string' || !SOURCE_TYPES.has(input.source_type)) {
      throw new BadRequestException(
        'source_type must be WEB, DOCUMENT, CONNECTOR, or INTERNAL',
      );
    }
    if (
      typeof input.rights_status !== 'string' ||
      !RIGHTS_STATUSES.has(input.rights_status)
    ) {
      throw new BadRequestException(
        'rights_status must be VERIFIED, UNKNOWN, RESTRICTED, or REVOKED',
      );
    }

    const sourceType = input.source_type as ResearchSourceType;
    const rightsStatus = input.rights_status as ResearchRightsStatus;
    const title = this.requiredString(input.title, 'title', 300);
    const canonicalUri = this.normalizeUri(input.canonical_uri);
    if (sourceType === ResearchSourceType.WEB && !canonicalUri) {
      throw new BadRequestException('canonical_uri is required for WEB sources');
    }

    let contentSha256: string | null = null;
    if (input.content_sha256 !== undefined && input.content_sha256 !== null) {
      if (
        typeof input.content_sha256 !== 'string' ||
        !/^[a-fA-F0-9]{64}$/.test(input.content_sha256)
      ) {
        throw new BadRequestException('content_sha256 must be a 64-character SHA-256 hex digest');
      }
      contentSha256 = input.content_sha256.toLowerCase();
    }

    const rightsBasis =
      input.rights_basis === undefined || input.rights_basis === null
        ? null
        : this.requiredString(input.rights_basis, 'rights_basis', 4000);
    const licenseLabel =
      input.license_label === undefined || input.license_label === null
        ? null
        : this.requiredString(input.license_label, 'license_label', 150);
    const allowResearch = this.optionalBoolean(input.allow_research, 'allow_research');
    const allowModelTraining = this.optionalBoolean(
      input.allow_model_training,
      'allow_model_training',
    );
    const allowRedistribution = this.optionalBoolean(
      input.allow_redistribution,
      'allow_redistribution',
    );

    if (rightsStatus === ResearchRightsStatus.VERIFIED && !rightsBasis) {
      throw new BadRequestException(
        'rights_basis is required when rights_status is VERIFIED',
      );
    }
    if (rightsStatus !== ResearchRightsStatus.VERIFIED) {
      if (
        rightsBasis !== null ||
        licenseLabel !== null ||
        allowResearch ||
        allowModelTraining ||
        allowRedistribution
      ) {
        throw new BadRequestException(
          'Usage permissions and license details require VERIFIED rights status',
        );
      }
    }

    return {
      sourceKey,
      sourceVersion,
      sourceType,
      title,
      canonicalUri,
      contentSha256,
      rightsStatus,
      rightsBasis,
      licenseLabel,
      allowResearch,
      allowModelTraining,
      allowRedistribution,
    };
  }

  private normalizeUri(value: string | null | undefined): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== 'string') {
      throw new BadRequestException('canonical_uri must be a valid HTTP(S) URL');
    }
    if (value.trim() === '') {
      return null;
    }
    if (value.length > 2048) {
      throw new BadRequestException('canonical_uri must be a valid HTTP(S) URL');
    }

    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      throw new BadRequestException('canonical_uri must be a valid HTTP(S) URL');
    }

    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      !url.hostname ||
      url.username !== '' ||
      url.password !== ''
    ) {
      throw new BadRequestException(
        'canonical_uri must use HTTP(S), include a hostname, and not contain credentials',
      );
    }

    return url.toString();
  }

  private optionalBoolean(value: boolean | undefined, field: string): boolean {
    if (value === undefined) {
      return false;
    }
    if (typeof value !== 'boolean') {
      throw new BadRequestException(`${field} must be a boolean`);
    }
    return value;
  }

  private selectSourceSql(whereClause: string): string {
    return `
      SELECT
        id::text AS id,
        tenant_id::text AS tenant_id,
        factory_id::text AS factory_id,
        source_key,
        source_version,
        source_type,
        title,
        canonical_uri,
        content_sha256,
        rights_status,
        rights_basis,
        license_label,
        allow_research,
        allow_model_training,
        allow_redistribution,
        prompt_injection_status,
        registry_status,
        request_hash,
        created_by::text AS created_by,
        created_at::text AS created_at
      FROM research_source_registry
      WHERE ${whereClause}
      LIMIT 1
    `;
  }

  private requestHash(input: Record<string, unknown>): string {
    return createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex');
  }

  private mapSource(row: ResearchSourceRow) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      factoryId: row.factory_id,
      sourceKey: row.source_key,
      sourceVersion: row.source_version,
      sourceType: row.source_type,
      title: row.title,
      canonicalUri: row.canonical_uri,
      contentSha256: row.content_sha256,
      rightsStatus: row.rights_status,
      rightsBasis: row.rights_basis,
      licenseLabel: row.license_label,
      allowResearch: row.allow_research,
      allowModelTraining: row.allow_model_training,
      allowRedistribution: row.allow_redistribution,
      promptInjectionStatus: row.prompt_injection_status,
      registryStatus: row.registry_status,
      createdAt: row.created_at,
    };
  }

  private validateScope(tenantId: string, factoryId: string, actorUserId: string): void {
    this.requiredUuid(tenantId, 'tenantId');
    this.requiredUuid(factoryId, 'factoryId');
    this.requiredUuid(actorUserId, 'actorUserId');
  }

  private requiredUuid(value: string, field: string): string {
    if (typeof value !== 'string' || !isUUID(value)) {
      throw new BadRequestException(`${field} must be a valid UUID`);
    }
    return value;
  }

  private requiredString(value: unknown, field: string, maxLength: number): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} is required`);
    }
    const normalized = value.trim();
    if (!normalized || normalized.length > maxLength) {
      throw new BadRequestException(
        `${field} must contain between 1 and ${maxLength} characters`,
      );
    }
    return normalized;
  }

  private async recordAssessmentAuditSafely(input: {
    tenantId: string;
    factoryId: string;
    actorUserId: string;
    assessmentId: string;
    sourceId: string;
    assessmentType: ResearchSourceAssessmentType;
    decision: ResearchSourceAssessmentDecision;
    contentSha256: string;
  }): Promise<void> {
    try {
      await this.auditService.record({
        tenantId: input.tenantId,
        factoryId: input.factoryId,
        actorUserId: input.actorUserId,
        eventType: 'RESEARCH_SOURCE_ASSESSMENT',
        action: 'RECORD_MANUAL_ASSESSMENT',
        resourceType: 'RESEARCH_SOURCE_ASSESSMENT',
        resourceId: input.assessmentId,
        dataClass: 'INTERNAL',
        payload: {
          sourceId: input.sourceId,
          assessmentType: input.assessmentType,
          decision: input.decision,
          assessmentMethod: 'MANUAL',
          contentSha256: input.contentSha256,
        },
      });
    } catch {
      // Do not mask a committed assessment if audit delivery fails.
    }
  }

  private async recordAuditSafely(input: {
    tenantId: string;
    factoryId: string;
    actorUserId: string;
    resourceId: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.auditService.record({
        tenantId: input.tenantId,
        factoryId: input.factoryId,
        actorUserId: input.actorUserId,
        eventType: 'RESEARCH_SOURCE_REGISTRY',
        action: 'REGISTER_VERSION',
        resourceType: 'RESEARCH_SOURCE',
        resourceId: input.resourceId,
        dataClass: 'INTERNAL',
        payload: input.payload,
      });
    } catch {
      // Do not mask a committed source registration if audit delivery fails.
    }
  }
}
