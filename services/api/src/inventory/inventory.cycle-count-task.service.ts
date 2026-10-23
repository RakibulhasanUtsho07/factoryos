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

export type InventoryCycleCountTaskStatus =
  | 'SCHEDULED'
  | 'IN_PROGRESS'
  | 'AWAITING_REVIEW'
  | 'COMPLETED'
  | 'CANCELLED';

interface CycleCountTaskRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  item_id: string;
  location_id: string | null;
  assigned_to_user_id: string | null;
  due_at: string;
  priority: number;
  status: InventoryCycleCountTaskStatus;
  blind_count: boolean;
  variance_escalation_status?: 'OPEN' | 'RESOLVED' | null;
  current_proposal_id: string | null;
  idempotency_key: string;
  request_hash: string;
  notes: string | null;
  created_by_user_id: string;
  created_at: string;
  started_by_user_id: string | null;
  started_at: string | null;
  submitted_by_user_id: string | null;
  submitted_at: string | null;
  completed_at: string | null;
  cancelled_by_user_id: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  version: string;
  item_sku?: string;
  item_name?: string;
  location_code?: string | null;
  overdue?: boolean;
}

export type InventoryCycleCountTask = Omit<
  CycleCountTaskRow,
  'idempotency_key' | 'request_hash'
> & { overdue: boolean; replayed: boolean };

const TASK_COLUMNS = `
  id::text AS id,
  tenant_id::text AS tenant_id,
  factory_id::text AS factory_id,
  item_id::text AS item_id,
  location_id::text AS location_id,
  assigned_to_user_id::text AS assigned_to_user_id,
  due_at::text AS due_at,
  priority,
  status,
  blind_count,
  current_proposal_id::text AS current_proposal_id,
  idempotency_key,
  request_hash,
  notes,
  created_by_user_id::text AS created_by_user_id,
  created_at::text AS created_at,
  started_by_user_id::text AS started_by_user_id,
  started_at::text AS started_at,
  submitted_by_user_id::text AS submitted_by_user_id,
  submitted_at::text AS submitted_at,
  completed_at::text AS completed_at,
  cancelled_by_user_id::text AS cancelled_by_user_id,
  cancelled_at::text AS cancelled_at,
  cancellation_reason,
  version::text AS version
`;

const TASK_COLUMNS_T = `
  t.id::text AS id,
  t.tenant_id::text AS tenant_id,
  t.factory_id::text AS factory_id,
  t.item_id::text AS item_id,
  t.location_id::text AS location_id,
  t.assigned_to_user_id::text AS assigned_to_user_id,
  t.due_at::text AS due_at,
  t.priority,
  t.status,
  t.blind_count,
  t.current_proposal_id::text AS current_proposal_id,
  t.idempotency_key,
  t.request_hash,
  t.notes,
  t.created_by_user_id::text AS created_by_user_id,
  t.created_at::text AS created_at,
  t.started_by_user_id::text AS started_by_user_id,
  t.started_at::text AS started_at,
  t.submitted_by_user_id::text AS submitted_by_user_id,
  t.submitted_at::text AS submitted_at,
  t.completed_at::text AS completed_at,
  t.cancelled_by_user_id::text AS cancelled_by_user_id,
  t.cancelled_at::text AS cancelled_at,
  t.cancellation_reason,
  t.version::text AS version
`;

@Injectable()
export class InventoryCycleCountTaskService {
  constructor(
    private readonly database: DatabaseService,
    private readonly auditService: AuditService,
  ) {}

  async createTask(
    userId: string,
    tenantId: string,
    factoryId: string,
    dto: {
      item_id: string;
      location_id?: string;
      assigned_to_user_id?: string;
      due_at: string;
      priority?: number;
      blind_count?: boolean;
      variance_escalation_threshold?: number;
      notes?: string;
    },
    rawIdempotencyKey: string | null,
    requestId: string | null,
    traceId: string | null,
  ): Promise<InventoryCycleCountTask> {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(dto.item_id, 'item_id');
    const itemId = dto.item_id.toLowerCase();
    const locationId = dto.location_id?.toLowerCase() ?? null;
    const assignedToUserId = dto.assigned_to_user_id?.toLowerCase() ?? null;
    if (locationId) this.validateUuid(locationId, 'location_id');
    if (assignedToUserId) this.validateUuid(assignedToUserId, 'assigned_to_user_id');

    const dueTimestamp = Date.parse(dto.due_at);
    if (!Number.isFinite(dueTimestamp)) throw new BadRequestException('due_at must be a valid ISO date-time');
    const dueAt = new Date(dueTimestamp).toISOString();
    const priority = dto.priority ?? 100;
    if (!Number.isInteger(priority) || priority < 0 || priority > 10000) {
      throw new BadRequestException('priority must be an integer between 0 and 10000');
    }
    const blindCount = dto.blind_count ?? true;
    if (typeof blindCount !== 'boolean') throw new BadRequestException('blind_count must be true or false');
    const rawThreshold = dto.variance_escalation_threshold;
    let varianceThreshold: number | null = null;
    if (rawThreshold !== undefined && rawThreshold !== null) {
      if (!Number.isFinite(rawThreshold) || rawThreshold <= 0 || rawThreshold > 99999999999999) {
        throw new BadRequestException('variance_escalation_threshold must be greater than zero and within the supported quantity range');
      }
      const fixedThreshold = rawThreshold.toFixed(4);
      if (Number(fixedThreshold) <= 0 || Number(fixedThreshold) !== rawThreshold) {
        throw new BadRequestException('variance_escalation_threshold supports at most 4 decimal places');
      }
      varianceThreshold = Number(fixedThreshold);
    }
    const notes = dto.notes?.trim() || null;
    const idempotencyKey = this.requiredIdempotencyKey(rawIdempotencyKey);
    const requestHash = this.hash({
      itemId, locationId, assignedToUserId, dueAt, priority, blindCount,
      varianceThreshold, notes,
    });

    let result: InventoryCycleCountTask;
    try {
      result = await this.database.transaction({ tenantId, userId }, async (client) => {
        const existing = await this.findByKey(client, tenantId, factoryId, idempotencyKey);
        if (existing) return this.replayOrConflict(existing, requestHash);

        const item = await client.query<{ status: string }>(
          `SELECT status FROM inventory_items
           WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 FOR UPDATE`,
          [itemId, tenantId, factoryId],
        );
        if (!item.rows[0]) throw new NotFoundException('Inventory item not found in this factory');
        if (item.rows[0].status !== 'ACTIVE') throw new ConflictException('Disabled inventory items cannot be scheduled for cycle count');

        if (assignedToUserId) {
          const assignee = await client.query<{ id: string }>(
            `SELECT u.id::text AS id
             FROM users u
             JOIN tenant_memberships tm ON tm.user_id = u.id
             WHERE u.id = $1 AND u.status = 'ACTIVE'
               AND tm.tenant_id = $2 AND tm.status = 'ACTIVE'
             LIMIT 1 FOR SHARE OF u, tm`,
            [assignedToUserId, tenantId],
          );
          if (!assignee.rows[0]) {
            throw new BadRequestException('assigned_to_user_id must identify an active member of this tenant');
          }
        }

        if (locationId) {
          const location = await client.query<{ id: string }>(
            `SELECT l.id::text AS id
             FROM inventory_locations l
             JOIN inventory_locations p
               ON p.id = l.parent_location_id AND p.tenant_id = l.tenant_id
              AND p.factory_id = l.factory_id
             WHERE l.id = $1 AND l.tenant_id = $2 AND l.factory_id = $3
               AND l.location_type = 'BIN' AND l.status = 'ACTIVE'
               AND p.location_type IN ('WAREHOUSE', 'STAGING') AND p.status = 'ACTIVE'
             FOR UPDATE OF l`,
            [locationId, tenantId, factoryId],
          );
          if (!location.rows[0]) throw new NotFoundException('Active bin not found in this factory');
        }

        const duplicateAfterLock = await this.findByKey(client, tenantId, factoryId, idempotencyKey);
        if (duplicateAfterLock) return this.replayOrConflict(duplicateAfterLock, requestHash);

        const inserted = await client.query<CycleCountTaskRow>(
          `INSERT INTO inventory_cycle_count_tasks (
             tenant_id, factory_id, item_id, location_id, assigned_to_user_id,
             due_at, priority, status, blind_count, variance_escalation_threshold,
             idempotency_key, request_hash, notes, created_by_user_id
           ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, 'SCHEDULED', $8, $9::numeric, $10, $11, $12, $13)
           RETURNING ${TASK_COLUMNS}`,
          [
            tenantId, factoryId, itemId, locationId, assignedToUserId,
            dueAt, priority, blindCount, varianceThreshold, idempotencyKey, requestHash, notes, userId,
          ],
        );
        const task = inserted.rows[0];
        if (!task) throw new Error('INVENTORY_CYCLE_COUNT_TASK_CREATE_FAILED');
        await this.insertOutboxEvent(client, {
          tenantId, factoryId, aggregateId: task.id,
          correlationId: this.correlationId(requestId, traceId),
          userId, eventType: 'INVENTORY.CYCLE_COUNT_TASK_SCHEDULED',
          payload: { task: this.eventShape(task), variance_escalation_threshold: varianceThreshold },
        });
        return this.toTask(task, false);
      });
    } catch (error) {
      if (this.errorCode(error) !== '23505') throw error;
      const stored = await this.database.query<CycleCountTaskRow>(
        `SELECT ${TASK_COLUMNS} FROM inventory_cycle_count_tasks
         WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3 LIMIT 1`,
        [tenantId, factoryId, idempotencyKey],
        { tenantId, userId },
      );
      if (!stored.rows[0]) throw new ConflictException('Cycle-count task conflicts with an existing record');
      result = this.replayOrConflict(stored.rows[0], requestHash);
    }

    if (!result.replayed) {
      await this.recordAuditSafely({
        tenantId, factoryId, userId, requestId, traceId, resourceId: result.id,
        action: 'CYCLE_COUNT_TASK_SCHEDULE',
        payload: {
          item_id: result.item_id, location_id: result.location_id,
          assigned_to_user_id: result.assigned_to_user_id, due_at: result.due_at,
          priority: result.priority, status: result.status,
          blind_count: result.blind_count, variance_escalation_threshold: varianceThreshold,
        },
      });
    }
    return result;
  }

  async listTasks(
    userId: string,
    tenantId: string,
    factoryId: string,
    options: { status?: string; limit?: number; assignedToMe?: boolean } = {},
  ): Promise<InventoryCycleCountTask[]> {
    this.validateScope(userId, tenantId, factoryId);
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }
    const status = options.status?.trim().toUpperCase() || null;
    if (status && !['SCHEDULED', 'IN_PROGRESS', 'AWAITING_REVIEW', 'COMPLETED', 'CANCELLED'].includes(status)) {
      throw new BadRequestException('status is not a valid cycle-count task status');
    }

    const result = await this.database.query<CycleCountTaskRow>(
      `SELECT ${TASK_COLUMNS_T},
              i.sku AS item_sku, i.name AS item_name,
              l.location_code AS location_code,
              e.status AS variance_escalation_status,
              (t.status IN ('SCHEDULED', 'IN_PROGRESS') AND t.due_at < clock_timestamp()) AS overdue
       FROM inventory_cycle_count_tasks t
       JOIN inventory_items i ON i.id = t.item_id AND i.tenant_id = t.tenant_id AND i.factory_id = t.factory_id
       LEFT JOIN inventory_locations l ON l.id = t.location_id AND l.tenant_id = t.tenant_id AND l.factory_id = t.factory_id
       LEFT JOIN inventory_cycle_count_variance_escalations e
         ON e.task_id = t.id AND e.tenant_id = t.tenant_id AND e.factory_id = t.factory_id
        AND e.proposal_id = t.current_proposal_id
       WHERE t.tenant_id = $1 AND t.factory_id = $2
         AND ($3::text IS NULL OR t.status = $3)
         AND (NOT $4::boolean OR t.assigned_to_user_id = $5)
       ORDER BY
         CASE WHEN t.status IN ('SCHEDULED', 'IN_PROGRESS') AND t.due_at < clock_timestamp() THEN 0 ELSE 1 END,
         t.due_at ASC, t.priority ASC, t.id ASC
       LIMIT $6`,
      [tenantId, factoryId, status, options.assignedToMe ?? false, userId, limit],
      { tenantId, userId },
    );
    return result.rows.map((row) => this.toTask(row, false));
  }

  async startTask(
    userId: string,
    tenantId: string,
    factoryId: string,
    taskId: string,
    requestId: string | null,
    traceId: string | null,
  ): Promise<InventoryCycleCountTask> {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(taskId, 'taskId');
    let replayed = false;
    const result = await this.database.transaction({ tenantId, userId }, async (client) => {
      const selected = await client.query<CycleCountTaskRow>(
        `SELECT ${TASK_COLUMNS} FROM inventory_cycle_count_tasks
         WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 FOR UPDATE`,
        [taskId, tenantId, factoryId],
      );
      const task = selected.rows[0];
      if (!task) throw new NotFoundException('Cycle-count task not found in this factory');
      if (task.status === 'IN_PROGRESS' && task.assigned_to_user_id === userId) {
        replayed = true;
        return this.toTask(task, true);
      }
      if (task.status !== 'SCHEDULED') throw new ConflictException('Only scheduled cycle-count tasks can be started');
      if (task.assigned_to_user_id && task.assigned_to_user_id !== userId) {
        throw new ConflictException('Cycle-count task is assigned to another user');
      }
      const updated = await client.query<CycleCountTaskRow>(
        `UPDATE inventory_cycle_count_tasks
         SET status = 'IN_PROGRESS',
             assigned_to_user_id = COALESCE(assigned_to_user_id, $1::uuid),
             started_by_user_id = $1::uuid,
             started_at = clock_timestamp(),
             version = version + 1
         WHERE id = $2 AND tenant_id = $3 AND factory_id = $4 AND status = 'SCHEDULED'
         RETURNING ${TASK_COLUMNS}`,
        [userId, taskId, tenantId, factoryId],
      );
      const started = updated.rows[0];
      if (!started) throw new ConflictException('Cycle-count task could not be started');
      await this.insertOutboxEvent(client, {
        tenantId, factoryId, aggregateId: started.id,
        correlationId: this.correlationId(requestId, traceId),
        userId, eventType: 'INVENTORY.CYCLE_COUNT_TASK_STARTED',
        payload: { task: this.eventShape(started) },
      });
      return this.toTask(started, false);
    });

    if (!replayed) await this.recordAuditSafely({
      tenantId, factoryId, userId, requestId, traceId, resourceId: result.id,
      action: 'CYCLE_COUNT_TASK_START',
      payload: { item_id: result.item_id, status: result.status, assigned_to_user_id: result.assigned_to_user_id },
    });
    return result;
  }

  async cancelTask(
    userId: string,
    tenantId: string,
    factoryId: string,
    taskId: string,
    cancellationReason: string,
    requestId: string | null,
    traceId: string | null,
  ): Promise<InventoryCycleCountTask> {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(taskId, 'taskId');
    const reason = cancellationReason.trim();
    if (!reason || reason.length > 1000) throw new BadRequestException('cancellation_reason must contain 1–1000 characters');
    let replayed = false;
    const result = await this.database.transaction({ tenantId, userId }, async (client) => {
      const selected = await client.query<CycleCountTaskRow>(
        `SELECT ${TASK_COLUMNS} FROM inventory_cycle_count_tasks
         WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 FOR UPDATE`,
        [taskId, tenantId, factoryId],
      );
      const task = selected.rows[0];
      if (!task) throw new NotFoundException('Cycle-count task not found in this factory');
      if (task.status === 'CANCELLED') {
        if (task.cancelled_by_user_id === userId && task.cancellation_reason === reason) {
          replayed = true;
          return this.toTask(task, true);
        }
        throw new ConflictException('Cycle-count task is already cancelled with a different decision');
      }
      if (!['SCHEDULED', 'IN_PROGRESS'].includes(task.status)) {
        throw new ConflictException('Only scheduled or in-progress cycle-count tasks can be cancelled');
      }
      const updated = await client.query<CycleCountTaskRow>(
        `UPDATE inventory_cycle_count_tasks
         SET status = 'CANCELLED',
             cancelled_by_user_id = $1::uuid,
             cancelled_at = clock_timestamp(),
             cancellation_reason = $2,
             version = version + 1
         WHERE id = $3 AND tenant_id = $4 AND factory_id = $5
           AND status IN ('SCHEDULED', 'IN_PROGRESS')
         RETURNING ${TASK_COLUMNS}`,
        [userId, reason, taskId, tenantId, factoryId],
      );
      const cancelled = updated.rows[0];
      if (!cancelled) throw new ConflictException('Cycle-count task could not be cancelled');
      await this.insertOutboxEvent(client, {
        tenantId, factoryId, aggregateId: cancelled.id,
        correlationId: this.correlationId(requestId, traceId),
        userId, eventType: 'INVENTORY.CYCLE_COUNT_TASK_CANCELLED',
        payload: { task: this.eventShape(cancelled) },
      });
      return this.toTask(cancelled, false);
    });

    if (!replayed) await this.recordAuditSafely({
      tenantId, factoryId, userId, requestId, traceId, resourceId: result.id,
      action: 'CYCLE_COUNT_TASK_CANCEL',
      payload: { item_id: result.item_id, status: result.status, cancellation_reason: reason },
    });
    return result;
  }

  private async findByKey(
    client: PoolClient,
    tenantId: string,
    factoryId: string,
    key: string,
  ): Promise<CycleCountTaskRow | null> {
    const result = await client.query<CycleCountTaskRow>(
      `SELECT ${TASK_COLUMNS} FROM inventory_cycle_count_tasks
       WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3 LIMIT 1`,
      [tenantId, factoryId, key],
    );
    return result.rows[0] ?? null;
  }

  private replayOrConflict(row: CycleCountTaskRow, requestHash: string): InventoryCycleCountTask {
    if (row.request_hash !== requestHash) {
      throw new ConflictException('Idempotency-Key was reused for a different cycle-count task');
    }
    return this.toTask(row, true);
  }

  private toTask(row: CycleCountTaskRow, replayed: boolean): InventoryCycleCountTask {
    const { idempotency_key, request_hash, ...task } = row;
    void idempotency_key;
    void request_hash;
    return {
      ...task,
      overdue: ['SCHEDULED', 'IN_PROGRESS'].includes(row.status) && Date.parse(row.due_at) < Date.now(),
      replayed,
    };
  }

  private eventShape(task: CycleCountTaskRow): Record<string, unknown> {
    return {
      id: task.id, item_id: task.item_id, location_id: task.location_id,
      assigned_to_user_id: task.assigned_to_user_id, due_at: task.due_at,
      priority: task.priority, blind_count: task.blind_count, status: task.status, current_proposal_id: task.current_proposal_id,
      version: task.version,
    };
  }

  private async insertOutboxEvent(
    client: PoolClient,
    input: {
      tenantId: string;
      factoryId: string;
      aggregateId: string;
      correlationId: string;
      userId: string;
      eventType:
        | 'INVENTORY.CYCLE_COUNT_TASK_SCHEDULED'
        | 'INVENTORY.CYCLE_COUNT_TASK_STARTED'
        | 'INVENTORY.CYCLE_COUNT_TASK_CANCELLED';
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO outbox_events (
         tenant_id, factory_id, aggregate_type, aggregate_id, event_type,
         event_version, occurred_at, correlation_id, causation_id, actor, source, payload
       ) VALUES ($1, $2, 'INVENTORY_CYCLE_COUNT_TASK', $3, $4, 1,
         clock_timestamp(), $5::uuid, NULL, $6::jsonb, $7::jsonb, $8::jsonb)`,
      [
        input.tenantId, input.factoryId, input.aggregateId, input.eventType,
        input.correlationId,
        JSON.stringify({ type: 'user', id: input.userId }),
        JSON.stringify({ system: 'FactoryOS', connector: 'inventory-cycle-count-task', version: process.env.APP_VERSION ?? process.env.npm_package_version ?? '0.1.0' }),
        JSON.stringify(input.payload),
      ],
    );
  }

  private async recordAuditSafely(input: {
    tenantId: string;
    factoryId: string;
    userId: string;
    requestId: string | null;
    traceId: string | null;
    resourceId: string;
    action: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.auditService.record({
        tenantId: input.tenantId, factoryId: input.factoryId, actorUserId: input.userId,
        eventType: 'INVENTORY', action: input.action, resourceType: 'INVENTORY_CYCLE_COUNT_TASK',
        resourceId: input.resourceId,
        requestId: input.requestId && isUUID(input.requestId) ? input.requestId : null,
        correlationId: input.traceId && isUUID(input.traceId) ? input.traceId : null,
        dataClass: 'INTERNAL', payload: input.payload,
      });
    } catch {
      // Transactional outbox preserves durable task lifecycle evidence.
    }
  }

  private requiredIdempotencyKey(rawKey: string | null): string {
    const key = rawKey?.trim() ?? '';
    if (!key) throw new BadRequestException('Idempotency-Key is required for cycle-count task creation');
    if (key.length > 255) throw new BadRequestException('Idempotency-Key must be at most 255 characters');
    return key;
  }

  private hash(value: Record<string, unknown>): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private correlationId(requestId: string | null, traceId: string | null): string {
    if (traceId && isUUID(traceId)) return traceId;
    if (requestId && isUUID(requestId)) return requestId;
    return randomUUID();
  }

  private validateScope(userId: string, tenantId: string, factoryId: string): void {
    this.validateUuid(userId, 'userId');
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');
  }

  private validateUuid(value: string, field: string): void {
    if (!isUUID(value)) throw new BadRequestException(field + ' must be a valid UUID');
  }

  private errorCode(error: unknown): string | null {
    if (typeof error !== 'object' || error === null || !('code' in error)) return null;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
}
