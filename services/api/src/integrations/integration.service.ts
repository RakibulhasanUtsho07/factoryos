import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { isUUID } from 'class-validator';
import { DatabaseService } from '../database/database.service';
import {
  assertPayloadSchema,
  assertWebhookEventTypeAllowed,
  assertValidWebhookSignature,
  integrationRequestHash,
  IntegrationContractError,
  validateWebhookEnvelope,
  validateWebhookSecretReference,
  validateAllowedWebhookEventTypes,
} from './integration-contract';
import type { WebhookEnvelope } from './integration-contract';

interface ConnectorRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  display_name: string;
  source_system: string;
  connector_type: string;
  status: string;
  secret_reference: string;
  schema_version: number;
  allowed_event_types: string[];
  payload_schema: Record<string, unknown>;
  idempotency_key?: string;
  request_hash?: string;
  created_by_user_id: string;
  updated_by_user_id?: string;
  reviewed_by_user_id: string | null;
  reviewed_at: Date | string | null;
  paused_at: Date | string | null;
  decision_reason: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface WebhookReceiptRow {
  outbox_event_id: string;
  payload_sha256: string;
  event_type: string;
  schema_version: number;
}

interface WebhookRouteRow {
  tenant_id: string;
  factory_id: string;
}

interface RawWebhookRequest {
  rawBody?: Buffer;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
  factoryos?: {
    requestId?: string | null;
    traceId?: string | null;
  };
}

type ConnectorAction = 'ACTIVATE' | 'REJECT' | 'PAUSE' | 'RESUME';

@Injectable()
export class IntegrationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService,
  ) {}

  async registerConnector(
    userId: string,
    tenantId: string,
    factoryId: string,
    input: {
      display_name: string;
      source_system: string;
      secret_reference: string;
      schema_version: number;
      allowed_event_types: string[];
      payload_schema: Record<string, unknown>;
    },
    idempotencyKeyInput: string | null,
  ) {
    this.assertScope(userId, tenantId, factoryId);
    const idempotencyKey = this.requireIdempotencyKey(idempotencyKeyInput);
    const displayName = input.display_name.trim();
    const sourceSystem = input.source_system.trim();
    const secretReference = this.validateAndResolveSecretReference(input.secret_reference);
    let allowedEventTypes: string[];
    try {
      allowedEventTypes = validateAllowedWebhookEventTypes(input.allowed_event_types);
    } catch (error) {
      throw this.contractException(error);
    }
    try {
      assertPayloadSchema(input.payload_schema);
    } catch (error) {
      throw this.contractException(error);
    }
    if (!Number.isInteger(input.schema_version) || input.schema_version < 1 || input.schema_version > 10000) {
      throw new BadRequestException('schema_version must be an integer between 1 and 10000');
    }
    const requestHash = integrationRequestHash({
      display_name: displayName,
      source_system: sourceSystem,
      secret_reference: secretReference,
      schema_version: input.schema_version,
      allowed_event_types: allowedEventTypes,
      payload_schema: input.payload_schema,
    });

    return this.database.transaction(
      async (client) => {
        const previous = await client.query<ConnectorRow & { request_hash: string }>(
          'SELECT id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,display_name,source_system,connector_type,status,secret_reference,schema_version,allowed_event_types,payload_schema,created_by_user_id::text AS created_by_user_id,reviewed_by_user_id::text AS reviewed_by_user_id,reviewed_at,paused_at,decision_reason,created_at,updated_at,request_hash FROM integration_connectors WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE',
          [tenantId, factoryId, idempotencyKey],
        );
        const existing = previous.rows[0];
        if (existing) {
          if (existing.request_hash !== requestHash) {
            throw new ConflictException('Idempotency-Key was already used for a different connector registration request');
          }
          return { ...this.connectorView(existing), replayed: true };
        }

        const created = await client.query<ConnectorRow>(
          'INSERT INTO integration_connectors(tenant_id,factory_id,display_name,source_system,secret_reference,schema_version,allowed_event_types,payload_schema,idempotency_key,request_hash,created_by_user_id,updated_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7::varchar[],$8::jsonb,$9,$10,$11,$11) RETURNING id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,display_name,source_system,connector_type,status,secret_reference,schema_version,allowed_event_types,payload_schema,created_by_user_id::text AS created_by_user_id,reviewed_by_user_id::text AS reviewed_by_user_id,reviewed_at,paused_at,decision_reason,created_at,updated_at',
          [
            tenantId, factoryId, displayName, sourceSystem, secretReference,
            input.schema_version, allowedEventTypes, JSON.stringify(input.payload_schema), idempotencyKey, requestHash, userId,
          ],
        );
        const connector = created.rows[0];
        if (!connector) throw new InternalServerErrorException('Connector registration did not return a saved record');
        await this.appendHistory(client, tenantId, factoryId, connector.id, userId, 'CREATED', 'Connector registered for review', connector.schema_version, {
          source_system: sourceSystem,
          schema_version: input.schema_version,
          secret_reference_configured: true,
        });
        return { ...this.connectorView(connector), replayed: false };
      },
      { tenantId, userId, advisoryLockKey: 'integration-connector-create:' + tenantId + ':' + factoryId + ':' + idempotencyKey },
    );
  }

  async listConnectors(
    userId: string,
    tenantId: string,
    factoryId: string,
    status?: string,
  ) {
    this.assertScope(userId, tenantId, factoryId);
    if (status && !['PENDING_REVIEW', 'ACTIVE', 'PAUSED', 'REJECTED'].includes(status)) {
      throw new BadRequestException('Unsupported connector status filter');
    }
    const result = await this.database.query<ConnectorRow>(
      'SELECT id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,display_name,source_system,connector_type,status,secret_reference,schema_version,allowed_event_types,payload_schema,created_by_user_id::text AS created_by_user_id,reviewed_by_user_id::text AS reviewed_by_user_id,reviewed_at,paused_at,decision_reason,created_at,updated_at FROM integration_connectors WHERE tenant_id=$1 AND factory_id=$2 AND ($3::text IS NULL OR status=$3) ORDER BY created_at DESC,id DESC LIMIT 200',
      [tenantId, factoryId, status ?? null],
      { tenantId, userId },
    );
    return { items: result.rows.map((row) => this.connectorView(row)), limit: 200 };
  }

  async getConnector(userId: string, tenantId: string, factoryId: string, connectorId: string) {
    this.assertScope(userId, tenantId, factoryId);
    return this.database.transaction(async (client) => {
      const row = await this.findConnector(client, tenantId, factoryId, connectorId, false);
      return this.connectorView(row);
    }, { tenantId, userId });
  }

  async transitionConnector(
    userId: string,
    tenantId: string,
    factoryId: string,
    connectorId: string,
    action: ConnectorAction,
    reason: string,
  ) {
    this.assertScope(userId, tenantId, factoryId);
    const cleanReason = this.requireReason(reason);
    return this.database.transaction(async (client) => {
      const connector = await this.findConnector(client, tenantId, factoryId, connectorId, true);
      let nextStatus = connector.status;
      let reviewedBy = connector.reviewed_by_user_id;
      let reviewedAt = connector.reviewed_at;
      let pausedAt = connector.paused_at;
      if (action === 'ACTIVATE' || action === 'REJECT') {
        if (connector.status !== 'PENDING_REVIEW') throw new ConflictException('Only pending connectors can be approved or rejected');
        if (connector.created_by_user_id === userId) throw new ConflictException('Connector maker cannot approve or reject their own registration');
        nextStatus = action === 'ACTIVATE' ? 'ACTIVE' : 'REJECTED';
        reviewedBy = userId;
        reviewedAt = new Date();
        pausedAt = null;
      } else if (action === 'PAUSE') {
        if (connector.status !== 'ACTIVE') throw new ConflictException('Only active connectors can be paused');
        nextStatus = 'PAUSED';
        pausedAt = new Date();
      } else {
        if (connector.status !== 'PAUSED') throw new ConflictException('Only paused connectors can be resumed');
        nextStatus = 'ACTIVE';
        pausedAt = null;
      }

      const result = await client.query<ConnectorRow>(
        'UPDATE integration_connectors SET status=$1,updated_by_user_id=$2,reviewed_by_user_id=$3,reviewed_at=$4,paused_at=$5,decision_reason=$6 WHERE id=$7 AND tenant_id=$8 AND factory_id=$9 RETURNING id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,display_name,source_system,connector_type,status,secret_reference,schema_version,allowed_event_types,payload_schema,created_by_user_id::text AS created_by_user_id,reviewed_by_user_id::text AS reviewed_by_user_id,reviewed_at,paused_at,decision_reason,created_at,updated_at',
        [nextStatus, userId, reviewedBy, reviewedAt, pausedAt, cleanReason, connectorId, tenantId, factoryId],
      );
      const updated = result.rows[0];
      if (!updated) throw new NotFoundException('Integration connector not found');
      await this.appendHistory(client, tenantId, factoryId, connectorId, userId, this.historyAction(action), cleanReason, connector.schema_version, {
        previous_status: connector.status,
        resulting_status: nextStatus,
      });
      return this.connectorView(updated);
    }, { tenantId, userId });
  }

  async rotateSecret(
    userId: string,
    tenantId: string,
    factoryId: string,
    connectorId: string,
    newReferenceInput: string,
    reasonInput: string,
  ) {
    this.assertScope(userId, tenantId, factoryId);
    const secretReference = this.validateAndResolveSecretReference(newReferenceInput);
    const reason = this.requireReason(reasonInput);
    return this.database.transaction(async (client) => {
      const connector = await this.findConnector(client, tenantId, factoryId, connectorId, true);
      if (connector.status !== 'PAUSED') throw new ConflictException('Pause the connector before rotating its signing secret');
      if (connector.secret_reference === secretReference) throw new ConflictException('New secret reference must differ from the current reference');
      const result = await client.query<ConnectorRow>(
        'UPDATE integration_connectors SET secret_reference=$1,updated_by_user_id=$2,decision_reason=$3 WHERE id=$4 AND tenant_id=$5 AND factory_id=$6 AND status=$7 RETURNING id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,display_name,source_system,connector_type,status,secret_reference,schema_version,allowed_event_types,payload_schema,created_by_user_id::text AS created_by_user_id,reviewed_by_user_id::text AS reviewed_by_user_id,reviewed_at,paused_at,decision_reason,created_at,updated_at',
        [secretReference, userId, reason, connectorId, tenantId, factoryId, 'PAUSED'],
      );
      const updated = result.rows[0];
      if (!updated) throw new ConflictException('Connector state changed; retry secret rotation after reloading it');
      await this.appendHistory(client, tenantId, factoryId, connectorId, userId, 'SECRET_ROTATED', reason, connector.schema_version, {
        prior_reference_replaced: true,
        new_reference_configured: true,
      });
      return this.connectorView(updated);
    }, { tenantId, userId });
  }

  async receiveWebhook(
    connectorId: string,
    request: RawWebhookRequest,
    timestampHeader: string | undefined,
    externalEventIdHeader: string | undefined,
    signatureHeader: string | undefined,
  ) {
    if (!isUUID(connectorId)) throw new BadRequestException('connectorId must be a UUID');
    const externalEventId = externalEventIdHeader?.trim() ?? '';
    if (!/^[\x21-\x7e]{1,200}$/.test(externalEventId)) {
      throw new BadRequestException('X-FactoryOS-Event-Id must contain 1 to 200 visible ASCII characters');
    }
    const rawBody = request.rawBody;
    if (!rawBody || rawBody.length === 0) throw new BadRequestException('Webhook raw request body is unavailable');
    if (rawBody.length > 3 * 1024 * 1024) throw new BadRequestException('Webhook body exceeds the 3 MiB limit');

    const route = await this.database.query<WebhookRouteRow>(
      'SELECT tenant_id::text AS tenant_id,factory_id::text AS factory_id FROM public.factoryos_resolve_integration_webhook($1)',
      [connectorId],
    );
    const scope = route.rows[0];
    if (!scope) throw new NotFoundException('Integration webhook endpoint not found');

    const connectorResult = await this.database.query<ConnectorRow>(
      'SELECT id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,display_name,source_system,connector_type,status,secret_reference,schema_version,allowed_event_types,payload_schema,created_by_user_id::text AS created_by_user_id,reviewed_by_user_id::text AS reviewed_by_user_id,reviewed_at,paused_at,decision_reason,created_at,updated_at FROM integration_connectors WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',
      [connectorId, scope.tenant_id, scope.factory_id],
      { tenantId: scope.tenant_id },
    );
    const connector = connectorResult.rows[0];
    if (!connector || !['ACTIVE', 'PAUSED'].includes(connector.status)) {
      throw new NotFoundException('Integration webhook endpoint not found');
    }

    let signatureTimestamp: number;
    const secretAlias = validateWebhookSecretReference(connector.secret_reference);
    const secret = this.config.get<string>(secretAlias);
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
      throw new InternalServerErrorException('Webhook signing secret is not configured with the required minimum length');
    }
    try {
      const toleranceRaw = this.config.get<string>('WEBHOOK_SIGNATURE_TOLERANCE_SECONDS');
      const tolerance = toleranceRaw === undefined ? 300 : Number(toleranceRaw);
      if (!Number.isInteger(tolerance) || tolerance < 60 || tolerance > 900) {
        throw new InternalServerErrorException('WEBHOOK_SIGNATURE_TOLERANCE_SECONDS must be an integer between 60 and 900');
      }
      signatureTimestamp = assertValidWebhookSignature(
        secret,
        timestampHeader ?? '',
        externalEventId,
        signatureHeader ?? '',
        rawBody,
        Date.now(),
        tolerance,
      );
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      throw this.contractException(error);
    }

    let envelope: WebhookEnvelope;
    try {
      envelope = validateWebhookEnvelope(request.body, connector.schema_version, connector.payload_schema);
      assertWebhookEventTypeAllowed(envelope.event_type, connector.allowed_event_types);
    } catch (error) {
      throw this.contractException(error);
    }
    const payloadHash = integrationRequestHash({
      event_type: envelope.event_type,
      schema_version: envelope.schema_version,
      correlation_id: envelope.correlation_id ?? null,
      payload: envelope.payload,
    });

    return this.database.transaction(async (client) => {
      const existingResult = await client.query<WebhookReceiptRow>(
        'SELECT outbox_event_id::text AS outbox_event_id,payload_sha256,event_type,schema_version FROM integration_webhook_receipts WHERE tenant_id=$1 AND factory_id=$2 AND connector_id=$3 AND external_event_id=$4 FOR UPDATE',
        [scope.tenant_id, scope.factory_id, connectorId, externalEventId],
      );
      const existing = existingResult.rows[0];
      if (existing) {
        if (existing.payload_sha256 !== payloadHash || existing.event_type !== envelope.event_type || Number(existing.schema_version) !== envelope.schema_version) {
          throw new ConflictException('X-FactoryOS-Event-Id was already accepted with a different payload');
        }
        return { accepted: true, duplicate: true, event_id: existing.outbox_event_id };
      }

      const currentResult = await client.query<{
        status: string;
        secret_reference: string;
        schema_version: number;
      }>(
        'SELECT status,secret_reference,schema_version FROM integration_connectors WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
        [connectorId, scope.tenant_id, scope.factory_id],
      );
      const current = currentResult.rows[0];
      if (!current || !['ACTIVE', 'PAUSED'].includes(current.status)) {
        throw new NotFoundException('Integration webhook endpoint not found');
      }
      if (current.secret_reference !== connector.secret_reference || Number(current.schema_version) !== envelope.schema_version) {
        throw new ServiceUnavailableException('Connector signing configuration changed during webhook validation; retry the same event');
      }
      if (current.status !== 'ACTIVE') {
        throw new ServiceUnavailableException('Integration connector is paused; retry this event after the connector is resumed');
      }

      const outboxId = randomUUID();
      const source = {
        system: connector.source_system,
        connector: connector.id,
        version: String(envelope.schema_version),
      };
      const outboxPayload = {
        connector_id: connector.id,
        source_system: connector.source_system,
        external_event_id: externalEventId,
        source_event_type: envelope.event_type,
        source_schema_version: envelope.schema_version,
        ...(envelope.correlation_id ? { external_correlation_id: envelope.correlation_id } : {}),
        payload: envelope.payload,
      };
      await client.query(
        "INSERT INTO outbox_events(id,tenant_id,factory_id,aggregate_type,aggregate_id,event_type,event_version,payload,status,attempts,next_attempt_at,occurred_at,correlation_id,actor,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,0,clock_timestamp(),clock_timestamp(),$10,NULL,$11::jsonb)",
        [
          outboxId,
          scope.tenant_id,
          scope.factory_id,
          'INTEGRATION_CONNECTOR',
          connectorId,
          'INTEGRATION.WEBHOOK_RECEIVED',
          1,
          JSON.stringify(outboxPayload),
          'PENDING',
          envelope.correlation_id ?? null,
          JSON.stringify(source),
        ],
      );
      await client.query(
        'INSERT INTO integration_webhook_receipts(tenant_id,factory_id,connector_id,external_event_id,event_type,schema_version,payload_sha256,signature_timestamp,outbox_event_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [scope.tenant_id, scope.factory_id, connectorId, externalEventId, envelope.event_type, envelope.schema_version, payloadHash, signatureTimestamp, outboxId],
      );
      return { accepted: true, duplicate: false, event_id: outboxId };
    }, {
      tenantId: scope.tenant_id,
      advisoryLockKey: 'integration-webhook:' + connectorId + ':' + externalEventId,
    });
  }

  async listHistory(userId: string, tenantId: string, factoryId: string, connectorId: string) {
    this.assertScope(userId, tenantId, factoryId);
    return this.database.transaction(async (client) => {
      await this.findConnector(client, tenantId, factoryId, connectorId, false);
      const result = await client.query(
        'SELECT id::text AS id,connector_id::text AS connector_id,actor_user_id::text AS actor_user_id,action,reason,schema_version,metadata,created_at FROM integration_connector_history WHERE tenant_id=$1 AND factory_id=$2 AND connector_id=$3 ORDER BY created_at DESC LIMIT 200',
        [tenantId, factoryId, connectorId],
      );
      return { items: result.rows };
    }, { tenantId, userId });
  }

  private async findConnector(client: PoolClient, tenantId: string, factoryId: string, connectorId: string, forUpdate: boolean): Promise<ConnectorRow> {
    if (!isUUID(connectorId)) throw new BadRequestException('connectorId must be a UUID');
    const result = await client.query<ConnectorRow>(
      'SELECT id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,display_name,source_system,connector_type,status,secret_reference,schema_version,allowed_event_types,payload_schema,created_by_user_id::text AS created_by_user_id,reviewed_by_user_id::text AS reviewed_by_user_id,reviewed_at,paused_at,decision_reason,created_at,updated_at FROM integration_connectors WHERE id=$1 AND tenant_id=$2 AND factory_id=$3' + (forUpdate ? ' FOR UPDATE' : ''),
      [connectorId, tenantId, factoryId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Integration connector not found');
    return row;
  }

  private async appendHistory(
    client: PoolClient,
    tenantId: string,
    factoryId: string,
    connectorId: string,
    actorUserId: string,
    action: string,
    reason: string,
    schemaVersion: number,
    metadata: Record<string, unknown>,
  ) {
    await client.query(
      'INSERT INTO integration_connector_history(tenant_id,factory_id,connector_id,actor_user_id,action,reason,schema_version,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
      [tenantId, factoryId, connectorId, actorUserId, action, reason, schemaVersion, JSON.stringify(metadata)],
    );
  }

  private validateAndResolveSecretReference(value: string) {
    let alias: string;
    try {
      alias = validateWebhookSecretReference(value);
    } catch (error) {
      throw this.contractException(error);
    }
    const secret = this.config.get<string>(alias);
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
      throw new BadRequestException('The referenced signing secret must exist and contain at least 32 UTF-8 bytes');
    }
    return 'env://' + alias;
  }

  private contractException(error: unknown): Error {
    if (!(error instanceof IntegrationContractError)) {
      return new BadRequestException('Integration request failed contract validation');
    }
    if (error.code.startsWith('WEBHOOK_TIMESTAMP_') || error.code === 'WEBHOOK_SIGNATURE_INVALID') {
      return new UnauthorizedException({ code: error.code, message: error.message });
    }
    if (error.code === 'WEBHOOK_EVENT_TYPE_NOT_ALLOWED' || error.code.startsWith('WEBHOOK_SCHEMA_VERSION') || error.code.startsWith('WEBHOOK_PAYLOAD')) {
      return new UnprocessableEntityException({ code: error.code, message: error.message });
    }
    return new BadRequestException({ code: error.code, message: error.message });
  }

  private requireIdempotencyKey(value: string | null): string {
    const key = value?.trim() ?? '';
    if (!/^[\x21-\x7e]{1,200}$/.test(key)) throw new BadRequestException('Idempotency-Key header is required and must contain 1 to 200 visible ASCII characters');
    return key;
  }

  private requireReason(value: string): string {
    const reason = value?.trim() ?? '';
    if (reason.length < 3 || reason.length > 500) throw new BadRequestException('reason must contain 3 to 500 characters');
    return reason;
  }

  private assertScope(userId: string, tenantId: string, factoryId: string) {
    if (!isUUID(userId) || !isUUID(tenantId) || !isUUID(factoryId)) {
      throw new UnauthorizedException('Authenticated user, tenant and factory scope are required');
    }
  }

  private historyAction(action: ConnectorAction): string {
    if (action === 'ACTIVATE') return 'ACTIVATED';
    if (action === 'REJECT') return 'REJECTED';
    if (action === 'PAUSE') return 'PAUSED';
    return 'RESUMED';
  }

  private connectorView(row: ConnectorRow) {
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      factory_id: row.factory_id,
      display_name: row.display_name,
      source_system: row.source_system,
      connector_type: row.connector_type,
      status: row.status,
      webhook_path: '/api/integrations/webhooks/' + row.id,
      schema_version: Number(row.schema_version),
      allowed_event_types: row.allowed_event_types,
      payload_schema: row.payload_schema,
      has_secret_reference: Boolean(row.secret_reference),
      created_by_user_id: row.created_by_user_id,
      reviewed_by_user_id: row.reviewed_by_user_id,
      reviewed_at: row.reviewed_at,
      paused_at: row.paused_at,
      decision_reason: row.decision_reason,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
