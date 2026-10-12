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

import { AuditService, type AuditEventInput } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { IamService } from '../iam/iam.service';
import { RegisterEdgeDeviceDto, EdgeDeviceProtocol } from './dto/register-edge-device.dto';
import {
  EdgeObservationDto,
  EdgeObservationQuality,
  EdgeObservationSourceMode,
  SyncEdgeObservationsDto,
} from './dto/sync-edge-observations.dto';
import { EdgeDeviceStatus, SetEdgeDeviceStatusDto } from './dto/set-edge-device-status.dto';

interface EdgeDeviceRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  device_key: string;
  display_name: string;
  protocol: EdgeDeviceProtocol;
  device_group: string | null;
  capability_profile: Record<string, unknown>;
  status: EdgeDeviceStatus;
  registration_hash: string;
  created_by: string;
  last_seen_at: string | null;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

interface EdgeSyncBatchRow extends QueryResultRow {
  id: string;
  batch_key: string;
  request_hash: string;
  observations_received: number;
  observations_inserted: number;
  observations_deduplicated: number;
  received_at: string;
}

interface NormalizedObservation {
  eventId: string;
  signalKey: string;
  observedAt: string;
  sourceMode: EdgeObservationSourceMode;
  quality: EdgeObservationQuality;
  payload: Record<string, unknown>;
}

interface EdgeAuditContext {
  requestId?: string | null;
  correlationId?: string | null;
}

interface SyncSummary {
  id: string;
  batchKey: string;
  observationsReceived: number;
  observationsInserted: number;
  observationsDeduplicated: number;
  receivedAt: string;
}

const DEVICE_COLUMNS = `
  id::text AS id,
  tenant_id::text AS tenant_id,
  factory_id::text AS factory_id,
  device_key,
  display_name,
  protocol,
  device_group,
  capability_profile,
  status,
  registration_hash,
  created_by::text AS created_by,
  last_seen_at::text AS last_seen_at,
  last_sync_at::text AS last_sync_at,
  created_at::text AS created_at,
  updated_at::text AS updated_at
`;

const DEVICE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const DEVICE_GROUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const SIGNAL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CREDENTIAL_FIELD_PATTERN =
  /(?:secret|password|credential|private.?key|api.?key|access.?token|refresh.?token|authorization|bearer)/i;

@Injectable()
export class EdgeDeviceGatewayService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
  ) {}

  async registerDevice(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    input: RegisterEdgeDeviceDto,
    auditContext: EdgeAuditContext = {},
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);
    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'edge.devices.write',
      factoryId,
    );

    const normalized = this.normalizeDevice(input);
    const registrationHash = this.hash({
      tenantId,
      factoryId,
      ...normalized,
    });

    const inserted = await this.database.query<EdgeDeviceRow>(
      `
      INSERT INTO edge_devices (
        tenant_id, factory_id, device_key, display_name, protocol,
        device_group, capability_profile, status, registration_hash, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'ACTIVE', $8, $9)
      ON CONFLICT (tenant_id, factory_id, device_key) DO NOTHING
      RETURNING ${DEVICE_COLUMNS}
      `,
      [
        tenantId,
        factoryId,
        normalized.deviceKey,
        normalized.displayName,
        normalized.protocol,
        normalized.deviceGroup,
        JSON.stringify(normalized.capabilityProfile),
        registrationHash,
        actorUserId,
      ],
      { tenantId, userId: actorUserId },
    );

    const created = inserted.rows[0];
    if (created) {
      await this.recordAuditSafely({
        tenantId,
        factoryId,
        actorUserId,
        eventType: 'EDGE_DEVICE_REGISTRY',
        action: 'REGISTER',
        resourceType: 'EDGE_DEVICE',
        resourceId: created.id,
        ...auditContext,
        payload: {
          deviceKeyHash: this.hash(normalized.deviceKey),
          protocol: normalized.protocol,
          status: created.status,
          capabilityKeys: Object.keys(normalized.capabilityProfile).sort(),
        },
      });
      return { idempotent: false, device: this.mapDevice(created) };
    }

    const existingResult = await this.database.query<EdgeDeviceRow>(
      `
      SELECT ${DEVICE_COLUMNS}
      FROM edge_devices
      WHERE tenant_id = $1 AND factory_id = $2 AND device_key = $3
      LIMIT 1
      `,
      [tenantId, factoryId, normalized.deviceKey],
      { tenantId, userId: actorUserId },
    );
    const existing = existingResult.rows[0];
    if (!existing || existing.registration_hash !== registrationHash) {
      throw new ConflictException(
        'The device key is already registered with different metadata',
      );
    }
    return { idempotent: true, device: this.mapDevice(existing) };
  }

  async listDevices(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    limit = 25,
    offset = 0,
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);
    this.validatePagination(limit, offset);
    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'edge.devices.read',
      factoryId,
    );

    const result = await this.database.query<EdgeDeviceRow>(
      `
      SELECT ${DEVICE_COLUMNS}
      FROM edge_devices
      WHERE tenant_id = $1 AND factory_id = $2
      ORDER BY created_at DESC, id DESC
      LIMIT $3 OFFSET $4
      `,
      [tenantId, factoryId, limit + 1, offset],
      { tenantId, userId: actorUserId },
    );
    const hasMore = result.rows.length > limit;
    return {
      limit,
      offset,
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
      devices: result.rows.slice(0, limit).map((row) => this.mapDevice(row)),
    };
  }

  async setDeviceStatus(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    deviceId: string,
    input: SetEdgeDeviceStatusDto,
    auditContext: EdgeAuditContext = {},
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);
    this.validateUuid(deviceId, 'deviceId');
    if (!Object.values(EdgeDeviceStatus).includes(input.status)) {
      throw new BadRequestException('status must be ACTIVE, PAUSED, or REVOKED');
    }
    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'edge.devices.control',
      factoryId,
    );

    const result = await this.database.transaction(
      async (client: PoolClient) => {
        const selected = await client.query<EdgeDeviceRow>(
          `
          SELECT ${DEVICE_COLUMNS}
          FROM edge_devices
          WHERE tenant_id = $1 AND factory_id = $2 AND id = $3
          FOR UPDATE
          `,
          [tenantId, factoryId, deviceId],
        );
        const current = selected.rows[0];
        if (!current) throw new NotFoundException('Edge device not found');

        if (current.status === input.status) {
          return { idempotent: true as const, device: this.mapDevice(current) };
        }
        if (current.status === EdgeDeviceStatus.REVOKED) {
          throw new ConflictException('A revoked edge device cannot be reactivated');
        }

        const updated = await client.query<EdgeDeviceRow>(
          `
          UPDATE edge_devices
          SET status = $4, status_changed_by = $5,
              status_changed_at = NOW(), updated_at = NOW()
          WHERE tenant_id = $1 AND factory_id = $2 AND id = $3
          RETURNING ${DEVICE_COLUMNS}
          `,
          [tenantId, factoryId, deviceId, input.status, actorUserId],
        );
        const row = updated.rows[0];
        if (!row) throw new NotFoundException('Edge device not found');
        return { idempotent: false as const, device: this.mapDevice(row) };
      },
      { tenantId, userId: actorUserId },
    );

    if (!result.idempotent) {
      await this.recordAuditSafely({
        tenantId,
        factoryId,
        actorUserId,
        eventType: 'EDGE_DEVICE_REGISTRY',
        action: 'CHANGE_STATUS',
        resourceType: 'EDGE_DEVICE',
        resourceId: deviceId,
        ...auditContext,
        payload: { status: result.device.status },
      });
    }
    return result;
  }

  async syncObservations(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    deviceId: string,
    input: SyncEdgeObservationsDto,
    auditContext: EdgeAuditContext = {},
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);
    this.validateUuid(deviceId, 'deviceId');
    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'edge.telemetry.ingest',
      factoryId,
    );

    const normalized = this.normalizeBatch(input);
    const requestHash = this.hash({
      tenantId,
      factoryId,
      deviceId,
      batchKey: normalized.batchKey,
      observations: normalized.observations,
    });

    const result = await this.database.transaction(
      async (client: PoolClient) => {
        const selectedDevice = await client.query<EdgeDeviceRow>(
          `
          SELECT ${DEVICE_COLUMNS}
          FROM edge_devices
          WHERE tenant_id = $1 AND factory_id = $2 AND id = $3
          FOR UPDATE
          `,
          [tenantId, factoryId, deviceId],
        );
        const device = selectedDevice.rows[0];
        if (!device) throw new NotFoundException('Edge device not found');

        const priorBatch = await client.query<EdgeSyncBatchRow>(
          `
          SELECT id::text AS id, batch_key, request_hash,
                 observations_received, observations_inserted,
                 observations_deduplicated, received_at::text AS received_at
          FROM edge_sync_batches
          WHERE tenant_id = $1 AND device_id = $2 AND batch_key = $3
          LIMIT 1
          `,
          [tenantId, deviceId, normalized.batchKey],
        );
        const prior = priorBatch.rows[0];
        if (prior) {
          if (prior.request_hash !== requestHash) {
            throw new ConflictException(
              'The batch key was already used with different observation content',
            );
          }
          return {
            idempotent: true as const,
            summary: this.mapSyncSummary(prior),
          };
        }

        if (device.status !== EdgeDeviceStatus.ACTIVE) {
          throw new ForbiddenException(
            `Edge device is ${device.status.toLowerCase()} and cannot ingest new observations`,
          );
        }

        let insertedCount = 0;
        let deduplicatedCount = 0;
        for (const observation of normalized.observations) {
          const itemHash = this.hash({
            tenantId,
            factoryId,
            deviceId,
            ...observation,
          });
          const payloadHash = this.hash(observation.payload);
          const inserted = await client.query<{ id: string }>(
            `
            INSERT INTO edge_observations (
              tenant_id, factory_id, device_id, event_id, signal_key,
              observed_at, source_mode, quality, payload, payload_hash,
              request_hash, recorded_by
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12
            )
            ON CONFLICT (tenant_id, device_id, event_id) DO NOTHING
            RETURNING id::text AS id
            `,
            [
              tenantId,
              factoryId,
              deviceId,
              observation.eventId,
              observation.signalKey,
              observation.observedAt,
              observation.sourceMode,
              observation.quality,
              JSON.stringify(observation.payload),
              payloadHash,
              itemHash,
              actorUserId,
            ],
          );

          if (inserted.rows[0]) {
            insertedCount += 1;
            continue;
          }

          const existingResult = await client.query<{ request_hash: string }>(
            `
            SELECT request_hash
            FROM edge_observations
            WHERE tenant_id = $1 AND device_id = $2 AND event_id = $3
            LIMIT 1
            `,
            [tenantId, deviceId, observation.eventId],
          );
          const existing = existingResult.rows[0];
          if (!existing || existing.request_hash !== itemHash) {
            throw new ConflictException(
              'An edge event ID was replayed with different observation content',
            );
          }
          deduplicatedCount += 1;
        }

        const batchResult = await client.query<EdgeSyncBatchRow>(
          `
          INSERT INTO edge_sync_batches (
            tenant_id, factory_id, device_id, batch_key, request_hash,
            observations_received, observations_inserted,
            observations_deduplicated, recorded_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING id::text AS id, batch_key, request_hash,
                    observations_received, observations_inserted,
                    observations_deduplicated, received_at::text AS received_at
          `,
          [
            tenantId,
            factoryId,
            deviceId,
            normalized.batchKey,
            requestHash,
            normalized.observations.length,
            insertedCount,
            deduplicatedCount,
            actorUserId,
          ],
        );
        const batch = batchResult.rows[0];
        if (!batch) throw new Error('EDGE_SYNC_BATCH_INSERT_FAILED');

        await client.query(
          `
          UPDATE edge_devices
          SET last_seen_at = NOW(), last_sync_at = NOW(), updated_at = NOW()
          WHERE tenant_id = $1 AND factory_id = $2 AND id = $3
          `,
          [tenantId, factoryId, deviceId],
        );

        return {
          idempotent: false as const,
          summary: this.mapSyncSummary(batch),
        };
      },
      { tenantId, userId: actorUserId },
    );

    if (!result.idempotent) {
      await this.recordAuditSafely({
        tenantId,
        factoryId,
        actorUserId,
        eventType: 'EDGE_TELEMETRY_SYNC',
        action: 'INGEST_BATCH',
        resourceType: 'EDGE_DEVICE',
        resourceId: deviceId,
        ...auditContext,
        payload: {
          batchKeyHash: this.hash(normalized.batchKey),
          batchRequestHash: requestHash,
          observationsReceived: result.summary.observationsReceived,
          observationsInserted: result.summary.observationsInserted,
          observationsDeduplicated: result.summary.observationsDeduplicated,
        },
      });
    }
    return result;
  }

  async listObservations(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    deviceId: string,
    limit = 25,
    offset = 0,
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);
    this.validateUuid(deviceId, 'deviceId');
    this.validatePagination(limit, offset);
    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'edge.telemetry.read',
      factoryId,
    );

    const device = await this.database.query<{ id: string }>(
      `
      SELECT id::text AS id FROM edge_devices
      WHERE tenant_id = $1 AND factory_id = $2 AND id = $3 LIMIT 1
      `,
      [tenantId, factoryId, deviceId],
      { tenantId, userId: actorUserId },
    );
    if (!device.rows[0]) throw new NotFoundException('Edge device not found');

    const result = await this.database.query<QueryResultRow & {
      id: string;
      event_id: string;
      signal_key: string;
      observed_at: string;
      source_mode: EdgeObservationSourceMode;
      quality: EdgeObservationQuality;
      payload: Record<string, unknown>;
      payload_hash: string;
      ingested_at: string;
    }>(
      `
      SELECT id::text AS id, event_id::text AS event_id, signal_key,
             observed_at::text AS observed_at, source_mode, quality, payload,
             payload_hash, ingested_at::text AS ingested_at
      FROM edge_observations
      WHERE tenant_id = $1 AND factory_id = $2 AND device_id = $3
      ORDER BY observed_at DESC, id DESC
      LIMIT $4 OFFSET $5
      `,
      [tenantId, factoryId, deviceId, limit + 1, offset],
      { tenantId, userId: actorUserId },
    );
    const hasMore = result.rows.length > limit;
    return {
      limit,
      offset,
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
      observations: result.rows.slice(0, limit).map((row) => ({
        id: row.id,
        eventId: row.event_id,
        signalKey: row.signal_key,
        observedAt: row.observed_at,
        sourceMode: row.source_mode,
        quality: row.quality,
        payload: row.payload,
        payloadHash: row.payload_hash,
        ingestedAt: row.ingested_at,
      })),
    };
  }

  private normalizeDevice(input: RegisterEdgeDeviceDto) {
    const deviceKey = this.requiredString(input?.device_key, 'device_key', 100);
    if (!DEVICE_KEY_PATTERN.test(deviceKey)) {
      throw new BadRequestException('device_key contains unsupported characters');
    }
    const displayName = this.requiredString(input?.display_name, 'display_name', 180);
    if (!Object.values(EdgeDeviceProtocol).includes(input?.protocol)) {
      throw new BadRequestException('protocol must be OPC_UA, MQTT, MODBUS, or GENERIC');
    }
    let deviceGroup: string | null = null;
    if (input.device_group !== undefined) {
      deviceGroup = this.requiredString(input.device_group, 'device_group', 120);
      if (!DEVICE_GROUP_PATTERN.test(deviceGroup)) {
        throw new BadRequestException('device_group contains unsupported characters');
      }
    }
    const capabilityProfile = this.normalizeJsonObject(
      input.capability_profile ?? {},
      'capability_profile',
      4096,
    );
    return {
      deviceKey,
      displayName,
      protocol: input.protocol,
      deviceGroup,
      capabilityProfile,
    };
  }

  private normalizeBatch(input: SyncEdgeObservationsDto) {
    const batchKey = this.requiredString(input?.batch_key, 'batch_key', 128);
    if (!IDEMPOTENCY_KEY_PATTERN.test(batchKey)) {
      throw new BadRequestException('batch_key contains unsupported characters');
    }
    if (
      !Array.isArray(input?.observations) ||
      input.observations.length < 1 ||
      input.observations.length > 100
    ) {
      throw new BadRequestException('observations must contain between 1 and 100 items');
    }

    const seenEventIds = new Set<string>();
    const observations = input.observations.map((item, index) => {
      const observation = item as EdgeObservationDto;
      const eventId = String(observation?.event_id ?? '').trim().toLowerCase();
      this.validateUuid(eventId, `observations[${index}].event_id`);
      if (seenEventIds.has(eventId)) {
        throw new BadRequestException('An event_id may appear only once per batch');
      }
      seenEventIds.add(eventId);

      const signalKey = this.requiredString(
        observation.signal_key,
        `observations[${index}].signal_key`,
        120,
      );
      if (!SIGNAL_KEY_PATTERN.test(signalKey)) {
        throw new BadRequestException(`observations[${index}].signal_key contains unsupported characters`);
      }
      const observedTimestamp = Date.parse(observation.observed_at);
      if (!Number.isFinite(observedTimestamp)) {
        throw new BadRequestException(`observations[${index}].observed_at must be a valid ISO date`);
      }
      if (!Object.values(EdgeObservationSourceMode).includes(observation.source_mode)) {
        throw new BadRequestException(`observations[${index}].source_mode is invalid`);
      }
      if (!Object.values(EdgeObservationQuality).includes(observation.quality)) {
        throw new BadRequestException(`observations[${index}].quality is invalid`);
      }
      const payload = this.normalizeJsonObject(
        observation.payload,
        `observations[${index}].payload`,
        4096,
      );
      return {
        eventId,
        signalKey,
        observedAt: new Date(observedTimestamp).toISOString(),
        sourceMode: observation.source_mode,
        quality: observation.quality,
        payload,
      } satisfies NormalizedObservation;
    });

    const encoded = this.canonicalJson({ batchKey, observations });
    if (Buffer.byteLength(encoded, 'utf8') > 64 * 1024) {
      throw new BadRequestException('The normalized observation batch exceeds 64 KiB');
    }
    return { batchKey, observations };
  }

  private normalizeJsonObject(
    value: unknown,
    field: string,
    maxBytes: number,
  ): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException(`${field} must be a JSON object`);
    }
    this.rejectCredentialFields(value, field);
    const encoded = this.canonicalJson(value);
    if (Buffer.byteLength(encoded, 'utf8') > maxBytes) {
      throw new BadRequestException(`${field} exceeds ${maxBytes} UTF-8 bytes`);
    }
    try {
      return JSON.parse(encoded) as Record<string, unknown>;
    } catch {
      throw new BadRequestException(`${field} must be valid JSON data`);
    }
  }

  private rejectCredentialFields(value: unknown, field: string): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        this.rejectCredentialFields(item, `${field}[${index}]`),
      );
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (CREDENTIAL_FIELD_PATTERN.test(key)) {
        throw new BadRequestException(`${field} must not contain credential material`);
      }
      this.rejectCredentialFields(child, `${field}.${key}`);
    }
  }

  private canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') {
      const encoded = JSON.stringify(value);
      if (encoded === undefined) {
        throw new BadRequestException('Value is not JSON serializable');
      }
      return encoded;
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.canonicalJson(item)).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${this.canonicalJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }

  private hash(value: unknown): string {
    return createHash('sha256').update(this.canonicalJson(value), 'utf8').digest('hex');
  }

  private validateScope(tenantId: string, factoryId: string, actorUserId: string) {
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');
    this.validateUuid(actorUserId, 'actorUserId');
  }

  private validateUuid(value: string, field: string): void {
    if (!isUUID(value)) throw new BadRequestException(`${field} must be a valid UUID`);
  }

  private requiredString(value: unknown, field: string, maxLength: number): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} is required`);
    }
    const normalized = value.trim();
    if (!normalized || normalized.length > maxLength) {
      throw new BadRequestException(`${field} must contain 1 to ${maxLength} characters`);
    }
    return normalized;
  }

  private validatePagination(limit: number, offset: number): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000) {
      throw new BadRequestException('offset must be an integer between 0 and 10000');
    }
  }

  private mapDevice(row: EdgeDeviceRow) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      factoryId: row.factory_id,
      deviceKey: row.device_key,
      displayName: row.display_name,
      protocol: row.protocol,
      deviceGroup: row.device_group,
      capabilityProfile: row.capability_profile ?? {},
      status: row.status,
      lastSeenAt: row.last_seen_at,
      lastSyncAt: row.last_sync_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapSyncSummary(row: EdgeSyncBatchRow): SyncSummary {
    return {
      id: row.id,
      batchKey: row.batch_key,
      observationsReceived: Number(row.observations_received),
      observationsInserted: Number(row.observations_inserted),
      observationsDeduplicated: Number(row.observations_deduplicated),
      receivedAt: row.received_at,
    };
  }

  private async recordAuditSafely(input: AuditEventInput): Promise<void> {
    try {
      await this.auditService.record(input);
    } catch {
      // Keep the durable domain transaction result intact if audit storage is unavailable.
      // The authorization guard separately records the permission decision.
    }
  }
}
