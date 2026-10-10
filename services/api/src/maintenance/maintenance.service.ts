import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';

import {
  type MaintenanceMachineStatus,
  type CreateMachineDto,
} from './dto/create-machine.dto';
import { ListMachinesDto } from './dto/list-machines.dto';
import { LogMachineDowntimeDto } from './dto/log-machine-downtime.dto';
import {
  type MachineDowntimeState,
  type ListMachineDowntimeDto,
} from './dto/list-machine-downtime.dto';

interface MachineRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  machine_code: string;
  machine_type: string;
  line_code: string;
  status: MaintenanceMachineStatus;
  notes: string | null;
  created_by_user_id: string;
  created_at: Date | string;
  updated_at: Date | string;
  version: number | string;
}

interface MachineDowntimeRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  machine_id: string;
  machine_code?: string;
  reason_code: string;
  description: string | null;
  started_at: Date | string;
  ended_at: Date | string | null;
  created_by_user_id: string;
  closed_by_user_id: string | null;
  created_at: Date | string;
  version: number | string;
}

interface CountRow extends QueryResultRow {
  total: number | string;
}

interface MachineStateRow extends QueryResultRow {
  id: string;
  status: MaintenanceMachineStatus;
}

@Injectable()
export class MaintenanceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * SRS v2.1 FR-MNT-01: keep the machine register scoped to the
   * authenticated tenant and the factory authorized by PermissionGuard.
   */
  async createMachine(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    input: CreateMachineDto,
    requestId: string | null,
    traceId: string | null,
  ): Promise<MachineRow> {
    this.validateScope(tenantId, factoryId, actorUserId);
    this.validateAuditContext(requestId, traceId);

    const machineCode = this.requiredText(
      input.machine_code,
      'machine_code',
      100,
    ).toUpperCase();
    const machineType = this.requiredText(
      input.machine_type,
      'machine_type',
      100,
    );
    const lineCode = this.requiredText(
      input.line_code,
      'line_code',
      100,
    );
    const status = input.status ?? 'ACTIVE';
    const notes = this.optionalText(input.notes, 'notes', 1000);

    let machine: MachineRow;
    try {
      machine = await this.database.transaction(
        async (client) => {
          const result = await client.query<MachineRow>(
            `
            INSERT INTO maintenance_machines (
              tenant_id,
              factory_id,
              machine_code,
              machine_type,
              line_code,
              status,
              notes,
              created_by_user_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING
              id,
              tenant_id,
              factory_id,
              machine_code,
              machine_type,
              line_code,
              status,
              notes,
              created_by_user_id,
              created_at,
              updated_at,
              version
            `,
            [
              tenantId,
              factoryId,
              machineCode,
              machineType,
              lineCode,
              status,
              notes,
              actorUserId,
            ],
          );

          const row = result.rows[0];
          if (!row) {
            throw new Error('MAINTENANCE_MACHINE_INSERT_FAILED');
          }

          return row;
        },
        { tenantId, userId: actorUserId },
      );
    } catch (error) {
      this.raiseUniqueConflict(error, 'A machine with this code already exists in this factory');
    }

    await this.auditService.record({
      tenantId,
      factoryId,
      actorUserId,
      eventType: 'maintenance.machine.created',
      action: 'CREATE',
      resourceType: 'maintenance_machine',
      resourceId: machine.id,
      requestId,
      correlationId: traceId,
      dataClass: 'OPERATIONAL',
      payload: {
        machine_code: machine.machine_code,
        machine_type: machine.machine_type,
        line_code: machine.line_code,
        status: machine.status,
      },
    });

    return machine;
  }

  async listMachines(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    input: ListMachinesDto,
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);

    const { page, limit, offset } = this.pagination(
      input.page,
      input.limit,
    );
    const status = input.status ?? null;
    const search = input.search?.trim() || null;

    return this.database.transaction(
      async (client) => {
        const filters = `
          tenant_id = $1
          AND factory_id = $2
          AND ($3::text IS NULL OR status = $3)
          AND (
            $4::text IS NULL
            OR POSITION(LOWER($4) IN LOWER(machine_code)) > 0
            OR POSITION(LOWER($4) IN LOWER(machine_type)) > 0
            OR POSITION(LOWER($4) IN LOWER(line_code)) > 0
          )
        `;
        const values = [tenantId, factoryId, status, search];

        const countResult = await client.query<CountRow>(
          `SELECT COUNT(*)::int AS total FROM maintenance_machines WHERE ${filters}`,
          values,
        );
        const result = await client.query<MachineRow>(
          `
          SELECT
            id,
            tenant_id,
            factory_id,
            machine_code,
            machine_type,
            line_code,
            status,
            notes,
            created_by_user_id,
            created_at,
            updated_at,
            version
          FROM maintenance_machines
          WHERE ${filters}
          ORDER BY machine_code ASC
          LIMIT $5 OFFSET $6
          `,
          [...values, limit, offset],
        );

        return {
          items: result.rows,
          page,
          limit,
          total: Number(countResult.rows[0]?.total ?? 0),
        };
      },
      { tenantId, userId: actorUserId },
    );
  }

  /**
   * A downtime start time is assigned by the server. Callers cannot
   * backdate or forge the operational timestamp through this endpoint.
   */
  async logDowntime(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    machineId: string,
    input: LogMachineDowntimeDto,
    requestId: string | null,
    traceId: string | null,
  ): Promise<MachineDowntimeRow> {
    this.validateScope(tenantId, factoryId, actorUserId);
    this.validateUuid(machineId, 'machineId');
    this.validateAuditContext(requestId, traceId);

    const reasonCode = this.requiredText(
      input.reason_code,
      'reason_code',
      100,
    ).toUpperCase();
    const description = this.optionalText(
      input.description,
      'description',
      1000,
    );

    let downtime: MachineDowntimeRow;
    try {
      downtime = await this.database.transaction(
        async (client) => {
          const machineResult = await client.query<MachineStateRow>(
            `
            SELECT id, status
            FROM maintenance_machines
            WHERE id = $1
              AND tenant_id = $2
              AND factory_id = $3
            FOR UPDATE
            `,
            [machineId, tenantId, factoryId],
          );
          const machine = machineResult.rows[0];

          if (!machine) {
            throw new NotFoundException('Machine was not found in this factory');
          }
          if (machine.status !== 'ACTIVE') {
            throw new ConflictException('Downtime can only be logged for an active machine');
          }

          const result = await client.query<MachineDowntimeRow>(
            `
            INSERT INTO machine_downtime_events (
              tenant_id,
              factory_id,
              machine_id,
              reason_code,
              description,
              created_by_user_id
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING
              id,
              tenant_id,
              factory_id,
              machine_id,
              reason_code,
              description,
              started_at,
              ended_at,
              created_by_user_id,
              closed_by_user_id,
              created_at,
              version
            `,
            [
              tenantId,
              factoryId,
              machineId,
              reasonCode,
              description,
              actorUserId,
            ],
          );

          const row = result.rows[0];
          if (!row) {
            throw new Error('MACHINE_DOWNTIME_INSERT_FAILED');
          }

          return row;
        },
        { tenantId, userId: actorUserId },
      );
    } catch (error) {
      this.raiseUniqueConflict(
        error,
        'This machine already has an open downtime event',
      );
    }

    await this.auditService.record({
      tenantId,
      factoryId,
      actorUserId,
      eventType: 'maintenance.machine.downtime.logged',
      action: 'CREATE',
      resourceType: 'machine_downtime_event',
      resourceId: downtime.id,
      requestId,
      correlationId: traceId,
      dataClass: 'OPERATIONAL',
      payload: {
        machine_id: machineId,
        reason_code: downtime.reason_code,
        started_at: downtime.started_at,
      },
    });

    return downtime;
  }

  async listDowntime(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    input: ListMachineDowntimeDto,
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);

    const { page, limit, offset } = this.pagination(
      input.page,
      input.limit,
    );
    const machineId = input.machine_id ?? null;
    if (machineId) {
      this.validateUuid(machineId, 'machine_id');
    }
    const state: MachineDowntimeState | null = input.state ?? null;

    return this.database.transaction(
      async (client) => {
        const filters = `
          d.tenant_id = $1
          AND d.factory_id = $2
          AND ($3::uuid IS NULL OR d.machine_id = $3)
          AND (
            $4::text IS NULL
            OR ($4::text = 'OPEN' AND d.ended_at IS NULL)
            OR ($4::text = 'CLOSED' AND d.ended_at IS NOT NULL)
          )
        `;
        const values = [tenantId, factoryId, machineId, state];

        const countResult = await client.query<CountRow>(
          `SELECT COUNT(*)::int AS total FROM machine_downtime_events d WHERE ${filters}`,
          values,
        );
        const result = await client.query<MachineDowntimeRow>(
          `
          SELECT
            d.id,
            d.tenant_id,
            d.factory_id,
            d.machine_id,
            m.machine_code,
            d.reason_code,
            d.description,
            d.started_at,
            d.ended_at,
            d.created_by_user_id,
            d.closed_by_user_id,
            d.created_at,
            d.version
          FROM machine_downtime_events d
          INNER JOIN maintenance_machines m
            ON m.id = d.machine_id
            AND m.tenant_id = d.tenant_id
            AND m.factory_id = d.factory_id
          WHERE ${filters}
          ORDER BY d.started_at DESC, d.id DESC
          LIMIT $5 OFFSET $6
          `,
          [...values, limit, offset],
        );

        return {
          items: result.rows,
          page,
          limit,
          total: Number(countResult.rows[0]?.total ?? 0),
        };
      },
      { tenantId, userId: actorUserId },
    );
  }

  async closeDowntime(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    eventId: string,
    requestId: string | null,
    traceId: string | null,
  ): Promise<MachineDowntimeRow> {
    this.validateScope(tenantId, factoryId, actorUserId);
    this.validateUuid(eventId, 'eventId');
    this.validateAuditContext(requestId, traceId);

    const downtime = await this.database.transaction(
      async (client) => {
        const existingResult = await client.query<MachineDowntimeRow>(
          `
          SELECT
            id,
            tenant_id,
            factory_id,
            machine_id,
            reason_code,
            description,
            started_at,
            ended_at,
            created_by_user_id,
            closed_by_user_id,
            created_at,
            version
          FROM machine_downtime_events
          WHERE id = $1
            AND tenant_id = $2
            AND factory_id = $3
          FOR UPDATE
          `,
          [eventId, tenantId, factoryId],
        );
        const existing = existingResult.rows[0];

        if (!existing) {
          throw new NotFoundException('Downtime event was not found in this factory');
        }
        if (existing.ended_at !== null) {
          throw new ConflictException('Downtime event is already closed');
        }

        const updatedResult = await client.query<MachineDowntimeRow>(
          `
          UPDATE machine_downtime_events
          SET
            ended_at = NOW(),
            closed_by_user_id = $4,
            version = version + 1
          WHERE id = $1
            AND tenant_id = $2
            AND factory_id = $3
            AND ended_at IS NULL
          RETURNING
            id,
            tenant_id,
            factory_id,
            machine_id,
            reason_code,
            description,
            started_at,
            ended_at,
            created_by_user_id,
            closed_by_user_id,
            created_at,
            version
          `,
          [eventId, tenantId, factoryId, actorUserId],
        );
        const row = updatedResult.rows[0];

        if (!row) {
          throw new ConflictException('Downtime event changed before it could be closed');
        }

        return row;
      },
      { tenantId, userId: actorUserId },
    );

    await this.auditService.record({
      tenantId,
      factoryId,
      actorUserId,
      eventType: 'maintenance.machine.downtime.closed',
      action: 'CLOSE',
      resourceType: 'machine_downtime_event',
      resourceId: downtime.id,
      requestId,
      correlationId: traceId,
      dataClass: 'OPERATIONAL',
      payload: {
        machine_id: downtime.machine_id,
        reason_code: downtime.reason_code,
        started_at: downtime.started_at,
        ended_at: downtime.ended_at,
      },
    });

    return downtime;
  }

  private validateScope(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
  ): void {
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');
    this.validateUuid(actorUserId, 'actorUserId');
  }

  private validateAuditContext(
    requestId: string | null,
    traceId: string | null,
  ): void {
    if (requestId) {
      this.validateUuid(requestId, 'requestId');
    }
    if (traceId) {
      this.validateUuid(traceId, 'traceId');
    }
  }

  private validateUuid(value: string, field: string): void {
    if (!isUUID(value)) {
      throw new BadRequestException(`${field} must be a valid UUID`);
    }
  }

  private requiredText(
    value: string,
    field: string,
    maxLength: number,
  ): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} is required`);
    }
    const normalized = value.trim();
    if (!normalized) {
      throw new BadRequestException(`${field} is required`);
    }
    if (normalized.length > maxLength) {
      throw new BadRequestException(`${field} must be at most ${maxLength} characters`);
    }
    return normalized;
  }

  private optionalText(
    value: string | undefined,
    field: string,
    maxLength: number,
  ): string | null {
    if (value === undefined) {
      return null;
    }
    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be a string`);
    }
    const normalized = value.trim();
    if (normalized.length > maxLength) {
      throw new BadRequestException(`${field} must be at most ${maxLength} characters`);
    }
    return normalized || null;
  }

  private pagination(
    pageValue: number | undefined,
    limitValue: number | undefined,
  ): { page: number; limit: number; offset: number } {
    const page = pageValue ?? 1;
    const limit = limitValue ?? 20;

    if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) {
      throw new BadRequestException('page must be an integer between 1 and 1000000');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }

    return {
      page,
      limit,
      offset: (page - 1) * limit,
    };
  }

  private raiseUniqueConflict(error: unknown, message: string): never {
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && (error as { code?: unknown }).code === '23505'
    ) {
      throw new ConflictException(message);
    }
    throw error;
  }
}
