import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { IamService } from '../iam/iam.service';
import {
  CreateSaasSchemaCompatibilityRuleDto,
  REQUIRED_TRANSFER_CATEGORIES,
  SaasTransferDatasetCategory,
} from './dto/create-saas-schema-compatibility-rule.dto';
import { CreateSaasTenantExportDto } from './dto/create-saas-tenant-export.dto';
import { AttestSaasTenantExportDto, SaasTransferDatasetDigest } from './dto/attest-saas-tenant-export.dto';
import { ValidateSaasTenantMigrationDto } from './dto/validate-saas-tenant-migration.dto';
import { SaasTenantMigrationAction, TransitionSaasTenantMigrationDto } from './dto/transition-saas-tenant-migration.dto';

type CompatibilityDecision = 'EXACT' | 'COMPATIBLE' | 'TRANSFORM_REQUIRED' | 'INCOMPATIBLE';
type TransferOperation = 'EXPORT' | 'MIGRATION';
type TransferStatus = 'REQUESTED' | 'COMPLETED' | 'VALIDATED' | 'BLOCKED' | 'IN_PROGRESS' | 'FAILED' | 'CANCELLED';
type TransferManifest = Record<string, SaasTransferDatasetDigest>;

interface CompatibilityRuleRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  rule_key: string;
  version: string | number;
  source_schema_version: string;
  target_schema_version: string;
  decision: Exclude<CompatibilityDecision, 'EXACT'>;
  required_categories: SaasTransferDatasetCategory[];
  mapping_reference: string | null;
  status: 'ACTIVE' | 'DISABLED';
  reason: string;
  idempotency_key: string;
  request_hash: string;
  created_by: string;
  created_at: string;
}

interface TransferRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  transfer_id: string;
  version: string | number;
  operation_type: TransferOperation;
  status: TransferStatus;
  source_schema_version: string;
  target_schema_version: string | null;
  compatibility_rule_key: string | null;
  compatibility_rule_version: string | number | null;
  compatibility_decision: CompatibilityDecision | null;
  required_categories: SaasTransferDatasetCategory[];
  source_transfer_id: string | null;
  source_transfer_version: string | number | null;
  source_bundle_reference: string | null;
  source_bundle_digest: string | null;
  source_manifest: TransferManifest;
  target_bundle_reference: string | null;
  target_bundle_digest: string | null;
  target_manifest: TransferManifest;
  preservation_verified: boolean;
  reason: string;
  idempotency_key: string;
  request_hash: string;
  actor_user_id: string;
  created_at: string;
}

const CATEGORY_VALUES = Object.values(SaasTransferDatasetCategory);
const REQUIRED_CATEGORIES = [...REQUIRED_TRANSFER_CATEGORIES] as SaasTransferDatasetCategory[];
const COUNT_PRESERVATION_CATEGORIES = [
  SaasTransferDatasetCategory.AUDIT_LOG,
  SaasTransferDatasetCategory.EVIDENCE,
  SaasTransferDatasetCategory.APPROVALS,
  SaasTransferDatasetCategory.EFFECTIVE_DATED_MASTER_DATA,
] as const;

@Injectable()
export class SaasTenantDataTransferService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
  ) {}

  async registerCompatibilityRule(tenantId: string, actorUserId: string, input: CreateSaasSchemaCompatibilityRuleDto) {
    this.identity(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.data_transfers.write');

    const sourceVersion = this.schemaVersion(input?.source_schema_version, 'source_schema_version');
    const targetVersion = this.schemaVersion(input?.target_schema_version, 'target_schema_version');
    if (sourceVersion === targetVersion) {
      throw new BadRequestException('identical source and target schemas use the built-in EXACT compatibility decision');
    }
    const decision = input?.decision;
    if (!['COMPATIBLE', 'TRANSFORM_REQUIRED', 'INCOMPATIBLE'].includes(decision)) {
      throw new BadRequestException('decision is invalid');
    }
    const requiredCategories = this.normalizeCategories(input?.required_categories, 'required_categories');
    const mappingReference = this.optionalReference(input?.mapping_reference, 'mapping_reference');
    if (decision === 'TRANSFORM_REQUIRED' && !mappingReference) {
      throw new BadRequestException('TRANSFORM_REQUIRED rules require an opaque mapping_reference');
    }
    if (decision !== 'TRANSFORM_REQUIRED' && mappingReference) {
      throw new BadRequestException('mapping_reference is only permitted for TRANSFORM_REQUIRED rules');
    }
    const reason = this.requiredString(input?.reason, 'reason', 1000);
    const idempotencyKey = this.idempotencyKey(input?.idempotency_key);
    const ruleKey = 'SCHEMA-' + this.hash(sourceVersion + '->' + targetVersion).slice(0, 32).toUpperCase();
    const requestHash = this.hash({
      operation: 'REGISTER_SCHEMA_COMPATIBILITY_RULE',
      sourceVersion,
      targetVersion,
      decision,
      requiredCategories,
      mappingReference,
      reason,
    });

    const result = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const replay = await this.findRuleReplay(client, tenantId, idempotencyKey, requestHash);
      if (replay) return { rule: replay, replayed: true };
      const latest = await client.query<CompatibilityRuleRow>(
        this.ruleSelect() + ' WHERE r.tenant_id = $1 AND r.source_schema_version = $2 AND r.target_schema_version = $3 ORDER BY r.version DESC LIMIT 1',
        [tenantId, sourceVersion, targetVersion],
      );
      const version = latest.rows[0] ? Number(latest.rows[0].version) + 1 : 1;
      const insert = await client.query<{ id: string }>(
        'INSERT INTO saas_schema_compatibility_rules (tenant_id, rule_key, version, source_schema_version, target_schema_version, decision, required_categories, mapping_reference, status, reason, idempotency_key, request_hash, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,\'ACTIVE\',$9,$10,$11,$12) RETURNING id::text AS id',
        [tenantId, ruleKey, version, sourceVersion, targetVersion, decision, JSON.stringify(requiredCategories), mappingReference, reason, idempotencyKey, requestHash, actorUserId],
      );
      const rule = await this.findRuleById(client, tenantId, insert.rows[0].id);
      return { rule, replayed: false };
    }, { tenantId, userId: actorUserId });

    if (!result.replayed) {
      await this.audit(actorUserId, tenantId, 'REGISTER_COMPATIBILITY_RULE', result.rule.id, {
        sourceSchemaVersion: result.rule.source_schema_version,
        targetSchemaVersion: result.rule.target_schema_version,
        decision: result.rule.decision,
        version: Number(result.rule.version),
      });
    }
    return { rule: this.mapRule(result.rule), replayed: result.replayed };
  }

  async listCompatibilityRules(tenantId: string, actorUserId: string) {
    this.identity(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.data_transfers.read');
    const result = await this.database.query<CompatibilityRuleRow>(
      this.ruleSelect() + ' WHERE r.tenant_id = $1 ORDER BY r.source_schema_version, r.target_schema_version, r.version DESC',
      [tenantId],
      { tenantId },
    );
    const latestByPair = new Map<string, CompatibilityRuleRow>();
    for (const row of result.rows) {
      const key = row.source_schema_version + '->' + row.target_schema_version;
      if (!latestByPair.has(key)) latestByPair.set(key, row);
    }
    return [...latestByPair.values()].map((row) => this.mapRule(row));
  }

  async createExport(tenantId: string, actorUserId: string, input: CreateSaasTenantExportDto) {
    this.identity(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.data_transfers.write');

    const sourceVersion = this.schemaVersion(input?.source_schema_version, 'source_schema_version');
    const extraCategories = input?.dataset_categories === undefined
      ? []
      : this.normalizeAdditionalCategories(input.dataset_categories, 'dataset_categories');
    const requiredCategories = this.normalizeCategories([...REQUIRED_CATEGORIES, ...extraCategories], 'dataset_categories');
    const reason = this.requiredString(input?.reason, 'reason', 1000);
    const idempotencyKey = this.idempotencyKey(input?.idempotency_key);
    const requestHash = this.hash({ operation: 'CREATE_TENANT_EXPORT', sourceVersion, requiredCategories, reason });

    const result = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const replay = await this.findTransferReplay(client, tenantId, idempotencyKey, requestHash);
      if (replay) return { transfer: replay, replayed: true };
      const transferId = randomUUID();
      const insert = await client.query<{ id: string }>(
        'INSERT INTO saas_tenant_data_transfers (tenant_id, transfer_id, version, operation_type, status, source_schema_version, required_categories, reason, idempotency_key, request_hash, actor_user_id) VALUES ($1,$2,1,\'EXPORT\',\'REQUESTED\',$3,$4::jsonb,$5,$6,$7,$8) RETURNING id::text AS id',
        [tenantId, transferId, sourceVersion, JSON.stringify(requiredCategories), reason, idempotencyKey, requestHash, actorUserId],
      );
      return { transfer: await this.findTransferById(client, tenantId, insert.rows[0].id), replayed: false };
    }, { tenantId, userId: actorUserId });

    if (!result.replayed) {
      await this.audit(actorUserId, tenantId, 'REQUEST_EXPORT', result.transfer.transfer_id, {
        sourceSchemaVersion: result.transfer.source_schema_version,
        requiredCategories: result.transfer.required_categories,
      });
    }
    return { transfer: this.mapTransfer(result.transfer), replayed: result.replayed };
  }

  async attestExport(tenantId: string, actorUserId: string, transferId: string, input: AttestSaasTenantExportDto) {
    this.identity(tenantId, actorUserId);
    const normalizedTransferId = this.uuid(transferId, 'transferId');
    await this.authorize(actorUserId, tenantId, 'saas.data_transfers.execute');
    const expectedVersion = this.expectedVersion(input?.expected_version);
    const bundleReference = this.requiredReference(input?.bundle_reference, 'bundle_reference', 200);
    const bundleDigest = this.sha256(input?.bundle_digest, 'bundle_digest');
    const reason = this.requiredString(input?.reason, 'reason', 1000);
    const idempotencyKey = this.idempotencyKey(input?.idempotency_key);

    const result = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const requestHash = this.hash({
        operation: 'ATTEST_TENANT_EXPORT',
        transferId: normalizedTransferId,
        expectedVersion,
        bundleReference,
        bundleDigest,
        datasetManifest: input?.dataset_manifest,
        reason,
      });
      const replay = await this.findTransferReplay(client, tenantId, idempotencyKey, requestHash);
      if (replay) return { transfer: replay, replayed: true };
      const current = await this.findLatestTransfer(client, tenantId, normalizedTransferId, true);
      if (current.operation_type !== 'EXPORT') throw new BadRequestException('only EXPORT transfers can be attested as exports');
      if (current.status !== 'REQUESTED') throw new ConflictException('export is no longer awaiting artifact attestation');
      if (Number(current.version) !== expectedVersion) throw new ConflictException('expected_version is stale');
      const manifest = this.validateManifest(input?.dataset_manifest, current.required_categories, 'dataset_manifest');
      const insert = await client.query<{ id: string }>(
        'INSERT INTO saas_tenant_data_transfers (tenant_id, transfer_id, version, operation_type, status, source_schema_version, required_categories, source_bundle_reference, source_bundle_digest, source_manifest, reason, idempotency_key, request_hash, actor_user_id) VALUES ($1,$2,$3,\'EXPORT\',\'COMPLETED\',$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10,$11,$12) RETURNING id::text AS id',
        [tenantId, normalizedTransferId, expectedVersion + 1, current.source_schema_version, JSON.stringify(current.required_categories), bundleReference, bundleDigest, JSON.stringify(manifest), reason, idempotencyKey, requestHash, actorUserId],
      );
      return { transfer: await this.findTransferById(client, tenantId, insert.rows[0].id), replayed: false };
    }, { tenantId, userId: actorUserId });

    if (!result.replayed) {
      await this.audit(actorUserId, tenantId, 'ATTEST_EXPORT', normalizedTransferId, {
        version: Number(result.transfer.version),
        bundleDigest,
        categories: Object.keys(result.transfer.source_manifest),
      });
    }
    return { transfer: this.mapTransfer(result.transfer), replayed: result.replayed };
  }

  async validateMigration(tenantId: string, actorUserId: string, input: ValidateSaasTenantMigrationDto) {
    this.identity(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.data_transfers.write');
    const sourceTransferId = this.uuid(input?.source_transfer_id, 'source_transfer_id');
    const targetVersion = this.schemaVersion(input?.target_schema_version, 'target_schema_version');
    const reason = this.requiredString(input?.reason, 'reason', 1000);
    const idempotencyKey = this.idempotencyKey(input?.idempotency_key);
    const requestHash = this.hash({
      operation: 'VALIDATE_TENANT_MIGRATION',
      sourceTransferId,
      targetVersion,
      reason,
    });

    const result = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const replay = await this.findTransferReplay(client, tenantId, idempotencyKey, requestHash);
      if (replay) return { transfer: replay, replayed: true };
      const source = await this.findLatestTransfer(client, tenantId, sourceTransferId, true);
      if (source.operation_type !== 'EXPORT' || source.status !== 'COMPLETED') {
        throw new ConflictException('migration source must be a completed, attested tenant export');
      }

      let decision: CompatibilityDecision = 'INCOMPATIBLE';
      let rule: CompatibilityRuleRow | null = null;
      if (source.source_schema_version === targetVersion) {
        decision = 'EXACT';
      } else {
        const ruleResult = await client.query<CompatibilityRuleRow>(
          this.ruleSelect() + ' WHERE r.tenant_id = $1 AND r.source_schema_version = $2 AND r.target_schema_version = $3 AND r.status = \'ACTIVE\' ORDER BY r.version DESC LIMIT 1',
          [tenantId, source.source_schema_version, targetVersion],
        );
        rule = ruleResult.rows[0] ?? null;
        if (rule) decision = rule.decision;
      }

      const requiredCategories = this.normalizeCategories([
        ...source.required_categories,
        ...(rule?.required_categories ?? []),
      ], 'required_categories');
      const missing = requiredCategories.filter((category) => !Object.prototype.hasOwnProperty.call(source.source_manifest, category));
      const status: TransferStatus = (decision === 'EXACT' || decision === 'COMPATIBLE') && missing.length === 0
        ? 'VALIDATED'
        : 'BLOCKED';
      const transferId = randomUUID();
      const finalReason = status === 'BLOCKED'
        ? reason + ' | Compatibility blocked: ' + (missing.length ? 'source export is missing required categories ' + missing.join(',') : decision)
        : reason;
      const insert = await client.query<{ id: string }>(
        'INSERT INTO saas_tenant_data_transfers (tenant_id, transfer_id, version, operation_type, status, source_schema_version, target_schema_version, compatibility_rule_key, compatibility_rule_version, compatibility_decision, required_categories, source_transfer_id, source_transfer_version, source_bundle_reference, source_bundle_digest, source_manifest, reason, idempotency_key, request_hash, actor_user_id) VALUES ($1,$2,1,\'MIGRATION\',$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18) RETURNING id::text AS id',
        [
          tenantId, transferId, status, source.source_schema_version, targetVersion,
          rule?.rule_key ?? null, rule ? Number(rule.version) : null, decision,
          JSON.stringify(requiredCategories), source.transfer_id, Number(source.version),
          source.source_bundle_reference, source.source_bundle_digest, JSON.stringify(source.source_manifest),
          finalReason, idempotencyKey, requestHash, actorUserId,
        ],
      );
      return { transfer: await this.findTransferById(client, tenantId, insert.rows[0].id), replayed: false };
    }, { tenantId, userId: actorUserId });

    if (!result.replayed) {
      await this.audit(actorUserId, tenantId, 'VALIDATE_MIGRATION', result.transfer.transfer_id, {
        sourceTransferId,
        targetSchemaVersion: targetVersion,
        compatibilityDecision: result.transfer.compatibility_decision,
        status: result.transfer.status,
      });
    }
    return { transfer: this.mapTransfer(result.transfer), replayed: result.replayed };
  }

  async transitionMigration(tenantId: string, actorUserId: string, transferId: string, input: TransitionSaasTenantMigrationDto) {
    this.identity(tenantId, actorUserId);
    const normalizedTransferId = this.uuid(transferId, 'transferId');
    await this.authorize(actorUserId, tenantId, 'saas.data_transfers.execute');
    if (!Object.values(SaasTenantMigrationAction).includes(input?.action)) {
      throw new BadRequestException('migration transition action is invalid');
    }
    const expectedVersion = this.expectedVersion(input?.expected_version);
    const reason = this.requiredString(input?.reason, 'reason', 1000);
    const idempotencyKey = this.idempotencyKey(input?.idempotency_key);
    const attachingArtifact = input.action === SaasTenantMigrationAction.COMPLETE;
    if (attachingArtifact) {
      if (input.preservation_verified !== true) {
        throw new BadRequestException('preservation_verified must be true to complete migration');
      }
    } else if (
      input.target_bundle_reference !== undefined ||
      input.target_bundle_digest !== undefined ||
      input.target_manifest !== undefined ||
      input.preservation_verified !== undefined
    ) {
      throw new BadRequestException('target artifact fields are accepted only when completing migration');
    }
    const bundleReference = attachingArtifact ? this.requiredReference(input.target_bundle_reference, 'target_bundle_reference', 200) : null;
    const bundleDigest = attachingArtifact ? this.sha256(input.target_bundle_digest, 'target_bundle_digest') : null;

    const result = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const requestHash = this.hash({
        operation: 'TRANSITION_TENANT_MIGRATION',
        transferId: normalizedTransferId,
        expectedVersion,
        action: input.action,
        targetBundleReference: bundleReference,
        targetBundleDigest: bundleDigest,
        targetManifest: input.target_manifest,
        preservationVerified: input.preservation_verified,
        reason,
      });
      const replay = await this.findTransferReplay(client, tenantId, idempotencyKey, requestHash);
      if (replay) return { transfer: replay, replayed: true };
      const current = await this.findLatestTransfer(client, tenantId, normalizedTransferId, true);
      if (current.operation_type !== 'MIGRATION') throw new BadRequestException('only MIGRATION transfers can use migration transitions');
      if (Number(current.version) !== expectedVersion) throw new ConflictException('expected_version is stale');
      const target = this.nextMigrationStatus(current.status, input.action);

      let manifest: TransferManifest = {};
      let preservationVerified = false;
      if (attachingArtifact) {
        manifest = this.validateManifest(input.target_manifest, current.required_categories, 'target_manifest');
        this.assertProtectedCategoryCounts(current.source_manifest, manifest);
        preservationVerified = true;
      }

      const insert = await client.query<{ id: string }>(
        'INSERT INTO saas_tenant_data_transfers (tenant_id, transfer_id, version, operation_type, status, source_schema_version, target_schema_version, compatibility_rule_key, compatibility_rule_version, compatibility_decision, required_categories, source_transfer_id, source_transfer_version, source_bundle_reference, source_bundle_digest, source_manifest, target_bundle_reference, target_bundle_digest, target_manifest, preservation_verified, reason, idempotency_key, request_hash, actor_user_id) VALUES ($1,$2,$3,\'MIGRATION\',$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15::jsonb,$16,$17,$18::jsonb,$19,$20,$21,$22,$23) RETURNING id::text AS id',
        [
          tenantId, normalizedTransferId, expectedVersion + 1, target, current.source_schema_version,
          current.target_schema_version, current.compatibility_rule_key, current.compatibility_rule_version,
          current.compatibility_decision, JSON.stringify(current.required_categories), current.source_transfer_id,
          current.source_transfer_version, current.source_bundle_reference, current.source_bundle_digest,
          JSON.stringify(current.source_manifest), bundleReference, bundleDigest, JSON.stringify(manifest),
          preservationVerified, reason, idempotencyKey, requestHash, actorUserId,
        ],
      );
      return { transfer: await this.findTransferById(client, tenantId, insert.rows[0].id), replayed: false };
    }, { tenantId, userId: actorUserId });

    if (!result.replayed) {
      await this.audit(actorUserId, tenantId, input.action, normalizedTransferId, {
        version: Number(result.transfer.version),
        status: result.transfer.status,
        preservationVerified: result.transfer.preservation_verified,
      });
    }
    return { transfer: this.mapTransfer(result.transfer), replayed: result.replayed };
  }

  async listLatest(tenantId: string, actorUserId: string, operationType?: TransferOperation) {
    this.identity(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.data_transfers.read');
    if (operationType && !['EXPORT', 'MIGRATION'].includes(operationType)) {
      throw new BadRequestException('operationType must be EXPORT or MIGRATION');
    }
    const result = await this.database.query<TransferRow>(
      this.transferSelect() +
        ' WHERE d.tenant_id = $1 AND ($2::varchar IS NULL OR d.operation_type = $2) ORDER BY d.transfer_id, d.version DESC',
      [tenantId, operationType ?? null],
      { tenantId },
    );
    const latestByTransfer = new Map<string, TransferRow>();
    for (const row of result.rows) {
      if (!latestByTransfer.has(row.transfer_id)) latestByTransfer.set(row.transfer_id, row);
    }
    return [...latestByTransfer.values()].map((row) => this.mapTransfer(row));
  }

  async history(tenantId: string, actorUserId: string, transferId: string) {
    this.identity(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.data_transfers.read');
    const normalizedTransferId = this.uuid(transferId, 'transferId');
    const result = await this.database.query<TransferRow>(
      this.transferSelect() + ' WHERE d.tenant_id = $1 AND d.transfer_id = $2 ORDER BY d.version DESC',
      [tenantId, normalizedTransferId],
      { tenantId },
    );
    if (result.rows.length === 0) throw new NotFoundException('Tenant data transfer was not found');
    return result.rows.map((row) => this.mapTransfer(row));
  }

  private nextMigrationStatus(current: TransferStatus, action: SaasTenantMigrationAction): TransferStatus {
    if (action === SaasTenantMigrationAction.START) {
      if (current !== 'VALIDATED') throw new ConflictException('Only a schema-validated migration can start');
      return 'IN_PROGRESS';
    }
    if (action === SaasTenantMigrationAction.COMPLETE) {
      if (current !== 'IN_PROGRESS') throw new ConflictException('Only an in-progress migration can complete');
      return 'COMPLETED';
    }
    if (action === SaasTenantMigrationAction.FAIL) {
      if (current !== 'IN_PROGRESS') throw new ConflictException('Only an in-progress migration can fail');
      return 'FAILED';
    }
    if (action === SaasTenantMigrationAction.CANCEL) {
      if (current !== 'VALIDATED' && current !== 'IN_PROGRESS') throw new ConflictException('Only a validated or in-progress migration can be cancelled');
      return 'CANCELLED';
    }
    throw new BadRequestException('Unsupported migration action');
  }

  private assertProtectedCategoryCounts(source: TransferManifest, target: TransferManifest) {
    const mismatches = COUNT_PRESERVATION_CATEGORIES.filter((category) => {
      if (source[category] === undefined || target[category] === undefined) return true;
      return source[category].record_count !== target[category].record_count;
    });
    if (mismatches.length > 0) {
      throw new ConflictException(
        'Migration cannot complete because required preservation counts changed: ' + mismatches.join(', '),
      );
    }
  }

  private validateManifest(value: unknown, requiredCategories: SaasTransferDatasetCategory[], field: string): TransferManifest {
    if (!this.isPlainObject(value)) {
      throw new BadRequestException(field + ' must be an object keyed by dataset category');
    }
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 65536) {
      throw new BadRequestException(field + ' must not exceed 64 KiB');
    }
    const keys = Object.keys(value);
    if (keys.length < requiredCategories.length || keys.length > CATEGORY_VALUES.length) {
      throw new BadRequestException(field + ' must contain all required dataset categories and no more than nine categories');
    }
    for (const key of keys) {
      if (!CATEGORY_VALUES.includes(key as SaasTransferDatasetCategory)) {
        throw new BadRequestException(field + ' contains an unsupported category: ' + key);
      }
    }
    const missing = requiredCategories.filter((category) => !Object.prototype.hasOwnProperty.call(value, category));
    if (missing.length) throw new BadRequestException(field + ' is missing required categories: ' + missing.join(', '));

    const normalized: TransferManifest = {};
    for (const category of keys as SaasTransferDatasetCategory[]) {
      const digest = value[category];
      if (!this.isPlainObject(digest)) {
        throw new BadRequestException(field + '.' + category + ' must contain record_count and sha256');
      }
      const recordCount = digest.record_count;
      if (!Number.isSafeInteger(recordCount) || Number(recordCount) < 0) {
        throw new BadRequestException(field + '.' + category + '.record_count must be a non-negative safe integer');
      }
      normalized[category] = {
        record_count: Number(recordCount),
        sha256: this.sha256(digest.sha256, field + '.' + category + '.sha256'),
      };
    }
    return normalized;
  }

  private normalizeAdditionalCategories(value: unknown, field: string): SaasTransferDatasetCategory[] {
    if (!Array.isArray(value)) throw new BadRequestException(field + ' must be an array');
    const normalized = [...new Set(value as SaasTransferDatasetCategory[])];
    if (normalized.some((category) => !CATEGORY_VALUES.includes(category))) {
      throw new BadRequestException(field + ' contains an unsupported dataset category');
    }
    if (normalized.length > CATEGORY_VALUES.length) throw new BadRequestException(field + ' contains too many dataset categories');
    return [...normalized].sort();
  }

  private normalizeCategories(value: unknown, field: string): SaasTransferDatasetCategory[] {
    if (!Array.isArray(value)) throw new BadRequestException(field + ' must be an array');
    const normalized = [...new Set(value as SaasTransferDatasetCategory[])];
    if (normalized.some((category) => !CATEGORY_VALUES.includes(category))) {
      throw new BadRequestException(field + ' contains an unsupported dataset category');
    }
    if (normalized.length < REQUIRED_CATEGORIES.length || normalized.length > CATEGORY_VALUES.length) {
      throw new BadRequestException(field + ' must contain between five and nine categories');
    }
    const missing = REQUIRED_CATEGORIES.filter((category) => !normalized.includes(category));
    if (missing.length) throw new BadRequestException(field + ' must include ' + REQUIRED_CATEGORIES.join(', '));
    return [...normalized].sort();
  }

  private async findRuleReplay(client: PoolClient, tenantId: string, idempotencyKey: string, requestHash: string) {
    const result = await client.query<CompatibilityRuleRow>(
      this.ruleSelect() + ' WHERE r.tenant_id = $1 AND r.idempotency_key = $2 LIMIT 1',
      [tenantId, idempotencyKey],
    );
    const prior = result.rows[0];
    if (!prior) return null;
    if (prior.request_hash !== requestHash) {
      throw new ConflictException('idempotency_key was already used for a different schema compatibility request');
    }
    return prior;
  }

  private async findRuleById(client: PoolClient, tenantId: string, id: string) {
    const result = await client.query<CompatibilityRuleRow>(
      this.ruleSelect() + ' WHERE r.tenant_id = $1 AND r.id = $2 LIMIT 1',
      [tenantId, id],
    );
    if (!result.rows[0]) throw new NotFoundException('Schema compatibility rule could not be read after insert');
    return result.rows[0];
  }

  private async findTransferReplay(client: PoolClient, tenantId: string, idempotencyKey: string, requestHash: string): Promise<TransferRow | null> {
    const result = await client.query<TransferRow>(
      this.transferSelect() + ' WHERE d.tenant_id = $1 AND d.idempotency_key = $2 LIMIT 1',
      [tenantId, idempotencyKey],
    );
    const prior = result.rows[0];
    if (!prior) return null;
    if (prior.request_hash !== requestHash) {
      throw new ConflictException('idempotency_key was already used for a different tenant data transfer request');
    }
    return this.findLatestTransfer(client, tenantId, prior.transfer_id, false);
  }

  private async findLatestTransfer(client: PoolClient, tenantId: string, transferId: string, lock: boolean) {
    const result = await client.query<TransferRow>(
      this.transferSelect() + ' WHERE d.tenant_id = $1 AND d.transfer_id = $2 ORDER BY d.version DESC LIMIT 1' + (lock ? ' FOR UPDATE' : ''),
      [tenantId, transferId],
    );
    if (!result.rows[0]) throw new NotFoundException('Tenant data transfer was not found');
    return result.rows[0];
  }

  private async findTransferById(client: PoolClient, tenantId: string, id: string) {
    const result = await client.query<TransferRow>(
      this.transferSelect() + ' WHERE d.tenant_id = $1 AND d.id = $2 LIMIT 1',
      [tenantId, id],
    );
    if (!result.rows[0]) throw new NotFoundException('Tenant data transfer snapshot could not be read after insert');
    return result.rows[0];
  }

  private ruleSelect() {
    return 'SELECT r.id::text AS id, r.tenant_id::text AS tenant_id, r.rule_key, r.version, r.source_schema_version, r.target_schema_version, r.decision, r.required_categories, r.mapping_reference, r.status, r.reason, r.idempotency_key, r.request_hash, r.created_by::text AS created_by, r.created_at::text AS created_at FROM saas_schema_compatibility_rules r';
  }

  private transferSelect() {
    return 'SELECT d.id::text AS id, d.tenant_id::text AS tenant_id, d.transfer_id::text AS transfer_id, d.version, d.operation_type, d.status, d.source_schema_version, d.target_schema_version, d.compatibility_rule_key, d.compatibility_rule_version, d.compatibility_decision, d.required_categories, d.source_transfer_id::text AS source_transfer_id, d.source_transfer_version, d.source_bundle_reference, d.source_bundle_digest, d.source_manifest, d.target_bundle_reference, d.target_bundle_digest, d.target_manifest, d.preservation_verified, d.reason, d.idempotency_key, d.request_hash, d.actor_user_id::text AS actor_user_id, d.created_at::text AS created_at FROM saas_tenant_data_transfers d';
  }

  private mapRule(row: CompatibilityRuleRow) {
    return {
      id: row.id,
      ruleKey: row.rule_key,
      version: Number(row.version),
      sourceSchemaVersion: row.source_schema_version,
      targetSchemaVersion: row.target_schema_version,
      decision: row.decision,
      requiredCategories: row.required_categories,
      mappingReference: row.mapping_reference,
      status: row.status,
      reason: row.reason,
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  }

  private mapTransfer(row: TransferRow) {
    return {
      id: row.id,
      transferId: row.transfer_id,
      tenantId: row.tenant_id,
      version: Number(row.version),
      operationType: row.operation_type,
      status: row.status,
      sourceSchemaVersion: row.source_schema_version,
      targetSchemaVersion: row.target_schema_version,
      compatibilityRuleKey: row.compatibility_rule_key,
      compatibilityRuleVersion: row.compatibility_rule_version === null ? null : Number(row.compatibility_rule_version),
      compatibilityDecision: row.compatibility_decision,
      requiredCategories: row.required_categories,
      sourceTransferId: row.source_transfer_id,
      sourceTransferVersion: row.source_transfer_version === null ? null : Number(row.source_transfer_version),
      sourceBundleReference: row.source_bundle_reference,
      sourceBundleDigest: row.source_bundle_digest,
      sourceManifest: row.source_manifest,
      targetBundleReference: row.target_bundle_reference,
      targetBundleDigest: row.target_bundle_digest,
      targetManifest: row.target_manifest,
      preservationVerified: row.preservation_verified,
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

  private async authorize(userId: string, tenantId: string, permission: string) {
    await this.iamService.authorize(userId, tenantId, permission);
  }

  private async audit(actorUserId: string, tenantId: string, action: string, resourceId: string, payload: Record<string, unknown>) {
    try {
      await this.auditService.record({
        tenantId,
        factoryId: null,
        actorUserId,
        eventType: 'SAAS_TENANT_DATA_TRANSFER',
        action,
        resourceType: 'SAAS_TENANT_DATA_TRANSFER',
        resourceId,
        correlationId: null,
        requestId: null,
        dataClass: 'RESTRICTED',
        payload,
      });
    } catch {
      // Transfer snapshots are committed atomically; audit failure cannot duplicate an operation.
    }
  }

  private identity(tenantId: string, actorUserId: string) {
    this.uuid(tenantId, 'tenantId');
    this.uuid(actorUserId, 'actorUserId');
  }

  private uuid(value: unknown, field: string) {
    if (typeof value !== 'string' || !isUUID(value)) throw new BadRequestException(field + ' must be a UUID');
    return value.toLowerCase();
  }

  private schemaVersion(value: unknown, field: string) {
    const version = this.requiredString(value, field, 32);
    if (!/^[0-9]{1,8}\.[0-9]{1,8}\.[0-9]{1,8}$/.test(version)) {
      throw new BadRequestException(field + ' must be a semantic version in MAJOR.MINOR.PATCH form');
    }
    return version;
  }

  private expectedVersion(value: unknown) {
    if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) >= Number.MAX_SAFE_INTEGER) {
      throw new BadRequestException('expected_version must be a positive safe integer');
    }
    return Number(value);
  }

  private requiredString(value: unknown, field: string, maxLength: number) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
      throw new BadRequestException(field + ' must be a non-empty string of at most ' + maxLength + ' characters');
    }
    return value.trim();
  }

  private idempotencyKey(value: unknown) {
    const key = this.requiredString(value, 'idempotency_key', 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) {
      throw new BadRequestException('idempotency_key has an invalid format');
    }
    return key;
  }

  private requiredReference(value: unknown, field: string, maxLength: number) {
    const reference = this.requiredString(value, field, maxLength);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(reference)) {
      throw new BadRequestException(field + ' must be an opaque identifier; URLs, paths and secrets are not accepted');
    }
    if (reference.length > maxLength) throw new BadRequestException(field + ' exceeds its maximum length');
    return reference;
  }

  private optionalReference(value: unknown, field: string) {
    if (value === undefined || value === null || value === '') return null;
    return this.requiredReference(value, field, 200);
  }

  private sha256(value: unknown, field: string) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
      throw new BadRequestException(field + ' must be a SHA-256 hex digest');
    }
    return value.toLowerCase();
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  private hash(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
  }
}
