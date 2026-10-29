import {
  BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { IamService } from '../iam/iam.service';
import {
  CreateSaasBackupProviderAcceptanceDto,
  SAAS_BACKUP_PROVIDER_ACCEPTANCE_SCENARIOS,
} from './dto/create-saas-backup-provider-acceptance.dto';
import { ReviewSaasBackupProviderAcceptanceDto } from './dto/review-saas-backup-provider-acceptance.dto';
import { RevokeSaasBackupProviderAcceptanceDto } from './dto/revoke-saas-backup-provider-acceptance.dto';
import { SaasTransferDatasetCategory } from './dto/create-saas-schema-compatibility-rule.dto';

const CONFIG_REFERENCE = 'FACTORYOS_BACKUP_STORAGE_CONFIG_REFERENCE';
const PROVIDER_REFERENCE = 'FACTORYOS_BACKUP_STORAGE_PROVIDER_REFERENCE';
const PROVIDER_SCOPE_REFERENCE = 'FACTORYOS_BACKUP_STORAGE_PROVIDER_SCOPE_REFERENCE';
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_EVIDENCE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CATEGORIES = new Set<string>(Object.values(SaasTransferDatasetCategory));
const SCENARIOS = new Set<string>(SAAS_BACKUP_PROVIDER_ACCEPTANCE_SCENARIOS);

export interface NormalizedBackupProviderAcceptanceScenario {
  scenarioCode: typeof SAAS_BACKUP_PROVIDER_ACCEPTANCE_SCENARIOS[number];
  outcome: 'PASS' | 'FAIL' | 'NOT_RUN';
  evidenceReference: string;
  evidenceSha256: string;
  executedAt: string;
  runnerReference: string;
}
interface AcceptanceRow extends QueryResultRow {
  acceptance_id: string;
  tenant_id: string;
  category_code: SaasTransferDatasetCategory;
  revision: string | number;
  provider_reference: string;
  provider_scope_reference: string;
  provider_scope_digest: string;
  configuration_reference: string;
  adapter_key: string;
  adapter_version: string;
  staging_evidence_reference: string;
  evidence_manifest_digest: string;
  scenario_count: number;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  idempotency_key: string;
  request_hash: string;
  submitted_by_user_id: string;
  reviewed_by_user_id: string | null;
  review_reason: string | null;
  submitted_at: string;
  reviewed_at: string | null;
  valid_until: string | null;
}
interface EvidenceRow extends QueryResultRow {
  scenario_code: string;
  outcome: 'PASS' | 'FAIL' | 'NOT_RUN';
  evidence_reference: string;
  evidence_sha256: string;
  executed_at: string | Date;
  runner_reference: string;
}
interface ProviderScope {
  providerReference: string;
  providerScopeReference: string;
  providerScopeDigest: string;
  configurationReference: string;
  adapterKey: string;
  adapterVersion: string;
}

export function digestSaasBackupProviderAcceptanceScenarios(
  scenarios: NormalizedBackupProviderAcceptanceScenario[],
): string {
  const canonical = [...scenarios].sort((a, b) => a.scenarioCode.localeCompare(b.scenarioCode));
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

export function digestSaasBackupProviderAcceptanceScope(input: {
  providerReference: string;
  providerScopeReference: string;
  configurationReference: string;
  adapterKey: string;
  adapterVersion: string;
}): string {
  return createHash('sha256').update(JSON.stringify([
    input.providerReference, input.providerScopeReference, input.configurationReference,
    input.adapterKey, input.adapterVersion,
  ]), 'utf8').digest('hex');
}

/**
 * Durable tenant/category-scoped provider acceptance.
 * Human review evaluates immutable evidence references; it does not discover cloud principals.
 */
@Injectable()
export class SaasTenantBackupProviderAcceptanceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
    private readonly config: ConfigService,
  ) {}

  async createAcceptance(tenantValue: string, actorValue: string, input: CreateSaasBackupProviderAcceptanceDto) {
    const tenantId = this.uuid(tenantValue, 'tenantId');
    const actorUserId = this.uuid(actorValue, 'actorUserId');
    await this.iamService.authorize(actorUserId, tenantId, 'saas.data_retention.write');
    const category = this.category(input?.category_code);
    const scope = this.providerScope(this.currentConfigReference(), 's3.tenant-backup.v1', '1.0.0');
    const stagingEvidenceReference = this.reference(input?.staging_evidence_reference, 'staging_evidence_reference');
    const idempotencyKey = this.key(input?.idempotency_key, 'idempotency_key');
    const scenarios = this.normalizeScenarios(input?.scenarios);
    const evidenceManifestDigest = digestSaasBackupProviderAcceptanceScenarios(scenarios);
    const requestHash = this.hash({
      operation: 'BACKUP_PROVIDER_ACCEPTANCE',
      category,
      scope: scope.providerScopeDigest,
      stagingEvidenceReference,
      evidenceManifestDigest,
      scenarios,
    });

    const result = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const replay = await client.query<AcceptanceRow>(
        'SELECT * FROM saas_tenant_backup_provider_acceptances WHERE tenant_id=$1 AND category_code=$2 AND provider_scope_digest=$3 AND idempotency_key=$4 FOR UPDATE',
        [tenantId, category, scope.providerScopeDigest, idempotencyKey],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== requestHash) {
          throw new ConflictException('Idempotency-Key was reused for a different provider acceptance evidence pack');
        }
        return {
          row: replay.rows[0],
          scenarios: await this.readScenarios(client, tenantId, replay.rows[0].acceptance_id),
          replayed: true,
        };
      }
      const latestResult = await client.query<AcceptanceRow>(
        'SELECT * FROM saas_tenant_backup_provider_acceptances WHERE tenant_id=$1 AND category_code=$2 AND provider_scope_digest=$3 ORDER BY revision DESC LIMIT 1 FOR UPDATE',
        [tenantId, category, scope.providerScopeDigest],
      );
      const latest = latestResult.rows[0];
      if (latest?.status === 'PENDING') {
        throw new ConflictException('The latest provider acceptance is awaiting independent review');
      }
      const revision = Number(latest?.revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new ConflictException('Provider acceptance revision is outside supported bounds');
      }
      const acceptanceId = randomUUID();
      const inserted = await client.query<AcceptanceRow>(
        'INSERT INTO saas_tenant_backup_provider_acceptances ' +
        '(acceptance_id,tenant_id,category_code,revision,provider_reference,provider_scope_reference,provider_scope_digest,' +
        'configuration_reference,adapter_key,adapter_version,staging_evidence_reference,evidence_manifest_digest,scenario_count,' +
        'status,idempotency_key,request_hash,submitted_by_user_id) ' +
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,10,'PENDING',$13,$14,$15) RETURNING *",
        [acceptanceId, tenantId, category, revision, scope.providerReference, scope.providerScopeReference,
          scope.providerScopeDigest, scope.configurationReference, scope.adapterKey, scope.adapterVersion,
          stagingEvidenceReference, evidenceManifestDigest, idempotencyKey, requestHash, actorUserId],
      );
      for (const scenario of scenarios) {
        await client.query(
          'INSERT INTO saas_tenant_backup_provider_acceptance_evidence ' +
          '(tenant_id,acceptance_id,scenario_code,outcome,evidence_reference,evidence_sha256,executed_at,runner_reference) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [tenantId, acceptanceId, scenario.scenarioCode, scenario.outcome, scenario.evidenceReference,
            scenario.evidenceSha256, scenario.executedAt, scenario.runnerReference],
        );
      }
      await this.auditService.recordWithClient(client, {
        tenantId, factoryId: null, actorUserId, eventType: 'SAAS_DATA_GOVERNANCE',
        action: 'BACKUP_PROVIDER_ACCEPTANCE_SUBMITTED', resourceType: 'SAAS_BACKUP_PROVIDER_ACCEPTANCE',
        resourceId: acceptanceId, correlationId: null, requestId: null, dataClass: 'RESTRICTED',
        payload: { category, revision, providerReference: scope.providerReference,
          providerScopeReference: scope.providerScopeReference, providerScopeDigest: scope.providerScopeDigest,
          adapterKey: scope.adapterKey, adapterVersion: scope.adapterVersion, evidenceManifestDigest,
          scenarioCount: scenarios.length, failedScenarioCount: scenarios.filter((s) => s.outcome !== 'PASS').length },
      });
      return { row: inserted.rows[0]!, scenarios, replayed: false };
    }, { tenantId, userId: actorUserId, advisoryLockKey: 'saas-backup-provider-acceptance:' + tenantId + ':' + category + ':' + scope.providerScopeDigest });

    return { acceptance: this.mapAcceptance(result.row, result.scenarios), replayed: result.replayed };
  }

  async reviewAcceptance(
    tenantValue: string,
    actorValue: string,
    acceptanceValue: string,
    input: ReviewSaasBackupProviderAcceptanceDto,
  ) {
    const tenantId = this.uuid(tenantValue, 'tenantId');
    const actorUserId = this.uuid(actorValue, 'actorUserId');
    const acceptanceId = this.uuid(acceptanceValue, 'acceptanceId');
    await this.iamService.authorize(actorUserId, tenantId, 'saas.data_retention.approve');
    if (input?.decision !== 'ACCEPT' && input?.decision !== 'REJECT') {
      throw new BadRequestException('decision must be ACCEPT or REJECT');
    }
    const reason = this.requiredString(input?.reason, 'reason', 1000, 3);
    const status = input.decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED';

    const result = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const found = await client.query<AcceptanceRow>(
        'SELECT * FROM saas_tenant_backup_provider_acceptances WHERE tenant_id=$1 AND acceptance_id=$2 FOR UPDATE',
        [tenantId, acceptanceId],
      );
      const current = found.rows[0];
      if (!current) throw new NotFoundException('Backup provider acceptance not found');
      if (current.status !== 'PENDING') throw new ConflictException('Only pending provider acceptances may be reviewed');
      if (current.submitted_by_user_id === actorUserId) {
        throw new ConflictException('Provider acceptance submission and review require different actors');
      }
      const scope = this.providerScope(current.configuration_reference, current.adapter_key, current.adapter_version);
      if (current.provider_scope_digest !== scope.providerScopeDigest) {
        throw new ConflictException('Provider acceptance scope does not match the current controlled configuration');
      }
      const latest = await client.query<AcceptanceRow>(
        'SELECT * FROM saas_tenant_backup_provider_acceptances WHERE tenant_id=$1 AND category_code=$2 AND provider_scope_digest=$3 ORDER BY revision DESC LIMIT 1 FOR UPDATE',
        [tenantId, current.category_code, current.provider_scope_digest],
      );
      if (!latest.rows[0] || latest.rows[0].acceptance_id !== acceptanceId) {
        throw new ConflictException('Only the current provider acceptance revision may be reviewed');
      }
      const scenarios = await this.readScenarios(client, tenantId, acceptanceId);
      this.assertScenarioIntegrity(current, scenarios);
      if (status === 'ACCEPTED') {
        if (scenarios.some((scenario) => scenario.outcome !== 'PASS')) {
          throw new ConflictException('Provider acceptance cannot be approved while any required staging scenario failed or was not run');
        }
        this.assertEvidenceFresh(scenarios);
      }
      const updated = await client.query<AcceptanceRow>(
        'UPDATE saas_tenant_backup_provider_acceptances SET status=$3,reviewed_by_user_id=$4,' +
        'review_reason=$5,reviewed_at=clock_timestamp(),valid_until=CASE WHEN $3=\'ACCEPTED\' ' +
        "THEN clock_timestamp()+interval '90 days' ELSE NULL END " +
        "WHERE tenant_id=$1 AND acceptance_id=$2 AND status='PENDING' RETURNING *",
        [tenantId, acceptanceId, status, actorUserId, reason],
      );
      if (!updated.rows[0]) throw new ConflictException('Provider acceptance changed during review');
      await this.auditService.recordWithClient(client, {
        tenantId, factoryId: null, actorUserId, eventType: 'SAAS_DATA_GOVERNANCE',
        action: 'BACKUP_PROVIDER_ACCEPTANCE_' + input.decision, resourceType: 'SAAS_BACKUP_PROVIDER_ACCEPTANCE',
        resourceId: acceptanceId, correlationId: null, requestId: null, dataClass: 'RESTRICTED',
        payload: { category: current.category_code, revision: Number(current.revision),
          providerScopeDigest: current.provider_scope_digest, evidenceManifestDigest: current.evidence_manifest_digest,
          decision: input.decision, reason, validUntil: updated.rows[0]!.valid_until },
      });
      return { row: updated.rows[0]!, scenarios };
    }, { tenantId, userId: actorUserId, advisoryLockKey: 'saas-backup-provider-acceptance-review:' + tenantId + ':' + acceptanceId });

    return this.mapAcceptance(result.row, result.scenarios);
  }

  async revokeAcceptance(
    tenantValue: string,
    actorValue: string,
    acceptanceValue: string,
    input: RevokeSaasBackupProviderAcceptanceDto,
  ) {
    const tenantId = this.uuid(tenantValue, 'tenantId');
    const actorUserId = this.uuid(actorValue, 'actorUserId');
    const acceptanceId = this.uuid(acceptanceValue, 'acceptanceId');
    await this.iamService.authorize(actorUserId, tenantId, 'saas.data_retention.approve');
    const reason = this.requiredString(input?.reason, 'reason', 1000, 3);
    const revocation = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const found = await client.query<AcceptanceRow>(
        'SELECT * FROM saas_tenant_backup_provider_acceptances WHERE tenant_id=$1 AND acceptance_id=$2 FOR UPDATE',
        [tenantId, acceptanceId],
      );
      const current = found.rows[0];
      if (!current || current.status !== 'ACCEPTED') throw new ConflictException('Only accepted provider records can be revoked');
      if (current.submitted_by_user_id === actorUserId || current.reviewed_by_user_id === actorUserId) {
        throw new ConflictException('Provider acceptance must be revoked by a third party');
      }
      const latest = await client.query<AcceptanceRow>(
        'SELECT * FROM saas_tenant_backup_provider_acceptances WHERE tenant_id=$1 AND category_code=$2 AND provider_scope_digest=$3 ORDER BY revision DESC LIMIT 1 FOR UPDATE',
        [tenantId, current.category_code, current.provider_scope_digest],
      );
      if (latest.rows[0]?.acceptance_id !== acceptanceId) {
        throw new ConflictException('Only the current provider acceptance revision may be revoked');
      }
      const inserted = await client.query(
        'INSERT INTO saas_tenant_backup_provider_acceptance_revocations (tenant_id,acceptance_id,revoked_by_user_id,reason) ' +
        'VALUES ($1,$2,$3,$4) RETURNING revocation_id,revoked_at',
        [tenantId, acceptanceId, actorUserId, reason],
      );
      await this.auditService.recordWithClient(client, {
        tenantId, factoryId: null, actorUserId, eventType: 'SAAS_DATA_GOVERNANCE',
        action: 'BACKUP_PROVIDER_ACCEPTANCE_REVOKED', resourceType: 'SAAS_BACKUP_PROVIDER_ACCEPTANCE',
        resourceId: acceptanceId, correlationId: null, requestId: null, dataClass: 'RESTRICTED',
        payload: { category: current.category_code, revision: Number(current.revision),
          providerScopeDigest: current.provider_scope_digest, revocationId: inserted.rows[0]?.revocation_id, reason },
      });
      return inserted.rows[0];
    }, { tenantId, userId: actorUserId, advisoryLockKey: 'saas-backup-provider-acceptance-revoke:' + tenantId + ':' + acceptanceId });
    return { acceptanceId, ...revocation };
  }

  async latestAcceptance(tenantValue: string, actorValue: string, categoryValue: string) {
    const tenantId = this.uuid(tenantValue, 'tenantId');
    const actorUserId = this.uuid(actorValue, 'actorUserId');
    await this.iamService.authorize(actorUserId, tenantId, 'saas.data_retention.read');
    const category = this.category(categoryValue);
    const scope = this.providerScope(this.currentConfigReference(), 's3.tenant-backup.v1', '1.0.0');
    const result = await this.database.query<AcceptanceRow>(
      'SELECT * FROM saas_tenant_backup_provider_acceptances WHERE tenant_id=$1 AND category_code=$2 AND provider_scope_digest=$3 ORDER BY revision DESC LIMIT 1',
      [tenantId, category, scope.providerScopeDigest], { tenantId, userId: actorUserId },
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('No provider acceptance exists for this category and configured provider scope');
    const scenarios = await this.readScenariosOutsideTransaction(tenantId, row.acceptance_id);
    this.assertScenarioIntegrity(row, scenarios);
    return this.mapAcceptance(row, scenarios);
  }

  async currentAcceptance(tenantValue: string, actorValue: string, categoryValue: string) {
    const tenantId = this.uuid(tenantValue, 'tenantId');
    const actorUserId = this.uuid(actorValue, 'actorUserId');
    await this.iamService.authorize(actorUserId, tenantId, 'saas.data_retention.read');
    return this.requireCurrentAcceptedProviderAcceptance(
      tenantId, this.category(categoryValue), this.currentConfigReference(), 's3.tenant-backup.v1', '1.0.0',
    );
  }

  async requireCurrentAcceptedProviderAcceptance(
    tenantValue: string,
    categoryValue: SaasTransferDatasetCategory,
    configurationReferenceValue: string,
    adapterKeyValue: string,
    adapterVersionValue: string,
  ) {
    const tenantId = this.uuid(tenantValue, 'tenantId');
    const category = this.category(categoryValue);
    const scope = this.providerScope(configurationReferenceValue, adapterKeyValue, adapterVersionValue);
    const result = await this.database.query<AcceptanceRow>(
      'SELECT * FROM saas_tenant_backup_provider_acceptances WHERE tenant_id=$1 AND category_code=$2 AND provider_scope_digest=$3 ORDER BY revision DESC LIMIT 1',
      [tenantId, category, scope.providerScopeDigest], { tenantId },
    );
    const row = result.rows[0];
    if (!row || row.status !== 'ACCEPTED' || !row.reviewed_by_user_id || !row.reviewed_at
      || !row.valid_until || new Date(row.valid_until).getTime() <= Date.now()
      || row.configuration_reference !== scope.configurationReference
      || row.provider_reference !== scope.providerReference
      || row.provider_scope_reference !== scope.providerScopeReference
      || row.adapter_key !== adapterKeyValue || row.adapter_version !== adapterVersionValue) {
      throw new ServiceUnavailableException('No current, independently reviewed provider acceptance matches this exact provider scope');
    }
    const revoked = await this.database.query(
      'SELECT 1 FROM saas_tenant_backup_provider_acceptance_revocations WHERE tenant_id=$1 AND acceptance_id=$2 LIMIT 1',
      [tenantId, row.acceptance_id], { tenantId },
    );
    if (revoked.rows.length) throw new ServiceUnavailableException('The current backup provider acceptance has been revoked');
    const scenarios = await this.readScenariosOutsideTransaction(tenantId, row.acceptance_id);
    this.assertScenarioIntegrity(row, scenarios);
    if (scenarios.some((scenario) => scenario.outcome !== 'PASS')) {
      throw new ServiceUnavailableException('The provider acceptance evidence matrix is not fully passing');
    }
    this.assertEvidenceFresh(scenarios);
    return this.mapAcceptance(row, scenarios);
  }

  private providerScope(configurationReferenceValue: string, adapterKey: string, adapterVersion: string): ProviderScope {
    const configurationReference = this.reference(configurationReferenceValue, 'configuration_reference');
    if (this.config.get<string>(CONFIG_REFERENCE)?.trim() !== configurationReference) {
      throw new ServiceUnavailableException('Backup provider acceptance configuration reference does not match the active deployment');
    }
    const providerReference = this.reference(this.config.get<string>(PROVIDER_REFERENCE), 'provider_reference');
    const providerScopeReference = this.reference(this.config.get<string>(PROVIDER_SCOPE_REFERENCE), 'provider_scope_reference');
    const providerScopeDigest = digestSaasBackupProviderAcceptanceScope({
      providerReference, providerScopeReference, configurationReference, adapterKey, adapterVersion,
    });
    return { providerReference, providerScopeReference, providerScopeDigest, configurationReference, adapterKey, adapterVersion };
  }

  private currentConfigReference(): string {
    return this.reference(this.config.get<string>(CONFIG_REFERENCE), 'configuration_reference');
  }

  private normalizeScenarios(value: unknown): NormalizedBackupProviderAcceptanceScenario[] {
    if (!Array.isArray(value) || value.length !== SAAS_BACKUP_PROVIDER_ACCEPTANCE_SCENARIOS.length) {
      throw new BadRequestException('Exactly ten required provider staging scenarios must be supplied');
    }
    const result: NormalizedBackupProviderAcceptanceScenario[] = [];
    const seen = new Set<string>();
    for (const entry of value as CreateSaasBackupProviderAcceptanceDto['scenarios']) {
      const scenarioCode = entry?.scenario_code;
      if (typeof scenarioCode !== 'string' || !SCENARIOS.has(scenarioCode) || seen.has(scenarioCode)) {
        throw new BadRequestException('Provider acceptance evidence has an unknown or duplicate scenario');
      }
      seen.add(scenarioCode);
      if (!['PASS', 'FAIL', 'NOT_RUN'].includes(entry.outcome)) {
        throw new BadRequestException('Provider acceptance scenario outcome is invalid');
      }
      const evidenceReference = this.reference(entry.evidence_reference, 'evidence_reference');
      const runnerReference = this.reference(entry.runner_reference, 'runner_reference');
      const evidenceSha256 = String(entry.evidence_sha256 ?? '').trim();
      if (!DIGEST.test(evidenceSha256)) throw new BadRequestException('Provider evidence requires a lowercase SHA-256 digest');
      const date = new Date(entry.executed_at);
      if (!entry.executed_at || !Number.isFinite(date.getTime())) {
        throw new BadRequestException('Provider evidence execution timestamp is invalid');
      }
      result.push({
        scenarioCode: scenarioCode as NormalizedBackupProviderAcceptanceScenario['scenarioCode'],
        outcome: entry.outcome,
        evidenceReference,
        evidenceSha256,
        executedAt: date.toISOString(),
        runnerReference,
      });
    }
    for (const required of SAAS_BACKUP_PROVIDER_ACCEPTANCE_SCENARIOS) {
      if (!seen.has(required)) throw new BadRequestException('Provider acceptance evidence is missing scenario ' + required);
    }
    this.assertEvidenceFresh(result);
    return result.sort((a, b) => a.scenarioCode.localeCompare(b.scenarioCode));
  }

  private assertEvidenceFresh(scenarios: NormalizedBackupProviderAcceptanceScenario[]): void {
    const now = Date.now();
    for (const scenario of scenarios) {
      const executedAt = new Date(scenario.executedAt).getTime();
      if (!Number.isFinite(executedAt) || executedAt > now || now - executedAt > 30 * 24 * 60 * 60 * 1000) {
        throw new ConflictException('Provider staging evidence must be no older than 30 days and cannot be future-dated');
      }
    }
  }

  private async readScenarios(client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: EvidenceRow[] }> },
    tenantId: string, acceptanceId: string): Promise<NormalizedBackupProviderAcceptanceScenario[]> {
    const result = await client.query(
      'SELECT scenario_code,outcome,evidence_reference,evidence_sha256,executed_at,runner_reference ' +
      'FROM saas_tenant_backup_provider_acceptance_evidence WHERE tenant_id=$1 AND acceptance_id=$2 ORDER BY scenario_code',
      [tenantId, acceptanceId],
    );
    return this.mapScenarios(result.rows);
  }

  private async readScenariosOutsideTransaction(tenantId: string, acceptanceId: string): Promise<NormalizedBackupProviderAcceptanceScenario[]> {
    const result = await this.database.query<EvidenceRow>(
      'SELECT scenario_code,outcome,evidence_reference,evidence_sha256,executed_at,runner_reference ' +
      'FROM saas_tenant_backup_provider_acceptance_evidence WHERE tenant_id=$1 AND acceptance_id=$2 ORDER BY scenario_code',
      [tenantId, acceptanceId], { tenantId },
    );
    return this.mapScenarios(result.rows);
  }

  private mapScenarios(rows: EvidenceRow[]): NormalizedBackupProviderAcceptanceScenario[] {
    return rows.map((row) => ({
      scenarioCode: row.scenario_code as NormalizedBackupProviderAcceptanceScenario['scenarioCode'],
      outcome: row.outcome,
      evidenceReference: row.evidence_reference,
      evidenceSha256: row.evidence_sha256,
      executedAt: new Date(row.executed_at).toISOString(),
      runnerReference: row.runner_reference,
    }));
  }

  private assertScenarioIntegrity(row: AcceptanceRow, scenarios: NormalizedBackupProviderAcceptanceScenario[]): void {
    if (Number(row.scenario_count) !== 10 || scenarios.length !== 10
      || new Set(scenarios.map((scenario) => scenario.scenarioCode)).size !== 10
      || scenarios.some((scenario) => !SCENARIOS.has(scenario.scenarioCode))
      || digestSaasBackupProviderAcceptanceScenarios(scenarios) !== row.evidence_manifest_digest) {
      throw new ServiceUnavailableException('Provider acceptance scenario evidence failed its immutable digest/count check');
    }
  }

  private mapAcceptance(row: AcceptanceRow, scenarios: NormalizedBackupProviderAcceptanceScenario[]) {
    return {
      acceptanceId: row.acceptance_id, tenantId: row.tenant_id, category: row.category_code,
      revision: Number(row.revision), providerReference: row.provider_reference,
      providerScopeReference: row.provider_scope_reference, providerScopeDigest: row.provider_scope_digest,
      configurationReference: row.configuration_reference, adapterKey: row.adapter_key,
      adapterVersion: row.adapter_version, stagingEvidenceReference: row.staging_evidence_reference,
      evidenceManifestDigest: row.evidence_manifest_digest, scenarioCount: Number(row.scenario_count),
      status: row.status, submittedByUserId: row.submitted_by_user_id,
      reviewedByUserId: row.reviewed_by_user_id, reviewReason: row.review_reason,
      submittedAt: row.submitted_at, reviewedAt: row.reviewed_at, validUntil: row.valid_until, scenarios,
    };
  }

  private async lockTenant(client: { query: (sql: string, values?: unknown[]) => Promise<{ rows?: unknown[] }> }, tenantId: string): Promise<void> {
    const result = await client.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [tenantId]);
    if (!result.rows?.length) throw new NotFoundException('Tenant not found');
  }
  private uuid(value: string, label: string): string {
    if (!isUUID(value)) throw new BadRequestException(label + ' must be a UUID');
    return value.toLowerCase();
  }
  private category(value: string): SaasTransferDatasetCategory {
    if (!CATEGORIES.has(value)) throw new BadRequestException('Unsupported provider acceptance category');
    return value as SaasTransferDatasetCategory;
  }
  private reference(value: unknown, label: string): string {
    if (typeof value !== 'string') throw new BadRequestException(label + ' is required');
    const normalized = value.trim();
    if (!SAFE_REFERENCE.test(normalized) || normalized.includes('://')
      || /(secret|password|credential|access[-_]?key|token)/i.test(normalized)) {
      throw new BadRequestException(label + ' must be a non-secret opaque evidence reference');
    }
    return normalized;
  }
  private key(value: unknown, label: string): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value.trim())) {
      throw new BadRequestException(label + ' must be a safe idempotency key');
    }
    return value.trim();
  }
  private requiredString(value: unknown, label: string, max: number, min: number): string {
    if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
      throw new BadRequestException(label + ' must contain between ' + min + ' and ' + max + ' characters');
    }
    return value.trim();
  }
  private hash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
  }
}
