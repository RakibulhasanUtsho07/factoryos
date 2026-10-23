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
import {
  EdgeDeviceHealthReportDto,
  EdgeDriftSignalDto,
  EdgeDriftSeverity,
  EdgeDriftSignalType,
  EdgeRuntimeHealthStatus,
} from './dto/edge-device-health.dto';

interface HealthReportRow extends QueryResultRow {
  id: string;
  health_event_id: string;
  reported_at: string;
  agent_version: string;
  runtime_status: EdgeRuntimeHealthStatus;
  pending_batches: number;
  pending_bytes: string | number;
  last_successful_sync_at: string | null;
  model_versions: Record<string, string>;
  drift_signals: Array<Record<string, unknown>>;
  capabilities: Record<string, unknown>;
  received_at: string;
  request_hash: string;
}

interface DeviceStatusRow extends QueryResultRow {
  status: 'ACTIVE' | 'PAUSED' | 'REVOKED';
}

interface CredentialIdRow extends QueryResultRow {
  id: string;
}

interface EdgeHealthAuditContext {
  requestId?: string | null;
  correlationId?: string | null;
}

export interface NormalizedEdgeHealthReport {
  healthEventId: string;
  reportedAt: string;
  agentVersion: string;
  runtimeStatus: EdgeRuntimeHealthStatus;
  pendingBatches: number;
  pendingBytes: number;
  lastSuccessfulSyncAt: string | null;
  modelVersions: Record<string, string>;
  driftSignals: Array<Record<string, unknown>>;
  capabilities: Record<string, unknown>;
}

const HEALTH_REPORT_COLUMNS = `
  id::text AS id,
  health_event_id::text AS health_event_id,
  reported_at::text AS reported_at,
  agent_version,
  runtime_status,
  pending_batches,
  pending_bytes::text AS pending_bytes,
  last_successful_sync_at::text AS last_successful_sync_at,
  model_versions,
  drift_signals,
  capabilities,
  received_at::text AS received_at,
  request_hash
`;

const MODEL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;
const AGENT_VERSION_PATTERN = VERSION_PATTERN;
const CREDENTIAL_FIELD_PATTERN =
  /(?:secret|password|credential|private.?key|api.?key|api.?token|access.?token|refresh.?token|authorization|bearer)/i;
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

@Injectable()
export class EdgeDeviceHealthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
  ) {}

  async recordReport(
    tenantId: string,
    factoryId: string,
    deviceId: string,
    credentialId: string,
    input: EdgeDeviceHealthReportDto,
    auditContext: EdgeHealthAuditContext = {},
  ) {
    this.validateScope(tenantId, factoryId, deviceId, credentialId);
    const normalized = this.normalizeReport(input);
    const requestHash = this.hash({
      tenantId,
      factoryId,
      deviceId,
      ...normalized,
    });

    const result = await this.database.transaction(
      async (client: PoolClient) => {
        const selectedDevice = await client.query<DeviceStatusRow>(
          `
          SELECT status
          FROM edge_devices
          WHERE tenant_id = $1 AND factory_id = $2 AND id = $3
          FOR UPDATE
          `,
          [tenantId, factoryId, deviceId],
        );
        const device = selectedDevice.rows[0];
        if (!device) throw new NotFoundException('Edge device not found');
        if (device.status !== 'ACTIVE') {
          throw new ForbiddenException('Only active edge devices may report health');
        }

        const activeCredential = await client.query<CredentialIdRow>(
          `
          SELECT id::text AS id
          FROM edge_device_credentials
          WHERE tenant_id = $1 AND factory_id = $2 AND device_id = $3
            AND id = $4 AND status = 'ACTIVE' AND expires_at > NOW()
          FOR UPDATE
          `,
          [tenantId, factoryId, deviceId, credentialId],
        );
        if (!activeCredential.rows[0]) {
          throw new ForbiddenException('Device credential was revoked or expired before health report completed');
        }

        const priorResult = await client.query<HealthReportRow>(
          `
          SELECT ${HEALTH_REPORT_COLUMNS}
          FROM edge_device_health_reports
          WHERE tenant_id = $1 AND device_id = $2 AND health_event_id = $3
          LIMIT 1
          `,
          [tenantId, deviceId, normalized.healthEventId],
        );
        const prior = priorResult.rows[0];
        if (prior) {
          if (prior.request_hash !== requestHash) {
            throw new ConflictException('The health event ID was already used with different content');
          }
          await this.touchDevice(client, tenantId, factoryId, deviceId);
          return { idempotent: true as const, report: this.mapReport(prior) };
        }

        const inserted = await client.query<HealthReportRow>(
          `
          INSERT INTO edge_device_health_reports (
            tenant_id, factory_id, device_id, credential_id, health_event_id,
            reported_at, agent_version, runtime_status, pending_batches,
            pending_bytes, last_successful_sync_at, model_versions, drift_signals,
            capabilities, request_hash
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
            $12::jsonb, $13::jsonb, $14::jsonb, $15
          )
          ON CONFLICT (tenant_id, device_id, health_event_id) DO NOTHING
          RETURNING ${HEALTH_REPORT_COLUMNS}
          `,
          [
            tenantId,
            factoryId,
            deviceId,
            credentialId,
            normalized.healthEventId,
            normalized.reportedAt,
            normalized.agentVersion,
            normalized.runtimeStatus,
            normalized.pendingBatches,
            normalized.pendingBytes,
            normalized.lastSuccessfulSyncAt,
            JSON.stringify(normalized.modelVersions),
            JSON.stringify(normalized.driftSignals),
            JSON.stringify(normalized.capabilities),
            requestHash,
          ],
        );

        let row = inserted.rows[0];
        if (!row) {
          const raced = await client.query<HealthReportRow>(
            `
            SELECT ${HEALTH_REPORT_COLUMNS}
            FROM edge_device_health_reports
            WHERE tenant_id = $1 AND device_id = $2 AND health_event_id = $3
            LIMIT 1
            `,
            [tenantId, deviceId, normalized.healthEventId],
          );
          row = raced.rows[0];
          if (!row || row.request_hash !== requestHash) {
            throw new ConflictException('The health event ID was concurrently used with different content');
          }
          await this.touchDevice(client, tenantId, factoryId, deviceId);
          return { idempotent: true as const, report: this.mapReport(row) };
        }

        await this.touchDevice(client, tenantId, factoryId, deviceId);
        return { idempotent: false as const, report: this.mapReport(row) };
      },
      { tenantId, userId: null },
    );

    if (!result.idempotent) {
      await this.recordAuditSafely({
        tenantId,
        factoryId,
        actorUserId: null,
        eventType: 'EDGE_DEVICE_HEALTH',
        action: 'REPORT_HEALTH',
        resourceType: 'EDGE_DEVICE',
        resourceId: deviceId,
        ...auditContext,
        payload: {
          healthEventId: result.report.healthEventId,
          runtimeStatus: result.report.runtimeStatus,
          pendingBatches: result.report.pendingBatches,
          pendingBytes: result.report.pendingBytes,
          modelCount: Object.keys(result.report.modelVersions).length,
          driftSignalCount: result.report.driftSignals.length,
        },
      });
    }
    return result;
  }

  async listReports(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    deviceId: string,
    limit = 25,
    offset = 0,
  ) {
    this.validateScope(tenantId, factoryId, deviceId, actorUserId);
    this.validatePagination(limit, offset);
    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'edge.devices.health.read',
      factoryId,
    );

    const device = await this.database.query<{ id: string }>(
      `
      SELECT id::text AS id
      FROM edge_devices
      WHERE tenant_id = $1 AND factory_id = $2 AND id = $3
      LIMIT 1
      `,
      [tenantId, factoryId, deviceId],
      { tenantId, userId: actorUserId },
    );
    if (!device.rows[0]) throw new NotFoundException('Edge device not found');

    const result = await this.database.query<HealthReportRow>(
      `
      SELECT ${HEALTH_REPORT_COLUMNS}
      FROM edge_device_health_reports
      WHERE tenant_id = $1 AND factory_id = $2 AND device_id = $3
      ORDER BY received_at DESC, id DESC
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
      reports: result.rows.slice(0, limit).map((row) => this.mapReport(row)),
    };
  }

  private async touchDevice(
    client: PoolClient,
    tenantId: string,
    factoryId: string,
    deviceId: string,
  ): Promise<void> {
    await client.query(
      `
      UPDATE edge_devices
      SET last_seen_at = NOW(), updated_at = NOW()
      WHERE tenant_id = $1 AND factory_id = $2 AND id = $3
      `,
      [tenantId, factoryId, deviceId],
    );
  }

  private normalizeReport(input: EdgeDeviceHealthReportDto): NormalizedEdgeHealthReport {
    const healthEventId = String(input?.health_event_id ?? '').trim().toLowerCase();
    this.validateUuid(healthEventId, 'health_event_id');

    const reportedTimestamp = Date.parse(String(input?.reported_at ?? ''));
    if (!Number.isFinite(reportedTimestamp)) {
      throw new BadRequestException('reported_at must be a valid ISO date');
    }
    if (reportedTimestamp > Date.now() + 5 * 60_000) {
      throw new BadRequestException('reported_at cannot be more than five minutes in the future');
    }

    const agentVersion = this.requiredString(input?.agent_version, 'agent_version', 64);
    if (!AGENT_VERSION_PATTERN.test(agentVersion)) {
      throw new BadRequestException('agent_version contains unsupported characters');
    }
    if (!Object.values(EdgeRuntimeHealthStatus).includes(input?.runtime_status)) {
      throw new BadRequestException('runtime_status is invalid');
    }
    if (!Number.isInteger(input?.pending_batches) || input.pending_batches < 0 || input.pending_batches > 10000) {
      throw new BadRequestException('pending_batches must be an integer between 0 and 10000');
    }
    if (!Number.isSafeInteger(input?.pending_bytes) || input.pending_bytes < 0 || input.pending_bytes > 4294967296) {
      throw new BadRequestException('pending_bytes must be an integer between 0 and 4294967296');
    }

    let lastSuccessfulSyncAt: string | null = null;
    if (input.last_successful_sync_at !== undefined && input.last_successful_sync_at !== null) {
      const syncTimestamp = Date.parse(input.last_successful_sync_at);
      if (!Number.isFinite(syncTimestamp) || syncTimestamp > reportedTimestamp + 5 * 60_000) {
        throw new BadRequestException('last_successful_sync_at must be a valid time no later than the report clock tolerance');
      }
      lastSuccessfulSyncAt = new Date(syncTimestamp).toISOString();
    }

    const modelVersions = this.normalizeModelVersions(input?.model_versions);
    const driftSignals = this.normalizeDriftSignals(input?.drift_signals, modelVersions);
    const capabilities = this.normalizeObject(input?.capabilities, 'capabilities', 8192);
    return {
      healthEventId,
      reportedAt: new Date(reportedTimestamp).toISOString(),
      agentVersion,
      runtimeStatus: input.runtime_status,
      pendingBatches: input.pending_batches,
      pendingBytes: input.pending_bytes,
      lastSuccessfulSyncAt,
      modelVersions,
      driftSignals,
      capabilities,
    };
  }

  private normalizeModelVersions(value: unknown): Record<string, string> {
    if (!this.isRecord(value)) {
      throw new BadRequestException('model_versions must be a JSON object');
    }
    const entries = Object.entries(value);
    if (entries.length > 32) {
      throw new BadRequestException('model_versions may contain at most 32 model entries');
    }
    const normalized: Record<string, string> = {};
    for (const [key, rawVersion] of entries.sort(([a], [b]) => a.localeCompare(b))) {
      if (!MODEL_KEY_PATTERN.test(key) || CREDENTIAL_FIELD_PATTERN.test(key) || RESERVED_KEYS.has(key)) {
        throw new BadRequestException('model_versions contains an unsupported model key');
      }
      if (typeof rawVersion !== 'string' || !VERSION_PATTERN.test(rawVersion)) {
        throw new BadRequestException(`model_versions[${key}] must be a bounded version identifier`);
      }
      normalized[key] = rawVersion;
    }
    if (Buffer.byteLength(this.canonicalJson(normalized), 'utf8') > 8192) {
      throw new BadRequestException('model_versions exceeds 8192 UTF-8 bytes');
    }
    return normalized;
  }

  private normalizeDriftSignals(
    value: unknown,
    modelVersions: Record<string, string>,
  ): Array<Record<string, unknown>> {
    if (!Array.isArray(value) || value.length > 32) {
      throw new BadRequestException('drift_signals must contain between 0 and 32 items');
    }
    const seen = new Set<string>();
    const signals = value.map((entry, index) => {
      if (!this.isRecord(entry)) {
        throw new BadRequestException(`drift_signals[${index}] must be a JSON object`);
      }
      const allowed = new Set([
        'signal_id', 'model_key', 'signal_type', 'severity', 'detected_at',
        'observed_score', 'baseline_score',
      ]);
      if (Object.keys(entry).some((key) => !allowed.has(key))) {
        throw new BadRequestException(`drift_signals[${index}] contains unsupported fields`);
      }

      const signalId = String(entry.signal_id ?? '').trim().toLowerCase();
      this.validateUuid(signalId, `drift_signals[${index}].signal_id`);
      if (seen.has(signalId)) {
        throw new BadRequestException('A health report cannot contain duplicate drift signal IDs');
      }
      seen.add(signalId);

      const modelKey = this.requiredString(entry.model_key, `drift_signals[${index}].model_key`, 80);
      if (!MODEL_KEY_PATTERN.test(modelKey) || !Object.hasOwn(modelVersions, modelKey)) {
        throw new BadRequestException(`drift_signals[${index}].model_key must refer to a reported model version`);
      }
      if (!Object.values(EdgeDriftSignalType).includes(entry.signal_type as EdgeDriftSignalType)) {
        throw new BadRequestException(`drift_signals[${index}].signal_type is invalid`);
      }
      if (!Object.values(EdgeDriftSeverity).includes(entry.severity as EdgeDriftSeverity)) {
        throw new BadRequestException(`drift_signals[${index}].severity is invalid`);
      }
      const detectedTimestamp = Date.parse(String(entry.detected_at ?? ''));
      if (!Number.isFinite(detectedTimestamp) || detectedTimestamp > Date.now() + 5 * 60_000) {
        throw new BadRequestException(`drift_signals[${index}].detected_at is invalid`);
      }

      const normalized: Record<string, unknown> = {
        signal_id: signalId,
        model_key: modelKey,
        signal_type: entry.signal_type,
        severity: entry.severity,
        detected_at: new Date(detectedTimestamp).toISOString(),
      };
      for (const scoreKey of ['observed_score', 'baseline_score'] as const) {
        const score = entry[scoreKey];
        if (score === undefined) continue;
        if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
          throw new BadRequestException(`drift_signals[${index}].${scoreKey} must be between 0 and 1`);
        }
        normalized[scoreKey] = score;
      }
      return normalized;
    });
    if (Buffer.byteLength(this.canonicalJson(signals), 'utf8') > 16384) {
      throw new BadRequestException('drift_signals exceeds 16384 UTF-8 bytes');
    }
    return signals;
  }

  private normalizeObject(value: unknown, field: string, maxBytes: number): Record<string, unknown> {
    if (!this.isRecord(value)) throw new BadRequestException(`${field} must be a JSON object`);
    this.rejectCredentialFields(value, field);
    const canonical = this.canonicalJson(value);
    if (Buffer.byteLength(canonical, 'utf8') > maxBytes) {
      throw new BadRequestException(`${field} exceeds ${maxBytes} UTF-8 bytes`);
    }
    try {
      return JSON.parse(canonical) as Record<string, unknown>;
    } catch {
      throw new BadRequestException(`${field} must be valid JSON`);
    }
  }

  private rejectCredentialFields(value: unknown, field: string): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) => this.rejectCredentialFields(item, `${field}[${index}]`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (CREDENTIAL_FIELD_PATTERN.test(key) || RESERVED_KEYS.has(key)) {
        throw new BadRequestException(`${field} must not contain credential or reserved fields`);
      }
      this.rejectCredentialFields(child, `${field}.${key}`);
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    // class-transformer may supply nested EdgeDriftSignalDto instances at the API boundary.
    return prototype === Object.prototype || prototype === EdgeDriftSignalDto.prototype;
  }

  private canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') {
      const encoded = JSON.stringify(value);
      if (encoded === undefined) throw new BadRequestException('Value is not JSON serializable');
      return encoded;
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.canonicalJson(item)).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${this.canonicalJson(record[key])}`,
    );
    return `{${entries.join(',')}}`;
  }

  private hash(value: unknown): string {
    return createHash('sha256').update(this.canonicalJson(value), 'utf8').digest('hex');
  }

  private mapReport(row: HealthReportRow) {
    return {
      id: row.id,
      healthEventId: row.health_event_id,
      reportedAt: row.reported_at,
      receivedAt: row.received_at,
      agentVersion: row.agent_version,
      runtimeStatus: row.runtime_status,
      pendingBatches: Number(row.pending_batches),
      pendingBytes: Number(row.pending_bytes),
      lastSuccessfulSyncAt: row.last_successful_sync_at,
      modelVersions: row.model_versions ?? {},
      driftSignals: row.drift_signals ?? [],
      capabilities: row.capabilities ?? {},
    };
  }

  private validateUuid(value: string, field: string): void {
    if (!isUUID(value)) {
      throw new BadRequestException(`${field} must be a valid UUID`);
    }
  }

  private validateScope(...values: string[]): void {
    for (const [index, value] of values.entries()) {
      if (!isUUID(value)) {
        const labels = ['tenantId', 'factoryId', 'deviceId', 'credentialId/actorUserId'];
        throw new BadRequestException(`${labels[index] ?? 'scope'} must be a valid UUID`);
      }
    }
  }

  private validatePagination(limit: number, offset: number): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000) {
      throw new BadRequestException('offset must be an integer between 0 and 10000');
    }
  }

  private requiredString(value: unknown, field: string, maxLength: number): string {
    if (typeof value !== 'string') throw new BadRequestException(`${field} is required`);
    const normalized = value.trim();
    if (!normalized || normalized.length > maxLength) {
      throw new BadRequestException(`${field} must contain 1 to ${maxLength} characters`);
    }
    return normalized;
  }

  private async recordAuditSafely(input: AuditEventInput): Promise<void> {
    try {
      await this.auditService.record(input);
    } catch {
      // Health data is already durable; audit must not leak report payloads or tokens.
    }
  }
}
