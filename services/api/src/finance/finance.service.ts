import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import {
  assertFactCompatibleWithDomain,
  financeRequestHash,
  isFinanceConnectorDomain,
  isFinanceConnectorMode,
  isFinanceFactType,
  normalizeFinanceCurrency,
  normalizeFinanceDecimal,
  reconciliationMatches,
  validateFinanceEndpoint,
  validateFinanceSecretReference,
  validateFinanceSftpConfiguration,
  type FinanceConnectorDomain,
  type FinanceConnectorMode,
  type FinanceFactType,
  type FinanceReconciliationSourceType,
} from './finance-contract';
import { assertFinanceOperationalSourceMatches, resolveFinanceOperationalSource } from './finance-operational-source';
import { FinanceFileImportDto, CreateFinanceConnectorDto,
  FinanceFactInputDto,
  FinanceMarginInputsQueryDto,
  FinanceWorkingCapitalQueryDto,
  IngestFinanceFactsDto,
  ListFinanceConnectorsDto,
  ListFinanceFactsDto,
  ReviewFinanceReconciliationDto,
  TransitionFinanceConnectorDto,
} from './dto/finance.dto';
import { parseFinanceFileImport, type ParsedFinanceFileImport } from './finance-file-import';

interface FinanceEventContext {
  requestId: string | null;
  traceId: string | null;
}
interface ConnectorRow extends QueryResultRow {
  id: string;
  connector_code: string;
  display_name: string;
  source_system: string;
  domain: FinanceConnectorDomain;
  integration_mode: FinanceConnectorMode;
  is_reporting_source?: boolean;
  status: 'PENDING_APPROVAL' | 'ACTIVE' | 'PAUSED' | 'REJECTED';
  row_version: number | string;
  created_by_user_id: string;
  endpoint_url?: string | null;
  configuration?: Record<string, unknown>;
  has_secret_reference?: boolean | string;
  reviewed_by_user_id?: string | null;
  reviewed_at?: string | null;
  paused_at?: string | null;
  decision_reason?: string | null;
  created_at?: string;
  updated_at?: string;
}
interface FinanceFileValidationIssue {
  row: number | null;
  field: string;
  code: string;
  message: string;
}
interface FinanceFileValidationReportRow extends QueryResultRow {
  id: string;
  connector_id: string;
  external_batch_ref: string;
  source_file_name: string | null;
  source_format: string | null;
  source_payload_sha256: string;
  status: 'VALID' | 'INVALID';
  row_count: number;
  valid_row_count: number;
  invalid_row_count: number;
  validation_report: { errors: FinanceFileValidationIssue[]; truncated: boolean; checks: string[] };
  created_at: string;
}
interface NormalizedFact {
  external_fact_id: string;
  source_fact_key: string;
  fact_type: FinanceFactType;
  source_record_type: string;
  source_record_ref: string;
  effective_at: string;
  due_at: string | null;
  currency: string;
  amount: string;
  customer_ref: string | null;
  product_id: string | null;
  product_ref: string | null;
  order_id: string | null;
  order_ref: string | null;
  cost_center_ref: string | null;
  shipment_ref: string | null;
  source_quantity: string | null;
  source_rate: string | null;
  source_uom_code: string | null;
  metadata_snapshot: Record<string, unknown>;
  reconciliation: null | {
    expected_source_type: string;
    expected_source_ref: string;
    expected_quantity: string;
    quantity_tolerance: string;
    expected_rate: string;
    rate_tolerance: string;
    uom_code: string;
    match_status: 'MATCHED' | 'MISMATCH';
  };
}
const REVERSIBLE_FACT_TYPES = new Set<FinanceFactType>([
  'GL_BALANCE',
  'BANK_BALANCE',
  'ACTUAL_REVENUE',
  'ACTUAL_COST',
  'ACTUAL_CONTRIBUTION_COST',
  'FORECAST_REVENUE',
  'FORECAST_COST',
  'FORECAST_CONTRIBUTION_COST',
]);
const SECRET_KEY_PATTERN = /(password|token|secret|credential|api.?key|authorization|private.?key|client.?secret)/i;

@Injectable()
export class FinanceService {
  constructor(private readonly database: DatabaseService) {}

  async createConnector(
    userId: string,
    tenantId: string,
    factoryId: string,
    dto: CreateFinanceConnectorDto,
    idempotencyKeyInput: string | null,
    ctx: FinanceEventContext,
  ) {
    const idempotencyKey = this.requireIdempotencyKey(idempotencyKeyInput);
    if (!isFinanceConnectorDomain(dto.domain) || !isFinanceConnectorMode(dto.integration_mode)) {
      throw new BadRequestException('Unsupported finance connector domain or integration mode');
    }
    const connectorCode = dto.connector_code.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._-]{1,63}$/.test(connectorCode)) {
      throw new BadRequestException('connector_code must be a stable uppercase identifier');
    }
    const outboundMode = dto.integration_mode === 'FILE_EXPORT' || dto.integration_mode === 'SFTP_EXPORT';
    const isReportingSource = dto.is_reporting_source ?? (dto.domain !== 'CUSTOM' && !outboundMode);
    if (outboundMode && isReportingSource) throw new BadRequestException('Outbound export connectors cannot be reporting sources');
    if (dto.domain === 'CUSTOM' && isReportingSource) {
      throw new BadRequestException('CUSTOM connectors are enrichment-only; map reporting facts to their governed source domain');
    }
    const sftpMode = dto.integration_mode === 'SFTP_IMPORT' || dto.integration_mode === 'SFTP_EXPORT';
    if (sftpMode && dto.endpoint_url) throw new BadRequestException('SFTP connectors use pinned host configuration, not endpoint_url');
    const endpointUrl = sftpMode ? null : this.endpoint(dto.integration_mode, dto.endpoint_url ?? null);
    const secretReference = this.secretReference(dto.secret_reference ?? null);
    let configuration = this.safeObject(dto.configuration ?? {}, 'configuration');
    if (sftpMode) {
      if (!secretReference) throw new BadRequestException('SFTP connectors require a secret-manager reference for the authentication key');
      try { configuration = validateFinanceSftpConfiguration(dto.integration_mode, configuration) as unknown as Record<string, unknown>; }
      catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'Invalid SFTP connector configuration'); }
    }
    const displayName = dto.display_name.trim();
    const sourceSystem = dto.source_system.trim();
    if (displayName.length < 2 || displayName.length > 160) {
      throw new BadRequestException('display_name must contain 2 to 160 non-space characters');
    }
    if (sourceSystem.length < 2 || sourceSystem.length > 120) {
      throw new BadRequestException('source_system must contain 2 to 120 non-space characters');
    }
    const requestHash = financeRequestHash({
      connector_code: connectorCode,
      display_name: displayName,
      source_system: sourceSystem,
      domain: dto.domain,
      integration_mode: dto.integration_mode,
      is_reporting_source: isReportingSource,
      endpoint_url: endpointUrl,
      secret_reference: secretReference,
      configuration,
    });

    return this.database.transaction(
      {
        tenantId, userId,
        requestId: this.uuidOrNull(ctx.requestId),
        traceId: this.uuidOrNull(ctx.traceId),
        advisoryLockKey: 'finance-connector-create:' + tenantId + ':' + factoryId + ':' + idempotencyKey,
      },
      async (client) => {
        await this.assertActiveFactory(client, tenantId, factoryId);
        const prior = await client.query<ConnectorRow & { request_hash: string }>(
          'SELECT id::text,connector_code,display_name,source_system,domain,integration_mode,status,row_version,created_by_user_id::text,' +
          'endpoint_url,configuration,is_reporting_source,(secret_reference IS NOT NULL) AS has_secret_reference,request_hash ' +
          'FROM finance_connectors WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE',
          [tenantId, factoryId, idempotencyKey],
        );
        if (prior.rows[0]) {
          if (prior.rows[0].request_hash !== requestHash) {
            throw new ConflictException('Idempotency-Key was already used for a different finance connector request');
          }
          return this.connectorResponse(prior.rows[0], true);
        }

        if (isReportingSource && dto.domain !== 'CUSTOM') {
          const existingSource = await client.query<{ id: string }>(
            'SELECT id::text FROM finance_connectors WHERE tenant_id=$1 AND factory_id=$2 AND domain=$3 ' +
            'AND is_reporting_source AND status IN (\'PENDING_APPROVAL\',\'ACTIVE\') LIMIT 1',
            [tenantId, factoryId, dto.domain],
          );
          if (existingSource.rows[0]) {
            throw new ConflictException('A reporting source already exists for domain ' + dto.domain + '; reject or pause it before replacing it');
          }
        }

        const id = randomUUID();
        let inserted: { rows: ConnectorRow[] };
        try {
          inserted = await client.query<ConnectorRow>(
            'INSERT INTO finance_connectors(' +
          'id,tenant_id,factory_id,connector_code,display_name,source_system,domain,integration_mode,' +
          'endpoint_url,secret_reference,configuration,is_reporting_source,status,row_version,idempotency_key,request_hash,created_by_user_id' +
          ') VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,\'PENDING_APPROVAL\',1,$13,$14,$15) ' +
          'RETURNING id::text,connector_code,display_name,source_system,domain,integration_mode,status,row_version,created_by_user_id::text,' +
          'endpoint_url,configuration,is_reporting_source,(secret_reference IS NOT NULL) AS has_secret_reference',
          [
            id, tenantId, factoryId, connectorCode, displayName, sourceSystem,
            dto.domain, dto.integration_mode, endpointUrl, secretReference, JSON.stringify(configuration),
            isReportingSource, idempotencyKey, requestHash, userId,
          ],
          );
        } catch (error) {
          if (error && typeof error === 'object' &&
              'constraint' in error &&
              error.constraint === 'uq_finance_domain_reporting_source') {
            throw new ConflictException('A reporting source already exists for domain ' + dto.domain);
          }
          throw error;
        }
        await this.connectorHistory(client, tenantId, factoryId, id, 'CREATED', userId,
          'Created pending independent approval', ctx, { domain: dto.domain, mode: dto.integration_mode });
        await this.audit(client, tenantId, factoryId, userId, 'FINANCE_CONNECTOR_CREATED', 'CREATE',
          'finance_connectors', id, ctx, { connector_code: connectorCode, domain: dto.domain, status: 'PENDING_APPROVAL' });
        await this.outbox(client, tenantId, factoryId, id, 'FINANCE_CONNECTOR_CREATED', userId, ctx,
          { connector_code: connectorCode, domain: dto.domain, status: 'PENDING_APPROVAL' });
        return this.connectorResponse(inserted.rows[0], false);
      },
    );
  }


  async getConnector(
    userId: string,
    tenantId: string,
    factoryId: string,
    connectorId: string,
  ) {
    return this.database.transaction({ tenantId, userId }, async (client) => {
      const result = await client.query<ConnectorRow>(
        'SELECT c.id::text,c.connector_code,c.display_name,c.source_system,c.domain,c.integration_mode,c.status,' +
        'c.row_version::int AS row_version,c.created_by_user_id::text,c.reviewed_by_user_id::text,' +
        'c.reviewed_at::text,c.paused_at::text,c.decision_reason,c.created_at::text,c.updated_at::text,' +
        'c.endpoint_url,c.configuration,c.is_reporting_source,(c.secret_reference IS NOT NULL) AS has_secret_reference,' +
        '(SELECT r.completed_at::text FROM finance_connector_runs r WHERE r.tenant_id=c.tenant_id AND r.factory_id=c.factory_id AND r.connector_id=c.id ORDER BY r.completed_at DESC LIMIT 1) AS last_run_at,' +
        '(SELECT r.source_occurred_at::text FROM finance_connector_runs r WHERE r.tenant_id=c.tenant_id AND r.factory_id=c.factory_id AND r.connector_id=c.id ORDER BY r.completed_at DESC LIMIT 1) AS last_source_occurred_at,' +
        '(SELECT r.status FROM finance_connector_runs r WHERE r.tenant_id=c.tenant_id AND r.factory_id=c.factory_id AND r.connector_id=c.id ORDER BY r.completed_at DESC LIMIT 1) AS last_run_status,' +
        '(SELECT r.mismatch_count FROM finance_connector_runs r WHERE r.tenant_id=c.tenant_id AND r.factory_id=c.factory_id AND r.connector_id=c.id ORDER BY r.completed_at DESC LIMIT 1) AS last_run_mismatch_count ' +
        'FROM finance_connectors c WHERE c.id=$1 AND c.tenant_id=$2 AND c.factory_id=$3',
        [connectorId, tenantId, factoryId],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundException('Finance connector not found in the active factory scope');
      return {
        ...this.connectorResponse(row, false),
        reviewed_by_user_id: row.reviewed_by_user_id ?? null,
        reviewed_at: row.reviewed_at ?? null,
        paused_at: row.paused_at ?? null,
        decision_reason: row.decision_reason ?? null,
        created_at: row.created_at ?? null,
        updated_at: row.updated_at ?? null,
        last_run_at: (row as ConnectorRow & { last_run_at?: string | null }).last_run_at ?? null,
        last_source_occurred_at: (row as ConnectorRow & { last_source_occurred_at?: string | null }).last_source_occurred_at ?? null,
        last_run_status: (row as ConnectorRow & { last_run_status?: string | null }).last_run_status ?? null,
        last_run_mismatch_count: (row as ConnectorRow & { last_run_mismatch_count?: number | null }).last_run_mismatch_count ?? null,
      };
    });
  }

  async listConnectors(
    userId: string,
    tenantId: string,
    factoryId: string,
    query: ListFinanceConnectorsDto,
  ) {
    return this.database.transaction({ tenantId, userId }, async (client) => {
      const result = await client.query(
        'SELECT c.id::text,c.connector_code,c.display_name,c.source_system,c.domain,c.integration_mode,c.status,' +
        'c.row_version::int AS row_version,c.created_by_user_id::text,c.reviewed_by_user_id::text,' +
        'c.reviewed_at::text,c.paused_at::text,c.decision_reason,c.created_at::text,c.updated_at::text,' +
        'c.endpoint_url,c.configuration,c.is_reporting_source,(c.secret_reference IS NOT NULL) AS has_secret_reference,' +
        '(SELECT r.completed_at::text FROM finance_connector_runs r WHERE r.tenant_id=c.tenant_id AND r.factory_id=c.factory_id AND r.connector_id=c.id ORDER BY r.completed_at DESC LIMIT 1) AS last_run_at,' +
        '(SELECT r.source_occurred_at::text FROM finance_connector_runs r WHERE r.tenant_id=c.tenant_id AND r.factory_id=c.factory_id AND r.connector_id=c.id ORDER BY r.completed_at DESC LIMIT 1) AS last_source_occurred_at,' +
        '(SELECT r.status FROM finance_connector_runs r WHERE r.tenant_id=c.tenant_id AND r.factory_id=c.factory_id AND r.connector_id=c.id ORDER BY r.completed_at DESC LIMIT 1) AS last_run_status,' +
        '(SELECT r.mismatch_count FROM finance_connector_runs r WHERE r.tenant_id=c.tenant_id AND r.factory_id=c.factory_id AND r.connector_id=c.id ORDER BY r.completed_at DESC LIMIT 1) AS last_run_mismatch_count ' +
        'FROM finance_connectors c WHERE c.tenant_id=$1 AND c.factory_id=$2 ' +
        'AND ($3::text IS NULL OR c.domain=$3) AND ($4::text IS NULL OR c.status=$4) ' +
        'ORDER BY c.created_at DESC LIMIT 100',
        [tenantId, factoryId, query.domain ?? null, query.status ?? null],
      );
      return result.rows;
    });
  }

  async transitionConnector(
    userId: string,
    tenantId: string,
    factoryId: string,
    connectorId: string,
    action: 'APPROVE' | 'REJECT' | 'PAUSE',
    dto: TransitionFinanceConnectorDto,
    ctx: FinanceEventContext,
  ) {
    const reason = dto.reason.trim();
    if (reason.length < 8) throw new BadRequestException('A decision reason of at least 8 characters is required');
    return this.database.transaction(
      {
        tenantId, userId,
        requestId: this.uuidOrNull(ctx.requestId),
        traceId: this.uuidOrNull(ctx.traceId),
        advisoryLockKey: 'finance-connector-transition:' + tenantId + ':' + connectorId,
      },
      async (client) => {
        const found = await client.query<ConnectorRow>(
          'SELECT id::text,connector_code,display_name,source_system,domain,integration_mode,status,' +
          'row_version::int AS row_version,created_by_user_id::text,is_reporting_source FROM finance_connectors ' +
          'WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
          [connectorId, tenantId, factoryId],
        );
        const connector = found.rows[0];
        if (!connector) throw new NotFoundException('Finance connector not found in the active factory scope');
        if (Number(connector.row_version) !== dto.expected_version) {
          throw new ConflictException('Finance connector row version changed; reload before retrying');
        }

        let nextStatus: ConnectorRow['status'];
        let historyAction: 'APPROVED' | 'REJECTED' | 'PAUSED';
        if (action === 'APPROVE') {
          if (connector.status !== 'PENDING_APPROVAL') throw new ConflictException('Only a pending finance connector can be approved');
          if (connector.created_by_user_id === userId) throw new ForbiddenException('The connector creator cannot approve their own connector');
          nextStatus = 'ACTIVE';
          historyAction = 'APPROVED';
        } else if (action === 'REJECT') {
          if (connector.status !== 'PENDING_APPROVAL') throw new ConflictException('Only a pending finance connector can be rejected');
          if (connector.created_by_user_id === userId) throw new ForbiddenException('The connector creator cannot reject their own connector');
          nextStatus = 'REJECTED';
          historyAction = 'REJECTED';
        } else {
          if (connector.status !== 'ACTIVE') throw new ConflictException('Only an active finance connector can be paused');
          nextStatus = 'PAUSED';
          historyAction = 'PAUSED';
        }

        const updated = await client.query<ConnectorRow>(
          'UPDATE finance_connectors SET status=$1,row_version=row_version+1,' +
          'reviewed_by_user_id=$2,reviewed_at=clock_timestamp(),paused_at=CASE WHEN $1=\'PAUSED\' THEN clock_timestamp() ELSE paused_at END,' +
          'decision_reason=$3,updated_at=clock_timestamp() ' +
          'WHERE id=$4 AND tenant_id=$5 AND factory_id=$6 AND row_version=$7 ' +
          'RETURNING id::text,connector_code,display_name,source_system,domain,integration_mode,status,row_version,created_by_user_id::text,' +
          'endpoint_url,configuration,is_reporting_source,(secret_reference IS NOT NULL) AS has_secret_reference',
          [nextStatus, userId, reason, connectorId, tenantId, factoryId, dto.expected_version],
        );
        if (!updated.rows[0]) throw new ConflictException('Finance connector transition lost an optimistic-concurrency race');

        await this.connectorHistory(client, tenantId, factoryId, connectorId, historyAction, userId, reason, ctx,
          { previous_status: connector.status, next_status: nextStatus, row_version: Number(updated.rows[0].row_version) });
        await this.audit(client, tenantId, factoryId, userId, 'FINANCE_CONNECTOR_' + historyAction, action,
          'finance_connectors', connectorId, ctx, { previous_status: connector.status, next_status: nextStatus, reason });
        await this.outbox(client, tenantId, factoryId, connectorId, 'FINANCE_CONNECTOR_' + historyAction, userId, ctx,
          { previous_status: connector.status, next_status: nextStatus, reason });
        return this.connectorResponse(updated.rows[0], false);
      },
    );
  }


  async validateFactsFile(
    userId: string,
    tenantId: string,
    factoryId: string,
    connectorId: string,
    dto: FinanceFileImportDto,
    idempotencyKeyInput: string | null,
    ctx: FinanceEventContext,
  ) {
    const idempotencyKey = this.requireIdempotencyKey(idempotencyKeyInput);
    const submittedContent = typeof dto.content_base64 === 'string' ? dto.content_base64.trim() : '';
    const submittedDigest = /^[A-Za-z0-9+/]+={0,2}$/.test(submittedContent) && submittedContent.length % 4 === 0
      ? createHash('sha256').update(Buffer.from(submittedContent, 'base64')).digest('hex')
      : createHash('sha256').update(submittedContent, 'utf8').digest('hex');
    const requestHash = financeRequestHash({
      external_batch_ref: dto.external_batch_ref,
      format: dto.format,
      file_name: dto.file_name,
      source_payload_sha256: submittedDigest,
    });
    const safeFileName = typeof dto.file_name === 'string' &&
      dto.file_name.trim().length > 0 && dto.file_name.trim().length <= 200 &&
      !dto.file_name.includes('/') && !dto.file_name.includes(String.fromCharCode(92)) &&
      !/[\u0000-\u001f\u007f]/.test(dto.file_name)
      ? dto.file_name.trim() : null;
    const safeFormat = dto.format === 'CSV' || dto.format === 'JSON' ? dto.format : null;
    const issues: FinanceFileValidationIssue[] = [];
    let parsed: ParsedFinanceFileImport | null = null;
    try {
      parsed = parseFinanceFileImport(dto);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'File validation failed';
      issues.push({ row: null, field: 'file', code: 'FILE_CONTRACT_INVALID', message: message.slice(0, 300) });
    }

    return this.database.transaction({
      tenantId,
      userId,
      requestId: this.uuidOrNull(ctx.requestId),
      traceId: this.uuidOrNull(ctx.traceId),
      advisoryLockKey: 'finance-file-validation:' + tenantId + ':' + factoryId + ':' + connectorId + ':' + idempotencyKey,
    }, async (client) => {
      const connectorResult = await client.query<ConnectorRow>(
        'SELECT id::text,connector_code,display_name,source_system,domain,integration_mode,status,row_version::int AS row_version,' +
        'created_by_user_id::text FROM finance_connectors WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR SHARE',
        [connectorId, tenantId, factoryId],
      );
      const connector = connectorResult.rows[0];
      if (!connector) throw new NotFoundException('Finance connector not found in the active factory scope');

      const existingReport = await client.query<FinanceFileValidationReportRow & { request_hash: string }>(
        'SELECT id::text,connector_id::text,external_batch_ref,source_file_name,source_format,source_payload_sha256,' +
        'status,row_count,valid_row_count,invalid_row_count,validation_report,created_at::text,request_hash ' +
        'FROM finance_file_import_validation_reports WHERE tenant_id=$1 AND factory_id=$2 AND connector_id=$3 AND idempotency_key=$4 FOR UPDATE',
        [tenantId, factoryId, connectorId, idempotencyKey],
      );
      if (existingReport.rows[0]) {
        if (existingReport.rows[0].request_hash !== requestHash) {
          throw new ConflictException('Idempotency-Key was already used for a different file validation request');
        }
        return { ...existingReport.rows[0], replayed: true };
      }
      if (connector.status !== 'ACTIVE') {
        throw new ConflictException('File validation requires an approved active finance connector');
      }
      if (!['FILE_IMPORT', 'SFTP_IMPORT'].includes(connector.integration_mode)) {
        throw new ConflictException('File validation requires a FILE_IMPORT or SFTP_IMPORT connector');
      }

      const facts = parsed?.batch.facts ?? [];
      const normalizedByRow = new Map<number, NormalizedFact>();
      const seenIds = new Map<string, number>();
      for (let index = 0; index < facts.length; index += 1) {
        const row = index + 1;
        try {
          const normalized = this.normalizeFact(facts[index]);
          const priorRow = seenIds.get(normalized.external_fact_id);
          if (priorRow !== undefined) {
            issues.push({ row, field: 'external_fact_id', code: 'DUPLICATE_IN_FILE', message: 'external_fact_id duplicates row ' + priorRow });
            continue;
          }
          seenIds.set(normalized.external_fact_id, row);
          try {
            assertFactCompatibleWithDomain(connector.domain, normalized.fact_type);
          } catch {
            issues.push({
              row, field: 'fact_type', code: 'CONNECTOR_DOMAIN_MISMATCH',
              message: 'Fact type is not permitted for connector domain ' + connector.domain,
            });
            continue;
          }
          normalizedByRow.set(row, normalized);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Fact normalization failed';
          issues.push({ row, field: 'fact', code: 'ROW_INVALID', message: message.slice(0, 300) });
        }
      }

      if (parsed && parsed.batch.facts.length > 0) {
        const priorBatch = await client.query<{ id: string }>(
          'SELECT id::text FROM finance_connector_runs WHERE tenant_id=$1 AND factory_id=$2 AND connector_id=$3 AND external_batch_ref=$4 LIMIT 1',
          [tenantId, factoryId, connectorId, parsed.batch.external_batch_ref.trim()],
        );
        if (priorBatch.rows[0]) {
          issues.push({ row: null, field: 'external_batch_ref', code: 'BATCH_ALREADY_IMPORTED', message: 'This external finance batch was already ingested' });
        }
        const validExternalIds = [...new Set([...normalizedByRow.values()].map((fact) => fact.external_fact_id))];
        if (validExternalIds.length > 0) {
          const existingFacts = await client.query<{ external_fact_id: string }>(
            'SELECT external_fact_id FROM financial_facts WHERE tenant_id=$1 AND factory_id=$2 AND connector_id=$3 AND external_fact_id = ANY($4::varchar[])',
            [tenantId, factoryId, connectorId, validExternalIds],
          );
          const existingIds = new Set(existingFacts.rows.map((row) => row.external_fact_id));
          for (const [row, fact] of normalizedByRow) {
            if (existingIds.has(fact.external_fact_id)) {
              issues.push({ row, field: 'external_fact_id', code: 'FACT_ALREADY_IMPORTED', message: 'This external fact ID has already been ingested' });
            }
          }
        }
        for (const [row, fact] of normalizedByRow) {
          if (!fact.reconciliation) continue;
          try {
            const operational = await resolveFinanceOperationalSource(
              client, tenantId, factoryId,
              fact.reconciliation.expected_source_type as FinanceReconciliationSourceType,
              fact.reconciliation.expected_source_ref,
            );
            assertFinanceOperationalSourceMatches(
              fact.currency, fact.reconciliation.expected_quantity, fact.reconciliation.expected_rate,
              fact.reconciliation.uom_code, operational,
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Operational reconciliation validation failed';
            issues.push({ row, field: 'reconciliation', code: 'RECONCILIATION_INVALID', message: message.slice(0, 300) });
          }
        }
      }

      const rowCount = facts.length;
      const invalidRowNumbers = new Set(issues.filter((issue) => issue.row !== null).map((issue) => issue.row as number));
      const hasFileLevelError = issues.some((issue) => issue.row === null);
      const validRowCount = hasFileLevelError ? 0 : Math.max(0, rowCount - invalidRowNumbers.size);
      const invalidRowCount = hasFileLevelError ? Math.max(1, rowCount) : invalidRowNumbers.size;
      const status = issues.length === 0 && parsed ? 'VALID' : 'INVALID';
      const report = {
        errors: issues.slice(0, 200),
        truncated: issues.length > 200,
        checks: ['encoding_and_size', 'file_structure', 'schema', 'row_normalization', 'connector_domain', 'duplicate_prevention', 'operational_reconciliation'],
      };
      const reportId = randomUUID();
      const insert = await client.query<FinanceFileValidationReportRow>(
        'INSERT INTO finance_file_import_validation_reports(' +
        'id,tenant_id,factory_id,connector_id,external_batch_ref,idempotency_key,request_hash,source_file_name,source_format,' +
        'source_payload_sha256,status,row_count,valid_row_count,invalid_row_count,validation_report,actor_user_id,request_id,trace_id' +
        ') VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18) ' +
        'RETURNING id::text,connector_id::text,external_batch_ref,source_file_name,source_format,source_payload_sha256,status,' +
        'row_count,valid_row_count,invalid_row_count,validation_report,created_at::text',
        [
          reportId, tenantId, factoryId, connectorId,
          parsed?.batch.external_batch_ref.trim() || String(dto.external_batch_ref ?? '').trim().slice(0, 200) || 'INVALID_FILE',
          idempotencyKey, requestHash, safeFileName, safeFormat, parsed?.sourcePayloadSha256 ?? submittedDigest,
          status, rowCount, validRowCount, invalidRowCount, JSON.stringify(report), userId,
          this.uuidOrNull(ctx.requestId), this.uuidOrNull(ctx.traceId),
        ],
      );
      await this.audit(client, tenantId, factoryId, userId, 'FINANCE_FILE_IMPORT_VALIDATED', 'VALIDATE',
        'finance_file_import_validation_reports', reportId, ctx, {
          connector_id: connectorId, status, source_file_name: safeFileName, source_format: safeFormat,
          source_payload_sha256: parsed?.sourcePayloadSha256 ?? submittedDigest,
          row_count: rowCount, valid_row_count: validRowCount, invalid_row_count: invalidRowCount, error_count: issues.length,
        });
      await this.outbox(client, tenantId, factoryId, reportId, 'FINANCE_FILE_IMPORT_VALIDATED', userId, ctx, {
        connector_id: connectorId, status, row_count: rowCount,
        valid_row_count: validRowCount, invalid_row_count: invalidRowCount,
        source_payload_sha256: parsed?.sourcePayloadSha256 ?? submittedDigest,
      });
      return { ...insert.rows[0], replayed: false };
    });
  }

  async listFileImportValidationReports(userId: string, tenantId: string, factoryId: string, connectorId: string) {
    return this.database.transaction({ tenantId, userId }, async (client) => {
      await this.assertFinanceConnectorExists(client, tenantId, factoryId, connectorId);
      const result = await client.query<FinanceFileValidationReportRow>(
        'SELECT id::text,connector_id::text,external_batch_ref,source_file_name,source_format,source_payload_sha256,' +
        'status,row_count,valid_row_count,invalid_row_count,validation_report,created_at::text ' +
        'FROM finance_file_import_validation_reports WHERE tenant_id=$1 AND factory_id=$2 AND connector_id=$3 ORDER BY created_at DESC LIMIT 100',
        [tenantId, factoryId, connectorId],
      );
      return result.rows;
    });
  }

  async getFileImportValidationReport(userId: string, tenantId: string, factoryId: string, connectorId: string, reportId: string) {
    return this.database.transaction({ tenantId, userId }, async (client) => {
      await this.assertFinanceConnectorExists(client, tenantId, factoryId, connectorId);
      const result = await client.query<FinanceFileValidationReportRow>(
        'SELECT id::text,connector_id::text,external_batch_ref,source_file_name,source_format,source_payload_sha256,' +
        'status,row_count,valid_row_count,invalid_row_count,validation_report,created_at::text ' +
        'FROM finance_file_import_validation_reports WHERE tenant_id=$1 AND factory_id=$2 AND connector_id=$3 AND id=$4',
        [tenantId, factoryId, connectorId, reportId],
      );
      if (!result.rows[0]) throw new NotFoundException('Finance file validation report was not found');
      return result.rows[0];
    });
  }

  async listFileImportReceipts(userId: string, tenantId: string, factoryId: string, connectorId: string) {
    return this.database.transaction({ tenantId, userId }, async (client) => {
      await this.assertFinanceConnectorExists(client, tenantId, factoryId, connectorId);
      const result = await client.query(
        'SELECT id::text,external_batch_ref,source_file_name,source_format,source_payload_sha256,status,' +
        'received_count,accepted_count,mismatch_count,completed_at::text,created_at::text,request_id::text,trace_id::text ' +
        'FROM finance_connector_runs WHERE tenant_id=$1 AND factory_id=$2 AND connector_id=$3 AND source_file_name IS NOT NULL ' +
        'ORDER BY completed_at DESC LIMIT 100',
        [tenantId, factoryId, connectorId],
      );
      return result.rows;
    });
  }

  async getFileImportReceipt(userId: string, tenantId: string, factoryId: string, connectorId: string, runId: string) {
    return this.database.transaction({ tenantId, userId }, async (client) => {
      await this.assertFinanceConnectorExists(client, tenantId, factoryId, connectorId);
      const result = await client.query(
        'SELECT id::text,external_batch_ref,source_file_name,source_format,source_payload_sha256,status,' +
        'received_count,accepted_count,mismatch_count,completed_at::text,created_at::text,actor_user_id::text,request_id::text,trace_id::text ' +
        'FROM finance_connector_runs WHERE tenant_id=$1 AND factory_id=$2 AND connector_id=$3 AND id=$4 AND source_file_name IS NOT NULL',
        [tenantId, factoryId, connectorId, runId],
      );
      if (!result.rows[0]) throw new NotFoundException('Finance file import receipt was not found');
      return { ...result.rows[0], receipt_type: 'FINANCE_FILE_IMPORT', immutable: true };
    });
  }

  private async assertFinanceConnectorExists(client: PoolClient, tenantId: string, factoryId: string, connectorId: string) {
    const result = await client.query<{ id: string }>(
      'SELECT id::text FROM finance_connectors WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',
      [connectorId, tenantId, factoryId],
    );
    if (!result.rows[0]) throw new NotFoundException('Finance connector not found in the active factory scope');
  }

  async importFactsFile(
    userId: string,
    tenantId: string,
    factoryId: string,
    connectorId: string,
    dto: FinanceFileImportDto,
    idempotencyKeyInput: string | null,
    ctx: FinanceEventContext,
    validationReportId?: string,
  ) {
    const parsed = parseFinanceFileImport(dto);
    return this.ingestFacts(
      userId,
      tenantId,
      factoryId,
      connectorId,
      parsed.batch,
      idempotencyKeyInput,
      ctx,
      parsed,
      validationReportId,
    );
  }

  async ingestFacts(
    userId: string,
    tenantId: string,
    factoryId: string,
    connectorId: string,
    dto: IngestFinanceFactsDto,
    idempotencyKeyInput: string | null,
    ctx: FinanceEventContext,
    sourceFileImport?: ParsedFinanceFileImport,
    validationReportId?: string,
  ) {
    const idempotencyKey = this.requireIdempotencyKey(idempotencyKeyInput);
    const batchReference = dto.external_batch_ref.trim();
    if (!batchReference) throw new BadRequestException('external_batch_ref must not be blank');
    if (!Array.isArray(dto.facts) || dto.facts.length < 1 || dto.facts.length > 500) {
      throw new BadRequestException('A finance batch must contain 1 to 500 facts');
    }
    const normalizedFacts = dto.facts.map((fact) => this.normalizeFact(fact));
    const externalIds = normalizedFacts.map((fact) => fact.external_fact_id);
    if (new Set(externalIds).size !== externalIds.length) {
      throw new BadRequestException('A finance batch cannot repeat external_fact_id values');
    }
    const batchHash = financeRequestHash({
      external_batch_ref: batchReference,
      source_occurred_at: dto.source_occurred_at ?? null,
      facts: normalizedFacts,
      source_file_import: sourceFileImport ? {
        file_name: sourceFileImport.sourceFileName,
        format: sourceFileImport.sourceFormat,
        payload_sha256: sourceFileImport.sourcePayloadSha256,
      } : null,
    });

    return this.database.transaction(
      {
        tenantId, userId,
        requestId: this.uuidOrNull(ctx.requestId),
        traceId: this.uuidOrNull(ctx.traceId),
        advisoryLockKey: 'finance-fact-ingest:' + tenantId + ':' + factoryId + ':' + connectorId,
      },
      async (client) => {
        const connectorResult = await client.query<ConnectorRow>(
          'SELECT id::text,connector_code,display_name,source_system,domain,integration_mode,status,' +
          'row_version::int AS row_version,created_by_user_id::text,is_reporting_source FROM finance_connectors ' +
          'WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR SHARE',
          [connectorId, tenantId, factoryId],
        );
        const connector = connectorResult.rows[0];
        if (!connector) throw new NotFoundException('Finance connector not found in the active factory scope');

        if (sourceFileImport && !['FILE_IMPORT', 'SFTP_IMPORT'].includes(connector.integration_mode)) {
          throw new ConflictException('File import is only permitted for FILE_IMPORT or SFTP_IMPORT connectors');
        }
        if (!sourceFileImport && ['FILE_IMPORT', 'SFTP_IMPORT', 'FILE_EXPORT', 'SFTP_EXPORT'].includes(connector.integration_mode)) {
          throw new ConflictException('File connectors must use the governed file-exchange endpoints');
        }
        if (validationReportId && !sourceFileImport) {
          throw new BadRequestException('A validation report can only be committed with the matching source file');
        }

        for (const fact of normalizedFacts) {
          try {
            assertFactCompatibleWithDomain(connector.domain, fact.fact_type);
          } catch {
            throw new BadRequestException(
              'Fact type ' + fact.fact_type + ' is not permitted for connector domain ' + connector.domain,
            );
          }
        }

        const prior = await client.query<{
          id: string; request_hash: string; status: string;
          received_count: number; accepted_count: number; mismatch_count: number;
          completed_at: string;
        }>(
          'SELECT id::text,request_hash,status,received_count,accepted_count,mismatch_count,completed_at::text,' +
          'source_file_name,source_format,source_payload_sha256 ' +
          'FROM finance_connector_runs WHERE tenant_id=$1 AND factory_id=$2 AND connector_id=$3 AND idempotency_key=$4 FOR UPDATE',
          [tenantId, factoryId, connectorId, idempotencyKey],
        );
        if (prior.rows[0]) {
          if (prior.rows[0].request_hash !== batchHash) {
            throw new ConflictException('Idempotency-Key was already used for a different finance fact batch');
          }
          return { ...prior.rows[0], replayed: true, reporting_ready: Number(prior.rows[0].mismatch_count) === 0 };
        }
        if (connector.status !== 'ACTIVE') {
          throw new ConflictException('Financial facts may only be ingested through an approved active connector');
        }
        if (validationReportId && sourceFileImport) {
          const reportResult = await client.query<{
            id: string; status: string; external_batch_ref: string;
            source_payload_sha256: string; source_file_name: string | null; source_format: string | null;
          }>(
            'SELECT id::text,status,external_batch_ref,source_payload_sha256,source_file_name,source_format ' +
            'FROM finance_file_import_validation_reports WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 AND connector_id=$4 FOR SHARE',
            [validationReportId, tenantId, factoryId, connectorId],
          );
          const report = reportResult.rows[0];
          if (!report) throw new NotFoundException('File validation report was not found in the active connector scope');
          if (report.status !== 'VALID' ||
              report.external_batch_ref !== batchReference ||
              report.source_payload_sha256 !== sourceFileImport.sourcePayloadSha256 ||
              report.source_file_name !== sourceFileImport.sourceFileName ||
              report.source_format !== sourceFileImport.sourceFormat) {
            throw new ConflictException('Only a VALID report for the exact same file, batch and connector can be committed');
          }
        }

        const batchRef = batchReference;
        const priorBatch = await client.query<{ id: string }>(
          'SELECT id::text FROM finance_connector_runs WHERE tenant_id=$1 AND factory_id=$2 AND connector_id=$3 AND external_batch_ref=$4 FOR UPDATE',
          [tenantId, factoryId, connectorId, batchRef],
        );
        if (priorBatch.rows[0]) {
          throw new ConflictException('This external finance batch was already ingested with a different idempotency key');
        }
        const existingFacts = await client.query<{ external_fact_id: string }>(
          'SELECT external_fact_id FROM financial_facts WHERE tenant_id=$1 AND factory_id=$2 AND connector_id=$3 AND external_fact_id = ANY($4::varchar[])',
          [tenantId, factoryId, connectorId, externalIds],
        );
        if (existingFacts.rows.length > 0) {
          throw new ConflictException('External finance fact IDs were already ingested: ' +
            existingFacts.rows.map((row) => row.external_fact_id).join(', '));
        }

        for (const fact of normalizedFacts) {
          const reconciliation = fact.reconciliation;
          if (!reconciliation) continue;
          const operational = await resolveFinanceOperationalSource(
            client,
            tenantId,
            factoryId,
            reconciliation.expected_source_type as FinanceReconciliationSourceType,
            reconciliation.expected_source_ref,
          );
          assertFinanceOperationalSourceMatches(
            fact.currency,
            reconciliation.expected_quantity,
            reconciliation.expected_rate,
            reconciliation.uom_code,
            operational,
          );
        }

        const mismatches = normalizedFacts.filter((fact) =>
          fact.reconciliation?.match_status === 'MISMATCH',
        ).length;
        const runId = randomUUID();
        const runResult = await client.query<{
          id: string; status: string; received_count: number; accepted_count: number; mismatch_count: number;
          completed_at: string;
        }>(
          'INSERT INTO finance_connector_runs(' +
          'id,tenant_id,factory_id,connector_id,external_batch_ref,idempotency_key,request_hash,status,' +
          'received_count,accepted_count,mismatch_count,source_occurred_at,actor_user_id,request_id,trace_id,' +
          'source_file_name,source_format,source_payload_sha256,validation_report_id' +
          ') VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ' +
          'RETURNING id::text,status,received_count,accepted_count,mismatch_count,completed_at::text,' +
          'source_file_name,source_format,source_payload_sha256,validation_report_id::text AS validation_report_id',
          [
            runId, tenantId, factoryId, connectorId, batchRef, idempotencyKey, batchHash,
            mismatches > 0 ? 'COMPLETED_WITH_MISMATCHES' : 'COMPLETED',
            normalizedFacts.length, mismatches, dto.source_occurred_at ?? null, userId,
            this.uuidOrNull(ctx.requestId), this.uuidOrNull(ctx.traceId),
            sourceFileImport?.sourceFileName ?? null,
            sourceFileImport?.sourceFormat ?? null,
            sourceFileImport?.sourcePayloadSha256 ?? null,
            validationReportId ?? null,
          ],
        );

        for (const fact of normalizedFacts) {
          const factId = randomUUID();
          await client.query(
            'INSERT INTO financial_facts(' +
            'id,tenant_id,factory_id,connector_id,connector_run_id,external_fact_id,source_fact_key,' +
            'fact_type,source_record_type,source_record_ref,effective_at,due_at,currency,amount,customer_ref,' +
            'product_id,product_ref,order_id,order_ref,cost_center_ref,shipment_ref,source_quantity,source_rate,' +
            'source_uom_code,metadata_snapshot,fact_hash,ingested_by_user_id' +
            ') VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25::jsonb,$26,$27)',
            [
              factId, tenantId, factoryId, connectorId, runId, fact.external_fact_id, fact.source_fact_key,
              fact.fact_type, fact.source_record_type, fact.source_record_ref, fact.effective_at, fact.due_at,
              fact.currency, fact.amount, fact.customer_ref, fact.product_id, fact.product_ref, fact.order_id,
              fact.order_ref, fact.cost_center_ref, fact.shipment_ref, fact.source_quantity, fact.source_rate,
              fact.source_uom_code, JSON.stringify(fact.metadata_snapshot), financeRequestHash(fact), userId,
            ],
          );

          if (fact.reconciliation) {
            const rec = fact.reconciliation;
            await client.query(
              'INSERT INTO finance_fact_reconciliations(' +
              'tenant_id,factory_id,fact_id,expected_source_type,expected_source_ref,source_quantity,' +
              'expected_quantity,quantity_tolerance,source_rate,expected_rate,rate_tolerance,uom_code,match_status' +
              ') VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
              [
                tenantId, factoryId, factId, rec.expected_source_type, rec.expected_source_ref,
                fact.source_quantity, rec.expected_quantity, rec.quantity_tolerance, fact.source_rate,
                rec.expected_rate, rec.rate_tolerance, rec.uom_code, rec.match_status,
              ],
            );
          }
        }

        await this.audit(client, tenantId, factoryId, userId, 'FINANCIAL_FACT_BATCH_INGESTED', 'INGEST',
          'finance_connector_runs', runId, ctx, {
            connector_id: connectorId, connector_code: connector.connector_code,
            external_batch_ref: batchRef, accepted_count: normalizedFacts.length, mismatch_count: mismatches,
            source_format: sourceFileImport?.sourceFormat ?? null,
            source_file_name: sourceFileImport?.sourceFileName ?? null,
            source_payload_sha256: sourceFileImport?.sourcePayloadSha256 ?? null,
            validation_report_id: validationReportId ?? null,
          });
        await this.outbox(client, tenantId, factoryId, runId, 'FINANCIAL_FACT_BATCH_INGESTED', userId, ctx,
          {
            connector_id: connectorId, connector_code: connector.connector_code,
            external_batch_ref: batchRef, accepted_count: normalizedFacts.length, mismatch_count: mismatches,
          });
        return { ...runResult.rows[0], connector_id: connectorId, replayed: false, reporting_ready: mismatches === 0 };
      },
    );
  }

  async listFacts(
    userId: string,
    tenantId: string,
    factoryId: string,
    query: ListFinanceFactsDto,
  ) {
    if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to)) {
      throw new BadRequestException('from must be earlier than or equal to to');
    }
    return this.database.transaction({ tenantId, userId }, async (client) => {
      const result = await client.query(
        'SELECT f.id::text,f.connector_id::text,f.connector_run_id::text,f.external_fact_id,f.source_fact_key,' +
        'f.fact_type,f.source_record_type,f.source_record_ref,f.effective_at::text,f.due_at::text,f.currency,' +
        'f.amount::text,f.customer_ref,f.product_id::text,f.product_ref,f.order_id::text,f.order_ref,' +
        'f.cost_center_ref,f.shipment_ref,f.source_quantity::text,f.source_rate::text,f.source_uom_code,' +
        'f.fact_hash,f.ingested_by_user_id::text,f.created_at::text,' +
        'r.match_status,r.review_status,r.quantity_delta::text,r.rate_delta::text ' +
        'FROM financial_facts f LEFT JOIN finance_fact_reconciliations r ' +
        'ON r.fact_id=f.id AND r.tenant_id=f.tenant_id AND r.factory_id=f.factory_id ' +
        'WHERE f.tenant_id=$1 AND f.factory_id=$2 ' +
        'AND ($3::text IS NULL OR f.fact_type=$3) AND ($4::uuid IS NULL OR f.order_id=$4) ' +
        'AND ($5::uuid IS NULL OR f.product_id=$5) AND ($6::text IS NULL OR f.customer_ref=$6) ' +
        'AND ($7::timestamptz IS NULL OR f.effective_at >= $7) AND ($8::timestamptz IS NULL OR f.effective_at <= $8) ' +
        'ORDER BY f.effective_at DESC,f.created_at DESC LIMIT $9',
        [
          tenantId, factoryId, query.fact_type ?? null, query.order_id ?? null, query.product_id ?? null,
          query.customer_ref?.trim() || null, query.from ?? null, query.to ?? null, query.limit ?? 50,
        ],
      );
      return result.rows;
    });
  }

  async marginInputs(
    userId: string,
    tenantId: string,
    factoryId: string,
    query: FinanceMarginInputsQueryDto,
  ) {
    const to = query.to ? new Date(query.to).toISOString() : new Date().toISOString();
    const from = query.from ? new Date(query.from).toISOString() : new Date(Date.parse(to) - 90 * 86400000).toISOString();
    if (Date.parse(from) > Date.parse(to)) throw new BadRequestException('from must be earlier than or equal to to');

    return this.database.transaction({ tenantId, userId }, async (client) => {
      const rows = await client.query(
        'WITH actual_events AS (' +
        ' SELECT f.* FROM financial_facts f WHERE f.tenant_id=$1 AND f.factory_id=$2 ' +
        ' AND EXISTS (SELECT 1 FROM finance_connectors fc WHERE fc.id=f.connector_id AND fc.tenant_id=f.tenant_id AND fc.factory_id=f.factory_id AND fc.is_reporting_source AND fc.status=\'ACTIVE\') ' +
        ' AND f.fact_type IN (\'ACTUAL_REVENUE\',\'ACTUAL_COST\',\'ACTUAL_CONTRIBUTION_COST\') ' +
        ' AND f.effective_at >= $3 AND f.effective_at <= $4 ' +
        ' AND ($5::uuid IS NULL OR f.order_id=$5) AND ($6::uuid IS NULL OR f.product_id=$6) ' +
        ' AND ($7::text IS NULL OR f.customer_ref=$7)' +
        '), latest_forecasts AS (' +
        ' SELECT DISTINCT ON (f.connector_id,f.fact_type,f.source_fact_key,f.currency) f.* ' +
        ' FROM financial_facts f WHERE f.tenant_id=$1 AND f.factory_id=$2 ' +
        ' AND EXISTS (SELECT 1 FROM finance_connectors fc WHERE fc.id=f.connector_id AND fc.tenant_id=f.tenant_id AND fc.factory_id=f.factory_id AND fc.is_reporting_source AND fc.status=\'ACTIVE\') ' +
        ' AND f.fact_type IN (\'FORECAST_REVENUE\',\'FORECAST_COST\',\'FORECAST_CONTRIBUTION_COST\') ' +
        ' AND f.effective_at >= $3 AND f.effective_at <= $4 AND ($5::uuid IS NULL OR f.order_id=$5) ' +
        ' AND ($6::uuid IS NULL OR f.product_id=$6) AND ($7::text IS NULL OR f.customer_ref=$7) ' +
        ' ORDER BY f.connector_id,f.fact_type,f.source_fact_key,f.currency,f.created_at DESC' +
        '), selected AS (SELECT * FROM actual_events UNION ALL SELECT * FROM latest_forecasts)' +
        ' SELECT currency,customer_ref,product_id::text,product_ref,order_id::text,order_ref,cost_center_ref,' +
        ' COALESCE(SUM(amount) FILTER(WHERE fact_type=\'ACTUAL_REVENUE\'),0)::text AS actual_revenue,' +
        ' COALESCE(SUM(amount) FILTER(WHERE fact_type=\'ACTUAL_COST\'),0)::text AS actual_cost,' +
        ' COALESCE(SUM(amount) FILTER(WHERE fact_type=\'ACTUAL_CONTRIBUTION_COST\'),0)::text AS actual_contribution_cost,' +
        ' COALESCE(SUM(amount) FILTER(WHERE fact_type=\'FORECAST_REVENUE\'),0)::text AS forecast_revenue,' +
        ' COALESCE(SUM(amount) FILTER(WHERE fact_type=\'FORECAST_COST\'),0)::text AS forecast_cost,' +
        ' COALESCE(SUM(amount) FILTER(WHERE fact_type=\'FORECAST_CONTRIBUTION_COST\'),0)::text AS forecast_contribution_cost,' +
        ' (COALESCE(SUM(amount) FILTER(WHERE fact_type=\'ACTUAL_REVENUE\'),0)-COALESCE(SUM(amount) FILTER(WHERE fact_type=\'ACTUAL_COST\'),0))::text AS actual_gross_margin,' +
        ' (COALESCE(SUM(amount) FILTER(WHERE fact_type=\'ACTUAL_REVENUE\'),0)-COALESCE(SUM(amount) FILTER(WHERE fact_type=\'ACTUAL_CONTRIBUTION_COST\'),0))::text AS actual_contribution_margin,' +
        ' (COALESCE(SUM(amount) FILTER(WHERE fact_type=\'FORECAST_REVENUE\'),0)-COALESCE(SUM(amount) FILTER(WHERE fact_type=\'FORECAST_COST\'),0))::text AS forecast_gross_margin,' +
        ' (COALESCE(SUM(amount) FILTER(WHERE fact_type=\'FORECAST_REVENUE\'),0)-COALESCE(SUM(amount) FILTER(WHERE fact_type=\'FORECAST_CONTRIBUTION_COST\'),0))::text AS forecast_contribution_margin,' +
        ' (COALESCE(SUM(amount) FILTER(WHERE fact_type=\'ACTUAL_COST\'),0)-COALESCE(SUM(amount) FILTER(WHERE fact_type=\'FORECAST_COST\'),0))::text AS cost_variance,' +
        ' (COALESCE(SUM(amount) FILTER(WHERE fact_type=\'ACTUAL_REVENUE\'),0)-COALESCE(SUM(amount) FILTER(WHERE fact_type=\'FORECAST_REVENUE\'),0))::text AS revenue_variance,' +
        ' ((COALESCE(SUM(amount) FILTER(WHERE fact_type=\'ACTUAL_REVENUE\'),0)-COALESCE(SUM(amount) FILTER(WHERE fact_type=\'ACTUAL_COST\'),0))-' +
        ' (COALESCE(SUM(amount) FILTER(WHERE fact_type=\'FORECAST_REVENUE\'),0)-COALESCE(SUM(amount) FILTER(WHERE fact_type=\'FORECAST_COST\'),0)))::text AS gross_margin_variance,' +
        ' (COALESCE(SUM(amount) FILTER(WHERE fact_type=\'ACTUAL_CONTRIBUTION_COST\'),0)-COALESCE(SUM(amount) FILTER(WHERE fact_type=\'FORECAST_CONTRIBUTION_COST\'),0))::text AS contribution_cost_variance,' +
        ' ((COALESCE(SUM(amount) FILTER(WHERE fact_type=\'ACTUAL_REVENUE\'),0)-COALESCE(SUM(amount) FILTER(WHERE fact_type=\'ACTUAL_CONTRIBUTION_COST\'),0))-' +
        ' (COALESCE(SUM(amount) FILTER(WHERE fact_type=\'FORECAST_REVENUE\'),0)-COALESCE(SUM(amount) FILTER(WHERE fact_type=\'FORECAST_CONTRIBUTION_COST\'),0)))::text AS contribution_margin_variance,' +
        ' CASE WHEN COALESCE(SUM(amount) FILTER(WHERE fact_type=\'ACTUAL_REVENUE\'),0)=0 THEN NULL ' +
        ' ELSE ROUND((COALESCE(SUM(amount) FILTER(WHERE fact_type=\'ACTUAL_REVENUE\'),0)-COALESCE(SUM(amount) FILTER(WHERE fact_type=\'ACTUAL_COST\'),0))/' +
        ' NULLIF(SUM(amount) FILTER(WHERE fact_type=\'ACTUAL_REVENUE\'),0)*100,4)::text END AS actual_gross_margin_percent ' +
        ' FROM selected GROUP BY currency,customer_ref,product_id,product_ref,order_id,order_ref,cost_center_ref ' +
        ' ORDER BY currency,customer_ref,order_ref,product_ref',
        [tenantId, factoryId, from, to, query.order_id ?? null, query.product_id ?? null, query.customer_ref?.trim() || null],
      );
      const count = await client.query<{ unresolved_count: string }>(
        'SELECT count(*)::text AS unresolved_count FROM finance_fact_reconciliations r ' +
        'JOIN financial_facts f ON f.id=r.fact_id AND f.tenant_id=r.tenant_id AND f.factory_id=r.factory_id ' +
        'WHERE r.tenant_id=$1 AND r.factory_id=$2 AND r.match_status=\'MISMATCH\' AND r.review_status=\'OPEN\' ' +
        'AND f.effective_at >= $3 AND f.effective_at <= $4 ' +
        'AND EXISTS (SELECT 1 FROM finance_connectors fc WHERE fc.id=f.connector_id AND fc.tenant_id=f.tenant_id AND fc.factory_id=f.factory_id AND fc.is_reporting_source AND fc.status=\'ACTIVE\') ' +
        'AND ($5::uuid IS NULL OR f.order_id=$5) AND ($6::uuid IS NULL OR f.product_id=$6) ' +
        'AND ($7::text IS NULL OR f.customer_ref=$7)',
        [tenantId, factoryId, from, to, query.order_id ?? null, query.product_id ?? null, query.customer_ref?.trim() || null],
      );
      const unresolved = Number(count.rows[0]?.unresolved_count ?? 0);
      const missingDomains = await client.query<{ domain: string }>(
        'SELECT expected.domain FROM unnest($3::text[]) AS expected(domain) ' +
        'WHERE NOT EXISTS (SELECT 1 FROM finance_connectors fc WHERE fc.tenant_id=$1 AND fc.factory_id=$2 ' +
        'AND fc.domain=expected.domain AND fc.is_reporting_source AND fc.status=\'ACTIVE\') ORDER BY expected.domain',
        [tenantId, factoryId, ['AR', 'GL']],
      );
      return {
        window: { from, to },
        reporting_ready: unresolved === 0 && missingDomains.rows.length === 0,
        unresolved_reconciliation_count: unresolved,
        missing_reporting_domains: missingDomains.rows.map((row) => row.domain),
        currency_policy: 'Results are grouped by currency; unlike currencies are never summed together.',
        rows: rows.rows,
      };
    });
  }

  async workingCapitalInputs(
    userId: string,
    tenantId: string,
    factoryId: string,
    query: FinanceWorkingCapitalQueryDto,
  ) {
    const asOf = query.as_of ? new Date(query.as_of).toISOString() : new Date().toISOString();
    const horizon = query.horizon_days ?? 30;
    const horizonEnd = new Date(Date.parse(asOf) + horizon * 86400000).toISOString();
    return this.database.transaction({ tenantId, userId }, async (client) => {
      const result = await client.query(
        'WITH latest_positions AS (' +
        ' SELECT DISTINCT ON (f.connector_id,f.fact_type,f.source_fact_key,f.currency) f.* ' +
        ' FROM financial_facts f WHERE f.tenant_id=$1 AND f.factory_id=$2 AND f.effective_at <= $3 ' +
        ' AND EXISTS (SELECT 1 FROM finance_connectors fc WHERE fc.id=f.connector_id AND fc.tenant_id=f.tenant_id AND fc.factory_id=f.factory_id AND fc.is_reporting_source AND fc.status=\'ACTIVE\') ' +
        ' AND f.fact_type IN (\'AR_OPEN\',\'AP_OPEN\',\'BANK_BALANCE\',\'INVENTORY_VALUE\',\'OPEN_PO_COMMITMENT\',' +
        '\'LC_EXPOSURE\',\'SHIPMENT_MILESTONE\',\'TAX_LIABILITY\',\'GL_BALANCE\') ' +
        ' ORDER BY f.connector_id,f.fact_type,f.source_fact_key,f.currency,f.effective_at DESC,f.created_at DESC' +
        '), grouped AS (' +
        ' SELECT currency,' +
        ' COALESCE(SUM(amount) FILTER(WHERE fact_type=\'AR_OPEN\'),0) AS receivables,' +
        ' COALESCE(SUM(amount) FILTER(WHERE fact_type=\'AP_OPEN\'),0) AS payables,' +
        ' COALESCE(SUM(amount) FILTER(WHERE fact_type=\'BANK_BALANCE\'),0) AS bank_balance,' +
        ' COALESCE(SUM(amount) FILTER(WHERE fact_type=\'INVENTORY_VALUE\'),0) AS inventory_value,' +
        ' COALESCE(SUM(amount) FILTER(WHERE fact_type=\'OPEN_PO_COMMITMENT\'),0) AS open_po_commitments,' +
        ' COALESCE(SUM(amount) FILTER(WHERE fact_type=\'LC_EXPOSURE\'),0) AS lc_exposure,' +
        ' COALESCE(SUM(amount) FILTER(WHERE fact_type=\'SHIPMENT_MILESTONE\'),0) AS shipment_milestones,' +
        ' COALESCE(SUM(amount) FILTER(WHERE fact_type=\'TAX_LIABILITY\'),0) AS tax_liability,' +
        ' COALESCE(SUM(amount) FILTER(WHERE fact_type=\'AR_OPEN\' AND due_at <= $4),0) AS scheduled_receivables,' +
        ' COALESCE(SUM(amount) FILTER(WHERE fact_type=\'SHIPMENT_MILESTONE\' AND due_at >= $3 AND due_at <= $4),0) AS scheduled_shipments,' +
        ' COALESCE(SUM(amount) FILTER(WHERE fact_type=\'AP_OPEN\' AND due_at <= $4),0) AS scheduled_payables,' +
        ' COALESCE(SUM(amount) FILTER(WHERE fact_type=\'OPEN_PO_COMMITMENT\' AND due_at <= $4),0) AS scheduled_commitments,' +
        ' COALESCE(SUM(amount) FILTER(WHERE fact_type=\'LC_EXPOSURE\' AND due_at <= $4),0) AS scheduled_lc,' +
        ' COALESCE(SUM(amount) FILTER(WHERE fact_type=\'TAX_LIABILITY\' AND due_at <= $4),0) AS scheduled_tax ' +
        ' FROM latest_positions GROUP BY currency)' +
        ' SELECT currency,receivables::text AS receivables,payables::text AS payables,' +
        ' bank_balance::text AS bank_balance,inventory_value::text AS inventory_value,' +
        ' open_po_commitments::text AS open_po_commitments,lc_exposure::text AS lc_exposure,' +
        ' shipment_milestones::text AS shipment_milestones,tax_liability::text AS tax_liability,' +
        ' (receivables+inventory_value-payables)::text AS net_working_capital,' +
        ' (scheduled_receivables+scheduled_shipments)::text AS forecast_inflows,' +
        ' (scheduled_payables+scheduled_commitments+scheduled_lc+scheduled_tax)::text AS forecast_outflows,' +
        ' (bank_balance+scheduled_receivables+scheduled_shipments-scheduled_payables-scheduled_commitments-scheduled_lc-scheduled_tax)::text AS projected_cash_at_horizon ' +
        ' FROM grouped ORDER BY currency',
        [tenantId, factoryId, asOf, horizonEnd],
      );
      const unresolved = await client.query<{ unresolved_count: string }>(
        'WITH latest_positions AS (' +
        ' SELECT DISTINCT ON (f.connector_id,f.fact_type,f.source_fact_key,f.currency) f.id,f.tenant_id,f.factory_id ' +
        ' FROM financial_facts f WHERE f.tenant_id=$1 AND f.factory_id=$2 AND f.effective_at <= $3 ' +
        ' AND EXISTS (SELECT 1 FROM finance_connectors fc WHERE fc.id=f.connector_id AND fc.tenant_id=f.tenant_id AND fc.factory_id=f.factory_id AND fc.is_reporting_source AND fc.status=\'ACTIVE\') ' +
        ' AND f.fact_type IN (\'AR_OPEN\',\'AP_OPEN\',\'BANK_BALANCE\',\'INVENTORY_VALUE\',\'OPEN_PO_COMMITMENT\',' +
        '\'LC_EXPOSURE\',\'SHIPMENT_MILESTONE\',\'TAX_LIABILITY\',\'GL_BALANCE\') ' +
        ' ORDER BY f.connector_id,f.fact_type,f.source_fact_key,f.currency,f.effective_at DESC,f.created_at DESC' +
        ') SELECT count(*)::text AS unresolved_count FROM finance_fact_reconciliations r ' +
        'JOIN latest_positions f ON f.id=r.fact_id AND f.tenant_id=r.tenant_id AND f.factory_id=r.factory_id ' +
        'WHERE r.tenant_id=$1 AND r.factory_id=$2 AND r.match_status=\'MISMATCH\' AND r.review_status=\'OPEN\'',
        [tenantId, factoryId, asOf],
      );
      const mismatchCount = Number(unresolved.rows[0]?.unresolved_count ?? 0);
      const missingDomains = await client.query<{ domain: string }>(
        'SELECT expected.domain FROM unnest($3::text[]) AS expected(domain) ' +
        'WHERE NOT EXISTS (SELECT 1 FROM finance_connectors fc WHERE fc.tenant_id=$1 AND fc.factory_id=$2 ' +
        'AND fc.domain=expected.domain AND fc.is_reporting_source AND fc.status=\'ACTIVE\') ORDER BY expected.domain',
        [tenantId, factoryId, ['AR', 'AP', 'BANK_RECONCILIATION', 'GL', 'TAX_EINVOICE']],
      );
      return {
        as_of: asOf,
        horizon_days: horizon,
        horizon_end: horizonEnd,
        reporting_ready: mismatchCount === 0 && missingDomains.rows.length === 0,
        unresolved_reconciliation_count: mismatchCount,
        missing_reporting_domains: missingDomains.rows.map((row) => row.domain),
        currency_policy: 'Each currency is reported separately; no implicit FX conversion is applied.',
        rows: result.rows,
      };
    });
  }

  async listReconciliations(
    userId: string,
    tenantId: string,
    factoryId: string,
    status?: 'OPEN' | 'RESOLVED' | 'WAIVED',
  ) {
    return this.database.transaction({ tenantId, userId }, async (client) => {
      const result = await client.query(
        'SELECT r.id::text,r.fact_id::text,f.external_fact_id,f.source_fact_key,f.fact_type,' +
        'r.expected_source_type,r.expected_source_ref,r.source_quantity::text,r.expected_quantity::text,' +
        'r.quantity_tolerance::text,r.quantity_delta::text,r.source_rate::text,r.expected_rate::text,' +
        'r.rate_tolerance::text,r.rate_delta::text,r.uom_code,r.match_status,r.review_status,' +
        'r.review_reason,r.reviewed_by_user_id::text,r.reviewed_at::text,r.created_at::text ' +
        'FROM finance_fact_reconciliations r JOIN financial_facts f ' +
        'ON f.id=r.fact_id AND f.tenant_id=r.tenant_id AND f.factory_id=r.factory_id ' +
        'WHERE r.tenant_id=$1 AND r.factory_id=$2 AND ($3::text IS NULL OR r.review_status=$3) ' +
        'ORDER BY CASE WHEN r.review_status=\'OPEN\' THEN 0 ELSE 1 END,r.created_at DESC LIMIT 100',
        [tenantId, factoryId, status ?? null],
      );
      return result.rows;
    });
  }

  async reviewReconciliation(
    userId: string,
    tenantId: string,
    factoryId: string,
    reconciliationId: string,
    dto: ReviewFinanceReconciliationDto,
    ctx: FinanceEventContext,
  ) {
    const reason = dto.reason.trim();
    if (reason.length < 8) throw new BadRequestException('A reconciliation explanation of at least 8 characters is required');
    return this.database.transaction(
      {
        tenantId, userId,
        requestId: this.uuidOrNull(ctx.requestId),
        traceId: this.uuidOrNull(ctx.traceId),
        advisoryLockKey: 'finance-reconciliation-review:' + tenantId + ':' + reconciliationId,
      },
      async (client) => {
        const found = await client.query<{
          id: string; fact_id: string; ingested_by_user_id: string; match_status: string; review_status: string;
        }>(
          'SELECT r.id::text,r.fact_id::text,f.ingested_by_user_id::text,r.match_status,r.review_status ' +
          'FROM finance_fact_reconciliations r JOIN financial_facts f ' +
          'ON f.id=r.fact_id AND f.tenant_id=r.tenant_id AND f.factory_id=r.factory_id ' +
          'WHERE r.id=$1 AND r.tenant_id=$2 AND r.factory_id=$3 FOR UPDATE OF r',
          [reconciliationId, tenantId, factoryId],
        );
        const row = found.rows[0];
        if (!row) throw new NotFoundException('Finance reconciliation finding not found in the active factory scope');
        if (row.match_status !== 'MISMATCH' || row.review_status !== 'OPEN') {
          throw new ConflictException('Only an open quantity/rate mismatch can be reviewed');
        }
        if (row.ingested_by_user_id === userId) {
          throw new ForbiddenException('The fact ingester cannot review their own reconciliation mismatch');
        }
        const next = dto.action === 'WAIVE' ? 'WAIVED' : 'RESOLVED';
        const updated = await client.query(
          'UPDATE finance_fact_reconciliations SET review_status=$1,review_reason=$2,' +
          'reviewed_by_user_id=$3,reviewed_at=clock_timestamp() ' +
          'WHERE id=$4 AND tenant_id=$5 AND factory_id=$6 AND review_status=\'OPEN\' RETURNING id::text,review_status,review_reason,reviewed_by_user_id::text,reviewed_at::text',
          [next, reason, userId, reconciliationId, tenantId, factoryId],
        );
        if (!updated.rows[0]) throw new ConflictException('Reconciliation review was concurrently completed');
        await this.audit(client, tenantId, factoryId, userId, 'FINANCE_RECONCILIATION_REVIEWED', dto.action,
          'finance_fact_reconciliations', reconciliationId, ctx, { match_status: row.match_status, review_status: next, reason });
        await this.outbox(client, tenantId, factoryId, reconciliationId, 'FINANCE_RECONCILIATION_REVIEWED', userId, ctx,
          { match_status: row.match_status, review_status: next, reason });
        return updated.rows[0];
      },
    );
  }

  private normalizeFact(input: FinanceFactInputDto): NormalizedFact {
    if (!isFinanceFactType(input.fact_type)) throw new BadRequestException('Unsupported financial fact type');
    const factType = input.fact_type;
    const allowNegative = REVERSIBLE_FACT_TYPES.has(factType);
    let amount: string;
    let currency: string;
    try {
      amount = normalizeFinanceDecimal(input.amount, { allowNegative });
      currency = normalizeFinanceCurrency(input.currency);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid financial amount or currency');
    }
    const sourceQuantity = input.source_quantity === undefined
      ? null
      : this.decimal(input.source_quantity, false, 'source_quantity');
    const sourceRate = input.source_rate === undefined
      ? null
      : this.decimal(input.source_rate, false, 'source_rate');
    const sourceUomCode = input.source_uom_code?.trim().toUpperCase() ?? null;
    if ((sourceQuantity === null) !== (sourceRate === null) || (sourceQuantity === null) !== (sourceUomCode === null)) {
      throw new BadRequestException('source_quantity, source_rate and source_uom_code must be supplied together');
    }

    let reconciliation: NormalizedFact['reconciliation'] = null;
    if (input.reconciliation) {
      if (sourceQuantity === null || sourceRate === null || sourceUomCode === null) {
        throw new BadRequestException('Reconciliation requires source quantity, source rate and source UOM evidence');
      }
      const expectedQuantity = this.decimal(input.reconciliation.expected_quantity, false, 'expected_quantity');
      const expectedRate = this.decimal(input.reconciliation.expected_rate, false, 'expected_rate');
      const quantityTolerance = this.decimal(input.reconciliation.quantity_tolerance ?? '0', false, 'quantity_tolerance');
      const rateTolerance = this.decimal(input.reconciliation.rate_tolerance ?? '0', false, 'rate_tolerance');
      const reconciliationUom = input.reconciliation.uom_code.trim().toUpperCase();
      if (sourceUomCode !== reconciliationUom) {
        throw new BadRequestException('Reconciliation UOM must match source UOM; convert quantities before comparison');
      }
      reconciliation = {
        expected_source_type: input.reconciliation.expected_source_type.trim(),
        expected_source_ref: input.reconciliation.expected_source_ref.trim(),
        expected_quantity: expectedQuantity,
        quantity_tolerance: quantityTolerance,
        expected_rate: expectedRate,
        rate_tolerance: rateTolerance,
        uom_code: reconciliationUom,
        match_status: reconciliationMatches(sourceQuantity, expectedQuantity, quantityTolerance, sourceRate, expectedRate, rateTolerance)
          ? 'MATCHED'
          : 'MISMATCH',
      };
    }

    if (sourceQuantity !== null && reconciliation === null) {
      throw new BadRequestException('Source quantity/rate evidence requires a reconciliation against the expected operational record');
    }

    const metadata = this.safeObject(input.metadata_snapshot ?? {}, 'metadata_snapshot');
    if (JSON.stringify(metadata).length > 32768) throw new BadRequestException('metadata_snapshot exceeds the 32 KiB contract limit');
    const effectiveAt = new Date(input.effective_at);
    if (Number.isNaN(effectiveAt.getTime())) throw new BadRequestException('effective_at is not a valid date-time');

    return {
      external_fact_id: input.external_fact_id.trim(),
      source_fact_key: input.source_fact_key.trim(),
      fact_type: factType,
      source_record_type: input.source_record_type.trim(),
      source_record_ref: input.source_record_ref.trim(),
      effective_at: effectiveAt.toISOString(),
      due_at: input.due_at ? new Date(input.due_at).toISOString() : null,
      currency,
      amount,
      customer_ref: input.customer_ref?.trim() || null,
      product_id: input.product_id?.toLowerCase() ?? null,
      product_ref: input.product_ref?.trim() || null,
      order_id: input.order_id?.toLowerCase() ?? null,
      order_ref: input.order_ref?.trim() || null,
      cost_center_ref: input.cost_center_ref?.trim() || null,
      shipment_ref: input.shipment_ref?.trim() || null,
      source_quantity: sourceQuantity,
      source_rate: sourceRate,
      source_uom_code: sourceUomCode,
      metadata_snapshot: metadata,
      reconciliation,
    };
  }

  private safeObject(value: Record<string, unknown>, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException(label + ' must be a JSON object');
    }
    const visit = (item: unknown, depth: number): void => {
      if (depth > 8) throw new BadRequestException(label + ' exceeds the maximum nesting depth');
      if (Array.isArray(item)) {
        if (item.length > 500) throw new BadRequestException(label + ' contains too many array entries');
        for (const nested of item) visit(nested, depth + 1);
      } else if (item && typeof item === 'object') {
        for (const [key, nested] of Object.entries(item as Record<string, unknown>)) {
          if (SECRET_KEY_PATTERN.test(key)) {
            throw new BadRequestException(label + ' must not contain credentials or secrets');
          }
          visit(nested, depth + 1);
        }
      } else if (typeof item === 'string' && item.length > 8000) {
        throw new BadRequestException(label + ' contains a string longer than 8 KiB');
      }
    };
    visit(value, 0);
    return value;
  }

  private decimal(value: string, allowNegative: boolean, field: string): string {
    try {
      return normalizeFinanceDecimal(value, { allowNegative });
    } catch (error) {
      throw new BadRequestException(field + ': ' + (error instanceof Error ? error.message : 'invalid decimal'));
    }
  }

  private endpoint(mode: FinanceConnectorMode, value: string | null): string | null {
    try {
      return validateFinanceEndpoint(mode, value);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid finance endpoint');
    }
  }

  private secretReference(value: string | null): string | null {
    try {
      return validateFinanceSecretReference(value);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid secret reference');
    }
  }

  private requireIdempotencyKey(input: string | null): string {
    const key = input?.trim() ?? '';
    if (key.length < 1 || key.length > 200) {
      throw new BadRequestException('Idempotency-Key header is required and must contain 1 to 200 characters');
    }
    return key;
  }

  private async assertActiveFactory(client: PoolClient, tenantId: string, factoryId: string): Promise<void> {
    const result = await client.query(
      'SELECT 1 FROM factories WHERE id=$1 AND tenant_id=$2 AND status=\'ACTIVE\'',
      [factoryId, tenantId],
    );
    if (!result.rows[0]) throw new ForbiddenException('Finance operations require an active factory in the authenticated tenant');
  }

  private connectorResponse(row: ConnectorRow, replayed: boolean) {
    return {
      id: row.id,
      connector_code: row.connector_code,
      display_name: row.display_name,
      source_system: row.source_system,
      domain: row.domain,
      integration_mode: row.integration_mode,
      status: row.status,
      row_version: Number(row.row_version),
      created_by_user_id: row.created_by_user_id,
      endpoint_url: row.endpoint_url ?? null,
      configuration: row.configuration ?? {},
      has_secret_reference: row.has_secret_reference === true || row.has_secret_reference === 't',
      is_reporting_source: row.is_reporting_source === true,
      replayed,
      system_of_record_boundary: 'EXTERNAL_SOURCE_REMAINS_AUTHORITATIVE',
      write_policy: 'READ_ONLY_INGESTION_NO_GL_JOURNAL_PAYMENT_OR_TAX_POSTING',
    };
  }

  private async connectorHistory(
    client: PoolClient,
    tenantId: string,
    factoryId: string,
    connectorId: string,
    action: 'CREATED' | 'APPROVED' | 'REJECTED' | 'PAUSED',
    userId: string,
    reason: string,
    ctx: FinanceEventContext,
    details: Record<string, unknown>,
  ) {
    await client.query(
      'INSERT INTO finance_connector_history(tenant_id,factory_id,connector_id,action,actor_user_id,reason,request_id,trace_id,details) ' +
      'VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',
      [tenantId, factoryId, connectorId, action, userId, reason, this.uuidOrNull(ctx.requestId),
        this.uuidOrNull(ctx.traceId), JSON.stringify(details)],
    );
  }

  private async audit(
    client: PoolClient,
    tenantId: string,
    factoryId: string,
    userId: string,
    eventType: string,
    action: string,
    resourceType: string,
    resourceId: string,
    ctx: FinanceEventContext,
    payload: Record<string, unknown>,
  ) {
    await client.query(
      'INSERT INTO audit_events(tenant_id,factory_id,actor_user_id,event_type,action,resource_type,resource_id,' +
      'correlation_id,request_id,data_class,payload) ' +
      'VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,\'CONFIDENTIAL\',$10::jsonb)',
      [tenantId, factoryId, userId, eventType, action, resourceType, resourceId,
        this.uuidOrNull(ctx.traceId), this.uuidOrNull(ctx.requestId), JSON.stringify(payload)],
    );
  }

  private async outbox(
    client: PoolClient,
    tenantId: string,
    factoryId: string,
    aggregateId: string,
    eventType: string,
    userId: string,
    ctx: FinanceEventContext,
    payload: Record<string, unknown>,
  ) {
    await client.query(
      'INSERT INTO outbox_events(tenant_id,factory_id,aggregate_type,aggregate_id,event_type,event_version,' +
      'occurred_at,correlation_id,causation_id,actor,source,payload) ' +
      'VALUES($1,$2,\'FINANCE\', $3,$4,1,clock_timestamp(),$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)',
      [
        tenantId, factoryId, aggregateId, eventType,
        this.uuidOrNull(ctx.traceId) ?? this.uuidOrNull(ctx.requestId) ?? randomUUID(),
        this.uuidOrNull(ctx.requestId),
        JSON.stringify({ type: 'user', id: userId }),
        JSON.stringify({ system: 'FactoryOS', connector: 'finance-integration-service', version: process.env.APP_VERSION ?? '0.0.1' }),
        JSON.stringify(payload),
      ],
    );
  }

  private uuidOrNull(value: string | null | undefined): string | null {
    if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      return null;
    }
    return value;
  }
}
