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

export type InventoryCycleCountSessionStatus =
  | 'SCHEDULED'
  | 'IN_PROGRESS'
  | 'AWAITING_REVIEW'
  | 'COMPLETED'
  | 'CANCELLED';

interface CycleCountSessionRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  item_id: string;
  assigned_to_user_id: string;
  due_at: string;
  priority: number;
  expected_bin_count: number;
  blind_count: boolean;
  variance_escalation_threshold: string | null;
  notes: string | null;
  created_by_user_id: string;
  created_at: string;
  idempotency_key: string;
  request_hash: string;
  task_count: number;
  scheduled_count: number;
  in_progress_count: number;
  awaiting_review_count: number;
  completed_count: number;
  cancelled_count: number;
  status: InventoryCycleCountSessionStatus;
}

interface CycleCountSessionTaskRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  item_id: string;
  location_id: string;
  session_id: string;
  assigned_to_user_id: string;
  due_at: string;
  priority: number;
  status: string;
  blind_count: boolean;
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
  item_sku: string;
  item_name: string;
  location_code: string;
  variance_escalation_status: 'OPEN' | 'RESOLVED' | null;
  overdue: boolean;
}

export type InventoryCycleCountSession = Omit<
  CycleCountSessionRow,
  'idempotency_key' | 'request_hash'
> & { replayed: boolean };

export type InventoryCycleCountSessionTask = Omit<
  CycleCountSessionTaskRow,
  'idempotency_key' | 'request_hash'
> & { overdue: boolean };

export type InventoryCycleCountSessionDetails = InventoryCycleCountSession & {
  tasks: InventoryCycleCountSessionTask[];
};

const SESSION_SELECT_SQL = `
WITH session_progress AS (
  SELECT
    t.session_id,
    t.tenant_id,
    t.factory_id,
    COUNT(*)::integer AS task_count,
    COUNT(*) FILTER (WHERE t.status = 'SCHEDULED')::integer AS scheduled_count,
    COUNT(*) FILTER (WHERE t.status = 'IN_PROGRESS')::integer AS in_progress_count,
    COUNT(*) FILTER (WHERE t.status = 'AWAITING_REVIEW')::integer AS awaiting_review_count,
    COUNT(*) FILTER (WHERE t.status = 'COMPLETED')::integer AS completed_count,
    COUNT(*) FILTER (WHERE t.status = 'CANCELLED')::integer AS cancelled_count,
    CASE
      WHEN COUNT(*) FILTER (WHERE t.status <> 'COMPLETED') = 0 THEN 'COMPLETED'
      WHEN COUNT(*) FILTER (WHERE t.status <> 'CANCELLED') = 0 THEN 'CANCELLED'
      WHEN COUNT(*) FILTER (WHERE t.status = 'SCHEDULED') = COUNT(*) THEN 'SCHEDULED'
      WHEN COUNT(*) FILTER (WHERE t.status IN ('SCHEDULED', 'IN_PROGRESS')) > 0 THEN 'IN_PROGRESS'
      WHEN COUNT(*) FILTER (WHERE t.status = 'AWAITING_REVIEW') > 0 THEN 'AWAITING_REVIEW'
      ELSE 'IN_PROGRESS'
    END AS session_status
  FROM inventory_cycle_count_tasks t
  WHERE t.session_id IS NOT NULL
  GROUP BY t.session_id, t.tenant_id, t.factory_id
)
SELECT
  s.id::text AS id,
  s.tenant_id::text AS tenant_id,
  s.factory_id::text AS factory_id,
  s.item_id::text AS item_id,
  s.assigned_to_user_id::text AS assigned_to_user_id,
  s.due_at::text AS due_at,
  s.priority,
  s.expected_bin_count,
  s.blind_count,
  s.variance_escalation_threshold::text AS variance_escalation_threshold,
  s.notes,
  s.created_by_user_id::text AS created_by_user_id,
  s.created_at::text AS created_at,
  s.idempotency_key,
  s.request_hash,
  p.task_count,
  p.scheduled_count,
  p.in_progress_count,
  p.awaiting_review_count,
  p.completed_count,
  p.cancelled_count,
  p.session_status AS status
FROM inventory_cycle_count_sessions s
JOIN session_progress p
  ON p.session_id = s.id AND p.tenant_id = s.tenant_id AND p.factory_id = s.factory_id
WHERE s.tenant_id = $1 AND s.factory_id = $2
`;

const SESSION_TASKS_SQL = `
SELECT
  t.id::text AS id,
  t.tenant_id::text AS tenant_id,
  t.factory_id::text AS factory_id,
  t.item_id::text AS item_id,
  t.location_id::text AS location_id,
  t.session_id::text AS session_id,
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
  t.version::text AS version,
  i.sku AS item_sku,
  i.name AS item_name,
  l.location_code AS location_code,
  e.status AS variance_escalation_status,
  (t.status IN ('SCHEDULED', 'IN_PROGRESS') AND t.due_at < clock_timestamp()) AS overdue
FROM inventory_cycle_count_tasks t
JOIN inventory_items i
  ON i.id = t.item_id AND i.tenant_id = t.tenant_id AND i.factory_id = t.factory_id
JOIN inventory_locations l
  ON l.id = t.location_id AND l.tenant_id = t.tenant_id AND l.factory_id = t.factory_id
LEFT JOIN inventory_cycle_count_variance_escalations e
  ON e.task_id = t.id AND e.tenant_id = t.tenant_id AND e.factory_id = t.factory_id
 AND e.proposal_id = t.current_proposal_id
WHERE t.tenant_id = $1 AND t.factory_id = $2 AND t.session_id = $3
ORDER BY l.location_code ASC, t.id ASC
`;

@Injectable()
export class InventoryCycleCountSessionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly auditService: AuditService,
  ) {}

  async createSession(
    userId: string,
    tenantId: string,
    factoryId: string,
    dto: {
      item_id: string;
      location_ids: string[];
      assigned_to_user_id: string;
      due_at: string;
      priority?: number;
      blind_count?: boolean;
      variance_escalation_threshold?: number;
      notes?: string;
    },
    rawIdempotencyKey: string | null,
    requestId: string | null,
    traceId: string | null,
  ): Promise<InventoryCycleCountSessionDetails> {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(dto.item_id, 'item_id');
    this.validateUuid(dto.assigned_to_user_id, 'assigned_to_user_id');

    if (!Array.isArray(dto.location_ids) || dto.location_ids.length < 2 || dto.location_ids.length > 50) {
      throw new BadRequestException('location_ids must contain between 2 and 50 active bins');
    }
    const locationIds = dto.location_ids.map((id) => {
      this.validateUuid(id, 'location_ids');
      return id.toLowerCase();
    }).sort();
    if (new Set(locationIds).size !== locationIds.length) {
      throw new BadRequestException('location_ids must not contain duplicate bins');
    }

    const itemId = dto.item_id.toLowerCase();
    const assignedToUserId = dto.assigned_to_user_id.toLowerCase();
    const dueTimestamp = Date.parse(dto.due_at);
    if (!Number.isFinite(dueTimestamp)) {
      throw new BadRequestException('due_at must be a valid ISO date-time');
    }
    const dueAt = new Date(dueTimestamp).toISOString();
    const priority = dto.priority ?? 100;
    if (!Number.isInteger(priority) || priority < 0 || priority > 10000) {
      throw new BadRequestException('priority must be an integer between 0 and 10000');
    }

    const blindCount = dto.blind_count ?? true;
    if (typeof blindCount !== 'boolean') {
      throw new BadRequestException('blind_count must be true or false');
    }
    let varianceThreshold: number | null = null;
    const rawThreshold = dto.variance_escalation_threshold;
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
      itemId,
      locationIds,
      assignedToUserId,
      dueAt,
      priority,
      blindCount,
      varianceThreshold,
      notes,
    });

    const outcome = await this.database.transaction({
      tenantId,
      userId,
      advisoryLockKey: 'inventory-cycle-count-session:' + tenantId + ':' + factoryId + ':' + idempotencyKey,
    }, async (client) => {
      const existing = await client.query<CycleCountSessionRow>(
        SESSION_SELECT_SQL + ' AND s.idempotency_key = $3 LIMIT 1',
        [tenantId, factoryId, idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) {
          throw new ConflictException('Idempotency-Key was reused for a different cycle-count session');
        }
        return { sessionId: existing.rows[0].id, replayed: true };
      }

      const item = await client.query<{ id: string }>(
        `SELECT id::text AS id
         FROM inventory_items
         WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 AND status = 'ACTIVE'
         FOR UPDATE`,
        [itemId, tenantId, factoryId],
      );
      if (!item.rows[0]) {
        throw new NotFoundException('Active inventory item not found in this factory');
      }

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

      const bins = await client.query<{ id: string }>(
        `SELECT l.id::text AS id
         FROM inventory_locations l
         JOIN inventory_locations p
           ON p.id = l.parent_location_id AND p.tenant_id = l.tenant_id
          AND p.factory_id = l.factory_id
         WHERE l.tenant_id = $1 AND l.factory_id = $2
           AND l.id = ANY($3::uuid[])
           AND l.location_type = 'BIN' AND l.status = 'ACTIVE'
           AND p.location_type IN ('WAREHOUSE', 'STAGING') AND p.status = 'ACTIVE'
         ORDER BY l.id
         FOR UPDATE OF l`,
        [tenantId, factoryId, locationIds],
      );
      if (bins.rows.length !== locationIds.length) {
        throw new BadRequestException('Every location_id must identify a distinct active bin in this factory');
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO inventory_cycle_count_sessions (
           tenant_id, factory_id, item_id, assigned_to_user_id, due_at, priority,
           expected_bin_count, blind_count, variance_escalation_threshold,
           idempotency_key, request_hash, notes, created_by_user_id
         ) VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9::numeric, $10, $11, $12, $13)
         RETURNING id::text AS id`,
        [
          tenantId, factoryId, itemId, assignedToUserId, dueAt, priority,
          locationIds.length, blindCount, varianceThreshold, idempotencyKey,
          requestHash, notes, userId,
        ],
      );
      const sessionId = inserted.rows[0]?.id;
      if (!sessionId) throw new Error('INVENTORY_CYCLE_COUNT_SESSION_CREATE_FAILED');

      const taskIds: string[] = [];
      for (const locationId of locationIds) {
        const childKey = 'session-' + sessionId + '-' + locationId;
        const childHash = this.hash({
          sessionId, itemId, locationId, assignedToUserId, dueAt, priority,
          blindCount, varianceThreshold, notes,
        });
        const task = await client.query<{ id: string }>(
          `INSERT INTO inventory_cycle_count_tasks (
             tenant_id, factory_id, item_id, location_id, session_id, assigned_to_user_id,
             due_at, priority, status, blind_count, variance_escalation_threshold,
             idempotency_key, request_hash, notes, created_by_user_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, 'SCHEDULED', $9, $10::numeric, $11, $12, $13, $14)
           RETURNING id::text AS id`,
          [
            tenantId, factoryId, itemId, locationId, sessionId, assignedToUserId,
            dueAt, priority, blindCount, varianceThreshold, childKey, childHash, notes, userId,
          ],
        );
        const taskId = task.rows[0]?.id;
        if (!taskId) throw new Error('INVENTORY_CYCLE_COUNT_SESSION_TASK_CREATE_FAILED');
        taskIds.push(taskId);
        await this.insertOutboxEvent(client, {
          tenantId, factoryId, aggregateType: 'INVENTORY_CYCLE_COUNT_TASK', aggregateId: taskId,
          correlationId: this.correlationId(requestId, traceId), userId,
          eventType: 'INVENTORY.CYCLE_COUNT_TASK_SCHEDULED',
          payload: {
            id: taskId, session_id: sessionId, item_id: itemId, location_id: locationId,
            assigned_to_user_id: assignedToUserId, due_at: dueAt, priority,
            blind_count: blindCount, status: 'SCHEDULED',
          },
        });
      }

      await this.insertOutboxEvent(client, {
        tenantId, factoryId, aggregateType: 'INVENTORY_CYCLE_COUNT_SESSION', aggregateId: sessionId,
        correlationId: this.correlationId(requestId, traceId), userId,
        eventType: 'INVENTORY.CYCLE_COUNT_SESSION_SCHEDULED',
        payload: {
          session_id: sessionId, item_id: itemId, assigned_to_user_id: assignedToUserId,
          bin_count: locationIds.length, task_ids: taskIds, due_at: dueAt, priority,
          blind_count: blindCount, variance_escalation_threshold: varianceThreshold,
        },
      });
      return { sessionId, replayed: false };
    });

    if (!outcome.replayed) {
      await this.recordAuditSafely({
        tenantId, factoryId, userId, requestId, traceId, resourceId: outcome.sessionId,
        action: 'CYCLE_COUNT_SESSION_SCHEDULE',
        payload: {
          item_id: itemId, bin_count: locationIds.length,
          assigned_to_user_id: assignedToUserId, due_at: dueAt, priority,
          blind_count: blindCount, variance_escalation_threshold: varianceThreshold,
        },
      });
    }

    const result = await this.getSession(userId, tenantId, factoryId, outcome.sessionId);
    return { ...result, replayed: outcome.replayed };
  }

  async listSessions(
    userId: string,
    tenantId: string,
    factoryId: string,
    options: { status?: string; limit?: number } = {},
  ): Promise<InventoryCycleCountSession[]> {
    this.validateScope(userId, tenantId, factoryId);
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }
    const status = options.status?.trim().toUpperCase() || null;
    if (status && !['SCHEDULED', 'IN_PROGRESS', 'AWAITING_REVIEW', 'COMPLETED', 'CANCELLED'].includes(status)) {
      throw new BadRequestException('status is not a valid cycle-count session status');
    }

    const result = await this.database.query<CycleCountSessionRow>(
      SESSION_SELECT_SQL + ' AND ($3::text IS NULL OR p.session_status = $3) ORDER BY s.created_at DESC, s.id DESC LIMIT $4',
      [tenantId, factoryId, status, limit],
      { tenantId, userId },
    );
    return result.rows.map((row) => this.toSession(row, false));
  }

  async getSession(
    userId: string,
    tenantId: string,
    factoryId: string,
    sessionId: string,
  ): Promise<InventoryCycleCountSessionDetails> {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(sessionId, 'sessionId');
    const sessionResult = await this.database.query<CycleCountSessionRow>(
      SESSION_SELECT_SQL + ' AND s.id = $3::uuid LIMIT 1',
      [tenantId, factoryId, sessionId],
      { tenantId, userId },
    );
    const session = sessionResult.rows[0];
    if (!session) throw new NotFoundException('Cycle-count session not found in this factory');

    const taskResult = await this.database.query<CycleCountSessionTaskRow>(
      SESSION_TASKS_SQL,
      [tenantId, factoryId, sessionId],
      { tenantId, userId },
    );
    return {
      ...this.toSession(session, false),
      tasks: taskResult.rows.map((row) => {
        const { idempotency_key, request_hash, ...task } = row;
        void idempotency_key;
        void request_hash;
        return task;
      }),
    };
  }

  async startSession(
    userId: string,
    tenantId: string,
    factoryId: string,
    sessionId: string,
    requestId: string | null,
    traceId: string | null,
  ): Promise<InventoryCycleCountSessionDetails> {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(sessionId, 'sessionId');
    const outcome = await this.database.transaction({ tenantId, userId }, async (client) => {
      const sessionResult = await client.query<{
        id: string;
        assigned_to_user_id: string;
        expected_bin_count: number;
      }>(
        `SELECT id::text AS id, assigned_to_user_id::text AS assigned_to_user_id, expected_bin_count
         FROM inventory_cycle_count_sessions
         WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
         FOR UPDATE`,
        [sessionId, tenantId, factoryId],
      );
      const session = sessionResult.rows[0];
      if (!session) throw new NotFoundException('Cycle-count session not found in this factory');
      if (session.assigned_to_user_id !== userId) {
        throw new ConflictException('Only the assigned counter can start this multi-bin session');
      }

      const tasks = await client.query<{
        id: string;
        status: string;
        started_by_user_id: string | null;
      }>(
        `SELECT id::text AS id, status, started_by_user_id::text AS started_by_user_id
         FROM inventory_cycle_count_tasks
         WHERE session_id = $1 AND tenant_id = $2 AND factory_id = $3
         ORDER BY id FOR UPDATE`,
        [sessionId, tenantId, factoryId],
      );
      if (tasks.rows.length !== session.expected_bin_count) {
        throw new ConflictException('Cycle-count session task set is incomplete');
      }

      let changed = false;
      for (const task of tasks.rows) {
        if (task.status === 'IN_PROGRESS') {
          if (task.started_by_user_id !== userId) {
            throw new ConflictException('Session contains a task started by a different counter');
          }
          continue;
        }
        if (task.status !== 'SCHEDULED') {
          throw new ConflictException('Only sessions with scheduled or already-started tasks can be started');
        }
        const updated = await client.query(
          `UPDATE inventory_cycle_count_tasks
           SET status = 'IN_PROGRESS', assigned_to_user_id = $1::uuid,
               started_by_user_id = $1::uuid, started_at = clock_timestamp(),
               version = version + 1
           WHERE id = $2 AND tenant_id = $3 AND factory_id = $4 AND status = 'SCHEDULED'`,
          [userId, task.id, tenantId, factoryId],
        );
        if (updated.rowCount !== 1) throw new ConflictException('A session task could not be started');
        changed = true;
        await this.insertOutboxEvent(client, {
          tenantId, factoryId, aggregateType: 'INVENTORY_CYCLE_COUNT_TASK', aggregateId: task.id,
          correlationId: this.correlationId(requestId, traceId), userId,
          eventType: 'INVENTORY.CYCLE_COUNT_TASK_STARTED',
          payload: { task_id: task.id, session_id: sessionId, status: 'IN_PROGRESS', started_by_user_id: userId },
        });
      }

      if (changed) {
        await this.insertOutboxEvent(client, {
          tenantId, factoryId, aggregateType: 'INVENTORY_CYCLE_COUNT_SESSION', aggregateId: sessionId,
          correlationId: this.correlationId(requestId, traceId), userId,
          eventType: 'INVENTORY.CYCLE_COUNT_SESSION_STARTED',
          payload: { session_id: sessionId, status: 'IN_PROGRESS', task_count: tasks.rows.length },
        });
      }
      return { replayed: !changed };
    });

    if (!outcome.replayed) {
      await this.recordAuditSafely({
        tenantId, factoryId, userId, requestId, traceId, resourceId: sessionId,
        action: 'CYCLE_COUNT_SESSION_START',
        payload: { status: 'IN_PROGRESS' },
      });
    }
    return { ...await this.getSession(userId, tenantId, factoryId, sessionId), replayed: outcome.replayed };
  }

  async cancelSession(
    userId: string,
    tenantId: string,
    factoryId: string,
    sessionId: string,
    cancellationReason: string,
    requestId: string | null,
    traceId: string | null,
  ): Promise<InventoryCycleCountSessionDetails> {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(sessionId, 'sessionId');
    const reason = cancellationReason.trim();
    if (!reason || reason.length > 1000) {
      throw new BadRequestException('cancellation_reason must contain 1–1000 characters');
    }

    const outcome = await this.database.transaction({ tenantId, userId }, async (client) => {
      const sessionResult = await client.query<{
        id: string;
        expected_bin_count: number;
      }>(
        `SELECT id::text AS id, expected_bin_count
         FROM inventory_cycle_count_sessions
         WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
         FOR UPDATE`,
        [sessionId, tenantId, factoryId],
      );
      const session = sessionResult.rows[0];
      if (!session) throw new NotFoundException('Cycle-count session not found in this factory');

      const tasks = await client.query<{
        id: string;
        status: string;
        cancelled_by_user_id: string | null;
        cancellation_reason: string | null;
      }>(
        `SELECT id::text AS id, status, cancelled_by_user_id::text AS cancelled_by_user_id, cancellation_reason
         FROM inventory_cycle_count_tasks
         WHERE session_id = $1 AND tenant_id = $2 AND factory_id = $3
         ORDER BY id FOR UPDATE`,
        [sessionId, tenantId, factoryId],
      );
      if (tasks.rows.length !== session.expected_bin_count) {
        throw new ConflictException('Cycle-count session task set is incomplete');
      }

      if (tasks.rows.every((task) => task.status === 'CANCELLED')) {
        if (tasks.rows.every((task) => task.cancelled_by_user_id === userId && task.cancellation_reason === reason)) {
          return { replayed: true };
        }
        throw new ConflictException('Cycle-count session was already cancelled with a different decision');
      }
      if (tasks.rows.some((task) => !['SCHEDULED', 'IN_PROGRESS'].includes(task.status))) {
        throw new ConflictException('A session can only be cancelled before any bin is submitted for review or completed');
      }

      await client.query(
        `SELECT set_config('app.inventory_cycle_count_session_cancel', 'true', true)`,
      );
      for (const task of tasks.rows) {
        const updated = await client.query(
          `UPDATE inventory_cycle_count_tasks
           SET status = 'CANCELLED', cancelled_by_user_id = $1::uuid,
               cancelled_at = clock_timestamp(), cancellation_reason = $2,
               version = version + 1
           WHERE id = $3 AND tenant_id = $4 AND factory_id = $5
             AND status IN ('SCHEDULED', 'IN_PROGRESS')`,
          [userId, reason, task.id, tenantId, factoryId],
        );
        if (updated.rowCount !== 1) throw new ConflictException('A session task could not be cancelled');
        await this.insertOutboxEvent(client, {
          tenantId, factoryId, aggregateType: 'INVENTORY_CYCLE_COUNT_TASK', aggregateId: task.id,
          correlationId: this.correlationId(requestId, traceId), userId,
          eventType: 'INVENTORY.CYCLE_COUNT_TASK_CANCELLED',
          payload: { task_id: task.id, session_id: sessionId, status: 'CANCELLED', cancellation_reason: reason },
        });
      }
      await this.insertOutboxEvent(client, {
        tenantId, factoryId, aggregateType: 'INVENTORY_CYCLE_COUNT_SESSION', aggregateId: sessionId,
        correlationId: this.correlationId(requestId, traceId), userId,
        eventType: 'INVENTORY.CYCLE_COUNT_SESSION_CANCELLED',
        payload: { session_id: sessionId, status: 'CANCELLED', cancellation_reason: reason, task_count: tasks.rows.length },
      });
      return { replayed: false };
    });

    if (!outcome.replayed) {
      await this.recordAuditSafely({
        tenantId, factoryId, userId, requestId, traceId, resourceId: sessionId,
        action: 'CYCLE_COUNT_SESSION_CANCEL',
        payload: { status: 'CANCELLED', cancellation_reason: reason },
      });
    }
    return { ...await this.getSession(userId, tenantId, factoryId, sessionId), replayed: outcome.replayed };
  }

  private toSession(row: CycleCountSessionRow, replayed: boolean): InventoryCycleCountSession {
    const { idempotency_key, request_hash, ...session } = row;
    void idempotency_key;
    void request_hash;
    return { ...session, replayed };
  }

  private async insertOutboxEvent(
    client: PoolClient,
    input: {
      tenantId: string;
      factoryId: string;
      aggregateType: string;
      aggregateId: string;
      correlationId: string;
      userId: string;
      eventType: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO outbox_events (
         tenant_id, factory_id, aggregate_type, aggregate_id, event_type,
         event_version, occurred_at, correlation_id, causation_id, actor, source, payload
       ) VALUES ($1, $2, $3, $4, $5, 1, clock_timestamp(), $6::uuid, NULL, $7::jsonb, $8::jsonb, $9::jsonb)`,
      [
        input.tenantId, input.factoryId, input.aggregateType, input.aggregateId, input.eventType,
        input.correlationId,
        JSON.stringify({ type: 'user', id: input.userId }),
        JSON.stringify({ system: 'FactoryOS', connector: 'inventory-cycle-count-session', version: process.env.APP_VERSION ?? process.env.npm_package_version ?? '0.1.0' }),
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
        tenantId: input.tenantId,
        factoryId: input.factoryId,
        actorUserId: input.userId,
        eventType: 'INVENTORY',
        action: input.action,
        resourceType: 'INVENTORY_CYCLE_COUNT_SESSION',
        resourceId: input.resourceId,
        requestId: input.requestId && isUUID(input.requestId) ? input.requestId : null,
        correlationId: input.traceId && isUUID(input.traceId) ? input.traceId : null,
        dataClass: 'INTERNAL',
        payload: input.payload,
      });
    } catch {
      // The transactional outbox contains the durable lifecycle evidence.
    }
  }

  private requiredIdempotencyKey(rawKey: string | null): string {
    const key = rawKey?.trim() ?? '';
    if (!key) throw new BadRequestException('Idempotency-Key is required for cycle-count session creation');
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
}
