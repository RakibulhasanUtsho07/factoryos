import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { randomUUID } from 'node:crypto';
import type { QueryResultRow, PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import {
  canonicalOtJson,
  classifyOtSequence,
  hashOtValue,
  normalizeOtObject,
  getAllowedOpcUaNodeIds,
  validateOpcUaNodeId,
} from './ot-device.contract';
import type { IngestOtTelemetryBatchDto, OtDeviceTransitionDto, RegisterOtDeviceDto, ReadOpcUaNodesDto } from './dto/ot-device.dto';
import { OpcUaGatewayClient } from './opcua-gateway.client';
import { ModbusGatewayClient } from './modbus-gateway.client';
import { getModbusTcpProfile, getMqttProfile, normalizeMqttTelemetryMessage } from './ot-protocol.contract';

export interface OtRequestScope {
  userId: string;
  tenantId: string;
  factoryId: string;
}

type DeviceStatus = 'PENDING_REVIEW' | 'ACTIVE' | 'PAUSED' | 'REVOKED';
type DeviceTransition = 'ACTIVATE' | 'PAUSE' | 'REVOKE';

interface OtDeviceRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  display_name: string;
  device_key: string;
  protocol: string;
  connection_reference: string;
  metadata: Record<string, unknown>;
  status: DeviceStatus;
  row_version: number;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  paused_at: string | null;
  revoked_at: string | null;
  request_hash?: string;
}

const DEVICE_SELECT = `
  id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id,
  display_name, device_key, protocol, connection_reference, metadata, status,
  row_version, created_at, updated_at, reviewed_at, paused_at, revoked_at
`;

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

const DEVICE_STATUSES: readonly DeviceStatus[] = [
  'PENDING_REVIEW', 'ACTIVE', 'PAUSED', 'REVOKED',
];

@Injectable()
export class OtDeviceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly opcUaGateway: OpcUaGatewayClient,
    private readonly modbusGateway: ModbusGatewayClient,
  ) {}

  async register(scope: OtRequestScope, dto: RegisterOtDeviceDto, rawIdempotencyKey?: string) {
    this.validateScope(scope);
    const idempotencyKey = rawIdempotencyKey?.trim() ?? '';
    if (!idempotencyKey || idempotencyKey.length > 200 || hasControlCharacters(idempotencyKey)) {
      throw new BadRequestException('A valid Idempotency-Key header of 1 to 200 characters is required');
    }
    const metadata = this.normalizeObject(dto.metadata ?? {}, 'metadata');
    try {
      if (dto.protocol === 'OPC_UA') getAllowedOpcUaNodeIds(metadata);
      if (dto.protocol === 'MQTT') getMqttProfile(metadata);
      if (dto.protocol === 'MODBUS_TCP') getModbusTcpProfile(metadata);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid OT protocol profile');
    }
    const request = {
      display_name: dto.display_name.trim(),
      device_key: dto.device_key.trim(),
      protocol: dto.protocol,
      connection_reference: dto.connection_reference,
      secret_reference: dto.secret_reference,
      metadata,
    };
    const requestHash = hashOtValue(request);

    try {
      return await this.database.transaction(async (client) => {
        const existing = await client.query<OtDeviceRow & { request_hash: string }>(
          `SELECT ${DEVICE_SELECT}, request_hash FROM ot_devices
           WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE`,
          [scope.tenantId, scope.factoryId, idempotencyKey],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].request_hash !== requestHash) {
            throw new ConflictException('Idempotency-Key was already used for a different OT device registration');
          }
          return this.presentDevice(existing.rows[0]);
        }

        const inserted = await client.query<OtDeviceRow>(
          `INSERT INTO ot_devices (
             tenant_id, factory_id, display_name, device_key, protocol,
             connection_reference, secret_reference, metadata, idempotency_key,
             request_hash, created_by_user_id, updated_by_user_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$11)
           RETURNING ${DEVICE_SELECT}`,
          [
            scope.tenantId, scope.factoryId, request.display_name, request.device_key,
            request.protocol, request.connection_reference, request.secret_reference,
            JSON.stringify(metadata), idempotencyKey, requestHash, scope.userId,
          ],
        );
        const device = inserted.rows[0];
        await this.appendHistory(client, scope, device, 'REGISTERED', null, {
          protocol: device.protocol,
          request_hash: requestHash,
        });
        return this.presentDevice(device);
      }, {
        tenantId: scope.tenantId,
        userId: scope.userId,
        advisoryLockKey: `ot-device-registration:${scope.tenantId}:${scope.factoryId}:${idempotencyKey}`,
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException('The OT device key or idempotency key is already registered in this factory');
      }
      throw error;
    }
  }

  async listDevices(
    scope: OtRequestScope,
    filters: { status?: string; protocol?: string } = {},
  ) {
    this.validateScope(scope);
    const status = filters.status?.trim().toUpperCase() || null;
    const protocol = filters.protocol?.trim().toUpperCase() || null;
    if (status && !DEVICE_STATUSES.includes(status as DeviceStatus)) {
      throw new BadRequestException('Unsupported OT device status');
    }
    if (protocol && !['OPC_UA', 'MQTT', 'MODBUS_TCP'].includes(protocol)) {
      throw new BadRequestException('Unsupported OT protocol');
    }
    const result = await this.database.query<OtDeviceRow>(
      `SELECT ${DEVICE_SELECT} FROM ot_devices
       WHERE tenant_id=$1 AND factory_id=$2
         AND ($3::text IS NULL OR status=$3)
         AND ($4::text IS NULL OR protocol=$4)
       ORDER BY created_at DESC, id DESC LIMIT 200`,
      [scope.tenantId, scope.factoryId, status, protocol],
      { tenantId: scope.tenantId, userId: scope.userId },
    );
    return { items: result.rows.map((row) => this.presentDevice(row)), limit: 200 };
  }

  async getDevice(scope: OtRequestScope, deviceId: string) {
    this.validateScope(scope);
    this.validateUuid(deviceId, 'deviceId');
    const result = await this.database.query<OtDeviceRow>(
      `SELECT ${DEVICE_SELECT} FROM ot_devices
       WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
      [deviceId, scope.tenantId, scope.factoryId],
      { tenantId: scope.tenantId, userId: scope.userId },
    );
    if (!result.rows[0]) throw new NotFoundException('OT device not found');
    return this.presentDevice(result.rows[0]);
  }

  async listHistory(scope: OtRequestScope, deviceId: string) {
    this.validateScope(scope);
    this.validateUuid(deviceId, 'deviceId');
    const result = await this.database.query(
      `SELECT h.id::text AS id, h.device_id::text AS device_id, h.actor_user_id::text AS actor_user_id,
              h.action, h.reason, h.row_version, h.metadata, h.occurred_at
       FROM ot_device_history h
       JOIN ot_devices d ON d.id=h.device_id AND d.tenant_id=h.tenant_id AND d.factory_id=h.factory_id
       WHERE h.tenant_id=$1 AND h.factory_id=$2 AND h.device_id=$3
       ORDER BY h.occurred_at DESC, h.id DESC LIMIT 200`,
      [scope.tenantId, scope.factoryId, deviceId],
      { tenantId: scope.tenantId, userId: scope.userId },
    );
    return { items: result.rows, limit: 200 };
  }

  async transition(
    scope: OtRequestScope,
    deviceId: string,
    transition: DeviceTransition,
    dto: OtDeviceTransitionDto,
  ) {
    this.validateScope(scope);
    this.validateUuid(deviceId, 'deviceId');
    const reason = dto.reason?.trim() ?? '';
    if (reason.length < 3 || reason.length > 500) {
      throw new BadRequestException('A transition reason of 3 to 500 characters is required');
    }
    if (!Number.isInteger(dto.expected_version) || dto.expected_version < 1) {
      throw new BadRequestException('expected_version must be a positive integer');
    }

    return this.database.transaction(async (client) => {
      const currentResult = await client.query<OtDeviceRow>(
        `SELECT ${DEVICE_SELECT} FROM ot_devices
         WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE`,
        [deviceId, scope.tenantId, scope.factoryId],
      );
      const current = currentResult.rows[0];
      if (!current) throw new NotFoundException('OT device not found');
      if (current.row_version !== dto.expected_version) {
        throw new ConflictException('OT device version is stale; read the current device and retry deliberately');
      }

      let target: DeviceStatus;
      let historyAction: string;
      if (transition === 'ACTIVATE') {
        if (current.status === 'PENDING_REVIEW') {
          target = 'ACTIVE';
          historyAction = 'ACTIVATED';
        } else if (current.status === 'PAUSED') {
          target = 'ACTIVE';
          historyAction = 'RESUMED';
        } else {
          throw new ConflictException('Only pending or paused OT devices can be activated');
        }
      } else if (transition === 'PAUSE') {
        if (current.status !== 'ACTIVE') throw new ConflictException('Only active OT devices can be paused');
        target = 'PAUSED';
        historyAction = 'PAUSED';
      } else {
        if (current.status === 'REVOKED') throw new ConflictException('A revoked OT device cannot be changed');
        target = 'REVOKED';
        historyAction = 'REVOKED';
      }

      const updatedResult = await client.query<OtDeviceRow>(
        `UPDATE ot_devices SET
           status=$4,
           row_version=row_version+1,
           updated_by_user_id=$5,
           updated_at=clock_timestamp(),
           reviewed_by_user_id=CASE WHEN $4='ACTIVE' THEN $5 ELSE reviewed_by_user_id END,
           reviewed_at=CASE WHEN $4='ACTIVE' THEN clock_timestamp() ELSE reviewed_at END,
           paused_at=CASE WHEN $4='PAUSED' THEN clock_timestamp() WHEN $4='ACTIVE' THEN NULL ELSE paused_at END,
           revoked_by_user_id=CASE WHEN $4='REVOKED' THEN $5 ELSE revoked_by_user_id END,
           revoked_at=CASE WHEN $4='REVOKED' THEN clock_timestamp() ELSE revoked_at END,
           revocation_reason=CASE WHEN $4='REVOKED' THEN $6 ELSE revocation_reason END
         WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 AND row_version=$7
         RETURNING ${DEVICE_SELECT}`,
        [
          deviceId, scope.tenantId, scope.factoryId, target, scope.userId, reason,
          dto.expected_version,
        ],
      );
      const updated = updatedResult.rows[0];
      if (!updated) throw new ConflictException('OT device changed concurrently; transition was not applied');
      await this.appendHistory(client, scope, updated, historyAction, reason, {
        previous_status: current.status,
        resulting_status: target,
      });
      return this.presentDevice(updated);
    }, {
      tenantId: scope.tenantId,
      userId: scope.userId,
      advisoryLockKey: `ot-device-transition:${scope.tenantId}:${scope.factoryId}:${deviceId}`,
    });
  }

  async readOpcUaNodes(scope: OtRequestScope, deviceId: string, dto: ReadOpcUaNodesDto) {
    this.validateScope(scope);
    this.validateUuid(deviceId, 'deviceId');
    if (!Array.isArray(dto.node_ids) || dto.node_ids.length < 1 || dto.node_ids.length > 10) {
      throw new BadRequestException('OPC UA reads must request between 1 and 10 allowlisted NodeIds');
    }
    let nodeIds: string[];
    try {
      nodeIds = dto.node_ids.map(validateOpcUaNodeId);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid OPC UA NodeId');
    }
    if (new Set(nodeIds).size !== nodeIds.length) {
      throw new BadRequestException('An OPC UA read cannot repeat a NodeId');
    }

    const device = await this.getDevice(scope, deviceId);
    if (device.protocol !== 'OPC_UA') throw new BadRequestException('Only OPC UA devices support this endpoint');
    if (device.status !== 'ACTIVE') throw new ConflictException('OPC UA reads require an active device');
    let allowlist: string[];
    try {
      allowlist = getAllowedOpcUaNodeIds(device.metadata);
    } catch {
      throw new ConflictException('OPC UA device has no valid registered NodeId allowlist');
    }
    if (nodeIds.some((nodeId) => !allowlist.includes(nodeId))) {
      throw new BadRequestException('The request includes a NodeId outside the registered read allowlist');
    }

    const requestId = randomUUID();
    try {
      const read = await this.opcUaGateway.read({
        requestId, tenantId: scope.tenantId, factoryId: scope.factoryId,
        deviceId, deviceKey: device.device_key,
        connectionReference: device.connection_reference, nodeIds,
      });
      if (read.request_id !== requestId || read.values.length !== nodeIds.length) {
        throw new ConflictException('OPC UA gateway response did not match the read request');
      }
      await this.recordOpcUaReadHistory(scope, deviceId, device.row_version, 'OPCUA_READ_COMPLETED', {
        request_id: requestId,
        node_ids: nodeIds,
        good_count: read.values.filter((item) => item.status === 'GOOD').length,
        uncertain_count: read.values.filter((item) => item.status === 'UNCERTAIN').length,
        bad_count: read.values.filter((item) => item.status === 'BAD').length,
      }, true);
      return { device_id: deviceId, request_id: requestId, protocol: 'OPC_UA', read_only: true, values: read.values };
    } catch (error) {
      await this.recordOpcUaReadHistory(scope, deviceId, device.row_version, 'OPCUA_READ_FAILED', {
        request_id: requestId,
        node_count: nodeIds.length,
        failure_class: this.opcUaFailureClass(error),
      }, false);
      throw error;
    }
  }

  private async recordOpcUaReadHistory(
    scope: OtRequestScope,
    deviceId: string,
    expectedVersion: number,
    action: 'OPCUA_READ_COMPLETED' | 'OPCUA_READ_FAILED',
    metadata: Record<string, unknown>,
    requireActiveVersion: boolean,
  ): Promise<void> {
    await this.database.transaction(async (client) => {
      const result = await client.query<OtDeviceRow>(
        'SELECT ' + DEVICE_SELECT + ' FROM ot_devices WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
        [deviceId, scope.tenantId, scope.factoryId],
      );
      const current = result.rows[0];
      if (!current) throw new NotFoundException('OT device not found');
      if (requireActiveVersion && (current.status !== 'ACTIVE' || current.row_version !== expectedVersion)) {
        throw new ConflictException('OT device status changed during the OPC UA read; values were discarded');
      }
      await this.appendHistory(client, scope, current, action, null, metadata);
    }, {
      tenantId: scope.tenantId, userId: scope.userId,
      advisoryLockKey: 'ot-opcua-read:' + scope.tenantId + ':' + scope.factoryId + ':' + deviceId,
    });
  }

  private opcUaFailureClass(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'status' in error) {
      const status = (error as { status?: unknown }).status;
      if (status === 504) return 'GATEWAY_TIMEOUT';
      if (status === 502) return 'GATEWAY_RESPONSE_REJECTED';
      if (status === 503) return 'GATEWAY_UNAVAILABLE';
    }
    return error instanceof ConflictException ? 'DEVICE_STATE_CHANGED' : 'READ_FAILED';
  }


  async ingestMqttMessage(
    scope: OtRequestScope,
    deviceId: string,
    dto: { topic: string; message: Record<string, unknown> },
  ) {
    this.validateScope(scope);
    this.validateUuid(deviceId, 'deviceId');
    const device = await this.getDevice(scope, deviceId);
    if (device.protocol !== 'MQTT') throw new BadRequestException('Only MQTT devices support this endpoint');
    if (device.status !== 'ACTIVE') throw new ConflictException('MQTT ingestion requires an active device');

    try {
      getMqttProfile(device.metadata);
    } catch {
      throw new ConflictException('MQTT device has no valid registered topic allowlist');
    }
    let event: ReturnType<typeof normalizeMqttTelemetryMessage>;
    try {
      const bytes = Buffer.from(JSON.stringify(dto.message), 'utf8');
      event = normalizeMqttTelemetryMessage(dto.topic, bytes, device.metadata);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'MQTT message failed validation');
    }

    const result = await this.ingestTelemetry(scope, deviceId, {
      events: [{
        source_event_id: event.source_event_id,
        event_type: event.event_type,
        stream_key: event.stream_key,
        ...(event.source_sequence === null ? {} : { source_sequence: event.source_sequence }),
        observed_at: event.observed_at,
        payload: event.payload,
      }],
    });
    return {
      protocol: 'MQTT',
      accepted_topic: dto.topic,
      source_event_id: event.source_event_id,
      ...result,
    };
  }

  async readModbusRegisters(scope: OtRequestScope, deviceId: string, dto: { stream_keys: string[] }) {
    this.validateScope(scope);
    this.validateUuid(deviceId, 'deviceId');
    if (!Array.isArray(dto.stream_keys) || dto.stream_keys.length < 1 || dto.stream_keys.length > 10) {
      throw new BadRequestException('Modbus reads must request between 1 and 10 configured stream keys');
    }
    if (new Set(dto.stream_keys).size !== dto.stream_keys.length) {
      throw new BadRequestException('A Modbus read cannot repeat a stream key');
    }
    const device = await this.getDevice(scope, deviceId);
    if (device.protocol !== 'MODBUS_TCP') throw new BadRequestException('Only Modbus TCP devices support this endpoint');
    if (device.status !== 'ACTIVE') throw new ConflictException('Modbus reads require an active device');

    let profile: ReturnType<typeof getModbusTcpProfile>;
    try {
      profile = getModbusTcpProfile(device.metadata);
    } catch {
      throw new ConflictException('Modbus device has no valid registered register map');
    }
    const allowed = new Map(profile.register_map.map((item) => [item.stream_key, item]));
    const registerMap = dto.stream_keys.map((key) => {
      const definition = allowed.get(key);
      if (!definition) throw new BadRequestException('A requested stream key is outside the registered Modbus map');
      return definition;
    });
    const requestId = randomUUID();
    let read: Awaited<ReturnType<ModbusGatewayClient['read']>>;
    try {
      read = await this.modbusGateway.read({
        requestId,
        tenantId: scope.tenantId,
        factoryId: scope.factoryId,
        deviceId,
        deviceKey: device.device_key,
        connectionReference: device.connection_reference,
        unitId: profile.unit_id,
        registerMap,
      });
    } catch (error) {
      await this.recordProtocolHistory(scope, deviceId, device.row_version, 'MODBUS_READ_FAILED', {
        request_id: requestId,
        stream_keys: dto.stream_keys,
        failure_class: this.modbusFailureClass(error),
      }, false);
      throw error;
    }
    if (read.request_id !== requestId || read.values.length !== registerMap.length) {
      await this.recordProtocolHistory(scope, deviceId, device.row_version, 'MODBUS_READ_FAILED', {
        request_id: requestId, failure_class: 'GATEWAY_RESPONSE_REJECTED',
      }, false);
      throw new ConflictException('Modbus read gateway response did not match the read request');
    }

    const accepted = await this.ingestTelemetry(scope, deviceId, {
      events: read.values.map((value) => ({
        source_event_id: requestId + ':' + value.stream_key,
        event_type: 'MODBUS_REGISTER_SAMPLE',
        stream_key: value.stream_key,
        ...(value.source_sequence === null ? {} : { source_sequence: value.source_sequence }),
        observed_at: value.observed_at,
        payload: { value: value.value },
      })),
    });
    await this.recordProtocolHistory(scope, deviceId, device.row_version, 'MODBUS_READ_COMPLETED', {
      request_id: requestId,
      stream_keys: read.values.map((value) => value.stream_key),
      accepted: accepted.accepted,
      duplicate_replays: accepted.duplicate_replays,
    }, true);
    return {
      protocol: 'MODBUS_TCP',
      read_only: true,
      request_id: requestId,
      values: read.values,
      telemetry: accepted,
    };
  }

  private async recordProtocolHistory(
    scope: OtRequestScope,
    deviceId: string,
    expectedVersion: number,
    action: 'MODBUS_READ_COMPLETED' | 'MODBUS_READ_FAILED',
    metadata: Record<string, unknown>,
    requireActiveVersion: boolean,
  ): Promise<void> {
    await this.database.transaction(async (client) => {
      const result = await client.query<OtDeviceRow>(
        'SELECT ' + DEVICE_SELECT + ' FROM ot_devices WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
        [deviceId, scope.tenantId, scope.factoryId],
      );
      const current = result.rows[0];
      if (!current) throw new NotFoundException('OT device not found');
      if (requireActiveVersion && (current.status !== 'ACTIVE' || current.row_version !== expectedVersion)) {
        throw new ConflictException('OT device status changed during the Modbus read; values were not acknowledged');
      }
      await this.appendHistory(client, scope, current, action, null, metadata);
    }, {
      tenantId: scope.tenantId,
      userId: scope.userId,
      advisoryLockKey: 'ot-modbus-read:' + scope.tenantId + ':' + scope.factoryId + ':' + deviceId,
    });
  }

  private modbusFailureClass(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'status' in error) {
      const status = (error as { status?: unknown }).status;
      if (status === 504) return 'GATEWAY_TIMEOUT';
      if (status === 502) return 'GATEWAY_RESPONSE_REJECTED';
      if (status === 503) return 'GATEWAY_UNAVAILABLE';
    }
    return 'READ_FAILED';
  }

  async ingestTelemetry(
    scope: OtRequestScope,
    deviceId: string,
    dto: IngestOtTelemetryBatchDto,
  ) {
    this.validateScope(scope);
    this.validateUuid(deviceId, 'deviceId');
    if (!Array.isArray(dto.events) || dto.events.length < 1 || dto.events.length > 20) {
      throw new BadRequestException('Telemetry batches must contain between 1 and 20 events');
    }

    const events = dto.events.map((event) => {
      const payload = this.normalizeObject(event.payload, 'telemetry payload');
      if (Buffer.byteLength(canonicalOtJson(payload), 'utf8') > 4096) {
        throw new BadRequestException('A telemetry payload cannot exceed 4096 UTF-8 bytes');
      }
      const observedAt = new Date(event.observed_at);
      if (!Number.isFinite(observedAt.getTime())) {
        throw new BadRequestException('observed_at must be a valid ISO-8601 timestamp');
      }
      const sourceEventId = event.source_event_id?.trim() ?? '';
      const eventType = event.event_type?.trim() ?? '';
      const streamKey = event.stream_key?.trim() ?? '';
      const sourceSequence = event.source_sequence ?? null;
      if (!sourceEventId || sourceEventId.length > 200 || hasControlCharacters(sourceEventId)) {
        throw new BadRequestException('source_event_id must be 1 to 200 safe characters');
      }
      if (!/^[A-Z][A-Z0-9_.-]{0,99}$/.test(eventType)) {
        throw new BadRequestException('event_type has an invalid format');
      }
      if (!streamKey || streamKey.length > 160 || hasControlCharacters(streamKey)) {
        throw new BadRequestException('stream_key must be 1 to 160 safe characters');
      }
      if (sourceSequence !== null && (!Number.isSafeInteger(sourceSequence) || sourceSequence < 1)) {
        throw new BadRequestException('source_sequence must be a safe positive integer');
      }
      const canonicalObservedAt = observedAt.toISOString();
      return {
        sourceEventId,
        eventType,
        streamKey,
        sourceSequence,
        observedAt: canonicalObservedAt,
        payload,
        payloadHash: hashOtValue(payload),
        envelopeHash: hashOtValue({
          source_event_id: sourceEventId,
          event_type: eventType,
          stream_key: streamKey,
          source_sequence: sourceSequence,
          observed_at: canonicalObservedAt,
          payload,
        }),
      };
    });

    // Stable ordering makes the same replayed spool batch classify identically
    // even when transport retries send the item array in a different order.
    events.sort((left, right) => {
      if (left.streamKey !== right.streamKey) return left.streamKey < right.streamKey ? -1 : 1;
      if (left.sourceSequence === null && right.sourceSequence !== null) return 1;
      if (left.sourceSequence !== null && right.sourceSequence === null) return -1;
      if (left.sourceSequence !== null && right.sourceSequence !== null && left.sourceSequence !== right.sourceSequence) {
        return left.sourceSequence - right.sourceSequence;
      }
      if (left.observedAt !== right.observedAt) return left.observedAt < right.observedAt ? -1 : 1;
      return left.sourceEventId < right.sourceEventId ? -1 : left.sourceEventId > right.sourceEventId ? 1 : 0;
    });

    try {
      return await this.database.transaction(async (client) => {
        const deviceResult = await client.query<OtDeviceRow>(
          `SELECT ${DEVICE_SELECT} FROM ot_devices
           WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE`,
          [deviceId, scope.tenantId, scope.factoryId],
        );
        const device = deviceResult.rows[0];
        if (!device) throw new NotFoundException('OT device not found');
        if (device.status !== 'ACTIVE') {
          throw new ConflictException('Telemetry ingestion is permitted only for active OT devices');
        }

        const results: Array<Record<string, unknown>> = [];
        let accepted = 0;
        let late = 0;
        let gaps = 0;
        let replayed = 0;

        for (const event of events) {
          const existing = await client.query(
            `SELECT id::text AS id, event_fingerprint_sha256
             FROM ot_telemetry_events
             WHERE tenant_id=$1 AND factory_id=$2 AND device_id=$3 AND source_event_id=$4`,
            [scope.tenantId, scope.factoryId, deviceId, event.sourceEventId],
          );
          if (existing.rows[0]) {
            if (existing.rows[0].event_fingerprint_sha256 !== event.envelopeHash) {
              throw new ConflictException('A source_event_id was replayed with a different event fingerprint');
            }
            replayed += 1;
            results.push({
              source_event_id: event.sourceEventId,
              status: 'DUPLICATE_REPLAY',
              telemetry_event_id: existing.rows[0].id,
            });
            continue;
          }

          let lastSequence: number | null = null;
          if (event.sourceSequence !== null) {
            const sameSequence = await client.query(
              `SELECT source_event_id FROM ot_telemetry_events
               WHERE tenant_id=$1 AND factory_id=$2 AND device_id=$3
                 AND stream_key=$4 AND source_sequence=$5`,
              [scope.tenantId, scope.factoryId, deviceId, event.streamKey, event.sourceSequence],
            );
            if (sameSequence.rows[0]) {
              throw new ConflictException('A stream sequence was already accepted for a different event');
            }
            const cursor = await client.query(
              `SELECT last_source_sequence::text AS last_source_sequence FROM ot_device_stream_cursors
               WHERE tenant_id=$1 AND factory_id=$2 AND device_id=$3 AND stream_key=$4 FOR UPDATE`,
              [scope.tenantId, scope.factoryId, deviceId, event.streamKey],
            );
            lastSequence = cursor.rows[0] ? Number(cursor.rows[0].last_source_sequence) : null;
          }

          const deliveryStatus = classifyOtSequence(lastSequence, event.sourceSequence);
          const inserted = await client.query(
            `INSERT INTO ot_telemetry_events (
               tenant_id, factory_id, device_id, source_event_id, event_type,
               stream_key, source_sequence, observed_at, delivery_status, payload, payload_sha256, event_fingerprint_sha256
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9,$10::jsonb,$11,$12)
             RETURNING id::text AS id`,
            [
              scope.tenantId, scope.factoryId, deviceId, event.sourceEventId, event.eventType,
              event.streamKey, event.sourceSequence, event.observedAt, deliveryStatus,
              JSON.stringify(event.payload), event.payloadHash, event.envelopeHash,
            ],
          );
          if (event.sourceSequence !== null) {
            await client.query(
              `INSERT INTO ot_device_stream_cursors (
                 tenant_id, factory_id, device_id, stream_key, last_source_sequence
               ) VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (tenant_id, factory_id, device_id, stream_key) DO UPDATE
                 SET last_source_sequence=GREATEST(ot_device_stream_cursors.last_source_sequence, EXCLUDED.last_source_sequence),
                     updated_at=clock_timestamp()`,
              [scope.tenantId, scope.factoryId, deviceId, event.streamKey, event.sourceSequence],
            );
          }

          accepted += 1;
          if (deliveryStatus === 'LATE') late += 1;
          if (deliveryStatus === 'SEQUENCE_GAP') gaps += 1;
          results.push({
            source_event_id: event.sourceEventId,
            status: deliveryStatus,
            telemetry_event_id: inserted.rows[0]?.id,
          });
        }

        if (accepted > 0) {
          // Telemetry receipt is not a device lifecycle transition. Keep row_version
          // reserved for optimistic concurrency on registry status changes.
          await this.appendHistory(client, scope, device, 'TELEMETRY_BATCH_INGESTED', null, {
            accepted,
            late,
            sequence_gaps: gaps,
            duplicate_replays: replayed,
          });
        }
        return {
          device_id: deviceId,
          received: dto.events.length,
          accepted,
          duplicate_replays: replayed,
          late,
          sequence_gaps: gaps,
          items: results,
        };
      }, {
        tenantId: scope.tenantId,
        userId: scope.userId,
        advisoryLockKey: `ot-telemetry:${scope.tenantId}:${scope.factoryId}:${deviceId}`,
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException('Concurrent OT telemetry replay or sequence collision; retry the identical batch');
      }
      throw error;
    }
  }

  async listTelemetry(scope: OtRequestScope, deviceId: string, rawLimit?: string) {
    this.validateScope(scope);
    this.validateUuid(deviceId, 'deviceId');
    const limit = rawLimit === undefined ? 100 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new BadRequestException('limit must be an integer between 1 and 200');
    }
    await this.getDevice(scope, deviceId);
    const result = await this.database.query(
      `SELECT id::text AS id, source_event_id, event_type, stream_key,
              source_sequence::text AS source_sequence, observed_at, received_at,
              delivery_status, payload, payload_sha256
       FROM ot_telemetry_events
       WHERE tenant_id=$1 AND factory_id=$2 AND device_id=$3
       ORDER BY observed_at DESC, id DESC LIMIT $4`,
      [scope.tenantId, scope.factoryId, deviceId, limit],
      { tenantId: scope.tenantId, userId: scope.userId },
    );
    return { items: result.rows, limit };
  }

  private async appendHistory(
    client: PoolClient,
    scope: OtRequestScope,
    device: OtDeviceRow,
    action: string,
    reason: string | null,
    metadata: Record<string, unknown>,
  ) {
    await client.query(
      `INSERT INTO ot_device_history (
         tenant_id, factory_id, device_id, actor_user_id, action, reason, row_version, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [
        scope.tenantId, scope.factoryId, device.id, scope.userId, action,
        reason, device.row_version, JSON.stringify(metadata),
      ],
    );
  }

  private presentDevice(row: OtDeviceRow) {
    // Secret references and credentials are deliberately excluded from all API responses.
    return {
      id: row.id,
      display_name: row.display_name,
      device_key: row.device_key,
      protocol: row.protocol,
      connection_reference: row.connection_reference,
      metadata: row.metadata,
      status: row.status,
      row_version: row.row_version,
      created_at: row.created_at,
      updated_at: row.updated_at,
      reviewed_at: row.reviewed_at,
      paused_at: row.paused_at,
      revoked_at: row.revoked_at,
    };
  }

  private normalizeObject(value: unknown, label: string) {
    try {
      const normalized = normalizeOtObject(value, label);
      if (Buffer.byteLength(canonicalOtJson(normalized), 'utf8') > 4096) {
        throw new Error(label + ' cannot exceed 4096 UTF-8 bytes');
      }
      return normalized;
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : label + ' is invalid');
    }
  }

  private validateScope(scope: OtRequestScope) {
    this.validateUuid(scope.userId, 'userId');
    this.validateUuid(scope.tenantId, 'tenantId');
    this.validateUuid(scope.factoryId, 'factoryId');
  }

  private validateUuid(value: string, label: string) {
    if (!isUUID(value)) throw new BadRequestException(label + ' must be a valid UUID');
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: unknown }).code === '23505';
  }
}
