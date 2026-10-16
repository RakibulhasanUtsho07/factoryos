import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { IamService } from '../iam/iam.service';
import {
  CreateSaasSandboxEnvironmentDto,
  SaasSandboxDataMode,
  SaasSandboxPurpose,
} from './dto/create-saas-sandbox-environment.dto';
import { ApproveSaasSandboxMaskedDataDto } from './dto/approve-saas-sandbox-masked-data.dto';
import {
  SaasSandboxTransitionAction,
  TransitionSaasSandboxEnvironmentDto,
} from './dto/transition-saas-sandbox-environment.dto';

type SandboxStatus = 'PENDING_APPROVAL' | 'ACTIVE' | 'SUSPENDED' | 'RETIRED';
type SandboxEventType =
  | 'CREATED'
  | 'MASKED_APPROVAL_REQUESTED'
  | 'MASKED_DATA_APPROVED'
  | 'SUSPENDED'
  | 'RESUMED'
  | 'RETIRED';

type SandboxRow = QueryResultRow & {
  id: string;
  tenant_id: string;
  environment_code: string;
  display_name: string;
  purpose: SaasSandboxPurpose;
  data_mode: SaasSandboxDataMode;
  status: SandboxStatus;
  version: number | string;
  dataset_manifest: Record<string, unknown>;
  privacy_assessment: Record<string, unknown>;
  approval_requested_by: string;
  approved_by: string | null;
  approval_reason: string | null;
  approved_at: string | null;
  approval_expires_at: string | null;
  idempotency_key: string;
  request_hash: string;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
};

type SandboxEventRow = QueryResultRow & {
  id: string;
  tenant_id: string;
  environment_id: string;
  environment_version: number | string;
  event_type: SandboxEventType;
  from_status: SandboxStatus | null;
  to_status: SandboxStatus;
  data_mode: SaasSandboxDataMode;
  reason: string | null;
  idempotency_key: string;
  request_hash: string;
  actor_user_id: string;
  created_at: string;
};

@Injectable()
export class SaasSandboxService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
  ) {}

  async createEnvironment(tenantId: string, actorUserId: string, input: CreateSaasSandboxEnvironmentDto) {
    this.scope(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.sandboxes.write');

    const environmentCode = this.requiredString(input?.environment_code, 'environment_code', 48).toUpperCase();
    if (!/^[A-Z][A-Z0-9_-]{0,47}$/.test(environmentCode)) {
      throw new BadRequestException('environment_code must use uppercase letters, digits, underscore or hyphen');
    }
    const displayName = this.requiredString(input?.display_name, 'display_name', 160);
    if (!Object.values(SaasSandboxPurpose).includes(input?.purpose)) {
      throw new BadRequestException('purpose is invalid');
    }
    if (!Object.values(SaasSandboxDataMode).includes(input?.data_mode)) {
      throw new BadRequestException('data_mode must be SYNTHETIC or MASKED');
    }

    const datasetManifest = this.validateManifest(input.data_mode, input.dataset_manifest);
    const privacyAssessment = this.validatePrivacyAssessment(input.data_mode, input.privacy_assessment);
    const idempotencyKey = this.requiredIdempotencyKey(input.idempotency_key);
    const status: SandboxStatus = input.data_mode === SaasSandboxDataMode.SYNTHETIC
      ? 'ACTIVE'
      : 'PENDING_APPROVAL';
    const requestHash = this.hash({
      operation: 'CREATE_SANDBOX',
      environmentCode,
      displayName,
      purpose: input.purpose,
      dataMode: input.data_mode,
      datasetManifest,
      privacyAssessment,
    });

    const outcome = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const existingByKey = await client.query<SandboxRow>(
        this.environmentSelect() + ' WHERE e.tenant_id = $1 AND e.idempotency_key = $2 LIMIT 1',
        [tenantId, idempotencyKey],
      );
      if (existingByKey.rows[0]) {
        const prior = existingByKey.rows[0];
        if (prior.request_hash !== requestHash) {
          throw new ConflictException('idempotency_key was already used for a different sandbox request');
        }
        return { environment: prior, event: null, replayed: true };
      }
      const eventKey = await client.query<{ id: string }>(
        'SELECT id::text AS id FROM saas_sandbox_environment_events WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1',
        [tenantId, idempotencyKey],
      );
      if (eventKey.rows[0]) {
        throw new ConflictException('idempotency_key was already used for a sandbox lifecycle operation');
      }
      const existingCode = await client.query<{ id: string }>(
        'SELECT id::text AS id FROM saas_sandbox_environments WHERE tenant_id = $1 AND environment_code = $2 LIMIT 1',
        [tenantId, environmentCode],
      );
      if (existingCode.rows[0]) {
        throw new ConflictException('environment_code already exists for this tenant; create a new code for a separate sandbox');
      }

      const insertedResult = await client.query<SandboxRow>(
        `INSERT INTO saas_sandbox_environments
          (tenant_id, environment_code, display_name, purpose, data_mode, status, version,
           dataset_manifest, privacy_assessment, approval_requested_by, idempotency_key,
           request_hash, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,1,$7::jsonb,$8::jsonb,$9,$10,$11,$9,$9)
         RETURNING id::text AS id, tenant_id::text AS tenant_id, environment_code, display_name,
           purpose, data_mode, status, version, dataset_manifest, privacy_assessment,
           approval_requested_by::text AS approval_requested_by, approved_by::text AS approved_by,
           approval_reason, approved_at::text AS approved_at, approval_expires_at::text AS approval_expires_at,
           idempotency_key, request_hash, created_by::text AS created_by, updated_by::text AS updated_by,
           created_at::text AS created_at, updated_at::text AS updated_at`,
        [
          tenantId,
          environmentCode,
          displayName,
          input.purpose,
          input.data_mode,
          status,
          JSON.stringify(datasetManifest),
          JSON.stringify(privacyAssessment),
          actorUserId,
          idempotencyKey,
          requestHash,
        ],
      );
      const environment = insertedResult.rows[0];
      if (!environment) throw new Error('SAAS_SANDBOX_ENVIRONMENT_INSERT_FAILED');
      const eventType: SandboxEventType = input.data_mode === SaasSandboxDataMode.SYNTHETIC
        ? 'CREATED'
        : 'MASKED_APPROVAL_REQUESTED';
      const event = await this.insertEvent(client, {
        tenantId,
        environmentId: environment.id,
        version: 1,
        eventType,
        fromStatus: null,
        toStatus: status,
        dataMode: input.data_mode,
        reason: null,
        idempotencyKey,
        requestHash,
        actorUserId,
      });
      return { environment, event, replayed: false };
    }, { tenantId, userId: actorUserId });

    if (!outcome.replayed) {
      await this.audit(actorUserId, tenantId, outcome.environment.id, 'SANDBOX_ENVIRONMENT_CREATED', {
        environmentCode,
        purpose: input.purpose,
        dataMode: input.data_mode,
        status: outcome.environment.status,
        version: Number(outcome.environment.version),
      });
    }
    return {
      environment: this.mapEnvironment(outcome.environment),
      event: outcome.event ? this.mapEvent(outcome.event) : null,
      replayed: outcome.replayed,
    };
  }

  async listEnvironments(tenantId: string, actorUserId: string) {
    this.scope(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.sandboxes.read');
    const result = await this.database.query<SandboxRow>(
      this.environmentSelect() + ' WHERE e.tenant_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT 100',
      [tenantId],
      { tenantId, userId: actorUserId },
    );
    return {
      items: result.rows.map((row) => this.mapEnvironment(row)),
      count: result.rows.length,
    };
  }

  async listEvents(tenantId: string, actorUserId: string, environmentId: string) {
    this.scope(tenantId, actorUserId);
    this.assertUuid(environmentId, 'environmentId');
    await this.authorize(actorUserId, tenantId, 'saas.sandboxes.read');
    const result = await this.database.query<SandboxEventRow>(
      `SELECT id::text AS id, tenant_id::text AS tenant_id, environment_id::text AS environment_id,
              environment_version, event_type, from_status, to_status, data_mode, reason,
              idempotency_key, request_hash, actor_user_id::text AS actor_user_id, created_at::text AS created_at
       FROM saas_sandbox_environment_events
       WHERE tenant_id = $1 AND environment_id = $2
       ORDER BY environment_version DESC`,
      [tenantId, environmentId],
      { tenantId, userId: actorUserId },
    );
    if (result.rows.length === 0) {
      const environment = await this.database.query<{ id: string }>(
        'SELECT id::text AS id FROM saas_sandbox_environments WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [tenantId, environmentId],
        { tenantId, userId: actorUserId },
      );
      if (!environment.rows[0]) throw new NotFoundException('Sandbox environment was not found');
    }
    return { items: result.rows.map((row) => this.mapEvent(row)), count: result.rows.length };
  }

  /**
   * Call this live guard before a sandbox consumer opens an environment.
   * It intentionally bypasses caches so expired masked-data approval cannot
   * be hidden by a stale read. This module registers control metadata only;
   * the environment provisioner/data adapter must call this guard itself.
   */
  async assertSandboxUsable(tenantId: string, environmentId: string): Promise<void> {
    this.assertUuid(tenantId, 'tenantId');
    this.assertUuid(environmentId, 'environmentId');
    const result = await this.database.query<{
      data_mode: SaasSandboxDataMode;
      status: SandboxStatus;
      approval_expires_at: string | null;
    }>(
      `SELECT data_mode, status, approval_expires_at::text AS approval_expires_at
       FROM saas_sandbox_environments
       WHERE tenant_id = $1 AND id = $2
       LIMIT 1`,
      [tenantId, environmentId],
      { tenantId },
    );
    const environment = result.rows[0];
    if (!environment || environment.status !== 'ACTIVE') {
      throw new ForbiddenException('Sandbox environment is not active for this tenant');
    }
    if (
      environment.data_mode === SaasSandboxDataMode.MASKED
      && (!environment.approval_expires_at || new Date(environment.approval_expires_at).getTime() <= Date.now())
    ) {
      throw new ForbiddenException('Masked-data approval is missing or expired; sandbox access is disabled');
    }
  }

  async approveMaskedData(
    tenantId: string,
    actorUserId: string,
    environmentId: string,
    input: ApproveSaasSandboxMaskedDataDto,
  ) {
    this.scope(tenantId, actorUserId);
    this.assertUuid(environmentId, 'environmentId');
    await this.authorize(actorUserId, tenantId, 'saas.sandboxes.approve_masked_data');

    if (!Number.isSafeInteger(input?.expected_version) || input.expected_version < 1) {
      throw new BadRequestException('expected_version must be a positive safe integer');
    }
    const reason = this.requiredString(input?.reason, 'reason', 1000);
    const approvalExpiresAt = this.normalizeDate(input?.approval_expires_at, 'approval_expires_at');
    const now = Date.now();
    const expiresAtMs = new Date(approvalExpiresAt).getTime();
    if (expiresAtMs <= now) throw new BadRequestException('approval_expires_at must be in the future');
    if (expiresAtMs > now + 90 * 24 * 60 * 60 * 1000) {
      throw new BadRequestException('masked-data approval cannot exceed 90 days');
    }
    const idempotencyKey = this.requiredIdempotencyKey(input?.idempotency_key);
    const requestHash = this.hash({
      operation: 'APPROVE_MASKED_DATA',
      environmentId,
      expectedVersion: input.expected_version,
      reason,
      approvalExpiresAt,
    });

    const outcome = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const replay = await this.findEventReplay(client, tenantId, idempotencyKey, requestHash);
      if (replay) return replay;
      const currentResult = await client.query<SandboxRow>(
        this.environmentSelect() + ' WHERE e.tenant_id = $1 AND e.id = $2 FOR UPDATE',
        [tenantId, environmentId],
      );
      const current = currentResult.rows[0];
      if (!current) throw new NotFoundException('Sandbox environment was not found');
      if (current.data_mode !== SaasSandboxDataMode.MASKED) {
        throw new BadRequestException('Only MASKED sandbox environments require this approval');
      }
      if (current.created_by === actorUserId || current.approval_requested_by === actorUserId) {
        throw new ForbiddenException('Masked-data approval requires a reviewer different from the requester');
      }
      if (current.status === 'RETIRED') throw new ConflictException('A retired sandbox cannot be approved');
      if (current.status === 'ACTIVE' && current.approval_expires_at
        && new Date(current.approval_expires_at).getTime() > now) {
        throw new ConflictException('Current masked-data approval is still valid');
      }
      if (current.status === 'SUSPENDED' && current.approval_expires_at
        && new Date(current.approval_expires_at).getTime() > now) {
        throw new ConflictException('A suspended sandbox with valid approval must be resumed, not re-approved');
      }
      if (current.status === 'ACTIVE' && current.approval_expires_at === null) {
        throw new ConflictException('Masked-data approval metadata is incomplete');
      }
      if (Number(current.version) !== input.expected_version) {
        throw new ConflictException('Sandbox version changed; reload and retry with the latest expected_version');
      }

      const nextVersion = Number(current.version) + 1;
      const updatedResult = await client.query<SandboxRow>(
        `UPDATE saas_sandbox_environments
         SET status = 'ACTIVE', version = $3, approved_by = $4, approval_reason = $5,
             approved_at = clock_timestamp(), approval_expires_at = $6::timestamptz,
             updated_by = $4, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 AND version = $7
         RETURNING id::text AS id, tenant_id::text AS tenant_id, environment_code, display_name,
           purpose, data_mode, status, version, dataset_manifest, privacy_assessment,
           approval_requested_by::text AS approval_requested_by, approved_by::text AS approved_by,
           approval_reason, approved_at::text AS approved_at, approval_expires_at::text AS approval_expires_at,
           idempotency_key, request_hash, created_by::text AS created_by, updated_by::text AS updated_by,
           created_at::text AS created_at, updated_at::text AS updated_at`,
        [tenantId, environmentId, nextVersion, actorUserId, reason, approvalExpiresAt, input.expected_version],
      );
      const environment = updatedResult.rows[0];
      if (!environment) throw new ConflictException('Sandbox state changed concurrently; reload and retry');
      const event = await this.insertEvent(client, {
        tenantId,
        environmentId,
        version: nextVersion,
        eventType: 'MASKED_DATA_APPROVED',
        fromStatus: current.status,
        toStatus: 'ACTIVE',
        dataMode: SaasSandboxDataMode.MASKED,
        reason,
        idempotencyKey,
        requestHash,
        actorUserId,
      });
      return { environment, event, replayed: false };
    }, { tenantId, userId: actorUserId });

    if (!outcome.replayed) {
      await this.audit(actorUserId, tenantId, environmentId, 'MASKED_DATA_APPROVED', {
        status: outcome.environment.status,
        version: Number(outcome.environment.version),
        approvalExpiresAt: outcome.environment.approval_expires_at,
      });
    }
    return {
      environment: this.mapEnvironment(outcome.environment),
      event: this.mapEvent(outcome.event),
      replayed: outcome.replayed,
    };
  }

  async transition(
    tenantId: string,
    actorUserId: string,
    environmentId: string,
    input: TransitionSaasSandboxEnvironmentDto,
  ) {
    this.scope(tenantId, actorUserId);
    this.assertUuid(environmentId, 'environmentId');
    await this.authorize(actorUserId, tenantId, 'saas.sandboxes.control');
    if (!Object.values(SaasSandboxTransitionAction).includes(input?.action)) {
      throw new BadRequestException('action is invalid');
    }
    if (!Number.isSafeInteger(input?.expected_version) || input.expected_version < 1) {
      throw new BadRequestException('expected_version must be a positive safe integer');
    }
    const reason = this.requiredString(input?.reason, 'reason', 1000);
    const idempotencyKey = this.requiredIdempotencyKey(input?.idempotency_key);
    const requestHash = this.hash({
      operation: 'TRANSITION_SANDBOX',
      environmentId,
      action: input.action,
      expectedVersion: input.expected_version,
      reason,
    });

    const outcome = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const replay = await this.findEventReplay(client, tenantId, idempotencyKey, requestHash);
      if (replay) return replay;
      const currentResult = await client.query<SandboxRow>(
        this.environmentSelect() + ' WHERE e.tenant_id = $1 AND e.id = $2 FOR UPDATE',
        [tenantId, environmentId],
      );
      const current = currentResult.rows[0];
      if (!current) throw new NotFoundException('Sandbox environment was not found');
      if (Number(current.version) !== input.expected_version) {
        throw new ConflictException('Sandbox version changed; reload and retry with the latest expected_version');
      }

      let nextStatus: SandboxStatus;
      let eventType: SandboxEventType;
      switch (input.action) {
        case SaasSandboxTransitionAction.SUSPEND:
          if (current.status !== 'ACTIVE') throw new ConflictException('Only ACTIVE sandbox environments can be suspended');
          nextStatus = 'SUSPENDED';
          eventType = 'SUSPENDED';
          break;
        case SaasSandboxTransitionAction.RESUME:
          if (current.status !== 'SUSPENDED') throw new ConflictException('Only SUSPENDED sandbox environments can be resumed');
          if (current.data_mode === SaasSandboxDataMode.MASKED
            && (!current.approval_expires_at || new Date(current.approval_expires_at).getTime() <= Date.now())) {
            throw new ForbiddenException('Masked-data approval expired; a reviewer must approve it again before resuming');
          }
          nextStatus = 'ACTIVE';
          eventType = 'RESUMED';
          break;
        case SaasSandboxTransitionAction.RETIRE:
          if (current.status === 'RETIRED') throw new ConflictException('Sandbox environment is already retired');
          nextStatus = 'RETIRED';
          eventType = 'RETIRED';
          break;
        default:
          throw new BadRequestException('Unsupported sandbox transition');
      }

      const nextVersion = Number(current.version) + 1;
      const updatedResult = await client.query<SandboxRow>(
        `UPDATE saas_sandbox_environments
         SET status = $3, version = $4, updated_by = $5, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 AND version = $6
         RETURNING id::text AS id, tenant_id::text AS tenant_id, environment_code, display_name,
           purpose, data_mode, status, version, dataset_manifest, privacy_assessment,
           approval_requested_by::text AS approval_requested_by, approved_by::text AS approved_by,
           approval_reason, approved_at::text AS approved_at, approval_expires_at::text AS approval_expires_at,
           idempotency_key, request_hash, created_by::text AS created_by, updated_by::text AS updated_by,
           created_at::text AS created_at, updated_at::text AS updated_at`,
        [tenantId, environmentId, nextStatus, nextVersion, actorUserId, input.expected_version],
      );
      const environment = updatedResult.rows[0];
      if (!environment) throw new ConflictException('Sandbox state changed concurrently; reload and retry');
      const event = await this.insertEvent(client, {
        tenantId,
        environmentId,
        version: nextVersion,
        eventType,
        fromStatus: current.status,
        toStatus: nextStatus,
        dataMode: current.data_mode,
        reason,
        idempotencyKey,
        requestHash,
        actorUserId,
      });
      return { environment, event, replayed: false };
    }, { tenantId, userId: actorUserId });

    if (!outcome.replayed) {
      await this.audit(actorUserId, tenantId, environmentId, outcome.event.event_type, {
        status: outcome.environment.status,
        version: Number(outcome.environment.version),
        reason,
      });
    }
    return {
      environment: this.mapEnvironment(outcome.environment),
      event: this.mapEvent(outcome.event),
      replayed: outcome.replayed,
    };
  }

  private validateManifest(dataMode: SaasSandboxDataMode, value: unknown): Record<string, unknown> {
    if (!this.isPlainObject(value)) throw new BadRequestException('dataset_manifest must be a metadata object');
    if (dataMode === SaasSandboxDataMode.SYNTHETIC) {
      this.rejectUnknownKeys(value, ['generator', 'generator_version', 'schema_version', 'seed', 'record_count'], 'dataset_manifest');
      const generator = this.requiredString(value.generator, 'dataset_manifest.generator', 100);
      const generatorVersion = this.requiredString(value.generator_version, 'dataset_manifest.generator_version', 80);
      const schemaVersion = this.requiredString(value.schema_version, 'dataset_manifest.schema_version', 80);
      const recordCount = value.record_count;
      if (!Number.isSafeInteger(recordCount) || (recordCount as number) < 0 || (recordCount as number) > 100_000_000) {
        throw new BadRequestException('dataset_manifest.record_count must be an integer from 0 to 100000000');
      }
      const seed = this.requiredString(value.seed, 'dataset_manifest.seed', 128);
      return {
        generator,
        generator_version: generatorVersion,
        schema_version: schemaVersion,
        seed,
        record_count: recordCount,
      };
    }

    this.rejectUnknownKeys(
      value,
      ['dataset_reference', 'schema_version', 'record_count', 'masking_policy_version', 'masked_at', 'checksum_sha256'],
      'dataset_manifest',
    );
    const datasetReference = this.requiredString(value.dataset_reference, 'dataset_manifest.dataset_reference', 200);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(datasetReference)) {
      throw new BadRequestException('dataset_manifest.dataset_reference must be an opaque reference ID, not a URL or path');
    }
    const schemaVersion = this.requiredString(value.schema_version, 'dataset_manifest.schema_version', 80);
    const maskingPolicyVersion = this.requiredString(value.masking_policy_version, 'dataset_manifest.masking_policy_version', 80);
    const maskedAt = this.normalizeDate(value.masked_at, 'dataset_manifest.masked_at');
    const checksum = this.requiredString(value.checksum_sha256, 'dataset_manifest.checksum_sha256', 64).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(checksum)) throw new BadRequestException('dataset_manifest.checksum_sha256 must be a SHA-256 hex digest');
    const recordCount = value.record_count;
    if (!Number.isSafeInteger(recordCount) || (recordCount as number) < 0 || (recordCount as number) > 100_000_000) {
      throw new BadRequestException('dataset_manifest.record_count must be an integer from 0 to 100000000');
    }
    if (new Date(maskedAt).getTime() > Date.now()) {
      throw new BadRequestException('dataset_manifest.masked_at cannot be in the future');
    }
    return {
      dataset_reference: datasetReference,
      schema_version: schemaVersion,
      record_count: recordCount,
      masking_policy_version: maskingPolicyVersion,
      masked_at: maskedAt,
      checksum_sha256: checksum,
    };
  }

  private validatePrivacyAssessment(dataMode: SaasSandboxDataMode, value: unknown): Record<string, unknown> {
    if (dataMode === SaasSandboxDataMode.SYNTHETIC) {
      if (value !== undefined && (!this.isPlainObject(value) || Object.keys(value).length > 0)) {
        throw new BadRequestException('Synthetic datasets must not include a customer-data privacy assessment payload');
      }
      return {};
    }
    if (!this.isPlainObject(value)) throw new BadRequestException('privacy_assessment is required for masked datasets');
    this.rejectUnknownKeys(value, ['data_minimization_status', 'residual_risk', 'reviewed_fields', 'assessed_at'], 'privacy_assessment');
    if (value.data_minimization_status !== 'ASSESSED') {
      throw new BadRequestException('privacy_assessment.data_minimization_status must be ASSESSED');
    }
    if (!['LOW', 'MEDIUM'].includes(String(value.residual_risk))) {
      throw new BadRequestException('Masked datasets with HIGH or unknown residual risk are not eligible for sandbox approval');
    }
    if (!Array.isArray(value.reviewed_fields) || value.reviewed_fields.length < 1 || value.reviewed_fields.length > 100) {
      throw new BadRequestException('privacy_assessment.reviewed_fields must contain 1 to 100 field identifiers');
    }
    const reviewedFields = value.reviewed_fields.map((field, index) => {
      const name = this.requiredString(field, `privacy_assessment.reviewed_fields[${index}]`, 120);
      if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,119}$/.test(name)) {
        throw new BadRequestException('privacy_assessment.reviewed_fields entries must be schema field identifiers');
      }
      return name;
    });
    const assessedAt = this.normalizeDate(value.assessed_at, 'privacy_assessment.assessed_at');
    if (new Date(assessedAt).getTime() > Date.now()) {
      throw new BadRequestException('privacy_assessment.assessed_at cannot be in the future');
    }
    return {
      data_minimization_status: 'ASSESSED',
      residual_risk: value.residual_risk,
      reviewed_fields: [...new Set(reviewedFields)].sort(),
      assessed_at: assessedAt,
    };
  }

  private async insertEvent(
    client: PoolClient,
    input: {
      tenantId: string;
      environmentId: string;
      version: number;
      eventType: SandboxEventType;
      fromStatus: SandboxStatus | null;
      toStatus: SandboxStatus;
      dataMode: SaasSandboxDataMode;
      reason: string | null;
      idempotencyKey: string;
      requestHash: string;
      actorUserId: string;
    },
  ) {
    const result = await client.query<SandboxEventRow>(
      `INSERT INTO saas_sandbox_environment_events
        (tenant_id, environment_id, environment_version, event_type, from_status, to_status,
         data_mode, reason, idempotency_key, request_hash, actor_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id::text AS id, tenant_id::text AS tenant_id, environment_id::text AS environment_id,
         environment_version, event_type, from_status, to_status, data_mode, reason,
         idempotency_key, request_hash, actor_user_id::text AS actor_user_id, created_at::text AS created_at`,
      [
        input.tenantId,
        input.environmentId,
        input.version,
        input.eventType,
        input.fromStatus,
        input.toStatus,
        input.dataMode,
        input.reason,
        input.idempotencyKey,
        input.requestHash,
        input.actorUserId,
      ],
    );
    if (!result.rows[0]) throw new Error('SAAS_SANDBOX_EVENT_INSERT_FAILED');
    return result.rows[0];
  }

  private async findEventReplay(client: PoolClient, tenantId: string, idempotencyKey: string, requestHash: string) {
    const priorResult = await client.query<SandboxEventRow>(
      `SELECT id::text AS id, tenant_id::text AS tenant_id, environment_id::text AS environment_id,
              environment_version, event_type, from_status, to_status, data_mode, reason,
              idempotency_key, request_hash, actor_user_id::text AS actor_user_id, created_at::text AS created_at
       FROM saas_sandbox_environment_events
       WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1`,
      [tenantId, idempotencyKey],
    );
    const priorEvent = priorResult.rows[0];
    if (!priorEvent) {
      const createKey = await client.query<{ id: string }>(
        'SELECT id::text AS id FROM saas_sandbox_environments WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1',
        [tenantId, idempotencyKey],
      );
      if (createKey.rows[0]) throw new ConflictException('idempotency_key was already used to create a sandbox environment');
      return null;
    }
    if (priorEvent.request_hash !== requestHash) {
      throw new ConflictException('idempotency_key was already used for a different sandbox lifecycle request');
    }
    const environmentResult = await client.query<SandboxRow>(
      this.environmentSelect() + ' WHERE e.tenant_id = $1 AND e.id = $2 LIMIT 1',
      [tenantId, priorEvent.environment_id],
    );
    const environment = environmentResult.rows[0];
    if (!environment) throw new NotFoundException('Sandbox lifecycle event exists but its environment is not visible');
    return { environment, event: priorEvent, replayed: true };
  }

  private environmentSelect() {
    return `SELECT e.id::text AS id, e.tenant_id::text AS tenant_id, e.environment_code, e.display_name,
                   e.purpose, e.data_mode, e.status, e.version, e.dataset_manifest, e.privacy_assessment,
                   e.approval_requested_by::text AS approval_requested_by, e.approved_by::text AS approved_by,
                   e.approval_reason, e.approved_at::text AS approved_at, e.approval_expires_at::text AS approval_expires_at,
                   e.idempotency_key, e.request_hash, e.created_by::text AS created_by, e.updated_by::text AS updated_by,
                   e.created_at::text AS created_at, e.updated_at::text AS updated_at
            FROM saas_sandbox_environments e`;
  }

  private mapEnvironment(row: SandboxRow) {
    const approvalExpiry = row.approval_expires_at ? new Date(row.approval_expires_at).getTime() : null;
    const effectiveStatus = row.status === 'ACTIVE'
      && row.data_mode === SaasSandboxDataMode.MASKED
      && (approvalExpiry === null || approvalExpiry <= Date.now())
      ? 'APPROVAL_EXPIRED'
      : row.status;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      environmentCode: row.environment_code,
      displayName: row.display_name,
      purpose: row.purpose,
      dataMode: row.data_mode,
      status: row.status,
      effectiveStatus,
      version: Number(row.version),
      datasetManifest: row.dataset_manifest,
      privacyAssessment: row.privacy_assessment,
      approvalRequestedBy: row.approval_requested_by,
      approvedBy: row.approved_by,
      approvalReason: row.approval_reason,
      approvedAt: row.approved_at,
      approvalExpiresAt: row.approval_expires_at,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapEvent(row: SandboxEventRow) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      environmentId: row.environment_id,
      environmentVersion: Number(row.environment_version),
      eventType: row.event_type,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      dataMode: row.data_mode,
      reason: row.reason,
      idempotencyKey: row.idempotency_key,
      actorUserId: row.actor_user_id,
      createdAt: row.created_at,
    };
  }

  private async lockTenant(client: PoolClient, tenantId: string) {
    const result = await client.query<{ id: string }>(
      'SELECT id::text AS id FROM tenants WHERE id = $1 FOR UPDATE',
      [tenantId],
    );
    if (!result.rows[0]) throw new NotFoundException('Tenant was not found');
  }

  private async authorize(actorUserId: string, tenantId: string, permission: string) {
    await this.iamService.authorize(actorUserId, tenantId, permission);
  }

  private async audit(actorUserId: string, tenantId: string, environmentId: string, action: string, payload: Record<string, unknown>) {
    try {
      await this.auditService.record({
        tenantId,
        factoryId: null,
        actorUserId,
        eventType: 'SAAS_SANDBOX',
        action,
        resourceType: 'SAAS_SANDBOX_ENVIRONMENT',
        resourceId: environmentId,
        correlationId: null,
        requestId: null,
        dataClass: 'INTERNAL',
        payload,
      });
    } catch {
      // The event ledger is committed atomically with the state; best-effort audit cannot duplicate a lifecycle transition.
    }
  }

  private scope(tenantId: string, actorUserId: string) {
    this.assertUuid(tenantId, 'tenantId');
    this.assertUuid(actorUserId, 'actorUserId');
  }

  private assertUuid(value: string, field: string) {
    if (typeof value !== 'string' || !isUUID(value)) throw new BadRequestException(`${field} must be a UUID`);
  }

  private requiredString(value: unknown, field: string, maxLength: number) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
      throw new BadRequestException(`${field} must be a non-empty string of at most ${maxLength} characters`);
    }
    return value.trim();
  }

  private requiredIdempotencyKey(value: unknown) {
    const key = this.requiredString(value, 'idempotency_key', 128);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(key)) {
      throw new BadRequestException('idempotency_key has an invalid format');
    }
    return key;
  }

  private normalizeDate(value: unknown, field: string) {
    if (typeof value !== 'string' && !(value instanceof Date)) {
      throw new BadRequestException(`${field} must be a valid date`);
    }
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new BadRequestException(`${field} must be a valid date`);
    return date.toISOString();
  }

  private rejectUnknownKeys(value: Record<string, unknown>, allowed: string[], field: string) {
    const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) {
      throw new BadRequestException(`${field} contains unsupported fields; only metadata/provenance fields are accepted`);
    }
  }

  private hash(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }
}
