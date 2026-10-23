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

export type InventoryCycleCountCadenceUnit = 'DAILY' | 'WEEKLY' | 'MONTHLY';
export type InventoryCycleCountRecurringPolicyStatus = 'ACTIVE' | 'PAUSED' | 'RETIRED';

interface RecurringPolicyRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  item_id: string;
  location_id: string | null;
  assigned_to_user_id: string;
  cadence_unit: InventoryCycleCountCadenceUnit;
  cadence_interval: number;
  anchor_at: string;
  next_occurrence_number: string;
  next_run_at: string;
  last_run_at: string | null;
  priority: number;
  blind_count: boolean;
  variance_escalation_threshold: string | null;
  status: InventoryCycleCountRecurringPolicyStatus;
  idempotency_key: string;
  request_hash: string;
  notes: string | null;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
  version: string;
}

export type InventoryCycleCountRecurringPolicy = Omit<
  RecurringPolicyRow,
  'idempotency_key' | 'request_hash'
> & { replayed: boolean };

export interface MaterializedOccurrence {
  policy_id: string;
  task_id: string;
  occurrence_number: number;
  scheduled_for: string;
  next_run_at: string;
}

const POLICY_COLUMNS = `
  id::text AS id,
  tenant_id::text AS tenant_id,
  factory_id::text AS factory_id,
  item_id::text AS item_id,
  location_id::text AS location_id,
  assigned_to_user_id::text AS assigned_to_user_id,
  cadence_unit,
  cadence_interval,
  anchor_at::text AS anchor_at,
  next_occurrence_number::text AS next_occurrence_number,
  next_run_at::text AS next_run_at,
  last_run_at::text AS last_run_at,
  priority,
  blind_count,
  variance_escalation_threshold::text AS variance_escalation_threshold,
  status,
  idempotency_key,
  request_hash,
  notes,
  created_by_user_id::text AS created_by_user_id,
  created_at::text AS created_at,
  updated_at::text AS updated_at,
  version::text AS version
`;

const POLICY_COLUMNS_P = POLICY_COLUMNS.split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const trimmed = line.replace(/,$/, '');
    const match = trimmed.match(/^([a-z_]+)(::text AS ([a-z_]+))?$/);
    if (!match) return line;
    return match[2] ? `p.${match[1]}${match[2]}` : `p.${match[1]}`;
  })
  .join(',\n  ');

@Injectable()
export class InventoryCycleCountRecurringPolicyService {
  constructor(
    private readonly database: DatabaseService,
    private readonly auditService: AuditService,
  ) {}

  async createPolicy(
    userId: string,
    tenantId: string,
    factoryId: string,
    dto: {
      item_id: string;
      location_id?: string;
      assigned_to_user_id: string;
      cadence_unit: InventoryCycleCountCadenceUnit;
      cadence_interval?: number;
      first_run_at: string;
      priority?: number;
      blind_count?: boolean;
      variance_escalation_threshold?: number;
      notes?: string;
    },
    rawIdempotencyKey: string | null,
    requestId: string | null,
    traceId: string | null,
  ): Promise<InventoryCycleCountRecurringPolicy> {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(dto.item_id, 'item_id');
    this.validateUuid(dto.assigned_to_user_id, 'assigned_to_user_id');

    const itemId = dto.item_id.toLowerCase();
    const locationId = dto.location_id?.toLowerCase() ?? null;
    const assignedToUserId = dto.assigned_to_user_id.toLowerCase();
    if (locationId) this.validateUuid(locationId, 'location_id');

    const cadenceUnit = dto.cadence_unit;
    if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(cadenceUnit)) {
      throw new BadRequestException('cadence_unit must be DAILY, WEEKLY or MONTHLY');
    }
    const cadenceInterval = dto.cadence_interval ?? 1;
    const maxInterval = cadenceUnit === 'DAILY' ? 365 : cadenceUnit === 'WEEKLY' ? 52 : 24;
    if (!Number.isInteger(cadenceInterval) || cadenceInterval < 1 || cadenceInterval > maxInterval) {
      throw new BadRequestException(`cadence_interval must be between 1 and ${maxInterval} for ${cadenceUnit}`);
    }

    const firstRunTimestamp = Date.parse(dto.first_run_at);
    if (!Number.isFinite(firstRunTimestamp)) {
      throw new BadRequestException('first_run_at must be a valid ISO date-time');
    }
    const firstRunAt = new Date(firstRunTimestamp).toISOString();
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
        throw new BadRequestException('variance_escalation_threshold supports at most four decimal places');
      }
      varianceThreshold = Number(fixedThreshold);
    }

    const notes = dto.notes?.trim() || null;
    const idempotencyKey = this.requiredIdempotencyKey(rawIdempotencyKey);
    const requestHash = this.hash({
      itemId, locationId, assignedToUserId, cadenceUnit, cadenceInterval,
      firstRunAt, priority, blindCount, varianceThreshold, notes,
    });

    let result: InventoryCycleCountRecurringPolicy;
    try {
      result = await this.database.transaction({
        tenantId,
        userId,
        advisoryLockKey: `inventory-cycle-count-recurring-create:${tenantId}:${factoryId}:${idempotencyKey}`,
      }, async (client) => {
        const existing = await client.query<RecurringPolicyRow>(
          `SELECT ${POLICY_COLUMNS}
           FROM inventory_cycle_count_recurring_policies
           WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3
           LIMIT 1 FOR UPDATE`,
          [tenantId, factoryId, idempotencyKey],
        );
        if (existing.rows[0]) return this.replayOrConflict(existing.rows[0], requestHash);

        const item = await client.query<{ id: string }>(
          `SELECT id::text AS id FROM inventory_items
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
          if (!location.rows[0]) {
            throw new NotFoundException('Active bin not found in this factory');
          }
        }

        const duplicateAfterLock = await client.query<RecurringPolicyRow>(
          `SELECT ${POLICY_COLUMNS}
           FROM inventory_cycle_count_recurring_policies
           WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3
           LIMIT 1 FOR UPDATE`,
          [tenantId, factoryId, idempotencyKey],
        );
        if (duplicateAfterLock.rows[0]) {
          return this.replayOrConflict(duplicateAfterLock.rows[0], requestHash);
        }

        const inserted = await client.query<RecurringPolicyRow>(
          `INSERT INTO inventory_cycle_count_recurring_policies (
             tenant_id, factory_id, item_id, location_id, assigned_to_user_id,
             cadence_unit, cadence_interval, anchor_at, next_occurrence_number,
             next_run_at, priority, blind_count, variance_escalation_threshold,
             status, idempotency_key, request_hash, notes, created_by_user_id
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8::timestamptz, 0,
             $8::timestamptz, $9, $10, $11::numeric,
             'ACTIVE', $12, $13, $14, $15
           )
           RETURNING ${POLICY_COLUMNS}`,
          [
            tenantId, factoryId, itemId, locationId, assignedToUserId,
            cadenceUnit, cadenceInterval, firstRunAt, priority, blindCount,
            varianceThreshold, idempotencyKey, requestHash, notes, userId,
          ],
        );
        const policy = inserted.rows[0];
        if (!policy) throw new Error('INVENTORY_CYCLE_COUNT_RECURRING_POLICY_CREATE_FAILED');

        await this.insertOutboxEvent(client, {
          tenantId, factoryId, aggregateType: 'INVENTORY_CYCLE_COUNT_RECURRING_POLICY',
          aggregateId: policy.id, correlationId: this.correlationId(requestId, traceId),
          userId, eventType: 'INVENTORY.CYCLE_COUNT_RECURRING_POLICY_CREATED',
          payload: {
            policy_id: policy.id, item_id: itemId, location_id: locationId,
            assigned_to_user_id: assignedToUserId, cadence_unit: cadenceUnit,
            cadence_interval: cadenceInterval, first_run_at: firstRunAt,
            priority, blind_count: blindCount, variance_escalation_threshold: varianceThreshold,
            status: 'ACTIVE',
          },
        });
        return this.toPolicy(policy, false);
      });
    } catch (error) {
      if (this.errorCode(error) !== '23505') throw error;
      const stored = await this.database.query<RecurringPolicyRow>(
        `SELECT ${POLICY_COLUMNS}
         FROM inventory_cycle_count_recurring_policies
         WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3
         LIMIT 1`,
        [tenantId, factoryId, idempotencyKey],
        { tenantId, userId },
      );
      if (!stored.rows[0]) {
        throw new ConflictException('Recurring cycle-count policy conflicts with an existing record');
      }
      result = this.replayOrConflict(stored.rows[0], requestHash);
    }

    if (!result.replayed) {
      await this.recordAuditSafely({
        tenantId, factoryId, userId, requestId, traceId, resourceId: result.id,
        action: 'CYCLE_COUNT_RECURRING_POLICY_CREATE',
        payload: {
          item_id: result.item_id, location_id: result.location_id,
          assigned_to_user_id: result.assigned_to_user_id, cadence_unit: result.cadence_unit,
          cadence_interval: result.cadence_interval, anchor_at: result.anchor_at,
          next_run_at: result.next_run_at, priority: result.priority,
          blind_count: result.blind_count,
          variance_escalation_threshold: result.variance_escalation_threshold,
        },
      });
    }
    return result;
  }

  async listPolicies(
    userId: string,
    tenantId: string,
    factoryId: string,
    options: { status?: string; limit?: number } = {},
  ): Promise<InventoryCycleCountRecurringPolicy[]> {
    this.validateScope(userId, tenantId, factoryId);
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }
    const status = options.status?.trim().toUpperCase() || null;
    if (status && !['ACTIVE', 'PAUSED', 'RETIRED'].includes(status)) {
      throw new BadRequestException('status must be ACTIVE, PAUSED or RETIRED');
    }

    const result = await this.database.query<RecurringPolicyRow>(
      `SELECT ${POLICY_COLUMNS}
       FROM inventory_cycle_count_recurring_policies
       WHERE tenant_id = $1 AND factory_id = $2
         AND ($3::text IS NULL OR status = $3)
       ORDER BY CASE WHEN status = 'ACTIVE' THEN 0 ELSE 1 END,
                next_run_at ASC, id ASC
       LIMIT $4`,
      [tenantId, factoryId, status, limit],
      { tenantId, userId },
    );
    return result.rows.map((row) => this.toPolicy(row, false));
  }

  async pausePolicy(
    userId: string,
    tenantId: string,
    factoryId: string,
    policyId: string,
    requestId: string | null,
    traceId: string | null,
  ): Promise<InventoryCycleCountRecurringPolicy> {
    return this.transitionPolicy(userId, tenantId, factoryId, policyId, 'PAUSED', requestId, traceId);
  }

  async resumePolicy(
    userId: string,
    tenantId: string,
    factoryId: string,
    policyId: string,
    requestId: string | null,
    traceId: string | null,
  ): Promise<InventoryCycleCountRecurringPolicy> {
    return this.transitionPolicy(userId, tenantId, factoryId, policyId, 'ACTIVE', requestId, traceId);
  }

  async retirePolicy(
    userId: string,
    tenantId: string,
    factoryId: string,
    policyId: string,
    requestId: string | null,
    traceId: string | null,
  ): Promise<InventoryCycleCountRecurringPolicy> {
    return this.transitionPolicy(userId, tenantId, factoryId, policyId, 'RETIRED', requestId, traceId);
  }

  async materializeDue(
    userId: string,
    tenantId: string,
    factoryId: string,
    limit = 50,
    requestId: string | null = null,
    traceId: string | null = null,
  ): Promise<{
    materialized_count: number;
    blocked_policy_count: number;
    limit: number;
    occurrences: MaterializedOccurrence[];
  }> {
    this.validateScope(userId, tenantId, factoryId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }

    const result = await this.database.transaction({
      tenantId,
      userId,
      advisoryLockKey: `inventory-cycle-count-recurring-materialize:${tenantId}:${factoryId}`,
    }, async (client) => {
      const blocked = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM inventory_cycle_count_recurring_policies p
         WHERE p.tenant_id = $1 AND p.factory_id = $2
           AND p.status = 'ACTIVE' AND p.next_run_at <= clock_timestamp()
           AND (
             NOT EXISTS (
               SELECT 1 FROM inventory_items i
               WHERE i.id = p.item_id AND i.tenant_id = p.tenant_id
                 AND i.factory_id = p.factory_id AND i.status = 'ACTIVE'
             )
             OR NOT EXISTS (
               SELECT 1 FROM users u
               JOIN tenant_memberships tm ON tm.user_id = u.id
               WHERE u.id = p.assigned_to_user_id AND u.status = 'ACTIVE'
                 AND tm.tenant_id = p.tenant_id AND tm.status = 'ACTIVE'
             )
             OR (p.location_id IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM inventory_locations l
               JOIN inventory_locations parent
                 ON parent.id = l.parent_location_id AND parent.tenant_id = l.tenant_id
                AND parent.factory_id = l.factory_id
               WHERE l.id = p.location_id AND l.tenant_id = p.tenant_id
                 AND l.factory_id = p.factory_id AND l.location_type = 'BIN'
                 AND l.status = 'ACTIVE' AND parent.location_type IN ('WAREHOUSE', 'STAGING')
                 AND parent.status = 'ACTIVE'
             ))
           )`,
        [tenantId, factoryId],
      );

      const due = await client.query<RecurringPolicyRow>(
        `SELECT ${POLICY_COLUMNS_P}
         FROM inventory_cycle_count_recurring_policies p
         JOIN inventory_items i
           ON i.id = p.item_id AND i.tenant_id = p.tenant_id
          AND i.factory_id = p.factory_id AND i.status = 'ACTIVE'
         JOIN users u ON u.id = p.assigned_to_user_id AND u.status = 'ACTIVE'
         JOIN tenant_memberships tm
           ON tm.user_id = u.id AND tm.tenant_id = p.tenant_id AND tm.status = 'ACTIVE'
         LEFT JOIN inventory_locations l
           ON l.id = p.location_id AND l.tenant_id = p.tenant_id
          AND l.factory_id = p.factory_id AND l.location_type = 'BIN' AND l.status = 'ACTIVE'
         LEFT JOIN inventory_locations parent
           ON parent.id = l.parent_location_id AND parent.tenant_id = l.tenant_id
          AND parent.factory_id = l.factory_id
          AND parent.location_type IN ('WAREHOUSE', 'STAGING') AND parent.status = 'ACTIVE'
         WHERE p.tenant_id = $1 AND p.factory_id = $2
           AND p.status = 'ACTIVE' AND p.next_run_at <= clock_timestamp()
           AND (p.location_id IS NULL OR parent.id IS NOT NULL)
         ORDER BY p.next_run_at ASC, p.id ASC
         LIMIT $3
         FOR UPDATE OF p SKIP LOCKED`,
        [tenantId, factoryId, limit],
      );

      const occurrences: MaterializedOccurrence[] = [];
      for (const policy of due.rows) {
        const scheduledFor = policy.next_run_at;
        const occurrenceNumber = Number(policy.next_occurrence_number);
        if (!Number.isSafeInteger(occurrenceNumber) || occurrenceNumber < 0 || occurrenceNumber >= 100000) {
          throw new ConflictException('Recurring policy occurrence cursor reached its supported limit');
        }

        const taskKey = `recurring-cycle-count:${policy.id}:${occurrenceNumber}`;
        const requestHash = this.hash({
          policyId: policy.id, occurrenceNumber, scheduledFor,
          itemId: policy.item_id, locationId: policy.location_id,
          assignedToUserId: policy.assigned_to_user_id, priority: policy.priority,
          blindCount: policy.blind_count,
          varianceEscalationThreshold: policy.variance_escalation_threshold,
        });

        const existing = await client.query<{ id: string }>(
          `SELECT id::text AS id
           FROM inventory_cycle_count_recurring_policy_occurrences
           WHERE tenant_id = $1 AND factory_id = $2
             AND policy_id = $3 AND occurrence_number = $4
           LIMIT 1`,
          [tenantId, factoryId, policy.id, occurrenceNumber],
        );
        if (existing.rows[0]) {
          throw new ConflictException('Recurring policy cursor points to an already materialized occurrence');
        }

        const task = await client.query<{ id: string }>(
          `INSERT INTO inventory_cycle_count_tasks (
             tenant_id, factory_id, item_id, location_id, assigned_to_user_id,
             due_at, priority, status, blind_count, variance_escalation_threshold,
             idempotency_key, request_hash, notes, created_by_user_id
           ) VALUES (
             $1, $2, $3, $4, $5, $6::timestamptz, $7, 'SCHEDULED', $8, $9::numeric,
             $10, $11, $12, $13
           )
           RETURNING id::text AS id`,
          [
            tenantId, factoryId, policy.item_id, policy.location_id, policy.assigned_to_user_id,
            scheduledFor, policy.priority, policy.blind_count, policy.variance_escalation_threshold,
            taskKey, requestHash, policy.notes, policy.created_by_user_id,
          ],
        );
        const taskId = task.rows[0]?.id;
        if (!taskId) throw new Error('INVENTORY_CYCLE_COUNT_RECURRING_TASK_CREATE_FAILED');

        await client.query(
          `INSERT INTO inventory_cycle_count_recurring_policy_occurrences (
             tenant_id, factory_id, policy_id, task_id, occurrence_number, scheduled_for, request_hash
           ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7)`,
          [tenantId, factoryId, policy.id, taskId, occurrenceNumber, scheduledFor, requestHash],
        );

        const cursor = await client.query<{
          next_run_at: string;
        }>(
          `UPDATE inventory_cycle_count_recurring_policies
           SET next_occurrence_number = next_occurrence_number + 1,
               last_run_at = next_run_at,
               next_run_at = public.factoryos_cycle_count_recurring_expected_run(
                 anchor_at, cadence_unit, cadence_interval, next_occurrence_number + 1
               ),
               updated_at = clock_timestamp(),
               version = version + 1
           WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
             AND status = 'ACTIVE' AND next_occurrence_number = $4
           RETURNING next_run_at::text AS next_run_at`,
          [policy.id, tenantId, factoryId, occurrenceNumber],
        );
        if (cursor.rowCount !== 1 || !cursor.rows[0]) {
          throw new ConflictException('Recurring policy cursor changed while materializing an occurrence');
        }

        await this.insertOutboxEvent(client, {
          tenantId, factoryId, aggregateType: 'INVENTORY_CYCLE_COUNT_TASK', aggregateId: taskId,
          correlationId: this.correlationId(requestId, traceId), userId,
          eventType: 'INVENTORY.CYCLE_COUNT_TASK_SCHEDULED',
          payload: {
            task_id: taskId, recurring_policy_id: policy.id,
            recurring_occurrence_number: occurrenceNumber, recurring_occurrence_at: scheduledFor,
            item_id: policy.item_id, location_id: policy.location_id,
            assigned_to_user_id: policy.assigned_to_user_id, due_at: scheduledFor,
            priority: policy.priority, blind_count: policy.blind_count,
            variance_escalation_threshold: policy.variance_escalation_threshold,
            status: 'SCHEDULED',
          },
        });
        await this.insertOutboxEvent(client, {
          tenantId, factoryId, aggregateType: 'INVENTORY_CYCLE_COUNT_RECURRING_POLICY',
          aggregateId: policy.id, correlationId: this.correlationId(requestId, traceId),
          userId, eventType: 'INVENTORY.CYCLE_COUNT_RECURRING_OCCURRENCE_MATERIALIZED',
          payload: {
            policy_id: policy.id, task_id: taskId, occurrence_number: occurrenceNumber,
            scheduled_for: scheduledFor, next_run_at: cursor.rows[0].next_run_at,
          },
        });

        occurrences.push({
          policy_id: policy.id, task_id: taskId, occurrence_number: occurrenceNumber,
          scheduled_for: scheduledFor, next_run_at: cursor.rows[0].next_run_at,
        });
      }

      return {
        materialized_count: occurrences.length,
        blocked_policy_count: Number(blocked.rows[0]?.count ?? '0'),
        limit,
        occurrences,
      };
    });

    if (result.materialized_count > 0) {
      await this.recordAuditSafely({
        tenantId, factoryId, userId, requestId, traceId,
        resourceId: result.occurrences[0].policy_id,
        action: 'CYCLE_COUNT_RECURRING_MATERIALIZE_DUE',
        payload: {
          materialized_count: result.materialized_count,
          blocked_policy_count: result.blocked_policy_count,
          occurrences: result.occurrences,
        },
      });
    }
    return result;
  }

  private async transitionPolicy(
    userId: string,
    tenantId: string,
    factoryId: string,
    policyId: string,
    desiredStatus: InventoryCycleCountRecurringPolicyStatus,
    requestId: string | null,
    traceId: string | null,
  ): Promise<InventoryCycleCountRecurringPolicy> {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(policyId, 'policyId');

    const result = await this.database.transaction({ tenantId, userId }, async (client) => {
      const selected = await client.query<RecurringPolicyRow>(
        `SELECT ${POLICY_COLUMNS}
         FROM inventory_cycle_count_recurring_policies
         WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
         FOR UPDATE`,
        [policyId, tenantId, factoryId],
      );
      const policy = selected.rows[0];
      if (!policy) throw new NotFoundException('Recurring cycle-count policy not found in this factory');
      if (policy.status === desiredStatus) return { policy, replayed: true };

      const allowed =
        (policy.status === 'ACTIVE' && ['PAUSED', 'RETIRED'].includes(desiredStatus))
        || (policy.status === 'PAUSED' && ['ACTIVE', 'RETIRED'].includes(desiredStatus));
      if (!allowed) {
        throw new ConflictException('Recurring cycle-count policy is retired or cannot make this status transition');
      }

      const updated = await client.query<RecurringPolicyRow>(
        `UPDATE inventory_cycle_count_recurring_policies
         SET status = $4, updated_at = clock_timestamp(), version = version + 1
         WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
         RETURNING ${POLICY_COLUMNS}`,
        [policyId, tenantId, factoryId, desiredStatus],
      );
      if (!updated.rows[0]) throw new ConflictException('Recurring policy status transition was not applied');

      await this.insertOutboxEvent(client, {
        tenantId, factoryId, aggregateType: 'INVENTORY_CYCLE_COUNT_RECURRING_POLICY',
        aggregateId: policyId, correlationId: this.correlationId(requestId, traceId),
        userId, eventType: `INVENTORY.CYCLE_COUNT_RECURRING_POLICY_${desiredStatus}`,
        payload: { policy_id: policyId, from_status: policy.status, to_status: desiredStatus },
      });
      return { policy: updated.rows[0], previousStatus: policy.status, replayed: false };
    });

    if (!result.replayed) {
      await this.recordAuditSafely({
        tenantId, factoryId, userId, requestId, traceId, resourceId: policyId,
        action: `CYCLE_COUNT_RECURRING_POLICY_${desiredStatus}`,
        payload: { from_status: result.previousStatus, to_status: desiredStatus },
      });
    }
    return this.toPolicy(result.policy, result.replayed);
  }

  private replayOrConflict(
    row: RecurringPolicyRow,
    requestHash: string,
  ): InventoryCycleCountRecurringPolicy {
    if (row.request_hash !== requestHash) {
      throw new ConflictException('Idempotency-Key was reused for a different recurring cycle-count policy');
    }
    return this.toPolicy(row, true);
  }

  private toPolicy(
    row: RecurringPolicyRow,
    replayed: boolean,
  ): InventoryCycleCountRecurringPolicy {
    const { idempotency_key, request_hash, ...policy } = row;
    void idempotency_key;
    void request_hash;
    return { ...policy, replayed };
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
        JSON.stringify({ system: 'FactoryOS', connector: 'inventory-cycle-count-recurring-policy', version: process.env.APP_VERSION ?? process.env.npm_package_version ?? '0.1.0' }),
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
        resourceType: 'INVENTORY_CYCLE_COUNT_RECURRING_POLICY',
        resourceId: input.resourceId,
        requestId: input.requestId && isUUID(input.requestId) ? input.requestId : null,
        correlationId: input.traceId && isUUID(input.traceId) ? input.traceId : null,
        dataClass: 'INTERNAL',
        payload: input.payload,
      });
    } catch {
      // A transactionally committed outbox event and the database policy ledger remain durable evidence.
    }
  }

  private requiredIdempotencyKey(rawKey: string | null): string {
    const key = rawKey?.trim() ?? '';
    if (!key) throw new BadRequestException('Idempotency-Key is required for recurring cycle-count policy creation');
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
    if (!isUUID(value)) throw new BadRequestException(`${field} must be a valid UUID`);
  }

  private errorCode(error: unknown): string | undefined {
    if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
}
