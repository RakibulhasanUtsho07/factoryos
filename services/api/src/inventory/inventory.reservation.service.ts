import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { CreateInventoryReservationDto } from './dto/create-inventory-reservation.dto';
import { TransitionInventoryReservationDto } from './dto/transition-inventory-reservation.dto';

type ReservationStatus = 'RESERVED' | 'RELEASED' | 'CONSUMED';

interface ReservationRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  item_id: string;
  location_id: string | null;
  quantity: string;
  remaining_quantity: string;
  consumed_quantity: string;
  released_quantity: string;
  status: ReservationStatus;
  idempotency_key: string;
  request_hash: string;
  reference_type: string | null;
  reference_id: string | null;
  notes: string | null;
  transition_idempotency_key: string | null;
  transition_request_hash: string | null;
  consumed_movement_id: string | null;
  created_by_user_id: string;
  correlation_id: string;
  created_at: string;
  updated_at: string;
}

interface BalanceRow extends QueryResultRow {
  quantity_on_hand: string;
  quantity_reserved: string;
}

interface MovementRow extends QueryResultRow {
  id: string;
  quantity_after: string;
}

type TraceabilityAllocationPolicy = 'FIFO' | 'FEFO' | 'LOT' | 'SERIAL';

interface TraceabilityCandidate extends QueryResultRow {
  traceability_unit_id: string;
  location_id: string;
  unit_type: 'LOT' | 'SERIAL';
  unit_code: string;
  expires_at: string | null;
  received_at: string;
  quantity_on_hand: string;
  quantity_reserved: string;
}

interface TraceabilityAllocation {
  traceabilityUnitId: string;
  locationId: string;
  quantity: string;
}

interface TraceabilityAllocationPlan {
  enforced: boolean;
  policy: TraceabilityAllocationPolicy;
  allocations: TraceabilityAllocation[];
}

export interface OrderMaterialDispositionRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  order_id: string;
  reservation_id: string;
  item_id: string;
  disposition_type: 'RETURN_TO_STOCK' | 'SCRAPPED';
  quantity: string;
  idempotency_key: string;
  request_hash: string;
  movement_id: string | null;
  notes: string | null;
  created_by_user_id: string;
  correlation_id: string;
  created_at: string;
}

export type OrderMaterialDispositionResult = Omit<
  OrderMaterialDispositionRow,
  'request_hash' | 'idempotency_key'
> & {
  replayed: boolean;
};

const ORDER_MATERIAL_DISPOSITION_COLUMNS = `
  id::text AS id,
  tenant_id::text AS tenant_id,
  factory_id::text AS factory_id,
  order_id::text AS order_id,
  reservation_id::text AS reservation_id,
  item_id::text AS item_id,
  disposition_type,
  quantity::text AS quantity,
  idempotency_key,
  request_hash,
  movement_id::text AS movement_id,
  notes,
  created_by_user_id::text AS created_by_user_id,
  correlation_id::text AS correlation_id,
  created_at::text AS created_at
`;

type ReservationResult = {
  id: string;
  tenant_id: string;
  factory_id: string;
  item_id: string;
  location_id: string | null;
  quantity: string;
  remaining_quantity: string;
  consumed_quantity: string;
  released_quantity: string;
  status: ReservationStatus;
  reference_type: string | null;
  reference_id: string | null;
  notes: string | null;
  consumed_movement_id: string | null;
  created_by_user_id: string;
  correlation_id: string;
  created_at: string;
  updated_at: string;
  replayed: boolean;
};

const RESERVATION_COLUMNS = `
  id::text AS id,
  tenant_id::text AS tenant_id,
  factory_id::text AS factory_id,
  item_id::text AS item_id,
  location_id::text AS location_id,
  quantity::text AS quantity,
  remaining_quantity::text AS remaining_quantity,
  consumed_quantity::text AS consumed_quantity,
  released_quantity::text AS released_quantity,
  status,
  idempotency_key,
  request_hash,
  reference_type,
  reference_id::text AS reference_id,
  notes,
  transition_idempotency_key,
  transition_request_hash,
  consumed_movement_id::text AS consumed_movement_id,
  created_by_user_id::text AS created_by_user_id,
  correlation_id::text AS correlation_id,
  created_at::text AS created_at,
  updated_at::text AS updated_at
`;

@Injectable()
export class InventoryReservationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly auditService: AuditService,
  ) {}

  async createReservation(
    userId: string,
    tenantId: string,
    factoryId: string,
    itemId: string,
    dto: CreateInventoryReservationDto,
    rawIdempotencyKey: string | null,
    requestId: string | null,
    traceId: string | null,
  ): Promise<ReservationResult> {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(itemId, 'itemId');
    const idempotencyKey = this.requiredIdempotencyKey(rawIdempotencyKey);
    const quantity = this.normalizeQuantity(dto.quantity);
    const referenceType = dto.reference_type?.trim().toUpperCase() || null;
    const referenceId = dto.reference_id?.trim().toLowerCase() || null;
    if (referenceId) this.validateUuid(referenceId, 'reference_id');
    const locationId = dto.location_id?.trim().toLowerCase() || null;
    if (locationId) this.validateUuid(locationId, 'location_id');
    const notes = dto.notes?.trim() || null;
    const requestHash = this.hash({
      itemId: itemId.toLowerCase(),
      locationId,
      quantity,
      referenceType,
      referenceId,
      notes,
    });
    let result: ReservationResult;

    try {
      result = await this.database.transaction(
        { tenantId, userId },
        async (client) => {
          const existingBeforeLock = await this.findByIdempotencyKey(
            client, tenantId, factoryId, idempotencyKey,
          );
          if (existingBeforeLock) return this.replayOrConflict(existingBeforeLock, requestHash);

          const itemResult = await client.query<{ id: string; status: string }>(
            `
            SELECT id::text AS id, status
            FROM inventory_items
            WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
            FOR UPDATE
            `,
            [itemId, tenantId, factoryId],
          );
          const item = itemResult.rows[0];
          if (!item) throw new NotFoundException('Inventory item not found in this factory');
          if (item.status !== 'ACTIVE') throw new ConflictException('Disabled inventory items cannot be reserved');

          const existingAfterLock = await this.findByIdempotencyKey(
            client, tenantId, factoryId, idempotencyKey,
          );
          if (existingAfterLock) return this.replayOrConflict(existingAfterLock, requestHash);

          if (locationId) {
            const locationResult = await client.query<{ id: string }>(
              `
              SELECT id::text AS id
              FROM inventory_locations
              WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
                AND status = 'ACTIVE' AND location_type = 'BIN' AND picking_enabled = TRUE
              FOR UPDATE
              `,
              [locationId, tenantId, factoryId],
            );
            if (!locationResult.rows[0]) {
              throw new NotFoundException('Active BIN location not found in this factory');
            }

            const locationBalance = await client.query<{ location_id: string }>(
              `
              UPDATE inventory_location_balances
              SET quantity_reserved = quantity_reserved + $1::numeric,
                  version = version + 1,
                  updated_at = clock_timestamp()
              WHERE tenant_id = $2 AND factory_id = $3 AND item_id = $4
                AND location_id = $5
                AND quantity_on_hand - quantity_reserved >= $1::numeric
              RETURNING location_id::text AS location_id
              `,
              [quantity, tenantId, factoryId, itemId, locationId],
            );
            if (!locationBalance.rows[0]) {
              throw new ConflictException('Insufficient unreserved stock at the selected BIN');
            }
          }

          const balanceResult = await client.query<BalanceRow>(
            `
            UPDATE inventory_stock_balances
            SET
              quantity_reserved = quantity_reserved + $1::numeric,
              version = version + 1,
              updated_at = clock_timestamp()
            WHERE tenant_id = $2
              AND factory_id = $3
              AND item_id = $4
              AND quantity_on_hand - quantity_reserved >= $1::numeric
            RETURNING
              quantity_on_hand::text AS quantity_on_hand,
              quantity_reserved::text AS quantity_reserved
            `,
            [quantity, tenantId, factoryId, itemId],
          );
          const balance = balanceResult.rows[0];
          if (!balance) {
            throw new ConflictException('Insufficient available stock for this reservation');
          }

          const correlationId = this.correlationId(requestId, traceId);
          const inserted = await client.query<ReservationRow>(
            `
            INSERT INTO inventory_reservations (
              tenant_id, factory_id, item_id, location_id, quantity, idempotency_key,
              request_hash, reference_type, reference_id, notes,
              created_by_user_id, correlation_id
            )
            VALUES ($1, $2, $3, $4::uuid, $5::numeric, $6, $7, $8, $9::uuid, $10, $11, $12::uuid)
            RETURNING ${RESERVATION_COLUMNS}
            `,
            [
              tenantId, factoryId, itemId, locationId, quantity, idempotencyKey, requestHash,
              referenceType, referenceId, notes, userId, correlationId,
            ],
          );
          const row = inserted.rows[0];
          if (!row) throw new Error('INVENTORY_RESERVATION_INSERT_FAILED');

          await this.insertOutboxEvent(client, {
            tenantId, factoryId, aggregateId: itemId, eventType: 'INVENTORY.STOCK_RESERVED',
            correlationId, userId,
            payload: {
              reservation: {
                id: row.id, item_id: itemId, location_id: row.location_id,
                quantity: row.quantity, status: row.status,
                reference_type: row.reference_type, reference_id: row.reference_id,
              },
              balance: {
                quantity_on_hand: balance.quantity_on_hand,
                quantity_reserved: balance.quantity_reserved,
              },
            },
          });
          return this.toResult(row, false);
        },
      );
    } catch (error) {
      if (this.errorCode(error) !== '23505') throw error;
      const stored = await this.database.query<ReservationRow>(
        `SELECT ${RESERVATION_COLUMNS}
         FROM inventory_reservations
         WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3
         LIMIT 1`,
        [tenantId, factoryId, idempotencyKey],
        { tenantId, userId },
      );
      if (!stored.rows[0]) {
        throw new ConflictException('Inventory reservation conflicts with an existing record');
      }
      result = this.replayOrConflict(stored.rows[0], requestHash);
    }

    if (!result.replayed) {
      await this.recordAuditSafely({
        tenantId, factoryId, userId, action: 'RESERVATION_CREATE',
        resourceId: result.id, requestId, traceId,
        payload: { itemId, locationId, quantity: result.quantity, referenceType, referenceId },
      });
    }
    return result;
  }



  /**
   * Records an explicit return-to-stock or scrap decision for already-issued
   * order material. Each disposition is immutable and idempotent.
   */
  async recordOrderMaterialDisposition(
    userId: string,
    tenantId: string,
    factoryId: string,
    orderId: string,
    dto: {
      reservation_id: string;
      disposition_type: 'RETURN_TO_STOCK' | 'SCRAPPED';
      quantity: number;
      notes?: string;
    },
    rawIdempotencyKey: string | null,
    requestId: string | null,
    traceId: string | null,
  ): Promise<OrderMaterialDispositionResult> {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(orderId, 'orderId');
    this.validateUuid(dto.reservation_id, 'reservation_id');
    if (!['RETURN_TO_STOCK', 'SCRAPPED'].includes(dto.disposition_type)) {
      throw new BadRequestException('disposition_type must be RETURN_TO_STOCK or SCRAPPED');
    }

    const idempotencyKey = this.requiredIdempotencyKey(rawIdempotencyKey);
    const quantity = this.normalizeQuantity(dto.quantity);
    const notes = dto.notes?.trim() || null;
    const reservationId = dto.reservation_id.toLowerCase();
    const normalizedOrderId = orderId.toLowerCase();
    const dispositionType = dto.disposition_type;
    const requestHash = this.hash({
      orderId: normalizedOrderId,
      reservationId,
      dispositionType,
      quantity,
      notes,
    });

    let result: OrderMaterialDispositionResult;
    try {
      result = await this.database.transaction(
        { tenantId, userId },
        async (client) => {
          const existingBeforeLock = await this.findDispositionByIdempotencyKey(
            client, tenantId, factoryId, idempotencyKey,
          );
          if (existingBeforeLock) {
            return this.replayDispositionOrConflict(existingBeforeLock, requestHash);
          }

          const orderResult = await client.query<{
            id: string;
            factory_id: string;
            order_number: string;
            status: string;
          }>(
            `
            SELECT id::text AS id, factory_id::text AS factory_id, order_number, status
            FROM orders
            WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
            FOR UPDATE
            `,
            [orderId, tenantId, factoryId],
          );
          const order = orderResult.rows[0];
          if (!order) throw new NotFoundException('Order not found in this factory');
          if (order.status !== 'IN_PROGRESS') {
            throw new ConflictException('Material disposition is only allowed for an in-progress order');
          }

          const reservationScope = await client.query<{ item_id: string }>(
            `
            SELECT r.item_id::text AS item_id
            FROM inventory_reservations r
            JOIN order_lines ol
              ON ol.id = r.reference_id
              AND ol.tenant_id = r.tenant_id
              AND ol.factory_id = r.factory_id
              AND ol.inventory_item_id = r.item_id
            WHERE r.id = $1
              AND r.tenant_id = $2
              AND r.factory_id = $3
              AND r.reference_type = 'ORDER_LINE'
              AND ol.order_id = $4
            LIMIT 1
            `,
            [reservationId, tenantId, factoryId, orderId],
          );
          const scopedReservation = reservationScope.rows[0];
          if (!scopedReservation) {
            throw new NotFoundException('Consumed inventory reservation was not found for this order');
          }

          const itemResult = await client.query<{ id: string; status: string }>(
            `
            SELECT id::text AS id, status
            FROM inventory_items
            WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
            FOR UPDATE
            `,
            [scopedReservation.item_id, tenantId, factoryId],
          );
          const item = itemResult.rows[0];
          if (!item) throw new NotFoundException('Inventory item not found in this factory');

          // Recheck after acquiring the item lock; stock movement and
          // reservation transitions use the same item -> reservation lock order.
          const existingAfterLock = await this.findDispositionByIdempotencyKey(
            client, tenantId, factoryId, idempotencyKey,
          );
          if (existingAfterLock) {
            return this.replayDispositionOrConflict(existingAfterLock, requestHash);
          }

          const reservationResult = await client.query<ReservationRow>(
            `
            SELECT
              r.id::text AS id,
              r.tenant_id::text AS tenant_id,
              r.factory_id::text AS factory_id,
              r.item_id::text AS item_id,
              r.quantity::text AS quantity,
              r.status,
              r.idempotency_key,
              r.request_hash,
              r.reference_type,
              r.reference_id::text AS reference_id,
              r.notes,
              r.transition_idempotency_key,
              r.transition_request_hash,
              r.consumed_movement_id::text AS consumed_movement_id,
              r.created_by_user_id::text AS created_by_user_id,
              r.correlation_id::text AS correlation_id,
              r.created_at::text AS created_at,
              r.updated_at::text AS updated_at
            FROM inventory_reservations r
            JOIN order_lines ol
              ON ol.id = r.reference_id
              AND ol.tenant_id = r.tenant_id
              AND ol.factory_id = r.factory_id
              AND ol.inventory_item_id = r.item_id
            WHERE r.id = $1
              AND r.tenant_id = $2
              AND r.factory_id = $3
              AND r.reference_type = 'ORDER_LINE'
              AND ol.order_id = $4
            FOR UPDATE OF r
            `,
            [reservationId, tenantId, factoryId, orderId],
          );
          const reservation = reservationResult.rows[0];
          if (!reservation || reservation.status !== 'CONSUMED') {
            throw new ConflictException('Only consumed order reservations can be dispositioned');
          }

          const capacityResult = await client.query<{
            within_limit: boolean;
            remaining_quantity: string;
          }>(
            `
            SELECT
              $1::numeric + COALESCE(SUM(d.quantity), 0) <= $2::numeric AS within_limit,
              ($2::numeric - COALESCE(SUM(d.quantity), 0))::text AS remaining_quantity
            FROM order_material_dispositions d
            WHERE d.tenant_id = $3
              AND d.factory_id = $4
              AND d.reservation_id = $5
            `,
            [quantity, reservation.quantity, tenantId, factoryId, reservationId],
          );
          const capacity = capacityResult.rows[0];
          if (!capacity?.within_limit) {
            throw new ConflictException(
              `Disposition quantity exceeds the remaining issued material (${capacity?.remaining_quantity ?? '0'} available)`,
            );
          }

          const correlationId = this.correlationId(requestId, traceId);
          const dispositionId = randomUUID();
          const dispositionMovementNotes =
            notes ?? `Material returned from order ${order.order_number}`;
          let movementId: string | null = null;
          let balance: BalanceRow | null = null;

          if (dispositionType === 'RETURN_TO_STOCK') {
            if (item.status !== 'ACTIVE') {
              throw new ConflictException('Disabled inventory items cannot receive returned material');
            }

            const balanceResult = await client.query<BalanceRow>(
              `
              UPDATE inventory_stock_balances
              SET quantity_on_hand = quantity_on_hand + $1::numeric,
                  version = version + 1,
                  updated_at = clock_timestamp()
              WHERE tenant_id = $2 AND factory_id = $3 AND item_id = $4
              RETURNING quantity_on_hand::text AS quantity_on_hand,
                        quantity_reserved::text AS quantity_reserved
              `,
              [quantity, tenantId, factoryId, item.id],
            );
            balance = balanceResult.rows[0] ?? null;
            if (!balance) throw new ConflictException('Inventory stock balance is unavailable');

            const movementKey = `order-material-return:${dispositionId}`;
            const movementHash = this.hash({
              itemId: item.id.toLowerCase(),
              movementType: 'RECEIPT',
              quantity,
              referenceType: 'ORDER_MATERIAL_RETURN',
              referenceId: dispositionId,
              notes: dispositionMovementNotes,
            });
            const movementResult = await client.query<MovementRow>(
              `
              INSERT INTO inventory_movements (
                tenant_id, factory_id, item_id, movement_type, quantity,
                quantity_delta, quantity_after, idempotency_key, request_hash,
                reference_type, reference_id, notes, created_by_user_id, correlation_id
              )
              VALUES ($1, $2, $3, 'RECEIPT', $4::numeric, $4::numeric, $5::numeric,
                      $6, $7, 'ORDER_MATERIAL_RETURN', $8::uuid, $9, $10, $11::uuid)
              RETURNING id::text AS id, quantity_after::text AS quantity_after
              `,
              [
                tenantId, factoryId, item.id, quantity, balance.quantity_on_hand,
                movementKey, movementHash, dispositionId, dispositionMovementNotes,
                userId, correlationId,
              ],
            );
            movementId = movementResult.rows[0]?.id ?? null;
            if (!movementId) throw new Error('ORDER_MATERIAL_RETURN_MOVEMENT_INSERT_FAILED');
          }

          const insertResult = await client.query<OrderMaterialDispositionRow>(
            `
            INSERT INTO order_material_dispositions (
              id, tenant_id, factory_id, order_id, reservation_id, item_id,
              disposition_type, quantity, idempotency_key, request_hash,
              movement_id, notes, created_by_user_id, correlation_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10,
                    $11::uuid, $12, $13, $14::uuid)
            RETURNING ${ORDER_MATERIAL_DISPOSITION_COLUMNS}
            `,
            [
              dispositionId, tenantId, factoryId, orderId, reservationId, item.id,
              dispositionType, quantity, idempotencyKey, requestHash,
              movementId, notes, userId, correlationId,
            ],
          );
          const inserted = insertResult.rows[0];
          if (!inserted) throw new Error('ORDER_MATERIAL_DISPOSITION_INSERT_FAILED');

          await this.insertOutboxEvent(client, {
            tenantId,
            factoryId,
            aggregateId: item.id,
            eventType: dispositionType === 'RETURN_TO_STOCK'
              ? 'INVENTORY.ORDER_MATERIAL_RETURNED'
              : 'INVENTORY.ORDER_MATERIAL_SCRAPPED',
            correlationId,
            userId,
            payload: {
              disposition: {
                id: inserted.id,
                order_id: order.id,
                reservation_id: reservationId,
                item_id: item.id,
                disposition_type: dispositionType,
                quantity: inserted.quantity,
                notes: inserted.notes,
                movement_id: movementId,
              },
              ...(balance ? {
                balance: {
                  quantity_on_hand: balance.quantity_on_hand,
                  quantity_reserved: balance.quantity_reserved,
                },
              } : {}),
            },
          });

          return this.toDispositionResult(inserted, false);
        },
      );
    } catch (error) {
      if (this.errorCode(error) !== '23505') throw error;
      const stored = await this.database.query<OrderMaterialDispositionRow>(
        `
        SELECT ${ORDER_MATERIAL_DISPOSITION_COLUMNS}
        FROM order_material_dispositions
        WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3
        LIMIT 1
        `,
        [tenantId, factoryId, idempotencyKey],
        { tenantId, userId },
      );
      if (!stored.rows[0]) {
        throw new ConflictException('Material disposition conflicts with an existing record');
      }
      result = this.replayDispositionOrConflict(stored.rows[0], requestHash);
    }

    if (!result.replayed) {
      await this.recordAuditSafely({
        tenantId,
        factoryId,
        userId,
        action: dispositionType === 'RETURN_TO_STOCK'
          ? 'ORDER_MATERIAL_RETURN_TO_STOCK'
          : 'ORDER_MATERIAL_SCRAPPED',
        resourceType: 'ORDER_MATERIAL_DISPOSITION',
        resourceId: result.id,
        requestId,
        traceId,
        payload: {
          orderId: result.order_id,
          reservationId: result.reservation_id,
          itemId: result.item_id,
          dispositionType: result.disposition_type,
          quantity: result.quantity,
          movementId: result.movement_id,
        },
      });
    }
    return result;
  }

  /**
   * Fails closed before an in-progress order is cancelled unless every
   * consumed order-line reservation has a complete return/scrap disposition.
   * The migration installs the same invariant as a database trigger.
   */
  async assertOrderMaterialsDisposedBeforeCancellation(
    client: PoolClient,
    input: {
      tenantId: string;
      factoryId: string;
      orderId: string;
      previousStatus: string;
      targetStatus: string;
    },
  ): Promise<void> {
    if (input.previousStatus !== 'IN_PROGRESS' || input.targetStatus !== 'CANCELLED') return;

    const incompleteResult = await client.query<{
      reservation_id: string;
      remaining_quantity: string;
    }>(
      `
      SELECT r.id::text AS reservation_id,
             (r.quantity - COALESCE(SUM(d.quantity), 0))::text AS remaining_quantity
      FROM inventory_reservations r
      JOIN order_lines ol
        ON ol.id = r.reference_id
        AND ol.tenant_id = r.tenant_id
        AND ol.factory_id = r.factory_id
        AND ol.inventory_item_id = r.item_id
      LEFT JOIN order_material_dispositions d
        ON d.tenant_id = r.tenant_id
        AND d.factory_id = r.factory_id
        AND d.reservation_id = r.id
      WHERE r.tenant_id = $1
        AND r.factory_id = $2
        AND ol.order_id = $3
        AND r.reference_type = 'ORDER_LINE'
        AND r.status = 'CONSUMED'
      GROUP BY r.id, r.quantity
      HAVING COALESCE(SUM(d.quantity), 0) <> r.quantity
      ORDER BY r.id
      LIMIT 1
      `,
      [input.tenantId, input.factoryId, input.orderId],
    );

    const incomplete = incompleteResult.rows[0];
    if (incomplete) {
      throw new ConflictException(
        `Order cannot be cancelled yet: reservation ${incomplete.reservation_id} has ${incomplete.remaining_quantity} material units without a return/scrap disposition`,
      );
    }
  }

  private async findDispositionByIdempotencyKey(
    client: PoolClient,
    tenantId: string,
    factoryId: string,
    idempotencyKey: string,
  ): Promise<OrderMaterialDispositionRow | null> {
    const result = await client.query<OrderMaterialDispositionRow>(
      `
      SELECT ${ORDER_MATERIAL_DISPOSITION_COLUMNS}
      FROM order_material_dispositions
      WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3
      LIMIT 1
      `,
      [tenantId, factoryId, idempotencyKey],
    );
    return result.rows[0] ?? null;
  }

  private replayDispositionOrConflict(
    row: OrderMaterialDispositionRow,
    requestHash: string,
  ): OrderMaterialDispositionResult {
    if (row.request_hash !== requestHash) {
      throw new ConflictException('Idempotency-Key has already been used for a different material disposition');
    }
    return this.toDispositionResult(row, true);
  }

  private toDispositionResult(
    row: OrderMaterialDispositionRow,
    replayed: boolean,
  ): OrderMaterialDispositionResult {
    const {
      request_hash: _requestHash,
      idempotency_key: _idempotencyKey,
      ...result
    } = row;
    return { ...result, replayed };
  }

  /**
   * Applies inventory side effects in the caller's order-status transaction.
   * The caller's PoolClient keeps order state, stock balances, reservation
   * history and outbox evidence atomic.
   */
  async applyOrderTransition(
    client: PoolClient,
    input: {
      userId: string;
      tenantId: string;
      factoryId: string;
      orderId: string;
      orderNumber: string;
      previousStatus: string;
      targetStatus: 'DRAFT' | 'CONFIRMED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
      requestId: string | null;
      traceId: string | null;
    },
  ): Promise<{
    reservations_created: number;
    reservations_released: number;
    reservations_consumed: number;
  }> {
    const result = {
      reservations_created: 0,
      reservations_released: 0,
      reservations_consumed: 0,
    };

    if (input.previousStatus === 'DRAFT' && input.targetStatus === 'CONFIRMED') {
      result.reservations_created = await this.reserveOrderLines(client, input);
    }
    if (input.targetStatus === 'CANCELLED') {
      result.reservations_released = await this.transitionOrderReservations(client, input, 'RELEASED');
    }
    if (input.previousStatus === 'CONFIRMED' && input.targetStatus === 'IN_PROGRESS') {
      result.reservations_consumed = await this.transitionOrderReservations(client, input, 'CONSUMED');
    }
    return result;
  }

  private async reserveOrderLines(
    client: PoolClient,
    input: {
      userId: string; tenantId: string; factoryId: string; orderId: string;
      orderNumber: string; requestId: string | null; traceId: string | null;
    },
  ): Promise<number> {
    const linesResult = await client.query<{
      id: string; line_number: number; item_id: string; quantity: string; unit: string;
    }>(
      `
      SELECT ol.id::text AS id, ol.line_number,
             ol.inventory_item_id::text AS item_id,
             ol.quantity::text AS quantity, ol.unit
      FROM order_lines ol
      WHERE ol.order_id = $1 AND ol.tenant_id = $2 AND ol.factory_id = $3
        AND ol.inventory_item_id IS NOT NULL
      ORDER BY ol.inventory_item_id, ol.id
      FOR UPDATE
      `,
      [input.orderId, input.tenantId, input.factoryId],
    );

    // Split numeric(18,4) quantities as integer 1/10000 units: no float drift.
    const toUnits = (value: string): bigint => {
      const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(String(value).trim());
      if (!match) throw new ConflictException('Inventory quantity is not a valid four-decimal value');
      return BigInt(match[1]!) * 10000n + BigInt((match[2] ?? '').padEnd(4, '0'));
    };
    const fromUnits = (value: bigint): string =>
      `${value / 10000n}.${String(value % 10000n).padStart(4, '0')}`;

    let createdCount = 0;
    const correlationId = this.correlationId(input.requestId, input.traceId);

    for (const line of linesResult.rows) {
      const itemResult = await client.query<{ id: string; status: string; unit: string }>(
        `
        SELECT id::text AS id, status, unit FROM inventory_items
        WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
        FOR UPDATE
        `,
        [line.item_id, input.tenantId, input.factoryId],
      );
      const item = itemResult.rows[0];
      if (!item) throw new NotFoundException(`Inventory item on order line ${line.line_number} was not found in this factory`);
      if (item.status !== 'ACTIVE') throw new ConflictException(`Inventory item on order line ${line.line_number} is disabled`);
      if (item.unit.trim().toUpperCase() !== line.unit.trim().toUpperCase()) {
        throw new ConflictException(`Order line ${line.line_number} unit no longer matches its inventory item`);
      }

      const quantity = this.normalizeQuantity(Number(line.quantity));
      const requiredUnits = toUnits(quantity);
      const referenceType = 'ORDER_LINE';
      const referenceId = line.id.toLowerCase();
      const notes = `Reserved for order ${input.orderNumber} (line ${line.line_number})`;
      const legacyKey = `order:${input.orderId}:line:${line.id}:reserve:v1`;
      const legacyHash = this.hash({ itemId: line.item_id.toLowerCase(), quantity, referenceType, referenceId, notes });

      // Existing v1 unallocated reservations are kept stable through deployment/retries.
      const legacy = await this.findByIdempotencyKey(client, input.tenantId, input.factoryId, legacyKey);
      if (legacy) {
        this.replayOrConflict(legacy, legacyHash);
        if (legacy.status !== 'RESERVED') {
          throw new ConflictException(`Order line ${line.line_number} already has a terminal inventory reservation`);
        }
        continue;
      }

      // A retry must replay the complete set of immutable per-bin child rows.
      const activeResult = await client.query<ReservationRow>(
        `
        SELECT ${RESERVATION_COLUMNS}
        FROM inventory_reservations
        WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3
          AND reference_type = 'ORDER_LINE' AND reference_id = $4::uuid
          AND status = 'RESERVED'
        ORDER BY location_id NULLS FIRST, id
        FOR UPDATE
        `,
        [input.tenantId, input.factoryId, line.item_id, referenceId],
      );
      if (activeResult.rows.length > 0) {
        let activeUnits = 0n;
        const usedLocations = new Set<string>();
        for (const existing of activeResult.rows) {
          const locationId = existing.location_id?.toLowerCase() ?? '';
          const childKey = `order:${input.orderId}:line:${line.id}:bin:${locationId}:reserve:v2`;
          const childHash = this.hash({
            itemId: line.item_id.toLowerCase(), locationId, quantity: existing.quantity,
            referenceType, referenceId, notes,
          });
          if (
            existing.status !== 'RESERVED' || !locationId || existing.idempotency_key !== childKey
            || existing.request_hash !== childHash || existing.reference_type !== referenceType
            || existing.reference_id !== referenceId || existing.notes !== notes
            || usedLocations.has(locationId)
          ) {
            throw new ConflictException(`Order line ${line.line_number} has an incomplete or conflicting active bin allocation`);
          }
          usedLocations.add(locationId);
          activeUnits += toUnits(existing.quantity);
        }
        if (activeUnits !== requiredUnits) {
          throw new ConflictException(`Order line ${line.line_number} has an incomplete active reservation allocation`);
        }
        continue;
      }

      const balanceBeforeResult = await client.query<BalanceRow>(
        `
        SELECT quantity_on_hand::text AS quantity_on_hand,
               quantity_reserved::text AS quantity_reserved
        FROM inventory_stock_balances
        WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3
        FOR UPDATE
        `,
        [input.tenantId, input.factoryId, line.item_id],
      );
      const balanceBefore = balanceBeforeResult.rows[0];
      if (!balanceBefore) throw new ConflictException(`Inventory balance is unavailable for order line ${line.line_number}`);
      const aggregateAvailable = toUnits(balanceBefore.quantity_on_hand) - toUnits(balanceBefore.quantity_reserved);
      if (aggregateAvailable < requiredUnits) {
        throw new ConflictException(`Insufficient available stock for order line ${line.line_number}`);
      }

      // Physical bins first, deterministic code order; UNASSIGNED is compatibility fallback.
      const locationsResult = await client.query<{
        location_id: string; location_code: string; is_default: boolean; location_type: string;
        quantity_on_hand: string; quantity_reserved: string;
      }>(
        `
        SELECT lb.location_id::text AS location_id, l.location_code, l.is_default, l.location_type,
               lb.quantity_on_hand::text AS quantity_on_hand,
               lb.quantity_reserved::text AS quantity_reserved
        FROM inventory_location_balances lb
        JOIN inventory_locations l
          ON l.id = lb.location_id AND l.tenant_id = lb.tenant_id AND l.factory_id = lb.factory_id
        LEFT JOIN inventory_locations parent
          ON parent.id = l.parent_location_id AND parent.tenant_id = l.tenant_id AND parent.factory_id = l.factory_id
        WHERE lb.tenant_id = $1 AND lb.factory_id = $2 AND lb.item_id = $3
          AND l.status = 'ACTIVE' AND l.picking_enabled = TRUE
          AND lb.quantity_on_hand > lb.quantity_reserved
          AND (
            (l.location_type = 'BIN' AND parent.location_type IN ('WAREHOUSE', 'STAGING') AND parent.status = 'ACTIVE')
            OR (l.is_default = TRUE AND l.location_type = 'VIRTUAL')
          )
        ORDER BY l.is_default ASC, lower(l.location_code), lb.location_id
        FOR UPDATE OF lb, l
        `,
        [input.tenantId, input.factoryId, line.item_id],
      );

      let remainingUnits = requiredUnits;
      const allocations: Array<{ locationId: string; quantity: string }> = [];
      for (const location of locationsResult.rows) {
        if (remainingUnits === 0n) break;
        const availableUnits = toUnits(location.quantity_on_hand) - toUnits(location.quantity_reserved);
        if (availableUnits <= 0n) continue;
        const allocated = availableUnits < remainingUnits ? availableUnits : remainingUnits;
        allocations.push({ locationId: location.location_id.toLowerCase(), quantity: fromUnits(allocated) });
        remainingUnits -= allocated;
      }
      if (remainingUnits !== 0n) {
        throw new ConflictException(`Insufficient stock in active bins to allocate order line ${line.line_number}; no partial reservation was committed`);
      }

      // One aggregate reservation increment per line; location balances and child rows are atomic with it.
      const balanceResult = await client.query<BalanceRow>(
        `
        UPDATE inventory_stock_balances
        SET quantity_reserved = quantity_reserved + $1::numeric,
            version = version + 1, updated_at = clock_timestamp()
        WHERE tenant_id = $2 AND factory_id = $3 AND item_id = $4
          AND quantity_on_hand - quantity_reserved >= $1::numeric
        RETURNING quantity_on_hand::text AS quantity_on_hand,
                  quantity_reserved::text AS quantity_reserved
        `,
        [quantity, input.tenantId, input.factoryId, line.item_id],
      );
      const balance = balanceResult.rows[0];
      if (!balance) throw new ConflictException(`Insufficient available stock for order line ${line.line_number}`);

      for (let index = 0; index < allocations.length; index += 1) {
        const allocation = allocations[index]!;
        const locationBalanceResult = await client.query<{ location_id: string }>(
          `
          UPDATE inventory_location_balances
          SET quantity_reserved = quantity_reserved + $1::numeric,
              version = version + 1, updated_at = clock_timestamp()
          WHERE tenant_id = $2 AND factory_id = $3 AND item_id = $4
            AND location_id = $5
            AND quantity_on_hand - quantity_reserved >= $1::numeric
          RETURNING location_id::text AS location_id
          `,
          [allocation.quantity, input.tenantId, input.factoryId, line.item_id, allocation.locationId],
        );
        if (!locationBalanceResult.rows[0]) {
          throw new ConflictException(`Bin stock changed while allocating order line ${line.line_number}; the transaction was rolled back`);
        }

        const idempotencyKey = `order:${input.orderId}:line:${line.id}:bin:${allocation.locationId}:reserve:v2`;
        const requestHash = this.hash({
          itemId: line.item_id.toLowerCase(), locationId: allocation.locationId,
          quantity: allocation.quantity, referenceType, referenceId, notes,
        });
        const inserted = await client.query<ReservationRow>(
          `
          INSERT INTO inventory_reservations (
            tenant_id, factory_id, item_id, location_id, quantity, idempotency_key,
            request_hash, reference_type, reference_id, notes, created_by_user_id, correlation_id
          )
          VALUES ($1, $2, $3, $4::uuid, $5::numeric, $6, $7, $8, $9::uuid, $10, $11, $12::uuid)
          RETURNING ${RESERVATION_COLUMNS}
          `,
          [
            input.tenantId, input.factoryId, line.item_id, allocation.locationId, allocation.quantity,
            idempotencyKey, requestHash, referenceType, referenceId, notes, input.userId, correlationId,
          ],
        );
        const reservation = inserted.rows[0];
        if (!reservation) throw new Error('ORDER_INVENTORY_BIN_RESERVATION_INSERT_FAILED');

        await this.insertOutboxEvent(client, {
          tenantId: input.tenantId, factoryId: input.factoryId, aggregateId: line.item_id,
          eventType: 'INVENTORY.STOCK_RESERVED', correlationId, userId: input.userId,
          payload: {
            reservation: {
              id: reservation.id, item_id: line.item_id, location_id: allocation.locationId,
              quantity: reservation.quantity, status: reservation.status,
              reference_type: referenceType, reference_id: referenceId,
              order_id: input.orderId, order_number: input.orderNumber,
            },
            allocation: { sequence: index + 1, total: allocations.length, line_quantity: quantity },
            balance: { quantity_on_hand: balance.quantity_on_hand, quantity_reserved: balance.quantity_reserved },
          },
        });
      }
      createdCount += allocations.length;
    }
    return createdCount;
  }

  private async transitionOrderReservations(
    client: PoolClient,
    input: {
      userId: string;
      tenantId: string;
      factoryId: string;
      orderId: string;
      orderNumber: string;
      requestId: string | null;
      traceId: string | null;
    },
    targetStatus: 'RELEASED' | 'CONSUMED',
  ): Promise<number> {
    // Keep the item -> reservation lock order used by the public reservation API.
    const candidates = await client.query<{ item_id: string }>(
      `
      SELECT DISTINCT r.item_id::text AS item_id
      FROM inventory_reservations r
      JOIN order_lines ol
        ON ol.id = r.reference_id
        AND ol.tenant_id = r.tenant_id
        AND ol.factory_id = r.factory_id
        AND ol.inventory_item_id = r.item_id
      WHERE r.tenant_id = $1 AND r.factory_id = $2
        AND r.reference_type = 'ORDER_LINE'
        AND ol.order_id = $3
        AND r.status = 'RESERVED'
      ORDER BY item_id
      `,
      [input.tenantId, input.factoryId, input.orderId],
    );
    const itemIds = candidates.rows.map((row) => row.item_id);
    if (itemIds.length === 0) return 0;

    const itemResult = await client.query<{ id: string; status: string }>(
      `
      SELECT id::text AS id, status
      FROM inventory_items
      WHERE tenant_id = $1 AND factory_id = $2 AND id = ANY($3::uuid[])
      ORDER BY id
      FOR UPDATE
      `,
      [input.tenantId, input.factoryId, itemIds],
    );
    if (itemResult.rows.length !== itemIds.length) {
      throw new ConflictException('An order reservation references an inventory item outside its factory');
    }
    const itemStatuses = new Map<string, string>(
      itemResult.rows.map((row) => [row.id, row.status] as const),
    );

    const reservationsResult = await client.query<ReservationRow>(
      `
      SELECT
        r.id::text AS id, r.tenant_id::text AS tenant_id,
        r.factory_id::text AS factory_id, r.item_id::text AS item_id,
        r.location_id::text AS location_id,
        r.quantity::text AS quantity, r.status, r.idempotency_key,
        r.request_hash, r.reference_type, r.reference_id::text AS reference_id,
        r.notes, r.transition_idempotency_key, r.transition_request_hash,
        r.consumed_movement_id::text AS consumed_movement_id,
        r.created_by_user_id::text AS created_by_user_id,
        r.correlation_id::text AS correlation_id,
        r.created_at::text AS created_at, r.updated_at::text AS updated_at
      FROM inventory_reservations r
      JOIN order_lines ol
        ON ol.id = r.reference_id
        AND ol.tenant_id = r.tenant_id
        AND ol.factory_id = r.factory_id
        AND ol.inventory_item_id = r.item_id
      WHERE r.tenant_id = $1 AND r.factory_id = $2
        AND r.reference_type = 'ORDER_LINE'
        AND ol.order_id = $3
        AND r.status = 'RESERVED'
      ORDER BY r.item_id, r.id
      FOR UPDATE OF r
      `,
      [input.tenantId, input.factoryId, input.orderId],
    );

    let changedCount = 0;
    const correlationId = this.correlationId(input.requestId, input.traceId);

    for (const reservation of reservationsResult.rows) {
      if (targetStatus === 'CONSUMED' && itemStatuses.get(reservation.item_id) !== 'ACTIVE') {
        throw new ConflictException(`Inventory item for order reservation ${reservation.id} is disabled`);
      }

      const transitionKey =
        `order:${input.orderId}:reservation:${reservation.id}:${targetStatus.toLowerCase()}:v1`;
      const transitionHash = this.hash({
        reservationId: reservation.id.toLowerCase(),
        targetStatus,
      });

      let balance: BalanceRow | undefined;
      if (reservation.location_id) {
        await this.decreaseLocationReserved(
          client, input.tenantId, input.factoryId, reservation.item_id,
          reservation.location_id, reservation.quantity,
        );
      }
      // Set/clear the location context for every child so a previous bin cannot leak.
      await client.query(
        `SELECT set_config('app.inventory_location_id', $1, TRUE)`,
        [targetStatus === 'CONSUMED' ? (reservation.location_id ?? '') : ''],
      );
      if (targetStatus === 'RELEASED') {
        const result = await client.query<BalanceRow>(
          `
          UPDATE inventory_stock_balances
          SET quantity_reserved = quantity_reserved - $1::numeric,
              version = version + 1, updated_at = clock_timestamp()
          WHERE tenant_id = $2 AND factory_id = $3 AND item_id = $4
            AND quantity_reserved >= $1::numeric
          RETURNING quantity_on_hand::text AS quantity_on_hand,
                    quantity_reserved::text AS quantity_reserved
          `,
          [reservation.quantity, input.tenantId, input.factoryId, reservation.item_id],
        );
        balance = result.rows[0];
      } else {
        const result = await client.query<BalanceRow>(
          `
          UPDATE inventory_stock_balances
          SET quantity_on_hand = quantity_on_hand - $1::numeric,
              quantity_reserved = quantity_reserved - $1::numeric,
              version = version + 1, updated_at = clock_timestamp()
          WHERE tenant_id = $2 AND factory_id = $3 AND item_id = $4
            AND quantity_reserved >= $1::numeric
            AND quantity_on_hand >= $1::numeric
          RETURNING quantity_on_hand::text AS quantity_on_hand,
                    quantity_reserved::text AS quantity_reserved
          `,
          [reservation.quantity, input.tenantId, input.factoryId, reservation.item_id],
        );
        balance = result.rows[0];
      }
      if (!balance) {
        throw new ConflictException(`Inventory balance is inconsistent for reservation ${reservation.id}; no order transition was applied`);
      }

      let consumedMovementId: string | null = null;
      if (targetStatus === 'CONSUMED') {
        const movementKey = 'reservation-consume-' + this.hash({
          tenantId: input.tenantId,
          factoryId: input.factoryId,
          reservationId: reservation.id,
          transitionKey,
        }).slice(0, 48);
        const movementResult = await client.query<MovementRow>(
          `
          INSERT INTO inventory_movements (
            tenant_id, factory_id, item_id, location_id, movement_type, quantity,
            quantity_delta, quantity_after, idempotency_key, request_hash,
            reference_type, reference_id, notes, created_by_user_id, correlation_id
          )
          VALUES ($1, $2, $3, $4::uuid, 'ISSUE', $5::numeric, -$5::numeric, $6::numeric,
                  $7, $8, 'RESERVATION', $9::uuid, $10, $11, $12::uuid)
          RETURNING id::text AS id, quantity_after::text AS quantity_after
          `,
          [
            input.tenantId, input.factoryId, reservation.item_id, reservation.location_id,
            reservation.quantity, balance.quantity_on_hand, movementKey, transitionHash,
            reservation.id, reservation.notes, input.userId, correlationId,
          ],
        );
        consumedMovementId = movementResult.rows[0]?.id ?? null;
        if (!consumedMovementId) throw new Error('ORDER_INVENTORY_CONSUMPTION_MOVEMENT_INSERT_FAILED');

        await this.insertOutboxEvent(client, {
          tenantId: input.tenantId,
          factoryId: input.factoryId,
          aggregateId: reservation.item_id,
          eventType: 'INVENTORY.STOCK_ISSUED',
          correlationId,
          userId: input.userId,
          payload: {
            movement: {
              id: consumedMovementId,
              item_id: reservation.item_id,
              location_id: reservation.location_id,
              movement_type: 'ISSUE',
              quantity: reservation.quantity,
              quantity_delta: '-' + reservation.quantity,
              quantity_after: balance.quantity_on_hand,
              reference_type: 'RESERVATION',
              reference_id: reservation.id,
            },
            reservation_id: reservation.id,
            order_id: input.orderId,
          },
        });
      }

      const updatedResult = await client.query<ReservationRow>(
        `
        UPDATE inventory_reservations
        SET status = $1, transition_idempotency_key = $2,
            transition_request_hash = $3, consumed_movement_id = $4::uuid,
            updated_at = clock_timestamp()
        WHERE id = $5 AND tenant_id = $6 AND factory_id = $7
          AND item_id = $8 AND status = 'RESERVED'
        RETURNING ${RESERVATION_COLUMNS}
        `,
        [
          targetStatus, transitionKey, transitionHash, consumedMovementId,
          reservation.id, input.tenantId, input.factoryId, reservation.item_id,
        ],
      );
      const updated = updatedResult.rows[0];
      if (!updated) throw new ConflictException(`Inventory reservation ${reservation.id} changed concurrently`);

      await this.insertOutboxEvent(client, {
        tenantId: input.tenantId,
        factoryId: input.factoryId,
        aggregateId: reservation.item_id,
        eventType: targetStatus === 'RELEASED'
          ? 'INVENTORY.STOCK_RESERVATION_RELEASED'
          : 'INVENTORY.STOCK_RESERVATION_CONSUMED',
        correlationId,
        userId: input.userId,
        payload: {
          reservation: {
            id: reservation.id,
            item_id: reservation.item_id,
            quantity: reservation.quantity,
            location_id: reservation.location_id,
            status: targetStatus,
            consumed_movement_id: consumedMovementId,
            order_id: input.orderId,
            order_number: input.orderNumber,
          },
          balance: {
            quantity_on_hand: balance.quantity_on_hand,
            quantity_reserved: balance.quantity_reserved,
          },
        },
      });
      changedCount += 1;
    }
    return changedCount;
  }

  /**
   * Reserve one immutable work-order BOM requirement inside the caller's
   * transaction. The caller owns work-order lifecycle/event atomicity.
   */
  async reserveWorkOrderMaterialRequirement(
    client: PoolClient,
    input: {
      userId: string;
      tenantId: string;
      factoryId: string;
      workOrderId: string;
      workOrderNumber: string;
      requirementId: string;
      bomLineId: string;
      itemId: string;
      itemUnit: string;
      lineNumber: number;
      quantity: string;
      correlationId: string;
    },
  ): Promise<Array<{ reservationId: string; locationId: string; quantity: string }>> {
    const itemResult = await client.query<{ id: string; status: string; unit: string }>(
      `
      SELECT id::text AS id, status, unit
      FROM inventory_items
      WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
      FOR UPDATE
      `,
      [input.itemId, input.tenantId, input.factoryId],
    );
    const item = itemResult.rows[0];
    if (!item) throw new NotFoundException('A work-order BOM component is not in this factory');
    if (item.status !== 'ACTIVE') throw new ConflictException('A work-order BOM component is disabled');
    if (item.unit.trim().toUpperCase() !== input.itemUnit.trim().toUpperCase()) {
      throw new ConflictException('The work-order material base unit no longer matches the inventory item unit');
    }

    const toUnits = (value: string): bigint => {
      const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(String(value).trim());
      if (!match) throw new ConflictException('Work-order material quantity is not a valid four-decimal value');
      return BigInt(match[1]!) * 10000n + BigInt((match[2] ?? '').padEnd(4, '0'));
    };
    const fromUnits = (value: bigint): string =>
      `${value / 10000n}.${String(value % 10000n).padStart(4, '0')}`;
    const requiredUnits = toUnits(input.quantity);
    if (requiredUnits <= 0n) throw new ConflictException('Work-order material requirement must be positive');

    const balanceBeforeResult = await client.query<BalanceRow>(
      `
      SELECT quantity_on_hand::text AS quantity_on_hand,
             quantity_reserved::text AS quantity_reserved
      FROM inventory_stock_balances
      WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3
      FOR UPDATE
      `,
      [input.tenantId, input.factoryId, input.itemId],
    );
    const balanceBefore = balanceBeforeResult.rows[0];
    if (!balanceBefore) throw new ConflictException(`Inventory balance is unavailable for BOM line ${input.lineNumber}`);
    if (toUnits(balanceBefore.quantity_on_hand) - toUnits(balanceBefore.quantity_reserved) < requiredUnits) {
      throw new ConflictException(`Insufficient unreserved stock to release work-order BOM line ${input.lineNumber}`);
    }

    const locationsResult = await client.query<{
      location_id: string; location_code: string; is_default: boolean; location_type: string;
      quantity_on_hand: string; quantity_reserved: string;
    }>(
      `
      SELECT lb.location_id::text AS location_id, l.location_code, l.is_default, l.location_type,
             lb.quantity_on_hand::text AS quantity_on_hand,
             lb.quantity_reserved::text AS quantity_reserved
      FROM inventory_location_balances lb
      JOIN inventory_locations l
        ON l.id = lb.location_id AND l.tenant_id = lb.tenant_id AND l.factory_id = lb.factory_id
      LEFT JOIN inventory_locations parent
        ON parent.id = l.parent_location_id AND parent.tenant_id = l.tenant_id AND parent.factory_id = l.factory_id
      WHERE lb.tenant_id = $1 AND lb.factory_id = $2 AND lb.item_id = $3
        AND l.status = 'ACTIVE' AND l.picking_enabled = TRUE
        AND lb.quantity_on_hand > lb.quantity_reserved
        AND (
          (l.location_type = 'BIN' AND parent.location_type IN ('WAREHOUSE', 'STAGING') AND parent.status = 'ACTIVE')
          OR (l.is_default = TRUE AND l.location_type = 'VIRTUAL')
        )
      ORDER BY l.is_default ASC, lower(l.location_code), lb.location_id
      FOR UPDATE OF lb, l
      `,
      [input.tenantId, input.factoryId, input.itemId],
    );

    let remainingUnits = requiredUnits;
    const allocations: Array<{ locationId: string; quantity: string }> = [];
    for (const location of locationsResult.rows) {
      if (remainingUnits === 0n) break;
      const availableUnits = toUnits(location.quantity_on_hand) - toUnits(location.quantity_reserved);
      if (availableUnits <= 0n) continue;
      const allocated = availableUnits < remainingUnits ? availableUnits : remainingUnits;
      allocations.push({
        locationId: location.location_id.toLowerCase(),
        quantity: fromUnits(allocated),
      });
      remainingUnits -= allocated;
    }
    if (remainingUnits !== 0n) {
      throw new ConflictException(
        `Insufficient available quantity in active picking bins for work-order BOM line ${input.lineNumber}`,
      );
    }

    const aggregateBalance = await client.query<BalanceRow>(
      `
      UPDATE inventory_stock_balances
      SET quantity_reserved = quantity_reserved + $1::numeric,
          version = version + 1, updated_at = clock_timestamp()
      WHERE tenant_id = $2 AND factory_id = $3 AND item_id = $4
        AND quantity_on_hand - quantity_reserved >= $1::numeric
      RETURNING quantity_on_hand::text AS quantity_on_hand,
                quantity_reserved::text AS quantity_reserved
      `,
      [input.quantity, input.tenantId, input.factoryId, input.itemId],
    );
    const balance = aggregateBalance.rows[0];
    if (!balance) throw new ConflictException('Available stock changed while releasing the work order');

    const notes = `Reserved for work order ${input.workOrderNumber} BOM line ${input.lineNumber}`;
    const allocationsCreated: Array<{ reservationId: string; locationId: string; quantity: string }> = [];
    for (const allocation of allocations) {
      const locationBalance = await client.query<{ location_id: string }>(
        `
        UPDATE inventory_location_balances
        SET quantity_reserved = quantity_reserved + $1::numeric,
            version = version + 1, updated_at = clock_timestamp()
        WHERE tenant_id = $2 AND factory_id = $3 AND item_id = $4 AND location_id = $5
          AND quantity_on_hand - quantity_reserved >= $1::numeric
        RETURNING location_id::text AS location_id
        `,
        [allocation.quantity, input.tenantId, input.factoryId, input.itemId, allocation.locationId],
      );
      if (!locationBalance.rows[0]) {
        throw new ConflictException('Picking-bin stock changed while releasing the work order; transaction rolled back');
      }

      const referenceType = 'WORK_ORDER_MATERIAL';
      const referenceId = input.workOrderId.toLowerCase();
      const idempotencyKey =
        `work-order:${input.workOrderId}:bom:${input.bomLineId}:bin:${allocation.locationId}:reserve:v1`;
      const requestHash = this.hash({
        itemId: input.itemId.toLowerCase(),
        locationId: allocation.locationId,
        quantity: allocation.quantity,
        referenceType,
        referenceId,
        notes,
      });
      const inserted = await client.query<ReservationRow>(
        `
        INSERT INTO inventory_reservations (
          tenant_id, factory_id, item_id, location_id, quantity, idempotency_key,
          request_hash, reference_type, reference_id, notes, created_by_user_id, correlation_id
        )
        VALUES ($1, $2, $3, $4::uuid, $5::numeric, $6, $7, $8, $9::uuid, $10, $11, $12::uuid)
        RETURNING ${RESERVATION_COLUMNS}
        `,
        [
          input.tenantId, input.factoryId, input.itemId, allocation.locationId,
          allocation.quantity, idempotencyKey, requestHash, referenceType,
          referenceId, notes, input.userId, input.correlationId,
        ],
      );
      const reservation = inserted.rows[0];
      if (!reservation) throw new Error('WORK_ORDER_MATERIAL_RESERVATION_INSERT_FAILED');

      await this.insertOutboxEvent(client, {
        tenantId: input.tenantId,
        factoryId: input.factoryId,
        aggregateId: input.itemId,
        eventType: 'INVENTORY.WORK_ORDER_MATERIAL_RESERVED',
        correlationId: input.correlationId,
        userId: input.userId,
        payload: {
          work_order_id: input.workOrderId,
          work_order_number: input.workOrderNumber,
          requirement_id: input.requirementId,
          bom_line_id: input.bomLineId,
          reservation: {
            id: reservation.id, item_id: input.itemId, location_id: allocation.locationId,
            quantity: allocation.quantity, status: 'RESERVED',
          },
          balance: { quantity_on_hand: balance.quantity_on_hand, quantity_reserved: balance.quantity_reserved },
        },
      });
      allocationsCreated.push({
        reservationId: reservation.id,
        locationId: allocation.locationId,
        quantity: allocation.quantity,
      });
    }
    return allocationsCreated;
  }

  /**
   * Posts accepted finished goods to the inventory ledger inside the caller's
   * production transaction. Scrap remains production evidence and is never
   * received into sellable inventory.
   */
  async postFinishedGoodsOutputReceipt(
    client: PoolClient,
    input: {
      userId: string;
      tenantId: string;
      factoryId: string;
      workOrderId: string | null;
      workOrderNumber: string | null;
      orderId: string;
      orderNumber: string;
      orderLineId: string;
      finishedItemId: string;
      productionReportId: string;
      goodQuantity: string;
      scrapQuantity: string;
      yieldPercentage: string;
      cumulativeYieldPercentage: string;
      correlationId: string;
    },
  ): Promise<{ movementId: string | null; quantityAfter: string | null }> {
    const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(String(input.goodQuantity).trim());
    if (!match) {
      throw new ConflictException('Finished-good output quantity must use non-negative four-decimal precision');
    }
    const whole = BigInt(match[1]!);
    const fraction = BigInt((match[2] ?? '').padEnd(4, '0'));
    const quantityUnits = whole * 10_000n + fraction;
    if (quantityUnits === 0n) return { movementId: null, quantityAfter: null };
    const quantity = `${whole}.${fraction.toString().padStart(4, '0')}`;

    const itemResult = await client.query<{ id: string; unit: string; status: string }>(
      `
      SELECT id::text AS id, unit, status
      FROM inventory_items
      WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
      FOR UPDATE
      `,
      [input.finishedItemId, input.tenantId, input.factoryId],
    );
    const item = itemResult.rows[0];
    if (!item) {
      throw new ConflictException('The work order finished-good item is no longer available in this factory');
    }
    if (item.status !== 'ACTIVE') {
      throw new ConflictException('Finished-good inventory item must remain active to receive production output');
    }

    // Force the aggregate receipt into the factory's default/UNASSIGNED bucket;
    // a previous operation in this transaction must never leak a bin selection.
    await client.query(`SELECT set_config('app.inventory_location_id', '', TRUE)`);
    const balanceResult = await client.query<{ quantity_on_hand: string }>(
      `
      UPDATE inventory_stock_balances
      SET quantity_on_hand = quantity_on_hand + $1::numeric,
          version = version + 1,
          updated_at = clock_timestamp()
      WHERE tenant_id = $2 AND factory_id = $3 AND item_id = $4
        AND quantity_on_hand + $1::numeric >= quantity_reserved
      RETURNING quantity_on_hand::text AS quantity_on_hand
      `,
      [quantity, input.tenantId, input.factoryId, input.finishedItemId],
    );
    const balance = balanceResult.rows[0];
    if (!balance) {
      throw new ConflictException('Finished-good inventory balance is missing or inconsistent; output was not posted');
    }

    const movementKey = `production-output-receipt-${input.productionReportId}`;
    const movementHash = this.hash({
      kind: 'PRODUCTION_OUTPUT_RECEIPT',
      tenantId: input.tenantId,
      factoryId: input.factoryId,
      workOrderId: input.workOrderId,
      productionReportId: input.productionReportId,
      finishedItemId: input.finishedItemId,
      goodQuantity: quantity,
    });
    const movementResult = await client.query<MovementRow>(
      `
      INSERT INTO inventory_movements (
        tenant_id, factory_id, item_id, location_id, movement_type, quantity,
        quantity_delta, quantity_after, input_quantity, input_unit_code,
        conversion_rule_id, conversion_factor_numerator, conversion_factor_denominator,
        conversion_rounding_mode, idempotency_key, request_hash, reference_type,
        reference_id, notes, created_by_user_id, correlation_id
      )
      VALUES (
        $1, $2, $3, NULL, 'RECEIPT', $4::numeric, $4::numeric, $5::numeric,
        $4::numeric, $6, NULL, NULL, NULL, NULL, $7, $8,
        'PRODUCTION_OUTPUT', $9::uuid, $10, $11, $12::uuid
      )
      RETURNING id::text AS id, quantity_after::text AS quantity_after
      `,
      [
        input.tenantId, input.factoryId, input.finishedItemId, quantity,
        balance.quantity_on_hand, item.unit, movementKey, movementHash,
        input.productionReportId,
        input.workOrderId
          ? `Finished-good receipt for work order ${input.workOrderNumber}`
          : `Finished-good receipt for order ${input.orderNumber}, line ${input.orderLineId}`,
        input.userId, input.correlationId,
      ],
    );
    const movement = movementResult.rows[0];
    if (!movement) throw new Error('PRODUCTION_FINISHED_GOOD_RECEIPT_INSERT_FAILED');

    await this.insertOutboxEvent(client, {
      tenantId: input.tenantId,
      factoryId: input.factoryId,
      aggregateId: input.finishedItemId,
      eventType: 'INVENTORY.STOCK_RECEIVED',
      correlationId: input.correlationId,
      userId: input.userId,
      payload: {
        purpose: 'PRODUCTION_OUTPUT',
        work_order_id: input.workOrderId,
        work_order_number: input.workOrderNumber,
        order_id: input.orderId,
        order_number: input.orderNumber,
        order_line_id: input.orderLineId,
        production_report_id: input.productionReportId,
        good_quantity: quantity,
        scrap_quantity: input.scrapQuantity,
        yield_percentage: input.yieldPercentage,
        cumulative_yield_percentage: input.cumulativeYieldPercentage,
        movement: {
          id: movement.id,
          item_id: input.finishedItemId,
          location_id: null,
          movement_type: 'RECEIPT',
          quantity,
          quantity_delta: quantity,
          quantity_after: movement.quantity_after,
          reference_type: 'PRODUCTION_OUTPUT',
          reference_id: input.productionReportId,
        },
      },
    });
    return { movementId: movement.id, quantityAfter: movement.quantity_after };
  }

  /**
   * Releases or consumes every raw-material reservation attached to the work order.
   * Must run in the same transaction as the caller's terminal state transition.
   */
  async transitionWorkOrderMaterialReservations(
    client: PoolClient,
    input: {
      userId: string;
      tenantId: string;
      factoryId: string;
      workOrderId: string;
      workOrderNumber: string;
      correlationId: string;
    },
    targetStatus: 'RELEASED' | 'CONSUMED',
  ): Promise<{ reservationCount: number; quantityByItem: Array<{ item_id: string; quantity: string }> }> {
    // Match the shared inventory locking order: inventory item first, then reservations.
    const itemIdsResult = await client.query<{ item_id: string }>(
      `
      SELECT DISTINCT item_id::text AS item_id
      FROM inventory_reservations
      WHERE tenant_id = $1 AND factory_id = $2
        AND reference_type = 'WORK_ORDER_MATERIAL'
        AND reference_id = $3 AND status = 'RESERVED'
      ORDER BY item_id
      `,
      [input.tenantId, input.factoryId, input.workOrderId],
    );
    const itemIds = itemIdsResult.rows.map((row) => row.item_id);
    if (itemIds.length === 0) {
      return { reservationCount: 0, quantityByItem: [] };
    }

    const itemResult = await client.query<{ id: string; status: string }>(
      `
      SELECT id::text AS id, status FROM inventory_items
      WHERE tenant_id = $1 AND factory_id = $2 AND id = ANY($3::uuid[])
      ORDER BY id FOR UPDATE
      `,
      [input.tenantId, input.factoryId, itemIds],
    );
    if (itemResult.rows.length !== itemIds.length) {
      throw new ConflictException('A work-order material reservation references an inventory item outside this factory');
    }
    const itemStatus = new Map(itemResult.rows.map((row) => [row.id, row.status] as const));
    const reservationResult = await client.query<ReservationRow>(
      `
      SELECT ${RESERVATION_COLUMNS}
      FROM inventory_reservations
      WHERE tenant_id = $1 AND factory_id = $2
        AND reference_type = 'WORK_ORDER_MATERIAL'
        AND reference_id = $3 AND status = 'RESERVED'
        AND item_id = ANY($4::uuid[])
      ORDER BY item_id, id
      FOR UPDATE
      `,
      [input.tenantId, input.factoryId, input.workOrderId, itemIds],
    );
    const reservations = reservationResult.rows;
    const toUnits = (value: string): bigint => {
      const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(String(value).trim());
      if (!match) throw new ConflictException('Work-order material quantity is not a valid four-decimal value');
      return BigInt(match[1]!) * 10000n + BigInt((match[2] ?? '').padEnd(4, '0'));
    };
    const fromUnits = (value: bigint): string =>
      `${value / 10000n}.${String(value % 10000n).padStart(4, '0')}`;
    const quantityByItem = new Map<string, bigint>();

    for (const reservation of reservations) {
      if (targetStatus === 'CONSUMED' && itemStatus.get(reservation.item_id) !== 'ACTIVE') {
        throw new ConflictException(`Cannot consume reserved material for disabled item ${reservation.item_id}`);
      }
      const transitionKey =
        `work-order:${input.workOrderId}:reservation:${reservation.id}:${targetStatus.toLowerCase()}:v1`;
      const transitionHash = this.hash({
        reservationId: reservation.id.toLowerCase(),
        targetStatus,
      });
      if (reservation.location_id) {
        await this.decreaseLocationReserved(
          client, input.tenantId, input.factoryId, reservation.item_id,
          reservation.location_id, reservation.quantity,
        );
      }
      await client.query(
        `SELECT set_config('app.inventory_location_id', $1, TRUE)`,
        [targetStatus === 'CONSUMED' ? (reservation.location_id ?? '') : ''],
      );

      const balanceResult = targetStatus === 'RELEASED'
        ? await client.query<BalanceRow>(
          `
          UPDATE inventory_stock_balances
          SET quantity_reserved = quantity_reserved - $1::numeric,
              version = version + 1, updated_at = clock_timestamp()
          WHERE tenant_id = $2 AND factory_id = $3 AND item_id = $4
            AND quantity_reserved >= $1::numeric
          RETURNING quantity_on_hand::text AS quantity_on_hand,
                    quantity_reserved::text AS quantity_reserved
          `,
          [reservation.quantity, input.tenantId, input.factoryId, reservation.item_id],
        )
        : await client.query<BalanceRow>(
          `
          UPDATE inventory_stock_balances
          SET quantity_on_hand = quantity_on_hand - $1::numeric,
              quantity_reserved = quantity_reserved - $1::numeric,
              version = version + 1, updated_at = clock_timestamp()
          WHERE tenant_id = $2 AND factory_id = $3 AND item_id = $4
            AND quantity_reserved >= $1::numeric AND quantity_on_hand >= $1::numeric
          RETURNING quantity_on_hand::text AS quantity_on_hand,
                    quantity_reserved::text AS quantity_reserved
          `,
          [reservation.quantity, input.tenantId, input.factoryId, reservation.item_id],
        );
      const balance = balanceResult.rows[0];
      if (!balance) throw new ConflictException(`Inventory balance is inconsistent for material reservation ${reservation.id}`);

      let consumedMovementId: string | null = null;
      if (targetStatus === 'CONSUMED') {
        const movementKey = 'reservation-consume-' + this.hash({
          tenantId: input.tenantId, factoryId: input.factoryId,
          reservationId: reservation.id, transitionKey,
        }).slice(0, 48);
        const movement = await client.query<MovementRow>(
          `
          INSERT INTO inventory_movements (
            tenant_id, factory_id, item_id, location_id, movement_type, quantity,
            quantity_delta, quantity_after, idempotency_key, request_hash,
            reference_type, reference_id, notes, created_by_user_id, correlation_id
          )
          VALUES ($1, $2, $3, $4::uuid, 'ISSUE', $5::numeric, -$5::numeric, $6::numeric,
            $7, $8, 'RESERVATION', $9::uuid, $10, $11, $12::uuid)
          RETURNING id::text AS id, quantity_after::text AS quantity_after
          `,
          [
            input.tenantId, input.factoryId, reservation.item_id, reservation.location_id,
            reservation.quantity, balance.quantity_on_hand, movementKey, transitionHash,
            reservation.id, reservation.notes, input.userId, input.correlationId,
          ],
        );
        consumedMovementId = movement.rows[0]?.id ?? null;
        if (!consumedMovementId) throw new Error('WORK_ORDER_MATERIAL_ISSUE_MOVEMENT_INSERT_FAILED');
        await this.insertOutboxEvent(client, {
          tenantId: input.tenantId, factoryId: input.factoryId,
          aggregateId: reservation.item_id, eventType: 'INVENTORY.STOCK_ISSUED',
          correlationId: input.correlationId, userId: input.userId,
          payload: {
            work_order_id: input.workOrderId,
            work_order_number: input.workOrderNumber,
            reservation_id: reservation.id,
            movement: {
              id: consumedMovementId,
              item_id: reservation.item_id,
              location_id: reservation.location_id,
              movement_type: 'ISSUE',
              quantity: reservation.quantity,
              quantity_delta: `-${reservation.quantity}`,
              quantity_after: balance.quantity_on_hand,
            },
          },
        });
      }

      const updated = await client.query<ReservationRow>(
        `
        UPDATE inventory_reservations
        SET status = $1, transition_idempotency_key = $2,
            transition_request_hash = $3, consumed_movement_id = $4::uuid,
            updated_at = clock_timestamp()
        WHERE id = $5 AND tenant_id = $6 AND factory_id = $7 AND item_id = $8
          AND status = 'RESERVED'
        RETURNING ${RESERVATION_COLUMNS}
        `,
        [
          targetStatus, transitionKey, transitionHash, consumedMovementId,
          reservation.id, input.tenantId, input.factoryId, reservation.item_id,
        ],
      );
      if (!updated.rows[0]) throw new ConflictException('Work-order material reservation changed concurrently');
      const units = toUnits(reservation.quantity);
      quantityByItem.set(reservation.item_id, (quantityByItem.get(reservation.item_id) ?? 0n) + units);

      await this.insertOutboxEvent(client, {
        tenantId: input.tenantId, factoryId: input.factoryId,
        aggregateId: reservation.item_id,
        eventType: targetStatus === 'RELEASED'
          ? 'INVENTORY.WORK_ORDER_MATERIAL_RESERVATION_RELEASED'
          : 'INVENTORY.WORK_ORDER_MATERIAL_CONSUMED',
        correlationId: input.correlationId, userId: input.userId,
        payload: {
          work_order_id: input.workOrderId,
          work_order_number: input.workOrderNumber,
          reservation: {
            id: reservation.id, item_id: reservation.item_id,
            location_id: reservation.location_id, quantity: reservation.quantity,
            status: targetStatus, consumed_movement_id: consumedMovementId,
          },
          balance: { quantity_on_hand: balance.quantity_on_hand, quantity_reserved: balance.quantity_reserved },
        },
      });
    }

    return {
      reservationCount: reservations.length,
      quantityByItem: [...quantityByItem.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([item_id, units]) => ({ item_id, quantity: fromUnits(units) })),
    };
  }

  async listReservations(
    tenantId: string,
    factoryId: string,
    itemId: string,
    options: { status?: string; limit?: number } = {},
  ): Promise<ReservationResult[]> {
    this.validateReadScope(tenantId, factoryId);
    this.validateUuid(itemId, 'itemId');
    const limit = options.limit ?? 50;
    this.validateLimit(limit);
    const status = options.status ?? null;
    if (status !== null && !['RESERVED', 'RELEASED', 'CONSUMED'].includes(status)) {
      throw new BadRequestException('Unsupported inventory reservation status filter');
    }

    const item = await this.database.query<{ id: string }>(
      `SELECT id::text AS id
       FROM inventory_items
       WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
       LIMIT 1`,
      [itemId, tenantId, factoryId],
      { tenantId },
    );
    if (!item.rows[0]) throw new NotFoundException('Inventory item not found in this factory');

    const result = await this.database.query<ReservationRow>(
      `SELECT ${RESERVATION_COLUMNS}
       FROM inventory_reservations
       WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3
         AND ($4::text IS NULL OR status = $4)
       ORDER BY created_at DESC, id DESC
       LIMIT $5`,
      [tenantId, factoryId, itemId, status, limit],
      { tenantId },
    );
    return result.rows.map((row) => this.toResult(row, false));
  }

  async transitionReservation(
    userId: string,
    tenantId: string,
    factoryId: string,
    itemId: string,
    reservationId: string,
    dto: TransitionInventoryReservationDto,
    rawIdempotencyKey: string | null,
    requestId: string | null,
    traceId: string | null,
  ): Promise<ReservationResult> {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(itemId, 'itemId');
    this.validateUuid(reservationId, 'reservationId');
    const targetStatus = dto.target_status;
    if (!['RELEASED', 'CONSUMED'].includes(targetStatus)) {
      throw new BadRequestException('target_status must be RELEASED or CONSUMED');
    }
    const transitionKey = this.requiredIdempotencyKey(rawIdempotencyKey);
    const transitionHash = this.hash({
      reservationId: reservationId.toLowerCase(),
      targetStatus,
    });

    let result: ReservationResult;
    try {
      result = await this.database.transaction(
        { tenantId, userId },
        async (client) => {
        // Use the same item -> reservation lock order as creation and stock movements.
        const itemResult = await client.query<{ id: string; status: string }>(
          `
          SELECT id::text AS id, status
          FROM inventory_items
          WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
          FOR UPDATE
          `,
          [itemId, tenantId, factoryId],
        );
        const item = itemResult.rows[0];
        if (!item) throw new NotFoundException('Inventory item not found in this factory');

        const reservationResult = await client.query<ReservationRow>(
          `SELECT ${RESERVATION_COLUMNS}
           FROM inventory_reservations
           WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 AND item_id = $4
           FOR UPDATE`,
          [reservationId, tenantId, factoryId, itemId],
        );
        const reservation = reservationResult.rows[0];
        if (!reservation) throw new NotFoundException('Inventory reservation not found in this factory');

        if (reservation.status !== 'RESERVED') {
          if (
            reservation.status === targetStatus
            && reservation.transition_idempotency_key === transitionKey
            && reservation.transition_request_hash === transitionHash
          ) {
            return this.toResult(reservation, true);
          }
          if (reservation.status === targetStatus && reservation.transition_idempotency_key === transitionKey) {
            throw new ConflictException('Idempotency-Key was reused for a different reservation transition');
          }
          throw new ConflictException('Inventory reservation is already terminal and cannot transition again');
        }
        if (targetStatus === 'CONSUMED' && item.status !== 'ACTIVE') {
          throw new ConflictException('Disabled inventory items cannot consume reservations');
        }

        let balance: BalanceRow | undefined;
        let consumedMovementId: string | null = null;
        if (reservation.location_id) {
          await this.decreaseLocationReserved(
            client, tenantId, factoryId, itemId, reservation.location_id, reservation.quantity,
          );
          if (targetStatus === 'CONSUMED') {
            await client.query(
              `SELECT set_config('app.inventory_location_id', $1, TRUE)`,
              [reservation.location_id],
            );
          }
        }

        if (targetStatus === 'RELEASED') {
          const balanceResult = await client.query<BalanceRow>(
            `
            UPDATE inventory_stock_balances
            SET quantity_reserved = quantity_reserved - $1::numeric,
                version = version + 1,
                updated_at = clock_timestamp()
            WHERE tenant_id = $2 AND factory_id = $3 AND item_id = $4
              AND quantity_reserved >= $1::numeric
            RETURNING quantity_on_hand::text AS quantity_on_hand,
              quantity_reserved::text AS quantity_reserved
            `,
            [reservation.quantity, tenantId, factoryId, itemId],
          );
          balance = balanceResult.rows[0];
        } else {
          const balanceResult = await client.query<BalanceRow>(
            `
            UPDATE inventory_stock_balances
            SET
              quantity_on_hand = quantity_on_hand - $1::numeric,
              quantity_reserved = quantity_reserved - $1::numeric,
              version = version + 1,
              updated_at = clock_timestamp()
            WHERE tenant_id = $2 AND factory_id = $3 AND item_id = $4
              AND quantity_reserved >= $1::numeric
              AND quantity_on_hand >= $1::numeric
            RETURNING quantity_on_hand::text AS quantity_on_hand,
              quantity_reserved::text AS quantity_reserved
            `,
            [reservation.quantity, tenantId, factoryId, itemId],
          );
          balance = balanceResult.rows[0];
        }
        if (!balance) throw new ConflictException('Inventory reservation balance is inconsistent; no transition was applied');

        const correlationId = this.correlationId(requestId, traceId);
        if (targetStatus === 'CONSUMED') {
          const movementKey = 'reservation-consume-' + this.hash({
            tenantId, factoryId, reservationId, transitionKey,
          }).slice(0, 48);
          const movementResult = await client.query<MovementRow>(
            `
            INSERT INTO inventory_movements (
              tenant_id, factory_id, item_id, location_id, movement_type, quantity,
              quantity_delta, quantity_after, idempotency_key, request_hash,
              reference_type, reference_id, notes, created_by_user_id, correlation_id
            )
            VALUES ($1, $2, $3, $4::uuid, 'ISSUE', $5::numeric, -$5::numeric, $6::numeric,
              $7, $8, 'RESERVATION', $9::uuid, $10, $11, $12::uuid)
            RETURNING id::text AS id, quantity_after::text AS quantity_after
            `,
            [
              tenantId, factoryId, itemId, reservation.location_id,
              reservation.quantity, balance.quantity_on_hand,
              movementKey, transitionHash, reservationId,
              reservation.notes, userId, correlationId,
            ],
          );
          consumedMovementId = movementResult.rows[0]?.id ?? null;
          if (!consumedMovementId) throw new Error('INVENTORY_RESERVATION_CONSUMPTION_MOVEMENT_INSERT_FAILED');
          await this.insertOutboxEvent(client, {
            tenantId, factoryId, aggregateId: itemId, eventType: 'INVENTORY.STOCK_ISSUED',
            correlationId, userId,
            payload: {
              movement: {
                id: consumedMovementId,
                item_id: itemId, location_id: reservation.location_id,
                movement_type: 'ISSUE', quantity: reservation.quantity,
                quantity_delta: '-' + reservation.quantity, quantity_after: balance.quantity_on_hand,
                reference_type: 'RESERVATION', reference_id: reservationId,
              },
              reservation_id: reservationId,
            },
          });
        }

        const updatedResult = await client.query<ReservationRow>(
          `
          UPDATE inventory_reservations
          SET status = $1,
              transition_idempotency_key = $2,
              transition_request_hash = $3,
              consumed_movement_id = $4::uuid,
              updated_at = clock_timestamp()
          WHERE id = $5 AND tenant_id = $6 AND factory_id = $7 AND item_id = $8
            AND status = 'RESERVED'
          RETURNING ${RESERVATION_COLUMNS}
          `,
          [
            targetStatus, transitionKey, transitionHash, consumedMovementId,
            reservationId, tenantId, factoryId, itemId,
          ],
        );
        const updated = updatedResult.rows[0];
        if (!updated) throw new ConflictException('Inventory reservation changed concurrently; no transition was applied');

        await this.insertOutboxEvent(client, {
          tenantId, factoryId, aggregateId: itemId,
          eventType: targetStatus === 'RELEASED'
            ? 'INVENTORY.STOCK_RESERVATION_RELEASED'
            : 'INVENTORY.STOCK_RESERVATION_CONSUMED',
          correlationId, userId,
          payload: {
            reservation: {
              id: reservationId, item_id: itemId, quantity: reservation.quantity,
              status: targetStatus, consumed_movement_id: consumedMovementId,
            },
            balance: {
              quantity_on_hand: balance.quantity_on_hand,
              quantity_reserved: balance.quantity_reserved,
            },
          },
        });
          return this.toResult(updated, false);
        },
      );
    } catch (error) {
      if (this.errorCode(error) === '23505') {
        throw new ConflictException('Idempotency-Key has already been used for another reservation transition');
      }
      throw error;
    }

    if (!result.replayed) {
      await this.recordAuditSafely({
        tenantId, factoryId, userId,
        action: targetStatus === 'RELEASED' ? 'RESERVATION_RELEASE' : 'RESERVATION_CONSUME',
        resourceId: result.id, requestId, traceId,
        payload: {
          itemId, quantity: result.quantity, status: result.status,
          consumedMovementId: result.consumed_movement_id,
        },
      });
    }
    return result;
  }

  private decimalToUnits(value: string): bigint {
    const match = /^(\\d+)(?:\\.(\\d{1,4}))?$/.exec(String(value).trim());
    if (!match) throw new ConflictException('Inventory quantity is not a valid four-decimal value');
    return BigInt(match[1]!) * 10000n + BigInt((match[2] ?? '').padEnd(4, '0'));
  }

  private unitsToDecimal(value: bigint): string {
    if (value < 0n) throw new ConflictException('Inventory quantity cannot be negative');
    return `${value / 10000n}.${String(value % 10000n).padStart(4, '0')}`;
  }

  private async planTraceabilityAllocations(
    client: PoolClient,
    input: {
      tenantId: string;
      factoryId: string;
      itemId: string;
      quantity: string;
      locationId?: string | null;
    },
  ): Promise<TraceabilityAllocationPlan> {
    const settings = await client.query<{ allocation_policy: TraceabilityAllocationPolicy }>(
      `
      SELECT allocation_policy
      FROM traceability_settings
      WHERE tenant_id = $1 AND factory_id = $2
      FOR SHARE
      `,
      [input.tenantId, input.factoryId],
    );
    const policy = settings.rows[0]?.allocation_policy ?? 'FIFO';
    const identityTypeResult = await client.query<{ has_lot: boolean; has_serial: boolean; has_identity: boolean }>(
      `
      SELECT
        COALESCE(bool_or(unit_type = 'LOT'), FALSE) AS has_lot,
        COALESCE(bool_or(unit_type = 'SERIAL'), FALSE) AS has_serial,
        (count(*) > 0) AS has_identity
      FROM traceability_units
      WHERE tenant_id = $1 AND factory_id = $2
        AND inventory_item_id = $3 AND product_role = 'MATERIAL'
        AND unit_type IN ('LOT', 'SERIAL')
      `,
      [input.tenantId, input.factoryId, input.itemId],
    );
    const identities = identityTypeResult.rows[0];
    const hasIdentity = identities?.has_identity ?? false;
    if ((policy === 'LOT' || policy === 'SERIAL') && !hasIdentity) {
      throw new ConflictException(`Material allocation policy ${policy} requires registered ${policy.toLowerCase()} identities before reserving stock`);
    }
    if ((policy === 'FIFO' || policy === 'FEFO') && !hasIdentity) {
      return { enforced: false, policy, allocations: [] };
    }
    const unitType: 'LOT' | 'SERIAL' =
      policy === 'LOT' ? 'LOT'
        : policy === 'SERIAL' ? 'SERIAL'
          : identities?.has_lot ? 'LOT' : 'SERIAL';
    if (unitType === 'LOT' && !identities?.has_lot) {
      throw new ConflictException('Material allocation policy requires a registered lot identity');
    }
    if (unitType === 'SERIAL' && !identities?.has_serial) {
      throw new ConflictException('Material allocation policy requires registered serial identities');
    }

    const requestedUnits = this.decimalToUnits(input.quantity);
    if (requestedUnits <= 0n) throw new BadRequestException('Reservation quantity must be positive');
    if (unitType === 'SERIAL' && requestedUnits % 10000n !== 0n) {
      throw new ConflictException('Serial-controlled material can only be allocated in whole serialized units');
    }

    const candidates = await client.query<TraceabilityCandidate>(
      `
      SELECT
        tlb.traceability_unit_id::text AS traceability_unit_id,
        tlb.location_id::text AS location_id,
        tu.unit_type,
        tu.unit_code,
        tu.expires_at::text AS expires_at,
        COALESCE(gr.posted_at, gr.received_at, tu.created_at)::text AS received_at,
        tlb.quantity_on_hand::text AS quantity_on_hand,
        tlb.quantity_reserved::text AS quantity_reserved
      FROM inventory_traceability_location_balances tlb
      JOIN traceability_units tu
        ON tu.id = tlb.traceability_unit_id
       AND tu.tenant_id = tlb.tenant_id AND tu.factory_id = tlb.factory_id
       AND tu.inventory_item_id = tlb.item_id
      JOIN inventory_locations l
        ON l.id = tlb.location_id AND l.tenant_id = tlb.tenant_id AND l.factory_id = tlb.factory_id
      LEFT JOIN inventory_locations parent
        ON parent.id = l.parent_location_id AND parent.tenant_id = l.tenant_id AND parent.factory_id = l.factory_id
      LEFT JOIN goods_receipts gr
        ON gr.id = tu.goods_receipt_id AND gr.tenant_id = tu.tenant_id AND gr.factory_id = tu.factory_id
      WHERE tlb.tenant_id = $1 AND tlb.factory_id = $2 AND tlb.item_id = $3
        AND ($4::uuid IS NULL OR tlb.location_id = $4::uuid)
        AND tu.product_role = 'MATERIAL' AND tu.unit_type = $5
        AND tu.status = 'ACTIVE'
        AND (tu.expires_at IS NULL OR tu.expires_at >= CURRENT_DATE)
        AND NOT (tu.attributes @> '{"damaged":true}'::jsonb)
        AND NOT (tu.attributes @> '{"held":true}'::jsonb)
        AND NOT (tu.attributes @> '{"quarantined":true}'::jsonb)
        AND upper(COALESCE(tu.attributes->>'condition', '')) NOT IN ('DAMAGED', 'HELD', 'QUARANTINED', 'EXPIRED')
        AND NOT EXISTS (
          SELECT 1 FROM quality_holds qh
          WHERE qh.tenant_id = tu.tenant_id AND qh.factory_id = tu.factory_id
            AND qh.status = 'ACTIVE'
            AND (qh.inventory_item_id = tu.inventory_item_id OR qh.traceability_unit_id = tu.id)
        )
        AND l.status = 'ACTIVE' AND l.picking_enabled = TRUE
        AND (
          (l.location_type = 'BIN' AND parent.location_type IN ('WAREHOUSE', 'STAGING') AND parent.status = 'ACTIVE')
          OR (l.location_type = 'VIRTUAL' AND l.is_default = TRUE)
        )
        AND tlb.quantity_on_hand > tlb.quantity_reserved
      ORDER BY
        CASE WHEN $6::text = 'FEFO' THEN tu.expires_at END ASC NULLS LAST,
        CASE WHEN $6::text IN ('FIFO', 'FEFO') THEN COALESCE(gr.posted_at, gr.received_at, tu.created_at) END ASC NULLS LAST,
        lower(tu.unit_code), tlb.location_id, tu.id
      FOR UPDATE OF tlb, tu
      `,
      [input.tenantId, input.factoryId, input.itemId, input.locationId ?? null, unitType, policy],
    );

    let remaining = requestedUnits;
    const allocations: TraceabilityAllocation[] = [];
    for (const candidate of candidates.rows) {
      if (remaining === 0n) break;
      const available = this.decimalToUnits(candidate.quantity_on_hand)
        - this.decimalToUnits(candidate.quantity_reserved);
      if (available <= 0n) continue;
      const quantityUnits = unitType === 'SERIAL' ? 10000n
        : (available < remaining ? available : remaining);
      if (unitType === 'SERIAL' && available < 10000n) continue;
      const allocated = quantityUnits < remaining ? quantityUnits : remaining;
      allocations.push({
        traceabilityUnitId: candidate.traceability_unit_id.toLowerCase(),
        locationId: candidate.location_id.toLowerCase(),
        quantity: this.unitsToDecimal(allocated),
      });
      remaining -= allocated;
    }
    if (remaining !== 0n) {
      throw new ConflictException(
        `Insufficient eligible ${policy} lot/serial stock for item ${input.itemId}; expired, held, damaged, quarantined, recalled and unavailable identities are excluded`,
      );
    }
    return { enforced: true, policy, allocations };
  }

  private groupTraceabilityAllocationsByLocation(
    plan: TraceabilityAllocationPlan,
  ): Array<{ locationId: string; quantity: string }> {
    const grouped = new Map<string, bigint>();
    for (const allocation of plan.allocations) {
      grouped.set(
        allocation.locationId,
        (grouped.get(allocation.locationId) ?? 0n) + this.decimalToUnits(allocation.quantity),
      );
    }
    return [...grouped.entries()].map(([locationId, units]) => ({
      locationId,
      quantity: this.unitsToDecimal(units),
    }));
  }

  private async persistTraceabilityAllocations(
    client: PoolClient,
    input: {
      tenantId: string;
      factoryId: string;
      itemId: string;
      reservationId: string;
      allocations: TraceabilityAllocation[];
    },
  ): Promise<void> {
    for (const allocation of input.allocations) {
      const updated = await client.query<{ id: string }>(
        `
        UPDATE inventory_traceability_location_balances
        SET quantity_reserved = quantity_reserved + $1::numeric,
            version = version + 1, updated_at = clock_timestamp()
        WHERE tenant_id = $2 AND factory_id = $3 AND item_id = $4
          AND traceability_unit_id = $5 AND location_id = $6
          AND quantity_on_hand - quantity_reserved >= $1::numeric
        RETURNING id::text AS id
        `,
        [allocation.quantity, input.tenantId, input.factoryId, input.itemId, allocation.traceabilityUnitId, allocation.locationId],
      );
      if (!updated.rows[0]) {
        throw new ConflictException('Lot/serial availability changed during reservation; the complete reservation transaction was rolled back');
      }
      await client.query(
        `
        INSERT INTO inventory_reservation_traceability_allocations (
          tenant_id, factory_id, reservation_id, item_id,
          traceability_unit_id, location_id, allocated_quantity
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::numeric)
        `,
        [input.tenantId, input.factoryId, input.reservationId, input.itemId,
          allocation.traceabilityUnitId, allocation.locationId, allocation.quantity],
      );
    }
  }

  private async hasMaterialTraceabilityUnits(
    client: PoolClient,
    tenantId: string,
    factoryId: string,
    itemId: string,
  ): Promise<boolean> {
    const result = await client.query<{ present: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1 FROM traceability_units
        WHERE tenant_id = $1 AND factory_id = $2 AND inventory_item_id = $3
          AND product_role = 'MATERIAL' AND unit_type IN ('LOT', 'SERIAL')
      ) AS present
      `,
      [tenantId, factoryId, itemId],
    );
    return result.rows[0]?.present ?? false;
  }

  private async consumeTraceabilityAllocations(
    client: PoolClient,
    input: {
      tenantId: string;
      factoryId: string;
      itemId: string;
      reservationId: string;
      consumptionId: string;
      quantity: string;
    },
  ): Promise<void> {
    const allocations = await client.query<{
      id: string;
      traceability_unit_id: string;
      location_id: string;
      remaining_quantity: string;
    }>(
      `
      SELECT a.id::text AS id, a.traceability_unit_id::text AS traceability_unit_id,
             a.location_id::text AS location_id,
             (a.allocated_quantity - a.consumed_quantity - a.released_quantity)::numeric(18,4)::text AS remaining_quantity
      FROM inventory_reservation_traceability_allocations a
      WHERE a.tenant_id = $1 AND a.factory_id = $2 AND a.item_id = $3
        AND a.reservation_id = $4
        AND a.allocated_quantity > a.consumed_quantity + a.released_quantity
      ORDER BY a.created_at, a.id
      FOR UPDATE
      `,
      [input.tenantId, input.factoryId, input.itemId, input.reservationId],
    );
    if (allocations.rows.length === 0) {
      if (await this.hasMaterialTraceabilityUnits(client, input.tenantId, input.factoryId, input.itemId)) {
        throw new ConflictException('This reservation has no lot/serial allocation evidence; stock cannot be issued through an untracked fallback');
      }
      return;
    }

    let remaining = this.decimalToUnits(input.quantity);
    for (const allocation of allocations.rows) {
      if (remaining === 0n) break;
      const available = this.decimalToUnits(allocation.remaining_quantity);
      if (available <= 0n) continue;
      const units = available < remaining ? available : remaining;
      const quantity = this.unitsToDecimal(units);
      const balance = await client.query<{ id: string }>(
        `
        UPDATE inventory_traceability_location_balances
        SET quantity_on_hand = quantity_on_hand - $1::numeric,
            quantity_reserved = quantity_reserved - $1::numeric,
            version = version + 1, updated_at = clock_timestamp()
        WHERE tenant_id = $2 AND factory_id = $3 AND item_id = $4
          AND traceability_unit_id = $5 AND location_id = $6
          AND quantity_on_hand >= $1::numeric AND quantity_reserved >= $1::numeric
        RETURNING id::text AS id
        `,
        [quantity, input.tenantId, input.factoryId, input.itemId, allocation.traceability_unit_id, allocation.location_id],
      );
      if (!balance.rows[0]) {
        throw new ConflictException('Lot/serial balance changed before issue; the full issue transaction was rolled back');
      }
      const updated = await client.query<{ id: string }>(
        `
        UPDATE inventory_reservation_traceability_allocations
        SET consumed_quantity = consumed_quantity + $1::numeric,
            updated_at = clock_timestamp()
        WHERE id = $2 AND tenant_id = $3 AND factory_id = $4
          AND consumed_quantity + released_quantity + $1::numeric <= allocated_quantity
        RETURNING id::text AS id
        `,
        [quantity, allocation.id, input.tenantId, input.factoryId],
      );
      if (!updated.rows[0]) throw new ConflictException('Lot/serial reservation allocation changed during issue');
      await client.query(
        `
        INSERT INTO inventory_reservation_consumption_traceability_allocations (
          tenant_id, factory_id, consumption_id, traceability_unit_id, location_id, quantity
        )
        VALUES ($1, $2, $3, $4, $5, $6::numeric)
        `,
        [input.tenantId, input.factoryId, input.consumptionId, allocation.traceability_unit_id, allocation.location_id, quantity],
      );
      remaining -= units;
    }
    if (remaining !== 0n) {
      throw new ConflictException('Reserved lot/serial allocations do not cover the requested issue quantity');
    }
  }

  private async releaseTraceabilityAllocations(
    client: PoolClient,
    input: {
      tenantId: string;
      factoryId: string;
      itemId: string;
      reservationId: string;
      quantity: string;
    },
  ): Promise<void> {
    const allocations = await client.query<{
      id: string; traceability_unit_id: string; location_id: string; remaining_quantity: string;
    }>(
      `
      SELECT a.id::text AS id, a.traceability_unit_id::text AS traceability_unit_id,
        a.location_id::text AS location_id,
        (a.allocated_quantity-a.consumed_quantity-a.released_quantity)::numeric(18,4)::text AS remaining_quantity
      FROM inventory_reservation_traceability_allocations a
      WHERE a.tenant_id=$1 AND a.factory_id=$2 AND a.item_id=$3 AND a.reservation_id=$4
        AND a.allocated_quantity>a.consumed_quantity+a.released_quantity
      ORDER BY a.created_at, a.id
      FOR UPDATE
      `,
      [input.tenantId, input.factoryId, input.itemId, input.reservationId],
    );
    let remaining = this.decimalToUnits(input.quantity);
    for (const allocation of allocations.rows) {
      if (remaining === 0n) break;
      const available = this.decimalToUnits(allocation.remaining_quantity);
      const units = available < remaining ? available : remaining;
      if (units <= 0n) continue;
      const quantity = this.unitsToDecimal(units);
      const balance = await client.query<{ id: string }>(
        `
        UPDATE inventory_traceability_location_balances
        SET quantity_reserved = quantity_reserved - $1::numeric,
            version = version + 1, updated_at = clock_timestamp()
        WHERE tenant_id=$2 AND factory_id=$3 AND item_id=$4
          AND traceability_unit_id=$5 AND location_id=$6 AND quantity_reserved >= $1::numeric
        RETURNING id::text AS id
        `,
        [quantity, input.tenantId, input.factoryId, input.itemId, allocation.traceability_unit_id, allocation.location_id],
      );
      if (!balance.rows[0]) throw new ConflictException('Lot/serial reserved balance is inconsistent while releasing inventory');
      const updated = await client.query<{ id: string }>(
        `
        UPDATE inventory_reservation_traceability_allocations
        SET released_quantity = released_quantity + $1::numeric, updated_at = clock_timestamp()
        WHERE id=$2 AND tenant_id=$3 AND factory_id=$4
          AND consumed_quantity + released_quantity + $1::numeric <= allocated_quantity
        RETURNING id::text AS id
        `,
        [quantity, allocation.id, input.tenantId, input.factoryId],
      );
      if (!updated.rows[0]) throw new ConflictException('Lot/serial allocation changed during reservation release');
      remaining -= units;
    }
    if (remaining !== 0n) {
      throw new ConflictException('Lot/serial allocation does not cover the reservation quantity being released');
    }
  }

  private async decreaseLocationReserved(
    client: PoolClient,
    tenantId: string,
    factoryId: string,
    itemId: string,
    locationId: string,
    quantity: string,
  ): Promise<void> {
    const result = await client.query<{ location_id: string }>(
      `
      UPDATE inventory_location_balances
      SET quantity_reserved = quantity_reserved - $1::numeric,
          version = version + 1,
          updated_at = clock_timestamp()
      WHERE tenant_id = $2 AND factory_id = $3 AND item_id = $4
        AND location_id = $5 AND quantity_reserved >= $1::numeric
      RETURNING location_id::text AS location_id
      `,
      [quantity, tenantId, factoryId, itemId, locationId],
    );
    if (!result.rows[0]) {
      throw new ConflictException('Location reservation balance is inconsistent; no transition was applied');
    }
  }

  private async findByIdempotencyKey(
    client: PoolClient,
    tenantId: string,
    factoryId: string,
    idempotencyKey: string,
  ): Promise<ReservationRow | null> {
    const result = await client.query<ReservationRow>(
      `SELECT ${RESERVATION_COLUMNS}
       FROM inventory_reservations
       WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3
       LIMIT 1`,
      [tenantId, factoryId, idempotencyKey],
    );
    return result.rows[0] ?? null;
  }

  private replayOrConflict(row: ReservationRow, requestHash: string): ReservationResult {
    if (row.request_hash !== requestHash) {
      throw new ConflictException('Idempotency-Key has already been used for a different inventory reservation');
    }
    return this.toResult(row, true);
  }

  private toResult(row: ReservationRow, replayed: boolean): ReservationResult {
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      factory_id: row.factory_id,
      item_id: row.item_id,
      location_id: row.location_id,
      quantity: row.quantity,
      status: row.status,
      reference_type: row.reference_type,
      reference_id: row.reference_id,
      notes: row.notes,
      consumed_movement_id: row.consumed_movement_id,
      created_by_user_id: row.created_by_user_id,
      correlation_id: row.correlation_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      replayed,
    };
  }

  private async insertOutboxEvent(
    client: PoolClient,
    input: {
      tenantId: string;
      factoryId: string;
      aggregateId: string;
      eventType: string;
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
        $1, $2, 'INVENTORY_ITEM', $3, $4, 1, clock_timestamp(),
        $5::uuid, NULL, $6::jsonb, $7::jsonb, $8::jsonb
      )
      `,
      [
        input.tenantId, input.factoryId, input.aggregateId, input.eventType,
        input.correlationId,
        JSON.stringify({ type: 'user', id: input.userId }),
        JSON.stringify({
          system: 'FactoryOS',
          connector: 'inventory-reservation-service',
          version: process.env.APP_VERSION ?? process.env.npm_package_version ?? '0.1.0',
        }),
        JSON.stringify(input.payload),
      ],
    );
  }

  private async recordAuditSafely(input: {
    tenantId: string;
    factoryId: string;
    userId: string;
    action: string;
    resourceId: string;
    resourceType?: string;
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
        action: input.action,
        resourceType: input.resourceType ?? 'INVENTORY_RESERVATION',
        resourceId: input.resourceId,
        requestId: input.requestId && isUUID(input.requestId) ? input.requestId : null,
        correlationId: input.traceId && isUUID(input.traceId) ? input.traceId : null,
        dataClass: 'INTERNAL',
        payload: input.payload,
      });
    } catch {
      // The balance and durable outbox event have already committed.
    }
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

  private normalizeQuantity(value: number): string {
    if (!Number.isFinite(value) || value <= 0) {
      throw new BadRequestException('quantity must be a positive number');
    }
    if (Math.abs(value * 10000 - Math.round(value * 10000)) > 0.000001) {
      throw new BadRequestException('quantity supports at most 4 decimal places');
    }
    return value.toFixed(4);
  }

  private requiredIdempotencyKey(value: string | null): string {
    const key = value?.trim() ?? '';
    if (!key) throw new BadRequestException('Idempotency-Key is required for inventory reservations');
    if (key.length > 255) throw new BadRequestException('Idempotency-Key must be at most 255 characters');
    return key;
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

  private hash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private errorCode(error: unknown): string | null {
    if (typeof error !== 'object' || error === null || !('code' in error)) return null;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
}
