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
import {
  STOCK_RECONCILIATION_REASON_CODES,
  type StockReconciliationReasonCode,
} from './dto/create-inventory-stock-reconciliation.dto';

interface ReconciliationRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  item_id: string;
  quantity_before: string;
  counted_quantity: string;
  quantity_delta: string;
  quantity_after: string;
  reason_code: StockReconciliationReasonCode;
  idempotency_key: string;
  request_hash: string;
  adjustment_movement_id: string | null;
  notes: string | null;
  created_by_user_id: string;
  correlation_id: string;
  created_at: string;
  location_id: string | null;
  location_quantity_before: string | null;
  location_counted_quantity: string | null;
  location_quantity_after: string | null;
}

interface InventoryMovementRow extends QueryResultRow {
  id: string;
  movement_type: 'RECEIPT' | 'ISSUE';
  quantity: string;
  quantity_delta: string;
  quantity_after: string;
  location_id: string | null;
}

interface LockedBalanceRow extends QueryResultRow {
  quantity_before: string;
  quantity_reserved: string;
  balance_version: string;
  quantity_delta: string;
  count_covers_reservations: boolean;
  has_variance: boolean;
  variance_is_positive: boolean;
}

export type InventoryStockReconciliationRecord = Omit<
  ReconciliationRow,
  'idempotency_key' | 'request_hash'
>;

export type InventoryStockReconciliationResult =
  InventoryStockReconciliationRecord & { replayed: boolean };

const RECONCILIATION_COLUMNS = `
  id::text AS id,
  tenant_id::text AS tenant_id,
  factory_id::text AS factory_id,
  item_id::text AS item_id,
  quantity_before::text AS quantity_before,
  counted_quantity::text AS counted_quantity,
  quantity_delta::text AS quantity_delta,
  quantity_after::text AS quantity_after,
  reason_code,
  idempotency_key,
  request_hash,
  adjustment_movement_id::text AS adjustment_movement_id,
  notes,
  created_by_user_id::text AS created_by_user_id,
  correlation_id::text AS correlation_id,
  created_at::text AS created_at,
  location_id::text AS location_id,
  location_quantity_before::text AS location_quantity_before,
  location_counted_quantity::text AS location_counted_quantity,
  location_quantity_after::text AS location_quantity_after
`;

@Injectable()
export class InventoryStockReconciliationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly auditService: AuditService,
  ) {}

  async recordReconciliation(
    userId: string,
    tenantId: string,
    factoryId: string,
    itemId: string,
    dto: {
      counted_quantity: number;
      reason_code: StockReconciliationReasonCode;
      notes?: string;
    },
    rawIdempotencyKey: string | null,
    requestId: string | null,
    traceId: string | null,
    cycleCountReview?: {
      proposalId: string;
      decisionIdempotencyKey: string;
      reviewRequestHash: string;
      reviewNote: string | null;
      locationId?: string;
      locationCountedQuantity?: string;
      locationQuantityAtCount?: string | null;
      locationVersionAtCount?: string | null;
    },
  ): Promise<InventoryStockReconciliationResult> {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(itemId, 'itemId');

    if (
      !Number.isFinite(dto.counted_quantity)
      || dto.counted_quantity < 0
      || dto.counted_quantity > 99999999999999
    ) {
      throw new BadRequestException(
        'counted_quantity must be between 0 and 99999999999999',
      );
    }
    if (
      Math.abs(
        dto.counted_quantity * 10000
          - Math.round(dto.counted_quantity * 10000),
      ) > 0.000001
    ) {
      throw new BadRequestException(
        'counted_quantity supports at most 4 decimal places',
      );
    }
    if (
      !STOCK_RECONCILIATION_REASON_CODES.includes(dto.reason_code)
    ) {
      throw new BadRequestException('reason_code is invalid');
    }
    if (dto.reason_code === 'CYCLE_COUNT' && !cycleCountReview) {
      throw new ConflictException(
        'Cycle counts must be submitted and approved through the cycle-count review workflow',
      );
    }
    if (cycleCountReview) this.validateUuid(cycleCountReview.proposalId, 'proposalId');

    const idempotencyKey = this.requiredIdempotencyKey(rawIdempotencyKey);
    const countedQuantity = dto.counted_quantity.toFixed(4);
    const reasonCode = dto.reason_code;
    const notes = dto.notes?.trim() || null;
    const normalizedItemId = itemId.toLowerCase();
    const requestHash = createHash('sha256')
      .update(JSON.stringify({
        itemId: normalizedItemId,
        countedQuantity,
        reasonCode,
        notes,
      }))
      .digest('hex');

    let result: InventoryStockReconciliationResult;
    try {
      result = await this.database.transaction(
        { tenantId, userId },
        async (client) => {
          let cycleCountSnapshot: {
            ledger_quantity_at_count: string;
            balance_version_at_count: string;
            counted_quantity: string;
            location_id: string | null;
            location_quantity_at_count: string | null;
            location_version_at_count: string | null;
            approved_quantity: string;
          } | null = null;
          if (cycleCountReview) {
            const workflowResult = await client.query<{
              id: string;
              status: 'PENDING_REVIEW' | 'REJECTED' | 'APPLIED';
              created_by_user_id: string;
              ledger_quantity_at_count: string;
              balance_version_at_count: string;
              counted_quantity: string;
              location_id: string | null;
              location_quantity_at_count: string | null;
              location_version_at_count: string | null;
              approved_quantity: string;
              reviewed_by_user_id: string | null;
              review_idempotency_key: string | null;
              review_request_hash: string | null;
              reconciliation_id: string | null;
            }>(
              `
              SELECT
                id::text AS id,
                status,
                created_by_user_id::text AS created_by_user_id,
                ledger_quantity_at_count::text AS ledger_quantity_at_count,
                balance_version_at_count::text AS balance_version_at_count,
                counted_quantity::text AS counted_quantity,
                location_id::text AS location_id,
                location_quantity_at_count::text AS location_quantity_at_count,
                location_version_at_count::text AS location_version_at_count,
                CASE WHEN location_id IS NULL THEN counted_quantity::numeric(18,4)::text
                     ELSE (ledger_quantity_at_count + counted_quantity - location_quantity_at_count)::numeric(18,4)::text END AS approved_quantity,
                reviewed_by_user_id::text AS reviewed_by_user_id,
                review_idempotency_key,
                review_request_hash,
                reconciliation_id::text AS reconciliation_id
              FROM inventory_cycle_count_proposals
              WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 AND item_id = $4
              FOR UPDATE
              `,
              [cycleCountReview.proposalId, tenantId, factoryId, normalizedItemId],
            );
            const proposal = workflowResult.rows[0];
            if (!proposal) {
              throw new NotFoundException('Cycle-count proposal not found in this factory');
            }
            cycleCountSnapshot = {
              ledger_quantity_at_count: proposal.ledger_quantity_at_count,
              balance_version_at_count: proposal.balance_version_at_count,
              counted_quantity: proposal.counted_quantity,
              location_id: proposal.location_id,
              location_quantity_at_count: proposal.location_quantity_at_count,
              location_version_at_count: proposal.location_version_at_count,
              approved_quantity: proposal.approved_quantity,
            };
            if (proposal.approved_quantity !== countedQuantity) {
              throw new ConflictException('Cycle-count approval quantity does not match the immutable submitted snapshot');
            }
            if (cycleCountReview.locationId !== (proposal.location_id ?? undefined)) {
              throw new ConflictException('Cycle-count location does not match the submitted proposal');
            }
            if (proposal.created_by_user_id === userId) {
              throw new ConflictException('The user who submitted a cycle count cannot approve it');
            }
            if (proposal.status === 'REJECTED') {
              throw new ConflictException('A rejected cycle count cannot be applied');
            }
            if (proposal.status === 'APPLIED') {
              if (
                proposal.reviewed_by_user_id !== userId
                || proposal.review_idempotency_key !== cycleCountReview.decisionIdempotencyKey
                || proposal.review_request_hash !== cycleCountReview.reviewRequestHash
                || !proposal.reconciliation_id
              ) {
                throw new ConflictException('Cycle count already has a different review decision');
              }
              const storedReconciliation = await client.query<ReconciliationRow>(
                `
                SELECT ${RECONCILIATION_COLUMNS}
                FROM inventory_stock_reconciliations
                WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
                LIMIT 1
                `,
                [proposal.reconciliation_id, tenantId, factoryId],
              );
              const stored = storedReconciliation.rows[0];
              if (!stored) {
                throw new ConflictException('Applied cycle count is missing its reconciliation record');
              }
              return this.replayOrConflict(stored, requestHash);
            }
            if (proposal.status !== 'PENDING_REVIEW') {
              throw new ConflictException('Cycle count is not awaiting review');
            }
          }

          const existingBeforeLock = await this.findByIdempotencyKey(
            client, tenantId, factoryId, idempotencyKey,
          );
          if (existingBeforeLock) {
            return this.replayOrConflict(existingBeforeLock, requestHash);
          }

          const itemResult = await client.query<{
            id: string;
            status: 'ACTIVE' | 'DISABLED';
          }>(
            `
            SELECT id::text AS id, status
            FROM inventory_items
            WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
            FOR UPDATE
            `,
            [normalizedItemId, tenantId, factoryId],
          );
          const item = itemResult.rows[0];
          if (!item) {
            throw new NotFoundException('Inventory item not found in this factory');
          }
          if (item.status !== 'ACTIVE') {
            throw new ConflictException(
              'Disabled inventory items cannot be reconciled',
            );
          }

          // Stock writers lock the item first. The same lock order makes the
          // captured ledger quantity and the physical count comparison atomic.
          const existingAfterLock = await this.findByIdempotencyKey(
            client, tenantId, factoryId, idempotencyKey,
          );
          if (existingAfterLock) {
            return this.replayOrConflict(existingAfterLock, requestHash);
          }

          const balanceResult = await client.query<LockedBalanceRow>(
            `
            SELECT
              b.quantity_on_hand::text AS quantity_before,
              b.quantity_reserved::text AS quantity_reserved,
              b.version::text AS balance_version,
              ($1::numeric - b.quantity_on_hand)::numeric(18, 4)::text AS quantity_delta,
              ($1::numeric >= b.quantity_reserved) AS count_covers_reservations,
              ($1::numeric <> b.quantity_on_hand) AS has_variance,
              ($1::numeric > b.quantity_on_hand) AS variance_is_positive
            FROM inventory_stock_balances b
            WHERE b.tenant_id = $2
              AND b.factory_id = $3
              AND b.item_id = $4
            FOR UPDATE
            `,
            [countedQuantity, tenantId, factoryId, normalizedItemId],
          );
          const balance = balanceResult.rows[0];
          if (!balance) {
            throw new ConflictException(
              'Inventory stock balance is not initialized for this item',
            );
          }
          if (
            cycleCountSnapshot
            && (
              balance.quantity_before !== cycleCountSnapshot.ledger_quantity_at_count
              || balance.balance_version !== cycleCountSnapshot.balance_version_at_count
            )
          ) {
            throw new ConflictException(
              'Inventory stock changed after this cycle count was submitted; submit a fresh physical count',
            );
          }
          let locationSnapshotForReconciliation: {
            quantity_before: string;
            version: string;
            quantity_reserved: string;
          } | null = null;
          if (cycleCountSnapshot?.location_id) {
            const locationBalanceResult = await client.query<{
              quantity_before: string;
              version: string;
              quantity_reserved: string;
            }>(
              `
              SELECT quantity_on_hand::text AS quantity_before,
                     version::text AS version,
                     quantity_reserved::text AS quantity_reserved
              FROM inventory_location_balances
              WHERE tenant_id = $1 AND factory_id = $2
                AND item_id = $3 AND location_id = $4
              FOR UPDATE
              `,
              [tenantId, factoryId, normalizedItemId, cycleCountSnapshot.location_id],
            );
            const locationBalance = locationBalanceResult.rows[0];
            if (!locationBalance) {
              throw new ConflictException('Cycle-count bin balance is no longer available; submit a fresh count');
            }
            if (
              locationBalance.quantity_before !== cycleCountSnapshot.location_quantity_at_count
              || locationBalance.version !== cycleCountSnapshot.location_version_at_count
            ) {
              throw new ConflictException(
                'Bin stock changed after this cycle count was submitted; submit a fresh physical count',
              );
            }
            if (
              Number(cycleCountSnapshot.counted_quantity) < Number(locationBalance.quantity_reserved)
            ) {
              throw new ConflictException('Physical bin count cannot be lower than the quantity reserved in the bin');
            }
            locationSnapshotForReconciliation = locationBalance;
          }
          if (!balance.count_covers_reservations) {
            throw new ConflictException(
              'Physical count cannot be lower than the quantity reserved for open work',
            );
          }

          const reconciliationId = randomUUID();
          const correlationId = this.correlationId(requestId, traceId);
          let movementId: string | null = null;

          if (balance.has_variance) {
            if (cycleCountSnapshot?.location_id) {
              await client.query(
                `SELECT set_config('app.inventory_location_id', $1, true)`,
                [cycleCountSnapshot.location_id],
              );
            }
            const updatedBalance = await client.query<{ quantity_on_hand: string }>(
              `
              UPDATE inventory_stock_balances
              SET
                quantity_on_hand = $1::numeric,
                version = version + 1,
                updated_at = clock_timestamp()
              WHERE tenant_id = $2
                AND factory_id = $3
                AND item_id = $4
                AND $1::numeric >= quantity_reserved
              RETURNING quantity_on_hand::text AS quantity_on_hand
              `,
              [countedQuantity, tenantId, factoryId, normalizedItemId],
            );
            if (!updatedBalance.rows[0]) {
              throw new ConflictException(
                'Inventory count would violate reserved-stock constraints',
              );
            }

            const movementType = balance.variance_is_positive
              ? 'RECEIPT'
              : 'ISSUE';
            const movementNotes = notes
              ?? 'Stock reconciliation (' + reasonCode + ')';
            const movementResult = await client.query<InventoryMovementRow>(
              `
              INSERT INTO inventory_movements (
                tenant_id, factory_id, item_id, movement_type, quantity,
                quantity_delta, quantity_after, idempotency_key, request_hash,
                reference_type, reference_id, notes, created_by_user_id, correlation_id,
                location_id
              )
              VALUES (
                $1, $2, $3, $4, ABS($5::numeric), $5::numeric, $6::numeric,
                $7, $8, 'STOCK_RECONCILIATION', $9::uuid, $10, $11, $12::uuid,
                $13::uuid
              )
              RETURNING
                id::text AS id,
                movement_type,
                quantity::text AS quantity,
                quantity_delta::text AS quantity_delta,
                quantity_after::text AS quantity_after
              `,
              [
                tenantId,
                factoryId,
                normalizedItemId,
                movementType,
                balance.quantity_delta,
                countedQuantity,
                'stock-reconciliation:' + reconciliationId,
                requestHash,
                reconciliationId,
                movementNotes,
                userId,
                correlationId,
                cycleCountSnapshot?.location_id ?? null,
              ],
            );
            const movement = movementResult.rows[0];
            if (!movement) {
              throw new Error('INVENTORY_RECONCILIATION_MOVEMENT_INSERT_FAILED');
            }
            movementId = movement.id;
          }

          const reconciliationResult = await client.query<ReconciliationRow>(
            `
            INSERT INTO inventory_stock_reconciliations (
              id, tenant_id, factory_id, item_id, quantity_before,
              counted_quantity, quantity_delta, quantity_after, reason_code,
              idempotency_key, request_hash, adjustment_movement_id, notes,
              created_by_user_id, correlation_id, location_id,
              location_quantity_before, location_counted_quantity, location_quantity_after
            )
            VALUES (
              $1::uuid, $2, $3, $4, $5::numeric, $6::numeric,
              $7::numeric, $6::numeric, $8, $9, $10, $11::uuid,
              $12, $13, $14::uuid, $15::uuid, $16::numeric, $17::numeric, $18::numeric
            )
            RETURNING ${RECONCILIATION_COLUMNS}
            `,
            [
              reconciliationId,
              tenantId,
              factoryId,
              normalizedItemId,
              balance.quantity_before,
              countedQuantity,
              balance.quantity_delta,
              reasonCode,
              idempotencyKey,
              requestHash,
              movementId,
              notes,
              userId,
              correlationId,
              cycleCountSnapshot?.location_id ?? null,
              locationSnapshotForReconciliation?.quantity_before ?? null,
              cycleCountSnapshot?.location_id ? cycleCountSnapshot.counted_quantity : null,
              cycleCountSnapshot?.location_id ? Number(cycleCountSnapshot.counted_quantity).toFixed(4) : null,
            ],
          );
          const reconciliation = reconciliationResult.rows[0];
          if (!reconciliation) {
            throw new Error('INVENTORY_STOCK_RECONCILIATION_INSERT_FAILED');
          }

          await this.insertOutboxEvent(client, {
            tenantId,
            factoryId,
            aggregateId: normalizedItemId,
            correlationId,
            userId,
            payload: {
              reconciliation: {
                id: reconciliation.id,
                item_id: reconciliation.item_id,
                quantity_before: reconciliation.quantity_before,
                counted_quantity: reconciliation.counted_quantity,
                quantity_delta: reconciliation.quantity_delta,
                quantity_after: reconciliation.quantity_after,
                location_id: reconciliation.location_id,
                location_quantity_before: reconciliation.location_quantity_before,
                location_counted_quantity: reconciliation.location_counted_quantity,
                location_quantity_after: reconciliation.location_quantity_after,
                reason_code: reconciliation.reason_code,
                adjustment_movement_id: reconciliation.adjustment_movement_id,
              },
            },
          });

          if (cycleCountReview) {
            const applied = await client.query<{ id: string }>(
              `
              UPDATE inventory_cycle_count_proposals
              SET status = 'APPLIED',
                  reviewed_by_user_id = $1,
                  reviewed_at = clock_timestamp(),
                  review_decision = 'APPROVE',
                  review_idempotency_key = $2,
                  review_request_hash = $3,
                  review_note = $4,
                  reconciliation_id = $5::uuid
              WHERE id = $6
                AND tenant_id = $7
                AND factory_id = $8
                AND item_id = $9
                AND status = 'PENDING_REVIEW'
                AND created_by_user_id <> $1
              RETURNING id::text AS id
              `,
              [
                userId,
                cycleCountReview.decisionIdempotencyKey,
                cycleCountReview.reviewRequestHash,
                cycleCountReview.reviewNote,
                reconciliation.id,
                cycleCountReview.proposalId,
                tenantId,
                factoryId,
                normalizedItemId,
              ],
            );
            if (!applied.rows[0]) {
              throw new ConflictException('Cycle-count approval lost its pending state');
            }
            await this.insertCycleCountApprovedEvent(client, {
              tenantId,
              factoryId,
              proposalId: cycleCountReview.proposalId,
              itemId: normalizedItemId,
              reconciliationId: reconciliation.id,
              correlationId,
              userId,
              quantityDelta: reconciliation.quantity_delta,
              reviewNote: cycleCountReview.reviewNote,
            });
          }

          return this.toResult(reconciliation, false);
        },
      );
    } catch (error) {
      if (this.errorCode(error) !== '23505') throw error;

      // The unique (tenant, factory, idempotency key) constraint arbitrates
      // concurrent retries even when the requests target different items.
      const stored = await this.database.query<ReconciliationRow>(
        `
        SELECT ${RECONCILIATION_COLUMNS}
        FROM inventory_stock_reconciliations
        WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3
        LIMIT 1
        `,
        [tenantId, factoryId, idempotencyKey],
        { tenantId, userId },
      );
      if (!stored.rows[0]) {
        throw new ConflictException(
          'Inventory stock reconciliation conflicts with an existing record',
        );
      }
      result = this.replayOrConflict(stored.rows[0], requestHash);
    }

    if (!result.replayed) {
      await this.recordAuditSafely({
        tenantId,
        factoryId,
        userId,
        requestId,
        traceId,
        resourceId: result.id,
        payload: {
          item_id: result.item_id,
          quantity_before: result.quantity_before,
          counted_quantity: result.counted_quantity,
          quantity_delta: result.quantity_delta,
          reason_code: result.reason_code,
          location_id: result.location_id,
          location_quantity_before: result.location_quantity_before,
          location_counted_quantity: result.location_counted_quantity,
          location_quantity_after: result.location_quantity_after,
          adjustment_movement_id: result.adjustment_movement_id,
        },
      });
    }
    return result;
  }

  async listReconciliations(
    tenantId: string,
    factoryId: string,
    itemId: string,
    limit = 50,
  ): Promise<InventoryStockReconciliationRecord[]> {
    this.validateReadScope(tenantId, factoryId);
    this.validateUuid(itemId, 'itemId');
    this.validateLimit(limit);

    const item = await this.database.query<{ id: string }>(
      `
      SELECT id::text AS id
      FROM inventory_items
      WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
      LIMIT 1
      `,
      [itemId, tenantId, factoryId],
      { tenantId },
    );
    if (!item.rows[0]) {
      throw new NotFoundException('Inventory item not found in this factory');
    }

    const result = await this.database.query<ReconciliationRow>(
      `
      SELECT ${RECONCILIATION_COLUMNS}
      FROM inventory_stock_reconciliations
      WHERE tenant_id = $1
        AND factory_id = $2
        AND item_id = $3
      ORDER BY created_at DESC, id DESC
      LIMIT $4
      `,
      [tenantId, factoryId, itemId, limit],
      { tenantId },
    );
    return result.rows.map((row) => this.toRecord(row));
  }

  private async findByIdempotencyKey(
    client: PoolClient,
    tenantId: string,
    factoryId: string,
    idempotencyKey: string,
  ): Promise<ReconciliationRow | null> {
    const result = await client.query<ReconciliationRow>(
      `
      SELECT ${RECONCILIATION_COLUMNS}
      FROM inventory_stock_reconciliations
      WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3
      LIMIT 1
      `,
      [tenantId, factoryId, idempotencyKey],
    );
    return result.rows[0] ?? null;
  }

  private replayOrConflict(
    row: ReconciliationRow,
    requestHash: string,
  ): InventoryStockReconciliationResult {
    if (row.request_hash !== requestHash) {
      throw new ConflictException(
        'Idempotency-Key was already used for a different stock reconciliation',
      );
    }
    return this.toResult(row, true);
  }

  private toResult(
    row: ReconciliationRow,
    replayed: boolean,
  ): InventoryStockReconciliationResult {
    return { ...this.toRecord(row), replayed };
  }

  private toRecord(row: ReconciliationRow): InventoryStockReconciliationRecord {
    const { idempotency_key, request_hash, ...record } = row;
    void idempotency_key;
    void request_hash;
    return record;
  }

  private async insertOutboxEvent(
    client: PoolClient,
    input: {
      tenantId: string;
      factoryId: string;
      aggregateId: string;
      correlationId: string;
      userId: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `
      INSERT INTO outbox_events (
        tenant_id, factory_id, aggregate_type, aggregate_id,
        event_type, event_version, occurred_at, correlation_id, causation_id,
        actor, source, payload
      )
      VALUES (
        $1, $2, 'INVENTORY_ITEM', $3, 'INVENTORY.STOCK_RECONCILED', 1,
        clock_timestamp(), $4::uuid, NULL, $5::jsonb, $6::jsonb, $7::jsonb
      )
      `,
      [
        input.tenantId,
        input.factoryId,
        input.aggregateId,
        input.correlationId,
        JSON.stringify({ type: 'user', id: input.userId }),
        JSON.stringify({
          system: 'FactoryOS',
          connector: 'inventory-stock-reconciliation',
          version: process.env.APP_VERSION ?? process.env.npm_package_version ?? '0.1.0',
        }),
        JSON.stringify(input.payload),
      ],
    );
  }

  private async insertCycleCountApprovedEvent(
    client: PoolClient,
    input: {
      tenantId: string;
      factoryId: string;
      proposalId: string;
      itemId: string;
      reconciliationId: string;
      correlationId: string;
      userId: string;
      quantityDelta: string;
      reviewNote: string | null;
    },
  ): Promise<void> {
    await client.query(
      `
      INSERT INTO outbox_events (
        tenant_id, factory_id, aggregate_type, aggregate_id,
        event_type, event_version, occurred_at, correlation_id, causation_id,
        actor, source, payload
      )
      VALUES (
        $1, $2, 'INVENTORY_CYCLE_COUNT', $3, 'INVENTORY.CYCLE_COUNT_APPROVED', 1,
        clock_timestamp(), $4::uuid, NULL, $5::jsonb, $6::jsonb, $7::jsonb
      )
      `,
      [
        input.tenantId,
        input.factoryId,
        input.proposalId,
        input.correlationId,
        JSON.stringify({ type: 'user', id: input.userId }),
        JSON.stringify({
          system: 'FactoryOS',
          connector: 'inventory-cycle-count',
          version: process.env.APP_VERSION ?? process.env.npm_package_version ?? '0.1.0',
        }),
        JSON.stringify({
          cycle_count: {
            id: input.proposalId,
            item_id: input.itemId,
            reconciliation_id: input.reconciliationId,
            quantity_delta: input.quantityDelta,
            review_note: input.reviewNote,
            status: 'APPLIED',
          },
        }),
      ],
    );
  }

  private async recordAuditSafely(input: {
    tenantId: string;
    factoryId: string;
    userId: string;
    resourceId: string;
    requestId: string | null;
    traceId: string | null;
    payload: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.auditService.record({
        tenantId: input.tenantId,
        factoryId: input.factoryId,
        actorUserId: input.userId,
        eventType: 'INVENTORY',
        action: 'STOCK_RECONCILE',
        resourceType: 'INVENTORY_STOCK_RECONCILIATION',
        resourceId: input.resourceId,
        requestId: input.requestId && isUUID(input.requestId) ? input.requestId : null,
        correlationId: input.traceId && isUUID(input.traceId) ? input.traceId : null,
        dataClass: 'INTERNAL',
        payload: input.payload,
      });
    } catch {
      // The business transaction and transactional outbox event have committed.
    }
  }

  private requiredIdempotencyKey(rawKey: string | null): string {
    const key = rawKey?.trim() ?? '';
    if (!key) {
      throw new BadRequestException(
        'Idempotency-Key is required for stock reconciliation',
      );
    }
    if (key.length > 255) {
      throw new BadRequestException('Idempotency-Key must be at most 255 characters');
    }
    return key;
  }

  private validateScope(userId: string, tenantId: string, factoryId: string): void {
    this.validateUuid(userId, 'userId');
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');
  }

  private validateReadScope(tenantId: string, factoryId: string): void {
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');
  }

  private validateUuid(value: string, field: string): void {
    if (!isUUID(value)) throw new BadRequestException(field + ' must be a valid UUID');
  }

  private validateLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }
  }

  private correlationId(requestId: string | null, traceId: string | null): string {
    if (traceId && isUUID(traceId)) return traceId;
    if (requestId && isUUID(requestId)) return requestId;
    return randomUUID();
  }

  private errorCode(error: unknown): string | null {
    if (typeof error !== 'object' || error === null || !('code' in error)) return null;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
}
