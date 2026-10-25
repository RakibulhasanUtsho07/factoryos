import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
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
import {
  recordOperationalWebhookEvent,
  recordOperationalWebhookReplay,
  type OperationalWebhookInput,
} from './integration-reconciliation.store';

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
    const externalEventId = externalEventIdHeader ?? '';
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

    const limitRaw = this.config.get<string>('WEBHOOK_RATE_LIMIT_PER_MINUTE');
    const rateLimit = limitRaw === undefined ? 600 : Number(limitRaw);
    if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 10000) {
      throw new InternalServerErrorException('WEBHOOK_RATE_LIMIT_PER_MINUTE must be an integer between 1 and 10000');
    }
    const requestCount = await this.database.transaction(async (client) => {
      const result = await client.query<{ request_count: number }>(
        `INSERT INTO public.integration_webhook_rate_limits AS existing
          (tenant_id,factory_id,connector_id,window_started_at,request_count)
         VALUES($1,$2,$3,to_timestamp((floor(extract(epoch from clock_timestamp()) / 60) * 60)::double precision),1)
         ON CONFLICT(connector_id) DO UPDATE
         SET tenant_id=EXCLUDED.tenant_id,
             factory_id=EXCLUDED.factory_id,
             window_started_at=EXCLUDED.window_started_at,
             request_count=CASE
               WHEN existing.window_started_at=EXCLUDED.window_started_at
                 THEN LEAST(existing.request_count+1,10001)
               ELSE 1
             END,
             updated_at=clock_timestamp()
         WHERE existing.tenant_id=EXCLUDED.tenant_id AND existing.factory_id=EXCLUDED.factory_id
         RETURNING request_count`,
        [scope.tenant_id, scope.factory_id, connectorId],
      );
      if (!result.rows[0]) throw new NotFoundException('Integration webhook endpoint not found');
      return Number(result.rows[0].request_count);
    }, { tenantId: scope.tenant_id });
    if (requestCount > rateLimit) {
      throw new HttpException('Webhook connector rate limit exceeded; retry after the current minute window', HttpStatus.TOO_MANY_REQUESTS);
    }

    let envelope: WebhookEnvelope;
    try {
      envelope = validateWebhookEnvelope(request.body, connector.schema_version, connector.payload_schema);
      assertWebhookEventTypeAllowed(envelope.event_type, connector.allowed_event_types);
      if ((connector.source_system === 'WMS_CARRIER') !== (envelope.event_type === 'WMS.SHIPMENT_DELIVERY')) {
        throw new UnprocessableEntityException(
          'WMS_CARRIER connectors must send WMS.SHIPMENT_DELIVERY events, and only WMS_CARRIER connectors may send them',
        );
      }
    } catch (error) {
      throw this.contractException(error);
    }
    const payloadHash = integrationRequestHash({
      event_type: envelope.event_type,
      schema_version: envelope.schema_version,
      correlation_id: envelope.correlation_id ?? null,
      payload: envelope.payload,
    });
    const reconciliationInput: OperationalWebhookInput = {
      tenantId: scope.tenant_id,
      factoryId: scope.factory_id,
      connectorId,
      sourceSystem: connector.source_system,
      externalEventId,
      eventType: envelope.event_type,
      schemaVersion: envelope.schema_version,
      payloadSha256: payloadHash,
      correlationId: envelope.correlation_id ?? null,
      payload: envelope.payload,
    };
    let conflictingReplay: OperationalWebhookInput | null = null;

    try {
    return await this.database.transaction(async (client) => {
      const existingResult = await client.query<WebhookReceiptRow>(
        'SELECT outbox_event_id::text AS outbox_event_id,payload_sha256,event_type,schema_version FROM integration_webhook_receipts WHERE tenant_id=$1 AND factory_id=$2 AND connector_id=$3 AND external_event_id=$4 FOR UPDATE',
        [scope.tenant_id, scope.factory_id, connectorId, externalEventId],
      );
      const existing = existingResult.rows[0];
      if (existing) {
        if (existing.payload_sha256 !== payloadHash || existing.event_type !== envelope.event_type || Number(existing.schema_version) !== envelope.schema_version) {
          conflictingReplay = reconciliationInput;
          throw new ConflictException('X-FactoryOS-Event-Id was already accepted with a different payload');
        }
        await recordOperationalWebhookReplay(client, reconciliationInput, 'DUPLICATE_REPLAY');
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

      if (connector.source_system === 'WMS_CARRIER') {
        await this.recordCarrierDeliveryEvent(client, {
          tenantId: scope.tenant_id,
          factoryId: scope.factory_id,
          connector,
          externalEventId,
          correlationId: envelope.correlation_id ?? null,
          payload: envelope.payload,
        });
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
        request_fingerprint_sha256: payloadHash,
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
      await recordOperationalWebhookEvent(client, reconciliationInput);
      return { accepted: true, duplicate: false, event_id: outboxId };
    }, {
      tenantId: scope.tenant_id,
      advisoryLockKey: 'integration-webhook:' + connectorId + ':' + externalEventId,
    });
    } catch (error) {
      if (conflictingReplay) {
        try {
          await this.database.transaction(async (client) => {
            await recordOperationalWebhookReplay(client, conflictingReplay!, 'CONFLICTING_DUPLICATE');
          }, { tenantId: scope.tenant_id });
        } catch {
          throw new InternalServerErrorException(
            'A conflicting webhook replay was detected but its reconciliation case could not be recorded',
          );
        }
      }
      throw error;
    }
  }

  /**
   * Maps an authenticated carrier connector envelope into the WMS delivery ledger.
   * This executes inside the generic webhook receipt/outbox transaction: the carrier receipt
   * and WMS event either commit together or neither does.
   */
  private async recordCarrierDeliveryEvent(
    client: PoolClient,
    input: {
      tenantId: string;
      factoryId: string;
      connector: ConnectorRow;
      externalEventId: string;
      correlationId: string | null;
      payload: Record<string, unknown>;
    },
  ) {
    const payload = input.payload;
    const requiredText = (field: string, maximum: number): string => {
      const value = payload[field];
      if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) {
        throw new BadRequestException(field + ' must be a non-empty string of at most ' + maximum + ' characters');
      }
      return value.trim();
    };
    const optionalText = (field: string, maximum: number): string | null => {
      const value = payload[field];
      if (value === undefined || value === null) return null;
      if (typeof value !== 'string' || value.length > maximum) {
        throw new BadRequestException(field + ' must be a string of at most ' + maximum + ' characters');
      }
      return value.trim() || null;
    };
    const parseTimestamp = (value: unknown, field: string): Date => {
      if (typeof value !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
        throw new BadRequestException(field + ' must be an RFC 3339 timestamp with an explicit timezone');
      }
      const parsed = new Date(value);
      if (!Number.isFinite(parsed.getTime())) throw new BadRequestException(field + ' must be a valid timestamp');
      return parsed;
    };

    const carrierName = requiredText('carrier_name', 255);
    const trackingReference = requiredText('tracking_reference', 255);
    const eventType = requiredText('event_type', 24).toUpperCase();
    if (!['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED', 'DELIVERED', 'RETURNED'].includes(eventType)) {
      throw new BadRequestException('event_type is not a supported WMS delivery lifecycle event');
    }
    const eventAt = parseTimestamp(payload.event_at, 'event_at');
    if (eventAt.getTime() > Date.now() + 10 * 60 * 1000) {
      throw new BadRequestException('event_at cannot be more than ten minutes in the future');
    }

    const recipientName = optionalText('recipient_name', 255);
    const proofType = optionalText('proof_type', 32)?.toUpperCase() ?? null;
    const proofReference = optionalText('proof_reference', 500);
    const proofSha256 = optionalText('proof_sha256', 64)?.toLowerCase() ?? null;
    const signedAt = payload.signed_at === undefined || payload.signed_at === null
      ? null
      : parseTimestamp(payload.signed_at, 'signed_at');
    const notes = optionalText('notes', 2000);
    if (eventType === 'DELIVERED') {
      if (!recipientName || !proofType || !proofReference || !proofSha256 || !signedAt
        || signedAt.getTime() > eventAt.getTime()) {
        throw new BadRequestException(
          'DELIVERED requires recipient, proof type, storage object key, SHA-256 digest and signed timestamp',
        );
      }
      if (!['SIGNATURE', 'PHOTO', 'DOCUMENT', 'OTP', 'CUSTOMER_ACKNOWLEDGEMENT'].includes(proofType)) {
        throw new BadRequestException('proof_type is not supported');
      }
      if (!/^[a-f0-9]{64}$/.test(proofSha256)) throw new BadRequestException('proof_sha256 must be SHA-256 hex');
      if (!/^(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9._/-]{0,499}$/.test(proofReference)) {
        throw new BadRequestException('proof_reference must be a relative storage object key');
      }
    } else if (['recipient_name', 'proof_type', 'proof_reference', 'proof_sha256', 'signed_at']
      .some((field) => payload[field] !== undefined && payload[field] !== null)) {
      throw new BadRequestException('POD fields may only be supplied for DELIVERED events');
    }

    const shipmentResult = await client.query<{
      shipment_unit_id: string;
      shipment_code: string;
      status: string;
    }>(
      `SELECT shipment_unit_id::text AS shipment_unit_id, shipment_code, status
       FROM wms_shipments
       WHERE tenant_id=$1 AND factory_id=$2
         AND lower(btrim(carrier_name))=lower(btrim($3))
         AND tracking_reference=$4
       ORDER BY shipment_unit_id
       LIMIT 2
       FOR UPDATE`,
      [input.tenantId, input.factoryId, carrierName, trackingReference],
    );
    if (shipmentResult.rows.length === 0) {
      throw new NotFoundException('Carrier tracking reference does not resolve to a shipment in this factory');
    }
    if (shipmentResult.rows.length > 1) {
      throw new ConflictException('Carrier tracking reference is ambiguous within this factory');
    }
    const shipment = shipmentResult.rows[0]!;
    if (shipment.status !== 'DISPATCHED') {
      throw new ConflictException('Carrier delivery events require a dispatched shipment');
    }

    const idempotencyKey = 'carrier:' + input.connector.id + ':' + input.externalEventId;
    const correlationId = input.correlationId ?? randomUUID();
    const requestHash = integrationRequestHash({
      connector_id: input.connector.id,
      external_event_id: input.externalEventId,
      shipment_unit_id: shipment.shipment_unit_id,
      carrier_name: carrierName,
      tracking_reference: trackingReference,
      event_type: eventType,
      event_at: eventAt.toISOString(),
      recipient_name: recipientName,
      proof_type: proofType,
      proof_reference: proofReference,
      proof_sha256: proofSha256,
      signed_at: signedAt?.toISOString() ?? null,
      notes,
    });
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO wms_shipment_delivery_events (
        tenant_id,factory_id,shipment_unit_id,event_type,source_system,event_at,
        recipient_name,proof_type,proof_reference,proof_sha256,signed_at,notes,
        idempotency_key,request_hash,recorded_by_user_id,correlation_id
      ) VALUES ($1,$2,$3,$4,'CARRIER_WEBHOOK',$5::timestamptz,$6,$7,$8,$9,$10::timestamptz,$11,$12,$13,NULL,$14::uuid)
      RETURNING id::text AS id`,
      [
        input.tenantId, input.factoryId, shipment.shipment_unit_id, eventType, eventAt.toISOString(),
        recipientName, proofType, proofReference, proofSha256, signedAt?.toISOString() ?? null, notes,
        idempotencyKey, requestHash, correlationId,
      ],
    );
    const eventId = inserted.rows[0]?.id;
    if (!eventId) throw new Error('WMS_CARRIER_DELIVERY_EVENT_INSERT_FAILED');

    // The connector creator is the accountable configuration owner; payload records that
    // the actual event actor is the authenticated carrier connector, not a user action.
    await client.query(
      `INSERT INTO audit_events (
        tenant_id,factory_id,actor_user_id,event_type,action,resource_type,
        resource_id,correlation_id,request_id,data_class,payload
      ) VALUES ($1,$2,$3,'WMS_FULFILLMENT','RECORDED','WMS_SHIPMENT_DELIVERY_EVENT',$4,$5,NULL,'INTERNAL',$6::jsonb)`,
      [
        input.tenantId, input.factoryId, input.connector.created_by_user_id, eventId, correlationId,
        JSON.stringify({
          shipment_unit_id: shipment.shipment_unit_id,
          shipment_code: shipment.shipment_code,
          event_type: eventType,
          event_at: eventAt.toISOString(),
          source_system: 'CARRIER_WEBHOOK',
          connector_id: input.connector.id,
          external_event_id: input.externalEventId,
          actor_kind: 'SIGNED_CARRIER_CONNECTOR',
          proof_type: proofType,
          proof_reference: proofReference,
          proof_sha256: proofSha256,
        }),
      ],
    );
    await client.query(
      `INSERT INTO outbox_events (
        tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload
      ) VALUES ($1,$2,'WMS_SHIPMENT_DELIVERY_EVENT',$3,'WMS.SHIPMENT_DELIVERY_EVENT_RECORDED',$4::jsonb)`,
      [
        input.tenantId, input.factoryId, eventId,
        JSON.stringify({
          delivery_event_id: eventId,
          shipment_unit_id: shipment.shipment_unit_id,
          shipment_code: shipment.shipment_code,
          event_type: eventType,
          event_at: eventAt.toISOString(),
          source_system: 'CARRIER_WEBHOOK',
          connector_id: input.connector.id,
          external_event_id: input.externalEventId,
          proof_type: proofType,
          proof_reference: proofReference,
          proof_sha256: proofSha256,
        }),
      ],
    );
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
