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
  quantity: string;
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

interface OrderMaterialDispositionRow extends QueryResultRow {
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

type OrderMaterialDispositionResult = Omit<
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
  quantity: string;
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
  quantity::text AS quantity,
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
    const notes = dto.notes?.trim() || null;
    const requestHash = this.hash({
      itemId: itemId.toLowerCase(),
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
              tenant_id, factory_id, item_id, quantity, idempotency_key,
              request_hash, reference_type, reference_id, notes,
              created_by_user_id, correlation_id
            )
            VALUES ($1, $2, $3, $4::numeric, $5, $6, $7, $8::uuid, $9, $10, $11::uuid)
            RETURNING ${RESERVATION_COLUMNS}
            `,
            [
              tenantId, factoryId, itemId, quantity, idempotencyKey, requestHash,
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
                id: row.id, item_id: itemId, quantity: row.quantity, status: row.status,
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
        payload: { itemId, quantity: result.quantity, referenceType, referenceId },
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
            SELECT ${RESERVATION_COLUMNS}
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
      userId: string;
      tenantId: string;
      factoryId: string;
      orderId: string;
      orderNumber: string;
      requestId: string | null;
      traceId: string | null;
    },
  ): Promise<number> {
    const linesResult = await client.query<{
      id: string;
      line_number: number;
      item_id: string;
      quantity: string;
      unit: string;
    }>(
      `
      SELECT ol.id::text AS id, ol.line_number,
             ol.inventory_item_id::text AS item_id,
             ol.quantity::text AS quantity, ol.unit
      FROM order_lines ol
      WHERE ol.order_id = $1
        AND ol.tenant_id = $2
        AND ol.factory_id = $3
        AND ol.inventory_item_id IS NOT NULL
      ORDER BY ol.inventory_item_id, ol.id
      FOR UPDATE
      `,
      [input.orderId, input.tenantId, input.factoryId],
    );

    let createdCount = 0;
    const correlationId = this.correlationId(input.requestId, input.traceId);

    for (const line of linesResult.rows) {
      const itemResult = await client.query<{ id: string; status: string; unit: string }>(
        `
        SELECT id::text AS id, status, unit
        FROM inventory_items
        WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
        FOR UPDATE
        `,
        [line.item_id, input.tenantId, input.factoryId],
      );
      const item = itemResult.rows[0];
      if (!item) {
        throw new NotFoundException(`Inventory item on order line ${line.line_number} was not found in this factory`);
      }
      if (item.status !== 'ACTIVE') {
        throw new ConflictException(`Inventory item on order line ${line.line_number} is disabled`);
      }
      if (item.unit.trim().toUpperCase() !== line.unit.trim().toUpperCase()) {
        throw new ConflictException(`Order line ${line.line_number} unit no longer matches its inventory item`);
      }

      const quantity = this.normalizeQuantity(Number(line.quantity));
      const referenceType = 'ORDER_LINE';
      const referenceId = line.id.toLowerCase();
      const notes = `Reserved for order ${input.orderNumber} (line ${line.line_number})`;
      const idempotencyKey = `order:${input.orderId}:line:${line.id}:reserve:v1`;
      const requestHash = this.hash({
        itemId: line.item_id.toLowerCase(),
        quantity,
        referenceType,
        referenceId,
        notes,
      });

      const prior = await this.findByIdempotencyKey(
        client, input.tenantId, input.factoryId, idempotencyKey,
      );
      if (prior) {
        this.replayOrConflict(prior, requestHash);
        if (prior.status !== 'RESERVED') {
          throw new ConflictException(`Order line ${line.line_number} already has a terminal inventory reservation`);
        }
        continue;
      }

      const activeReservation = await client.query<{ id: string }>(
        `
        SELECT id::text AS id
        FROM inventory_reservations
        WHERE tenant_id = $1 AND factory_id = $2
          AND reference_type = 'ORDER_LINE'
          AND reference_id = $3::uuid
          AND status = 'RESERVED'
        ORDER BY id
        LIMIT 1
        FOR UPDATE
        `,
        [input.tenantId, input.factoryId, referenceId],
      );
      if (activeReservation.rows[0]) {
        throw new ConflictException(
          `Order line ${line.line_number} already has an active inventory reservation`,
        );
      }

      const balanceResult = await client.query<BalanceRow>(
        `
        UPDATE inventory_stock_balances
        SET quantity_reserved = quantity_reserved + $1::numeric,
            version = version + 1,
            updated_at = clock_timestamp()
        WHERE tenant_id = $2 AND factory_id = $3 AND item_id = $4
          AND quantity_on_hand - quantity_reserved >= $1::numeric
        RETURNING quantity_on_hand::text AS quantity_on_hand,
                  quantity_reserved::text AS quantity_reserved
        `,
        [quantity, input.tenantId, input.factoryId, line.item_id],
      );
      const balance = balanceResult.rows[0];
      if (!balance) {
        throw new ConflictException(`Insufficient available stock for order line ${line.line_number}`);
      }

      const inserted = await client.query<ReservationRow>(
        `
        INSERT INTO inventory_reservations (
          tenant_id, factory_id, item_id, quantity, idempotency_key,
          request_hash, reference_type, reference_id, notes,
          created_by_user_id, correlation_id
        )
        VALUES ($1, $2, $3, $4::numeric, $5, $6, $7, $8::uuid, $9, $10, $11::uuid)
        RETURNING ${RESERVATION_COLUMNS}
        `,
        [
          input.tenantId, input.factoryId, line.item_id, quantity, idempotencyKey,
          requestHash, referenceType, referenceId, notes, input.userId, correlationId,
        ],
      );
      const reservation = inserted.rows[0];
      if (!reservation) throw new Error('ORDER_INVENTORY_RESERVATION_INSERT_FAILED');

      await this.insertOutboxEvent(client, {
        tenantId: input.tenantId,
        factoryId: input.factoryId,
        aggregateId: line.item_id,
        eventType: 'INVENTORY.STOCK_RESERVED',
        correlationId,
        userId: input.userId,
        payload: {
          reservation: {
            id: reservation.id,
            item_id: line.item_id,
            quantity: reservation.quantity,
            status: reservation.status,
            reference_type: referenceType,
            reference_id: referenceId,
            order_id: input.orderId,
            order_number: input.orderNumber,
          },
          balance: {
            quantity_on_hand: balance.quantity_on_hand,
            quantity_reserved: balance.quantity_reserved,
          },
        },
      });
      createdCount += 1;
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
            tenant_id, factory_id, item_id, movement_type, quantity,
            quantity_delta, quantity_after, idempotency_key, request_hash,
            reference_type, reference_id, notes, created_by_user_id, correlation_id
          )
          VALUES ($1, $2, $3, 'ISSUE', $4::numeric, -$4::numeric, $5::numeric,
                  $6, $7, 'RESERVATION', $8::uuid, $9, $10, $11::uuid)
          RETURNING id::text AS id, quantity_after::text AS quantity_after
          `,
          [
            input.tenantId, input.factoryId, reservation.item_id, reservation.quantity,
            balance.quantity_on_hand, movementKey, transitionHash, reservation.id,
            reservation.notes, input.userId, correlationId,
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
              tenant_id, factory_id, item_id, movement_type, quantity,
              quantity_delta, quantity_after, idempotency_key, request_hash,
              reference_type, reference_id, notes, created_by_user_id, correlation_id
            )
            VALUES ($1, $2, $3, 'ISSUE', $4::numeric, -$4::numeric, $5::numeric,
              $6, $7, 'RESERVATION', $8::uuid, $9, $10, $11::uuid)
            RETURNING id::text AS id, quantity_after::text AS quantity_after
            `,
            [
              tenantId, factoryId, itemId, reservation.quantity, balance.quantity_on_hand,
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
                item_id: itemId, movement_type: 'ISSUE', quantity: reservation.quantity,
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
