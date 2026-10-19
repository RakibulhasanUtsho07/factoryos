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
  CompleteResearchExtractionDto,
  CreateResearchIngestionJobDto,
  FailResearchIngestionJobDto,
  PauseResearchIngestionJobDto,
  ResearchIngestionCheckpointDto,
} from './dto/research-ingestion.dto';

type DbRow = Record<string, any>;
type SourceRow = {
  id: string;
  tenant_id: string;
  namespace: string;
  source_type: string;
  title: string;
  authors: unknown;
  publication_date: string | null;
  doi: string | null;
  venue: string | null;
  abstract: string | null;
  source_url: string | null;
  source_metadata: Record<string, unknown>;
  source_revision: number;
  rights_version: number;
  license_status: string;
  access_status: string;
  rights_basis: string | null;
  license_reference: string | null;
  full_text_storage_allowed: boolean;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_reason: string | null;
};
type LockedJob = { job: DbRow; source: SourceRow };

const RIGHTS_PERMITTED = ['OPEN_ACCESS', 'LICENSED', 'USER_PROVIDED_AUTHORIZED'];
const JOB_STATUSES = [
  'QUEUED', 'RUNNING', 'PAUSED', 'SUCCEEDED', 'FAILED', 'CANCELLED',
  'BLOCKED_RIGHTS', 'BLOCKED_SOURCE_CHANGED',
];
const STAGES = [
  'QUEUED', 'RIGHTS_CHECK', 'FETCH_METADATA', 'FETCH_CONTENT', 'NORMALIZE',
  'SAFETY_SCAN', 'EXTRACT_CLAIMS', 'VALIDATE', 'COMMIT', 'COMPLETE',
];
const CLAIM_STAGES = STAGES.slice(1, -1);

@Injectable()
export class ResearchIngestionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async createJob(
    userId: string,
    tenantId: string,
    sourceId: string,
    dto: CreateResearchIngestionJobDto,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateScope(userId, tenantId);
    this.uuid(sourceId, 'sourceId');
    const idempotencyKey = this.text(dto.idempotency_key, 'idempotency_key', 200);
    const mode = dto.mode;
    if (!['METADATA_ONLY', 'FULL_TEXT'].includes(mode)) {
      throw new BadRequestException('Unsupported research ingestion mode');
    }
    const maxAttempts = dto.max_attempts ?? 5;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
      throw new BadRequestException('max_attempts must be between 1 and 10');
    }

    return this.database.transaction({ tenantId, userId }, async (client: PoolClient) => {
      const source = await this.lockSource(client, tenantId, sourceId);
      this.assertSourceRights(source, mode);
      const sourceSnapshot = this.sourceSnapshot(source);
      const rightsSnapshot = this.rightsSnapshot(source);
      const rightsFingerprint = this.hash(rightsSnapshot);
      const requestHash = this.hash({
        sourceId, mode, maxAttempts,
        sourceRevision: Number(source.source_revision),
        rightsVersion: Number(source.rights_version),
        rightsFingerprint,
      });
      const inserted = await client.query<DbRow>(
        `INSERT INTO research_ingestion_jobs (
           tenant_id,namespace,source_id,mode,status,stage,progress_percent,attempt_count,max_attempts,
           idempotency_key,request_hash,source_revision,rights_version,rights_fingerprint,
           rights_snapshot,source_snapshot,resume_checkpoint,correlation_id,created_by
         )
         VALUES ($1,'TENANT',$2,$3,'QUEUED','QUEUED',0,0,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,'{}'::jsonb,$12,$13)
         ON CONFLICT (tenant_id,source_id,idempotency_key) DO NOTHING
         RETURNING *`,
        [
          tenantId, sourceId, mode, maxAttempts, idempotencyKey, requestHash,
          Number(source.source_revision), Number(source.rights_version), rightsFingerprint,
          JSON.stringify(rightsSnapshot), JSON.stringify(sourceSnapshot),
          this.correlationId(requestId, traceId), userId,
        ],
      );

      let row = inserted.rows[0];
      if (!row) {
        const existing = await client.query<DbRow>(
          `SELECT * FROM research_ingestion_jobs
           WHERE tenant_id=$1 AND source_id=$2 AND idempotency_key=$3 FOR SHARE`,
          [tenantId, sourceId, idempotencyKey],
        );
        row = existing.rows[0];
        if (!row) throw new Error('RESEARCH_INGESTION_IDEMPOTENCY_LOOKUP_FAILED');
        if (String(row.request_hash) !== requestHash) {
          throw new ConflictException({
            code: 'RESEARCH_INGESTION_IDEMPOTENCY_CONFLICT',
            message: 'This idempotency key was already used for a different source revision or ingestion request',
          });
        }
        return { ...this.safeJob(row), idempotentReplay: true };
      }

      await this.appendEvent(client, row, {
        eventType: 'JOB_QUEUED',
        fromStatus: null,
        toStatus: 'QUEUED',
        actorUserId: userId,
        detail: { mode, sourceRevision: Number(source.source_revision), rightsVersion: Number(source.rights_version) },
      });
      await this.auditInTransaction(client, {
        tenantId, actorUserId: userId, action: 'INGESTION_JOB_CREATED',
        resourceType: 'RESEARCH_INGESTION_JOB', resourceId: String(row.id),
        correlationId: this.correlationId(requestId, traceId),
        payload: { sourceId, mode, maxAttempts, rightsFingerprint, sourceRevision: Number(source.source_revision) },
      });
      return this.safeJob(row);
    });
  }

  async listJobs(tenantId: string, query: { source_id?: string; status?: string; limit?: number }) {
    this.uuid(tenantId, 'tenantId');
    const limit = this.limit(query.limit);
    if (query.source_id) this.uuid(query.source_id, 'source_id');
    if (query.status && !JOB_STATUSES.includes(query.status)) {
      throw new BadRequestException('Unsupported research ingestion status');
    }
    const result = await this.database.query<DbRow>(
      `SELECT id::text AS id,tenant_id::text AS tenant_id,source_id::text AS source_id,mode,
          status,stage,progress_percent,attempt_count,max_attempts,version,source_revision,rights_version,
          rights_fingerprint,resume_checkpoint,lease_owner::text AS lease_owner,lease_expires_at::text AS lease_expires_at,
          available_at::text AS available_at,last_error_code,last_error_message,retryable,correlation_id::text AS correlation_id,
          created_by::text AS created_by,started_at::text AS started_at,completed_at::text AS completed_at,
          created_at::text AS created_at,updated_at::text AS updated_at
       FROM research_ingestion_jobs
       WHERE tenant_id=$1 AND ($2::uuid IS NULL OR source_id=$2)
         AND ($3::text IS NULL OR status=$3)
       ORDER BY created_at DESC,id DESC LIMIT $4`,
      [tenantId, query.source_id ?? null, query.status ?? null, limit],
      { tenantId },
    );
    return result.rows;
  }

  async claimNextJob(
    userId: string,
    tenantId: string,
    leaseSeconds = 300,
    requestId: string | null = null,
    traceId: string | null = null,
  ) {
    this.validateScope(userId, tenantId);
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 900) {
      throw new BadRequestException('lease_seconds must be between 30 and 900');
    }
    return this.database.transaction({ tenantId, userId }, async (client: PoolClient) => {
      // An expired last attempt must become terminal instead of leaving an invisible zombie job.
      const exhausted = await client.query<DbRow>(
        `WITH expired AS (
           SELECT id FROM research_ingestion_jobs
           WHERE tenant_id=$1 AND status='RUNNING' AND lease_expires_at <= clock_timestamp()
             AND attempt_count >= max_attempts
           FOR UPDATE SKIP LOCKED
         )
         UPDATE research_ingestion_jobs j
         SET status='FAILED',lease_owner=NULL,lease_expires_at=NULL,retryable=FALSE,
             last_error_code='LEASE_EXHAUSTED',last_error_message='Worker lease expired after the final permitted attempt',
             completed_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1
         FROM expired e WHERE j.id=e.id
         RETURNING j.id::text AS id,j.stage,j.progress_percent`,
        [tenantId],
      );
      for (const row of exhausted.rows) {
        await client.query(
          `INSERT INTO research_ingestion_events
             (tenant_id,job_id,event_type,from_status,to_status,stage,progress_percent,detail,actor_user_id)
           VALUES ($1,$2,'JOB_FAILED','RUNNING','FAILED',$3,$4,$5::jsonb,$6)`,
          [tenantId, row.id, row.stage, row.progress_percent,
            JSON.stringify({ errorCode: 'LEASE_EXHAUSTED' }), userId],
        );
      }

      const candidate = await client.query<DbRow>(
        `SELECT j.*,s.access_status AS current_access_status,s.license_status AS current_license_status,
            s.rights_basis AS current_rights_basis,s.full_text_storage_allowed AS current_full_text_allowed,
            s.source_revision AS current_source_revision,s.rights_version AS current_rights_version
         FROM research_ingestion_jobs j
         JOIN research_sources s ON s.id=j.source_id AND s.tenant_id=j.tenant_id AND s.namespace=j.namespace
         WHERE j.tenant_id=$1
           AND (j.status IN ('QUEUED','PAUSED')
                OR (j.status='RUNNING' AND j.lease_expires_at <= clock_timestamp()))
           AND j.available_at <= clock_timestamp()
           AND j.attempt_count < j.max_attempts
           AND s.access_status='APPROVED'
           AND s.license_status = ANY($2::text[])
           AND s.rights_basis IS NOT NULL AND length(btrim(s.rights_basis)) > 0
           AND j.source_revision=s.source_revision AND j.rights_version=s.rights_version
           AND (j.mode <> 'FULL_TEXT' OR s.full_text_storage_allowed=TRUE)
         ORDER BY j.available_at,j.created_at,j.id
         FOR UPDATE OF j,s SKIP LOCKED
         LIMIT 1`,
        [tenantId, RIGHTS_PERMITTED],
      );
      const job = candidate.rows[0];
      if (!job) return { job: null, claimed: false };
      const fromStatus = String(job.status);
      const updated = await client.query<DbRow>(
        `UPDATE research_ingestion_jobs
         SET status='RUNNING',
             stage=CASE WHEN stage='QUEUED' THEN 'RIGHTS_CHECK' ELSE stage END,
             attempt_count=attempt_count+1,lease_owner=$1,
             lease_expires_at=clock_timestamp()+make_interval(secs => $2),
             retryable=FALSE,last_error_code=NULL,last_error_message=NULL,
             started_at=COALESCE(started_at,clock_timestamp()),updated_at=clock_timestamp(),version=version+1
         WHERE id=$3 AND tenant_id=$4
         RETURNING *`,
        [userId, leaseSeconds, job.id, tenantId],
      );
      const row = updated.rows[0];
      if (!row) throw new Error('RESEARCH_INGESTION_JOB_CLAIM_FAILED');
      await this.appendEvent(client, row, {
        eventType: 'WORKER_CLAIMED',
        fromStatus,
        toStatus: 'RUNNING',
        actorUserId: userId,
        detail: { attempt: Number(row.attempt_count), leaseSeconds, resumedFromStage: String(row.stage) },
      });
      await this.auditInTransaction(client, {
        tenantId, actorUserId: userId, action: 'INGESTION_JOB_CLAIMED',
        resourceType: 'RESEARCH_INGESTION_JOB', resourceId: String(row.id),
        correlationId: this.uuidOrNull(traceId) ?? this.uuidOrNull(requestId),
        payload: { attempt: Number(row.attempt_count), leaseSeconds, resumed: fromStatus !== 'QUEUED' },
      });
      return { job: this.safeJob(row), claimed: true };
    });
  }

  async checkpoint(
    userId: string,
    tenantId: string,
    jobId: string,
    dto: ResearchIngestionCheckpointDto,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateScope(userId, tenantId);
    this.uuid(jobId, 'jobId');
    const checkpoint = this.validateCheckpoint(dto.checkpoint);
    const message = dto.message?.trim().slice(0, 500) || null;
    if (!CLAIM_STAGES.includes(dto.stage)) throw new BadRequestException('Unsupported ingestion stage');
    return this.database.transaction({ tenantId, userId }, async (client: PoolClient) => {
      const locked = await this.lockJobAndSource(client, tenantId, jobId);
      const { job, source } = locked;
      this.assertJobOwner(job, userId);
      if (Number(job.version) !== dto.expected_version) {
        throw new ConflictException({ code: 'RESEARCH_INGESTION_VERSION_MISMATCH', currentVersion: Number(job.version) });
      }
      if (String(job.status) !== 'RUNNING') throw new ConflictException('Only a running ingestion job can be checkpointed');
      this.assertCurrentSnapshot(job, source);
      const currentStageIndex = STAGES.indexOf(String(job.stage));
      const nextStageIndex = STAGES.indexOf(dto.stage);
      if (nextStageIndex < currentStageIndex) throw new ConflictException('Ingestion stage cannot move backwards');
      if (dto.progress_percent < Number(job.progress_percent)) {
        throw new ConflictException('Ingestion progress cannot move backwards');
      }
      const digest = this.hash(checkpoint);
      const updated = await client.query<DbRow>(
        `UPDATE research_ingestion_jobs
         SET stage=$1,progress_percent=$2,resume_checkpoint=$3::jsonb,lease_expires_at=clock_timestamp()+INTERVAL '5 minutes',
             updated_at=clock_timestamp(),version=version+1
         WHERE id=$4 AND tenant_id=$5 AND version=$6 AND status='RUNNING' AND lease_owner=$7
           AND lease_expires_at > clock_timestamp()
         RETURNING *`,
        [dto.stage, dto.progress_percent, JSON.stringify(checkpoint), jobId, tenantId, dto.expected_version, userId],
      );
      const row = updated.rows[0];
      if (!row) throw new ConflictException('Ingestion lease expired or the job changed before checkpoint commit');
      await this.appendEvent(client, row, {
        eventType: 'CHECKPOINT_SAVED',
        fromStatus: 'RUNNING',
        toStatus: 'RUNNING',
        actorUserId: userId,
        checkpoint,
        detail: { stage: dto.stage, progressPercent: dto.progress_percent, message },
      });
      return this.safeJob(row);
    });
  }

  async pauseJob(
    userId: string,
    tenantId: string,
    jobId: string,
    dto: PauseResearchIngestionJobDto,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateScope(userId, tenantId);
    this.uuid(jobId, 'jobId');
    const reason = this.text(dto.reason, 'reason', 500);
    return this.database.transaction({ tenantId, userId }, async (client: PoolClient) => {
      const { job, source } = await this.lockJobAndSource(client, tenantId, jobId);
      this.assertJobOwner(job, userId);
      if (String(job.status) !== 'RUNNING') throw new ConflictException('Only a running ingestion job can be paused');
      if (Number(job.version) !== dto.expected_version) {
        throw new ConflictException({ code: 'RESEARCH_INGESTION_VERSION_MISMATCH', currentVersion: Number(job.version) });
      }
      this.assertCurrentSnapshot(job, source);
      const updated = await client.query<DbRow>(
        `UPDATE research_ingestion_jobs
         SET status='PAUSED',lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp(),version=version+1
         WHERE id=$1 AND tenant_id=$2 AND version=$3 AND status='RUNNING' AND lease_owner=$4
         RETURNING *`,
        [jobId, tenantId, dto.expected_version, userId],
      );
      const row = updated.rows[0];
      if (!row) throw new ConflictException('Ingestion job changed before pause');
      await this.appendEvent(client, row, {
        eventType: 'JOB_PAUSED', fromStatus: 'RUNNING', toStatus: 'PAUSED',
        actorUserId: userId, detail: { reason },
      });
      await this.auditInTransaction(client, {
        tenantId, actorUserId: userId, action: 'INGESTION_JOB_PAUSED',
        resourceType: 'RESEARCH_INGESTION_JOB', resourceId: jobId,
        correlationId: this.correlationId(requestId, traceId), payload: { reason, stage: row.stage },
      });
      return this.safeJob(row);
    });
  }

  async failJob(
    userId: string,
    tenantId: string,
    jobId: string,
    dto: FailResearchIngestionJobDto,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateScope(userId, tenantId);
    this.uuid(jobId, 'jobId');
    const code = dto.error_code.trim();
    const message = this.text(dto.error_message, 'error_message', 1000);
    if (!/^[A-Z][A-Z0-9_]{1,99}$/.test(code)) throw new BadRequestException('error_code must be a stable uppercase code');
    return this.database.transaction({ tenantId, userId }, async (client: PoolClient) => {
      const { job, source } = await this.lockJobAndSource(client, tenantId, jobId);
      this.assertJobOwner(job, userId);
      if (String(job.status) !== 'RUNNING') throw new ConflictException('Only a running ingestion job can be failed');
      if (Number(job.version) !== dto.expected_version) {
        throw new ConflictException({ code: 'RESEARCH_INGESTION_VERSION_MISMATCH', currentVersion: Number(job.version) });
      }
      this.assertCurrentSnapshot(job, source);
      const shouldRetry = dto.retryable && Number(job.attempt_count) < Number(job.max_attempts);
      const nextStatus = shouldRetry ? 'QUEUED' : 'FAILED';
      const delaySeconds = Math.min(300, Math.max(2, 2 ** Number(job.attempt_count)));
      const updated = await client.query<DbRow>(
        `UPDATE research_ingestion_jobs
         SET status=$1,lease_owner=NULL,lease_expires_at=NULL,
             available_at=CASE WHEN $1='QUEUED' THEN clock_timestamp()+make_interval(secs => $2) ELSE available_at END,
             last_error_code=$3,last_error_message=$4,retryable=$5,
             completed_at=CASE WHEN $1='FAILED' THEN clock_timestamp() ELSE NULL END,
             updated_at=clock_timestamp(),version=version+1
         WHERE id=$6 AND tenant_id=$7 AND version=$8 AND status='RUNNING' AND lease_owner=$9
         RETURNING *`,
        [nextStatus, delaySeconds, code, message, shouldRetry, jobId, tenantId, dto.expected_version, userId],
      );
      const row = updated.rows[0];
      if (!row) throw new ConflictException('Ingestion job changed before failure could be committed');
      await this.appendEvent(client, row, {
        eventType: shouldRetry ? 'JOB_RETRY_SCHEDULED' : 'JOB_FAILED',
        fromStatus: 'RUNNING', toStatus: nextStatus, actorUserId: userId,
        checkpoint: job.resume_checkpoint,
        detail: { errorCode: code, message, retryable: shouldRetry, retryDelaySeconds: shouldRetry ? delaySeconds : null },
      });
      await this.auditInTransaction(client, {
        tenantId, actorUserId: userId, action: shouldRetry ? 'INGESTION_JOB_RETRY_SCHEDULED' : 'INGESTION_JOB_FAILED',
        resourceType: 'RESEARCH_INGESTION_JOB', resourceId: jobId,
        correlationId: this.correlationId(requestId, traceId),
        payload: { errorCode: code, retryable: shouldRetry, attemptCount: Number(row.attempt_count) },
      });
      return this.safeJob(row);
    });
  }

  async completeExtraction(
    userId: string,
    tenantId: string,
    jobId: string,
    dto: CompleteResearchExtractionDto,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateScope(userId, tenantId);
    this.uuid(jobId, 'jobId');
    if (!Array.isArray(dto.claims) || dto.claims.length < 1 || dto.claims.length > 100) {
      throw new BadRequestException('An extraction must contain 1 to 100 claim candidates');
    }
    const claims = dto.claims.map((item) => this.normalizeExtractedClaim(item));
    const itemKeys = new Set(claims.map((item) => item.item_key));
    if (itemKeys.size !== claims.length) throw new BadRequestException('Extraction item_key values must be unique within a run');

    return this.database.transaction({ tenantId, userId }, async (client: PoolClient) => {
      const { job, source } = await this.lockJobAndSource(client, tenantId, jobId);
      this.assertJobOwner(job, userId);
      if (String(job.status) !== 'RUNNING') throw new ConflictException('Only a running ingestion job can commit extraction results');
      if (Number(job.version) !== dto.expected_version) {
        throw new ConflictException({ code: 'RESEARCH_INGESTION_VERSION_MISMATCH', currentVersion: Number(job.version) });
      }
      this.assertCurrentSnapshot(job, source);
      if (STAGES.indexOf(String(job.stage)) < STAGES.indexOf('EXTRACT_CLAIMS')) {
        throw new ConflictException('Ingestion must reach claim extraction before committing extracted claims');
      }
      if (String(job.lease_owner) !== userId || !job.lease_expires_at ||
          new Date(String(job.lease_expires_at)).getTime() <= Date.now()) {
        throw new ConflictException('Ingestion worker lease expired before extraction commit');
      }
      const sourceAllowsStorage = source.full_text_storage_allowed === true;
      if (String(job.mode) === 'METADATA_ONLY' && claims.some((item) => item.stored_excerpt)) {
        throw new ForbiddenException('Metadata-only jobs cannot persist research excerpts');
      }
      if (claims.some((item) => item.stored_excerpt) && !sourceAllowsStorage) {
        throw new ForbiddenException('Current source rights do not permit persistence of extracted text');
      }

      const rightsSnapshot = this.rightsSnapshot(source);
      const sourceSnapshot = this.sourceSnapshot(source);
      const outputPayload = {
        extractorName: this.text(dto.extractor_name, 'extractor_name', 160),
        extractorVersion: this.text(dto.extractor_version, 'extractor_version', 100),
        schemaVersion: this.text(dto.schema_version, 'schema_version', 100),
        inputSha256: dto.input_sha256.toLowerCase(),
        promptSha256: dto.prompt_sha256?.toLowerCase() ?? null,
        configSha256: dto.config_sha256?.toLowerCase() ?? null,
        claims: claims.map((item) => ({
          itemKey: item.item_key,
          claimText: item.claim_text,
          sourceLocator: item.source_locator,
          methodology: item.methodology,
          datasetDescription: item.dataset_description,
          limitations: item.limitations,
          practicalImplication: item.practical_implication,
          evidenceGrade: item.evidence_grade,
          evidenceStrength: item.evidence_strength,
          topicTags: item.topic_tags,
          excerptSha256: item.stored_excerpt ? this.hash(item.stored_excerpt) : null,
        })).sort((a, b) => a.itemKey.localeCompare(b.itemKey)),
      };
      const outputSha256 = this.hash(outputPayload);
      const safetyFindings = claims.flatMap((item) => {
        const flags = this.safetyFlags([
          item.claim_text, item.methodology, item.dataset_description,
          item.limitations, item.practical_implication, item.stored_excerpt,
        ].filter((part): part is string => Boolean(part)).join('\n'));
        return flags.length ? [{ itemKey: item.item_key, flags }] : [];
      });
      const safetyResult = safetyFindings.length ? 'REVIEW_REQUIRED' : 'PASS';
      const insertedRun = await client.query<DbRow>(
        `INSERT INTO research_extraction_runs (
           tenant_id,job_id,source_id,extractor_name,extractor_version,schema_version,
           model_provider,model_id,model_version,prompt_sha256,config_sha256,input_sha256,output_sha256,
           source_revision,rights_version,rights_fingerprint,source_snapshot,rights_snapshot,
           safety_result,safety_findings,claim_count,untrusted_input,full_text_persisted,created_by
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19,$20::jsonb,$21,TRUE,$22,$23)
         RETURNING id::text AS id,output_sha256,created_at::text AS created_at`,
        [
          tenantId, jobId, String(source.id), outputPayload.extractorName, outputPayload.extractorVersion,
          outputPayload.schemaVersion, dto.model_provider?.trim() || null, dto.model_id?.trim() || null,
          dto.model_version?.trim() || null, outputPayload.promptSha256, outputPayload.configSha256,
          outputPayload.inputSha256, outputSha256, Number(source.source_revision), Number(source.rights_version),
          String(job.rights_fingerprint), JSON.stringify(sourceSnapshot), JSON.stringify(rightsSnapshot),
          safetyResult, JSON.stringify(safetyFindings), claims.length, claims.some((item) => Boolean(item.stored_excerpt)), userId,
        ],
      );
      const run = insertedRun.rows[0];
      if (!run) throw new Error('RESEARCH_EXTRACTION_RUN_INSERT_FAILED');
      const claimIds: string[] = [];
      for (const item of claims) {
        const flags = this.safetyFlags([
          item.claim_text, item.methodology, item.dataset_description,
          item.limitations, item.practical_implication, item.stored_excerpt,
        ].filter((part): part is string => Boolean(part)).join('\n'));
        const excerptDigest = item.stored_excerpt ? this.hash(item.stored_excerpt) : null;
        const itemResult = await client.query<DbRow>(
          `INSERT INTO research_extraction_items (
             tenant_id,extraction_run_id,item_key,source_locator,claim_text_sha256,excerpt_sha256,
             safety_flags,review_status
           )
           VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8)
           RETURNING id::text AS id`,
          [
            tenantId, String(run.id), item.item_key, JSON.stringify(item.source_locator),
            this.hash(item.claim_text), excerptDigest, JSON.stringify(flags),
            flags.length ? 'REVIEW_REQUIRED' : 'PROPOSED',
          ],
        );
        const extractionItem = itemResult.rows[0];
        if (!extractionItem) throw new Error('RESEARCH_EXTRACTION_ITEM_INSERT_FAILED');
        const provenance = {
          locator: item.source_locator,
          extraction: {
            runId: String(run.id), itemKey: item.item_key,
            extractorName: outputPayload.extractorName, extractorVersion: outputPayload.extractorVersion,
            schemaVersion: outputPayload.schemaVersion, inputSha256: outputPayload.inputSha256,
            outputSha256, sourceRevision: Number(source.source_revision),
            rightsVersion: Number(source.rights_version), safetyFlags: flags,
          },
        };
        const claimResult = await client.query<DbRow>(
          `INSERT INTO research_claims (
             tenant_id,namespace,source_id,extraction_item_id,claim_text,methodology,dataset_description,
             limitations,practical_implication,evidence_grade,evidence_strength,topic_tags,provenance_ref,
             stored_excerpt,created_by
           )
           VALUES ($1,'TENANT',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14)
           RETURNING id::text AS id,status,claim_text,evidence_grade,evidence_strength`,
          [
            tenantId, source.id, String(extractionItem.id), item.claim_text, item.methodology,
            item.dataset_description, item.limitations, item.practical_implication,
            item.evidence_grade, item.evidence_strength, JSON.stringify(item.topic_tags),
            JSON.stringify(provenance), sourceAllowsStorage ? item.stored_excerpt : null, userId,
          ],
        );
        const claim = claimResult.rows[0];
        if (!claim) throw new Error('RESEARCH_EXTRACTED_CLAIM_INSERT_FAILED');
        claimIds.push(String(claim.id));
        }
      const updated = await client.query<DbRow>(
        `UPDATE research_ingestion_jobs
         SET status='SUCCEEDED',stage='COMPLETE',progress_percent=100,lease_owner=NULL,lease_expires_at=NULL,
             resume_checkpoint=jsonb_build_object('extractionRunId',$1,'claimCount',$2,'outputSha256',$3),
             completed_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1
         WHERE id=$4 AND tenant_id=$5 AND version=$6 AND status='RUNNING' AND lease_owner=$7
           AND lease_expires_at > clock_timestamp()
         RETURNING *`,
        [String(run.id), claims.length, outputSha256, jobId, tenantId, dto.expected_version, userId],
      );
      const finalJob = updated.rows[0];
      if (!finalJob) throw new ConflictException('Ingestion lease expired or job changed before extraction commit');
      await this.appendEvent(client, finalJob, {
        eventType: 'EXTRACTION_COMMITTED', fromStatus: 'RUNNING', toStatus: 'SUCCEEDED',
        actorUserId: userId, detail: {
          extractionRunId: String(run.id), claimCount: claims.length,
          outputSha256, safetyResult, flaggedClaimCount: safetyFindings.length,
        },
      });
      await this.auditInTransaction(client, {
        tenantId, actorUserId: userId, action: 'RESEARCH_EXTRACTION_COMMITTED',
        resourceType: 'RESEARCH_EXTRACTION_RUN', resourceId: String(run.id),
        correlationId: this.correlationId(requestId, traceId),
        payload: {
          sourceId: String(source.id), jobId, claimIds, outputSha256, inputSha256: outputPayload.inputSha256,
          sourceRevision: Number(source.source_revision), rightsVersion: Number(source.rights_version),
          safetyResult, flaggedClaimCount: safetyFindings.length,
        },
      });
      return {
        job: this.safeJob(finalJob),
        extractionRun: {
          id: String(run.id), outputSha256, inputSha256: outputPayload.inputSha256,
          claimCount: claims.length, safetyResult, safetyFindings, createdAt: run.created_at,
        },
        claims: claimIds,
      };
    });
  }

  async listJobEvents(userId: string, tenantId: string, jobId: string) {
    this.validateScope(userId, tenantId);
    this.uuid(jobId, 'jobId');
    const visible = await this.database.query<DbRow>(
      'SELECT id FROM research_ingestion_jobs WHERE id=$1 AND tenant_id=$2',
      [jobId, tenantId], { tenantId, userId },
    );
    if (!visible.rows[0]) throw new NotFoundException('Research ingestion job not found');
    const result = await this.database.query<DbRow>(
      `SELECT id::text AS id,job_id::text AS job_id,event_type,from_status,to_status,stage,
          progress_percent,checkpoint_digest,detail,actor_user_id::text AS actor_user_id,created_at::text AS created_at
       FROM research_ingestion_events WHERE tenant_id=$1 AND job_id=$2
       ORDER BY created_at,id LIMIT 500`,
      [tenantId, jobId], { tenantId, userId },
    );
    return result.rows;
  }

  async listSourceRightsHistory(userId: string, tenantId: string, sourceId: string, limit = 100) {
    this.validateScope(userId, tenantId);
    this.uuid(sourceId, 'sourceId');
    const safeLimit = this.limit(limit);
    const source = await this.database.query<DbRow>(
      'SELECT id FROM research_sources WHERE id=$1 AND tenant_id=$2 AND namespace=$3',
      [sourceId, tenantId, 'TENANT'], { tenantId, userId },
    );
    if (!source.rows[0]) throw new NotFoundException('Tenant research source not found');
    const rows = await this.database.query<DbRow>(
      `SELECT id::text AS id,source_id::text AS source_id,source_revision,rights_version,
          action,rights_snapshot,source_snapshot,actor_user_id::text AS actor_user_id,created_at::text AS created_at
       FROM research_source_rights_history
       WHERE tenant_id=$1 AND source_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3`,
      [tenantId, sourceId, safeLimit], { tenantId, userId },
    );
    return rows.rows;
  }

  private async lockJobAndSource(client: PoolClient, tenantId: string, jobId: string): Promise<LockedJob> {
    const lookup = await client.query<DbRow>(
      'SELECT source_id::text AS source_id FROM research_ingestion_jobs WHERE id=$1 AND tenant_id=$2',
      [jobId, tenantId],
    );
    if (!lookup.rows[0]) throw new NotFoundException('Research ingestion job not found');
    const source = await this.lockSource(client, tenantId, String(lookup.rows[0].source_id));
    const result = await client.query<DbRow>(
      'SELECT * FROM research_ingestion_jobs WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
      [jobId, tenantId],
    );
    const job = result.rows[0];
    if (!job) throw new NotFoundException('Research ingestion job not found');
    return { job, source };
  }

  private async lockSource(client: PoolClient, tenantId: string, sourceId: string): Promise<SourceRow> {
    const result = await client.query<SourceRow>(
      `SELECT id::text AS id,tenant_id::text AS tenant_id,namespace,source_type,title,authors,
          publication_date::text AS publication_date,doi,venue,abstract,source_url,source_metadata,
          source_revision,rights_version,license_status,access_status,rights_basis,license_reference,
          full_text_storage_allowed,reviewed_by::text AS reviewed_by,reviewed_at::text AS reviewed_at,review_reason
       FROM research_sources
       WHERE id=$1 AND tenant_id=$2 AND namespace='TENANT'
       FOR SHARE`,
      [sourceId, tenantId],
    );
    const source = result.rows[0];
    if (!source) throw new NotFoundException('Tenant research source not found');
    return source;
  }

  private assertSourceRights(source: SourceRow, mode: string) {
    if (source.access_status !== 'APPROVED') {
      throw new ForbiddenException('Ingestion requires a currently approved research source');
    }
    if (!RIGHTS_PERMITTED.includes(source.license_status) || !source.rights_basis?.trim()) {
      throw new ForbiddenException('The source does not have a permitted license/access basis for research ingestion');
    }
    if (source.source_type === 'CUSTOMER_PROVIDED' && source.license_status !== 'USER_PROVIDED_AUTHORIZED') {
      throw new ForbiddenException('Customer-provided source ingestion requires explicit user authorization');
    }
    if (mode === 'FULL_TEXT' && !source.full_text_storage_allowed) {
      throw new ForbiddenException('Full-text ingestion requires explicit full-text storage rights');
    }
  }

  private assertCurrentSnapshot(job: DbRow, source: SourceRow) {
    if (source.access_status !== 'APPROVED' || !RIGHTS_PERMITTED.includes(source.license_status)
      || !source.rights_basis?.trim()) {
      throw new ForbiddenException('Source rights were revoked or are no longer sufficient for ingestion');
    }
    if (String(job.mode) === 'FULL_TEXT' && !source.full_text_storage_allowed) {
      throw new ForbiddenException('Current source rights do not permit full-text ingestion');
    }
    if (Number(job.source_revision) !== Number(source.source_revision)) {
      throw new ConflictException({ code: 'RESEARCH_SOURCE_REVISION_CHANGED', sourceRevision: Number(source.source_revision) });
    }
    if (Number(job.rights_version) !== Number(source.rights_version)) {
      throw new ConflictException({ code: 'RESEARCH_SOURCE_RIGHTS_CHANGED', rightsVersion: Number(source.rights_version) });
    }
  }

  private assertJobOwner(job: DbRow, userId: string) {
    if (String(job.lease_owner ?? '') !== userId) {
      throw new ForbiddenException('Only the current ingestion lease owner can update this job');
    }
    if (!job.lease_expires_at || new Date(String(job.lease_expires_at)).getTime() <= Date.now()) {
      throw new ConflictException('Ingestion worker lease has expired');
    }
  }

  private sourceSnapshot(source: SourceRow) {
    return {
      sourceId: String(source.id),
      namespace: source.namespace,
      sourceType: source.source_type,
      sourceRevision: Number(source.source_revision),
      title: source.title,
      authors: source.authors,
      publicationDate: source.publication_date,
      doi: source.doi,
      venue: source.venue,
      abstract: source.abstract,
      sourceUrl: source.source_url,
      sourceMetadata: source.source_metadata ?? {},
    };
  }

  private rightsSnapshot(source: SourceRow) {
    return {
      sourceId: String(source.id),
      namespace: source.namespace,
      sourceRevision: Number(source.source_revision),
      rightsVersion: Number(source.rights_version),
      licenseStatus: source.license_status,
      accessStatus: source.access_status,
      rightsBasis: source.rights_basis,
      licenseReference: source.license_reference,
      fullTextStorageAllowed: source.full_text_storage_allowed,
      reviewedBy: source.reviewed_by,
      reviewedAt: source.reviewed_at,
      reviewReason: source.review_reason,
    };
  }

  private safeJob(row: DbRow) {
    const {
      request_hash: _requestHash,
      rights_snapshot: _rightsSnapshot,
      source_snapshot: _sourceSnapshot,
      ...safe
    } = row;
    return safe;
  }

  private async appendEvent(
    client: PoolClient,
    job: DbRow,
    input: {
      eventType: string;
      fromStatus: string | null;
      toStatus: string | null;
      actorUserId: string | null;
      checkpoint?: unknown;
      detail: Record<string, unknown>;
    },
  ) {
    const digest = input.checkpoint === undefined ? null : this.hash(input.checkpoint);
    await client.query(
      `INSERT INTO research_ingestion_events
         (tenant_id,job_id,event_type,from_status,to_status,stage,progress_percent,checkpoint_digest,detail,actor_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
      [
        String(job.tenant_id), String(job.id), input.eventType, input.fromStatus, input.toStatus,
        String(job.stage), Number(job.progress_percent), digest, JSON.stringify(input.detail), input.actorUserId,
      ],
    );
  }

  private async auditInTransaction(
    client: PoolClient,
    input: {
      tenantId: string;
      actorUserId: string;
      action: string;
      resourceType: string;
      resourceId: string;
      correlationId: string | null;
      payload: Record<string, unknown>;
    },
  ) {
    await this.audit.recordWithClient(client, {
      tenantId: input.tenantId,
      factoryId: null,
      actorUserId: input.actorUserId,
      eventType: 'RESEARCH_INGESTION',
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      correlationId: input.correlationId,
      payload: input.payload,
    });
  }

  private normalizeExtractedClaim(item: CompleteResearchExtractionDto['claims'][number]) {
    const itemKey = this.text(item.item_key, 'item_key', 160);
    const claimText = this.text(item.claim_text, 'claim_text', 12000);
    const locator = item.source_locator;
    if (!locator || typeof locator !== 'object' || Array.isArray(locator) ||
        !Object.entries(locator).some(([key, value]) => key.trim() && value !== null && value !== undefined && String(value).trim())) {
      throw new BadRequestException('Each extracted claim requires a page, section, passage or other source locator');
    }
    if (Buffer.byteLength(JSON.stringify(locator), 'utf8') > 16000) {
      throw new BadRequestException('Source locator exceeds the 16 KiB limit');
    }
    const excerpt = item.stored_excerpt?.trim() || null;
    if (excerpt && excerpt.length > 4000) throw new BadRequestException('Stored excerpts are limited to 4000 characters');
    const tags = (item.topic_tags ?? []).map((tag) => this.text(tag, 'topic_tag', 100));
    if (tags.length > 50 || new Set(tags.map((tag) => tag.toLocaleLowerCase())).size !== tags.length) {
      throw new BadRequestException('topic_tags must contain at most 50 unique values');
    }
    return {
      item_key: itemKey,
      claim_text: claimText,
      source_locator: locator,
      stored_excerpt: excerpt,
      methodology: item.methodology?.trim() || null,
      dataset_description: item.dataset_description?.trim() || null,
      limitations: item.limitations?.trim() || null,
      practical_implication: item.practical_implication?.trim() || null,
      evidence_grade: item.evidence_grade ?? 'UNASSESSED',
      evidence_strength: item.evidence_strength ?? 'UNASSESSED',
      topic_tags: tags,
    };
  }

  private validateCheckpoint(value: Record<string, unknown>) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('checkpoint must be a metadata object');
    }
    const visit = (entry: unknown, depth: number): void => {
      if (depth > 6) throw new BadRequestException('checkpoint nesting cannot exceed 6 levels');
      if (Array.isArray(entry)) {
        if (entry.length > 100) throw new BadRequestException('checkpoint arrays cannot exceed 100 entries');
        entry.forEach((item) => visit(item, depth + 1));
      } else if (entry && typeof entry === 'object') {
        for (const [key, child] of Object.entries(entry as Record<string, unknown>)) {
          if (/raw.?text|full.?text|document.?body|stored.?excerpt|content.?body/i.test(key)) {
            throw new BadRequestException('Checkpoint cannot retain raw document text or excerpts');
          }
          visit(child, depth + 1);
        }
      } else if (typeof entry === 'string' && entry.length > 500) {
        throw new BadRequestException('Checkpoint strings are limited to 500 characters');
      } else if (entry !== null && !['string', 'number', 'boolean', 'undefined'].includes(typeof entry)) {
        throw new BadRequestException('Checkpoint contains an unsupported metadata value');
      }
    };
    visit(value, 0);
    if (Buffer.byteLength(this.canonicalJson(value), 'utf8') > 16000) {
      throw new BadRequestException('checkpoint cannot exceed 16 KiB');
    }
    return value;
  }

  private safetyFlags(text: string): string[] {
    const flags: string[] = [];
    if (/(ignore|disregard|override)\s+(all\s+)?(previous|prior|system)\s+instructions/i.test(text)) {
      flags.push('PROMPT_CONTROL_INSTRUCTION');
    }
    if (/(reveal|print|expose|dump)\s+(the\s+)?(system prompt|hidden prompt|credentials|secrets|api keys)/i.test(text)) {
      flags.push('SECRET_EXTRACTION_INSTRUCTION');
    }
    if (/(exfiltrat|send|upload|forward)\s+.{0,80}(credential|secret|private data|customer data)/i.test(text)) {
      flags.push('POSSIBLE_DATA_EXFILTRATION_INSTRUCTION');
    }
    return [...new Set(flags)];
  }

  private hash(value: unknown) {
    return createHash('sha256').update(this.canonicalJson(value)).digest('hex');
  }

  private canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return '[' + value.map((item) => this.canonicalJson(item)).join(',') + ']';
    if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      return '{' + Object.keys(object).sort().map((key) =>
        JSON.stringify(key) + ':' + this.canonicalJson(object[key])).join(',') + '}';
    }
    return JSON.stringify(value) ?? 'null';
  }

  private validateScope(userId: string, tenantId: string) {
    this.uuid(userId, 'userId');
    this.uuid(tenantId, 'tenantId');
  }

  private uuid(value: string, field: string) {
    if (!isUUID(value)) throw new BadRequestException(field + ' must be a valid UUID');
  }

  private uuidOrNull(value: string | null): string | null {
    return value && isUUID(value) ? value : null;
  }

  private correlationId(requestId: string | null, traceId: string | null) {
    return this.uuidOrNull(traceId) ?? this.uuidOrNull(requestId) ?? randomUUID();
  }

  private text(value: string, field: string, max: number) {
    if (typeof value !== 'string') throw new BadRequestException(field + ' is required');
    const result = value.trim();
    if (!result || result.length > max) throw new BadRequestException(field + ' must contain 1-' + max + ' characters');
    return result;
  }

  private limit(value?: number) {
    const result = value ?? 50;
    if (!Number.isInteger(result) || result < 1 || result > 100) {
      throw new BadRequestException('limit must be between 1 and 100');
    }
    return result;
  }
}
