import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { isUUID } from 'class-validator';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import {
  CreateInventoryItemDto,
  CreateInventoryMovementDto,
  CreateInventoryReservationDto,
  InventoryReservationStatus,
  ListInventoryReservationsDto,
  TransitionInventoryReservationDto,
  InventoryMovementType,
  ListInventoryBalancesDto,
  ListInventoryItemsDto,
  ListInventoryMovementsDto,
} from './inventory.dto';

interface InventoryItemRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  item_code: string;
  item_name: string;
  base_unit: string;
  status: 'ACTIVE' | 'INACTIVE';
  version: number;
  created_at: string;
  updated_at: string;
}

interface InventoryMovementRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  item_id: string;
  item_code: string;
  item_name: string;
  location_code: string;
  movement_type: InventoryMovementType;
  quantity_delta: string;
  on_hand_after: string;
  reason: string;
  reference_ref: string | null;
  idempotency_key: string;
  recorded_by: string;
  correlation_id: string | null;
  request_id: string | null;
  created_at: string;
}


interface InventoryReservationRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  item_id: string;
  item_code: string;
  item_name: string;
  base_unit: string;
  location_code: string;
  quantity: string;
  status: InventoryReservationStatus;
  reason: string;
  reference_ref: string | null;
  idempotency_key: string;
  created_by_user_id: string;
  updated_by_user_id: string;
  created_at: string;
  updated_at: string;
  version: number;
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly database: DatabaseService,
    private readonly auditService: AuditService,
  ) {}

  async createItem(
    userId: string,
    tenantId: string,
    factoryId: string,
    dto: CreateInventoryItemDto,
    requestId: string | null,
    traceId: string | null,
  ): Promise<InventoryItemRow> {
    this.validateIdentity(userId, tenantId, factoryId);
    const itemCode = dto.item_code.trim().toUpperCase();
    const itemName = dto.item_name.trim();
    const baseUnit = dto.base_unit.trim();

    if (
      !/^[A-Z0-9][A-Z0-9._-]{0,79}$/.test(itemCode) ||
      !itemName ||
      itemName.length > 240 ||
      !/^[A-Za-z][A-Za-z0-9._-]{0,23}$/.test(baseUnit)
    ) {
      throw new BadRequestException('Inventory item code, name or base unit is invalid');
    }

    let item: InventoryItemRow;
    try {
      item = await this.database.transaction(
        { tenantId, userId },
        async (client) => {
          await this.assertActiveFactory(client, tenantId, factoryId);
          const result = await client.query<InventoryItemRow>(
            `
            INSERT INTO inventory_items (
              tenant_id, factory_id, item_code, item_name, base_unit, created_by_user_id
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING
              id::text AS id,
              tenant_id::text AS tenant_id,
              factory_id::text AS factory_id,
              item_code, item_name, base_unit, status,
              version::int AS version,
              created_at::text AS created_at,
              updated_at::text AS updated_at
            `,
            [tenantId, factoryId, itemCode, itemName, baseUnit, userId],
          );
          const row = result.rows[0];
          if (!row) throw new Error('INVENTORY_ITEM_INSERT_FAILED');
          return row;
        },
      );
    } catch (error) {
      if (this.pgCode(error) === '23505') {
        throw new ConflictException('Inventory item code already exists in this factory');
      }
      throw error;
    }

    await this.recordAuditSafely({
      tenantId, factoryId, userId, requestId, traceId,
      action: 'CREATE',
      resourceType: 'INVENTORY_ITEM',
      resourceId: item.id,
      payload: { itemCode: item.item_code, baseUnit: item.base_unit },
    });
    return item;
  }

  async listItems(tenantId: string, factoryId: string, query: ListInventoryItemsDto) {
    this.validateIdentity(null, tenantId, factoryId);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const values: unknown[] = [tenantId, factoryId];
    let filter = '';
    if (query.search?.trim()) {
      values.push(`%${query.search.trim()}%`);
      filter = `AND (item_code ILIKE $3 OR item_name ILIKE $3)`;
    }
    values.push(limit, (page - 1) * limit);
    const limitIndex = values.length - 1;
    const offsetIndex = values.length;

    const result = await this.database.query<InventoryItemRow>(
      `
      SELECT
        id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id,
        item_code, item_name, base_unit, status, version::int AS version,
        created_at::text AS created_at, updated_at::text AS updated_at
      FROM inventory_items
      WHERE tenant_id = $1 AND factory_id = $2 ${filter}
      ORDER BY item_code ASC, id ASC
      LIMIT $${limitIndex} OFFSET $${offsetIndex}
      `,
      values,
      { tenantId },
    );
    return { page, limit, items: result.rows };
  }

  async createMovement(
    userId: string,
    tenantId: string,
    factoryId: string,
    dto: CreateInventoryMovementDto,
    idempotencyKeyInput: string,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateIdentity(userId, tenantId, factoryId);
    this.validateMovement(dto);

    const idempotencyKey = idempotencyKeyInput.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(idempotencyKey)) {
      throw new BadRequestException('Idempotency-Key must be 1-128 safe ASCII characters');
    }
    this.validateOptionalUuid(requestId, 'requestId');
    this.validateOptionalUuid(traceId, 'traceId');

    const normalized = {
      item_id: dto.item_id.toLowerCase(),
      location_code: dto.location_code.trim().toUpperCase(),
      movement_type: dto.movement_type,
      quantity_delta: dto.quantity_delta,
      reason: dto.reason.trim(),
      reference_ref: dto.reference_ref?.trim() || null,
    };
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ tenant_id: tenantId, factory_id: factoryId, ...normalized }))
      .digest('hex');

    const result = await this.database.transaction(
      { tenantId, userId },
      async (client) => {
        // Serialize same-key requests before the ledger lookup.
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
          [tenantId, idempotencyKey],
        );

        const priorResult = await client.query<{ request_hash: string; id: string }>(
          `
          SELECT id::text AS id, request_hash
          FROM inventory_movements
          WHERE tenant_id = $1 AND idempotency_key = $2
          LIMIT 1
          `,
          [tenantId, idempotencyKey],
        );
        const prior = priorResult.rows[0];
        if (prior) {
          if (prior.request_hash !== requestHash) {
            throw new ConflictException('Idempotency-Key was already used for a different inventory movement');
          }
          return {
            movement: await this.getMovementInTransaction(client, tenantId, factoryId, prior.id),
            replayed: true,
          };
        }

        await this.assertActiveFactory(client, tenantId, factoryId);
        const itemResult = await client.query<{ id: string; item_code: string; item_name: string }>(
          `
          SELECT id::text AS id, item_code, item_name
          FROM inventory_items
          WHERE tenant_id = $1 AND factory_id = $2 AND id = $3 AND status = 'ACTIVE'
          FOR SHARE
          `,
          [tenantId, factoryId, normalized.item_id],
        );
        const item = itemResult.rows[0];
        if (!item) throw new NotFoundException('Active inventory item was not found in this factory');

        await client.query(
          `
          INSERT INTO inventory_stock_balances (tenant_id, factory_id, item_id, location_code, on_hand_quantity)
          VALUES ($1, $2, $3, $4, 0)
          ON CONFLICT (tenant_id, factory_id, item_id, location_code) DO NOTHING
          `,
          [tenantId, factoryId, item.id, normalized.location_code],
        );

        const balanceResult = await client.query<{ id: string; on_hand_quantity: string }>(
          `
          SELECT id::text AS id, on_hand_quantity::text AS on_hand_quantity
          FROM inventory_stock_balances
          WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3 AND location_code = $4
          FOR UPDATE
          `,
          [tenantId, factoryId, item.id, normalized.location_code],
        );
        const balance = balanceResult.rows[0];
        if (!balance) throw new Error('INVENTORY_BALANCE_LOCK_FAILED');

        const updateResult = await client.query<{ on_hand_after: string }>(
          `
          UPDATE inventory_stock_balances
          SET on_hand_quantity = on_hand_quantity + $1::numeric,
              version = version + 1,
              updated_at = clock_timestamp()
          WHERE id = $2 AND tenant_id = $3 AND factory_id = $4
            AND on_hand_quantity + $1::numeric >= reserved_quantity
            AND on_hand_quantity + $1::numeric <= 1000000000000
          RETURNING on_hand_quantity::text AS on_hand_after
          `,
          [normalized.quantity_delta, balance.id, tenantId, factoryId],
        );
        const balanceAfter = updateResult.rows[0];
        if (!balanceAfter) {
          throw new ConflictException('Inventory movement would make the stock balance negative, consume reserved units, or exceed the supported quantity');
        }

        const correlationId = traceId ?? requestId ?? randomUUID();
        const inserted = await client.query<{ id: string }>(
          `
          INSERT INTO inventory_movements (
            tenant_id, factory_id, item_id, location_code, movement_type,
            quantity_delta, on_hand_after, reason, reference_ref,
            idempotency_key, request_hash, recorded_by, correlation_id, request_id
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          RETURNING id::text AS id
          `,
          [
            tenantId, factoryId, item.id, normalized.location_code, normalized.movement_type,
            normalized.quantity_delta, balanceAfter.on_hand_after, normalized.reason,
            normalized.reference_ref, idempotencyKey, requestHash, userId, correlationId, requestId,
          ],
        );
        const movementId = inserted.rows[0]?.id;
        if (!movementId) throw new Error('INVENTORY_MOVEMENT_INSERT_FAILED');

        const payload = {
          movement_id: movementId,
          item_id: item.id,
          item_code: item.item_code,
          factory_id: factoryId,
          location_code: normalized.location_code,
          movement_type: normalized.movement_type,
          quantity_delta: String(normalized.quantity_delta),
          on_hand_after: balanceAfter.on_hand_after,
          reference_ref: normalized.reference_ref,
          actor_user_id: userId,
        };
        await client.query(
          `
          INSERT INTO outbox_events (
            tenant_id, factory_id, aggregate_type, aggregate_id, event_type,
            event_version, occurred_at, correlation_id, causation_id, actor, source, payload
          )
          VALUES ($1, $2, 'INVENTORY_MOVEMENT', $3, 'INVENTORY.MOVEMENT_RECORDED',
            1, clock_timestamp(), $4, NULL, $5::jsonb, $6::jsonb, $7::jsonb)
          `,
          [
            tenantId, factoryId, movementId, correlationId,
            JSON.stringify({ type: 'user', id: userId }),
            JSON.stringify({
              system: 'FactoryOS',
              connector: 'inventory-service',
              version: process.env.APP_VERSION ?? process.env.npm_package_version ?? '0.1.0',
            }),
            JSON.stringify(payload),
          ],
        );

        return {
          movement: await this.getMovementInTransaction(client, tenantId, factoryId, movementId),
          replayed: false,
        };
      },
    );

    if (!result.replayed) {
      await this.recordAuditSafely({
        tenantId, factoryId, userId, requestId, traceId,
        action: result.movement.movement_type,
        resourceType: 'INVENTORY_MOVEMENT',
        resourceId: result.movement.id,
        payload: {
          itemCode: result.movement.item_code,
          locationCode: result.movement.location_code,
          quantityDelta: result.movement.quantity_delta,
          onHandAfter: result.movement.on_hand_after,
          idempotencyKey,
        },
      });
    }
    return result;
  }


  async createReservation(
    userId: string,
    tenantId: string,
    factoryId: string,
    dto: CreateInventoryReservationDto,
    idempotencyKeyInput: string,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateIdentity(userId, tenantId, factoryId);
    this.validateReservation(dto);
    const idempotencyKey = this.validateIdempotencyKey(idempotencyKeyInput);
    this.validateOptionalUuid(requestId, 'requestId');
    this.validateOptionalUuid(traceId, 'traceId');

    const normalized = {
      item_id: dto.item_id.toLowerCase(),
      location_code: dto.location_code.trim().toUpperCase(),
      quantity: dto.quantity,
      reason: dto.reason.trim(),
      reference_ref: dto.reference_ref?.trim() || null,
    };
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ tenant_id: tenantId, factory_id: factoryId, ...normalized }))
      .digest('hex');

    const result = await this.database.transaction(
      { tenantId, userId },
      async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [tenantId, idempotencyKey]);
        const priorResult = await client.query<{ id: string; request_hash: string }>(
          'SELECT id::text AS id, request_hash FROM inventory_reservations WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1',
          [tenantId, idempotencyKey],
        );
        const prior = priorResult.rows[0];
        if (prior) {
          if (prior.request_hash !== requestHash) {
            throw new ConflictException('Idempotency-Key was already used for a different inventory reservation');
          }
          return {
            reservation: await this.getReservationInTransaction(client, tenantId, factoryId, prior.id),
            replayed: true,
          };
        }

        await this.assertActiveFactory(client, tenantId, factoryId);
        const itemResult = await client.query<{ id: string }>(
          `SELECT id::text AS id FROM inventory_items
           WHERE tenant_id = $1 AND factory_id = $2 AND id = $3 AND status = 'ACTIVE'
           FOR SHARE`,
          [tenantId, factoryId, normalized.item_id],
        );
        const item = itemResult.rows[0];
        if (!item) throw new NotFoundException('Active inventory item was not found in this factory');

        await client.query(
          `INSERT INTO inventory_stock_balances (tenant_id, factory_id, item_id, location_code, on_hand_quantity, reserved_quantity)
           VALUES ($1, $2, $3, $4, 0, 0)
           ON CONFLICT (tenant_id, factory_id, item_id, location_code) DO NOTHING`,
          [tenantId, factoryId, item.id, normalized.location_code],
        );
        const balanceResult = await client.query<{ id: string; on_hand_quantity: string; reserved_quantity: string }>(
          `SELECT id::text AS id, on_hand_quantity::text AS on_hand_quantity, reserved_quantity::text AS reserved_quantity
           FROM inventory_stock_balances
           WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3 AND location_code = $4
           FOR UPDATE`,
          [tenantId, factoryId, item.id, normalized.location_code],
        );
        const balance = balanceResult.rows[0];
        if (!balance) throw new Error('INVENTORY_BALANCE_LOCK_FAILED');

        const balanceUpdate = await client.query<{ on_hand_after: string; reserved_quantity_after: string }>(
          `UPDATE inventory_stock_balances
           SET reserved_quantity = reserved_quantity + $1::numeric,
               version = version + 1,
               updated_at = clock_timestamp()
           WHERE id = $2 AND tenant_id = $3 AND factory_id = $4
             AND on_hand_quantity - reserved_quantity >= $1::numeric
           RETURNING on_hand_quantity::text AS on_hand_after, reserved_quantity::text AS reserved_quantity_after`,
          [normalized.quantity, balance.id, tenantId, factoryId],
        );
        const balanceAfter = balanceUpdate.rows[0];
        if (!balanceAfter) {
          throw new ConflictException('Insufficient available inventory to reserve requested quantity');
        }

        const reservationResult = await client.query<{ id: string }>(
          `INSERT INTO inventory_reservations (
             tenant_id, factory_id, item_id, location_code, quantity, reason, reference_ref,
             idempotency_key, request_hash, created_by_user_id, updated_by_user_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
           RETURNING id::text AS id`,
          [tenantId, factoryId, item.id, normalized.location_code, normalized.quantity,
            normalized.reason, normalized.reference_ref, idempotencyKey, requestHash, userId],
        );
        const reservationId = reservationResult.rows[0]?.id;
        if (!reservationId) throw new Error('INVENTORY_RESERVATION_INSERT_FAILED');

        const correlationId = traceId ?? requestId ?? randomUUID();
        await client.query(
          `INSERT INTO inventory_reservation_events (
             tenant_id, factory_id, reservation_id, event_type, quantity, on_hand_after,
             reserved_quantity_after, reason, idempotency_key, request_hash, recorded_by_user_id,
             correlation_id, request_id
           ) VALUES ($1,$2,$3,'RESERVED',$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [tenantId, factoryId, reservationId, normalized.quantity, balanceAfter.on_hand_after,
            balanceAfter.reserved_quantity_after, normalized.reason, idempotencyKey, requestHash,
            userId, correlationId, requestId],
        );
        await this.publishReservationEvent(
          client, tenantId, factoryId, reservationId, item.id, normalized.location_code,
          'RESERVED', normalized.quantity, normalized.reason, normalized.reference_ref,
          balanceAfter.on_hand_after, balanceAfter.reserved_quantity_after, null, correlationId, userId,
        );

        return {
          reservation: await this.getReservationInTransaction(client, tenantId, factoryId, reservationId),
          replayed: false,
        };
      },
    );

    if (!result.replayed) {
      await this.recordAuditSafely({
        tenantId, factoryId, userId, requestId, traceId,
        action: 'RESERVE',
        resourceType: 'INVENTORY_RESERVATION',
        resourceId: result.reservation.id,
        payload: {
          itemCode: result.reservation.item_code,
          locationCode: result.reservation.location_code,
          quantity: result.reservation.quantity,
          referenceRef: result.reservation.reference_ref,
          idempotencyKey,
        },
      });
    }
    return result;
  }

  async transitionReservation(
    userId: string,
    tenantId: string,
    factoryId: string,
    reservationId: string,
    targetStatus: 'RELEASED' | 'CONSUMED',
    dto: TransitionInventoryReservationDto,
    idempotencyKeyInput: string,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateIdentity(userId, tenantId, factoryId);
    this.validateOptionalUuid(reservationId, 'reservationId');
    const reason = dto.reason.trim();
    if (reason.length < 8 || reason.length > 300) {
      throw new BadRequestException('reason must be between 8 and 300 characters');
    }
    const idempotencyKey = this.validateIdempotencyKey(idempotencyKeyInput);
    this.validateOptionalUuid(requestId, 'requestId');
    this.validateOptionalUuid(traceId, 'traceId');

    const requestHash = createHash('sha256')
      .update(JSON.stringify({
        tenant_id: tenantId, factory_id: factoryId, reservation_id: reservationId,
        target_status: targetStatus, reason,
      }))
      .digest('hex');

    const result = await this.database.transaction(
      { tenantId, userId },
      async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [tenantId, idempotencyKey]);
        const priorEventResult = await client.query<{ request_hash: string; reservation_id: string; movement_id: string | null }>(
          `SELECT request_hash, reservation_id::text AS reservation_id, movement_id::text AS movement_id
           FROM inventory_reservation_events
           WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1`,
          [tenantId, idempotencyKey],
        );
        const priorEvent = priorEventResult.rows[0];
        if (priorEvent) {
          if (priorEvent.request_hash !== requestHash) {
            throw new ConflictException('Idempotency-Key was already used for a different inventory reservation operation');
          }
          const reservation = await this.getReservationInTransaction(
            client, tenantId, factoryId, priorEvent.reservation_id,
          );
          const movement = priorEvent.movement_id
            ? await this.getMovementInTransaction(client, tenantId, factoryId, priorEvent.movement_id)
            : null;
          return { reservation, movement, replayed: true };
        }

        const reservationResult = await client.query<{
          id: string; item_id: string; location_code: string; quantity: string;
          status: InventoryReservationStatus; reference_ref: string | null;
        }>(
          `SELECT id::text AS id, item_id::text AS item_id, location_code,
                  quantity::text AS quantity, status, reference_ref
           FROM inventory_reservations
           WHERE tenant_id = $1 AND factory_id = $2 AND id = $3
           FOR UPDATE`,
          [tenantId, factoryId, reservationId],
        );
        const reservation = reservationResult.rows[0];
        if (!reservation) throw new NotFoundException('Inventory reservation was not found in this factory');
        if (reservation.status !== InventoryReservationStatus.ACTIVE) {
          throw new ConflictException(`Inventory reservation is already ${reservation.status.toLowerCase()}`);
        }

        const balanceResult = await client.query<{ id: string }>(
          `SELECT id::text AS id FROM inventory_stock_balances
           WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3 AND location_code = $4
           FOR UPDATE`,
          [tenantId, factoryId, reservation.item_id, reservation.location_code],
        );
        const balance = balanceResult.rows[0];
        if (!balance) throw new Error('INVENTORY_RESERVATION_BALANCE_NOT_FOUND');

        const balanceUpdate = targetStatus === 'RELEASED'
          ? await client.query<{ on_hand_after: string; reserved_quantity_after: string }>(
            `UPDATE inventory_stock_balances
             SET reserved_quantity = reserved_quantity - $1::numeric,
                 version = version + 1, updated_at = clock_timestamp()
             WHERE id = $2 AND tenant_id = $3 AND factory_id = $4 AND reserved_quantity >= $1::numeric
             RETURNING on_hand_quantity::text AS on_hand_after, reserved_quantity::text AS reserved_quantity_after`,
            [reservation.quantity, balance.id, tenantId, factoryId],
          )
          : await client.query<{ on_hand_after: string; reserved_quantity_after: string }>(
            `UPDATE inventory_stock_balances
             SET on_hand_quantity = on_hand_quantity - $1::numeric,
                 reserved_quantity = reserved_quantity - $1::numeric,
                 version = version + 1, updated_at = clock_timestamp()
             WHERE id = $2 AND tenant_id = $3 AND factory_id = $4
               AND reserved_quantity >= $1::numeric AND on_hand_quantity >= $1::numeric
             RETURNING on_hand_quantity::text AS on_hand_after, reserved_quantity::text AS reserved_quantity_after`,
            [reservation.quantity, balance.id, tenantId, factoryId],
          );
        const balanceAfter = balanceUpdate.rows[0];
        if (!balanceAfter) {
          throw new ConflictException('Inventory reservation balance is inconsistent; no stock was changed');
        }

        const correlationId = traceId ?? requestId ?? randomUUID();
        let movementId: string | null = null;
        if (targetStatus === 'CONSUMED') {
          const movementKey = `INV-RES-CONSUME-${randomUUID()}`;
          const movementHash = createHash('sha256')
            .update(JSON.stringify({ operation: 'RESERVATION_CONSUME', reservation_id: reservationId, request_hash: requestHash }))
            .digest('hex');
          const movementInsert = await client.query<{ id: string }>(
            `INSERT INTO inventory_movements (
               tenant_id, factory_id, item_id, location_code, movement_type, quantity_delta, on_hand_after,
               reason, reference_ref, idempotency_key, request_hash, recorded_by, correlation_id, request_id
             ) VALUES ($1,$2,$3,$4,'ISSUE',-$5::numeric,$6,$7,$8,$9,$10,$11,$12,$13)
             RETURNING id::text AS id`,
            [tenantId, factoryId, reservation.item_id, reservation.location_code, reservation.quantity,
              balanceAfter.on_hand_after, reason, reservation.reference_ref, movementKey, movementHash,
              userId, correlationId, requestId],
          );
          movementId = movementInsert.rows[0]?.id ?? null;
          if (!movementId) throw new Error('INVENTORY_CONSUMPTION_MOVEMENT_INSERT_FAILED');
          const movementPayload = {
            movement_id: movementId, item_id: reservation.item_id, factory_id: factoryId,
            location_code: reservation.location_code, movement_type: 'ISSUE',
            quantity_delta: `-${reservation.quantity}`,
            on_hand_after: balanceAfter.on_hand_after, reference_ref: reservation.reference_ref,
            reservation_id: reservationId, actor_user_id: userId,
          };
          await client.query(
            `INSERT INTO outbox_events (
               tenant_id, factory_id, aggregate_type, aggregate_id, event_type, event_version,
               occurred_at, correlation_id, causation_id, actor, source, payload
             ) VALUES ($1,$2,'INVENTORY_MOVEMENT',$3,'INVENTORY.MOVEMENT_RECORDED',1,clock_timestamp(),
               $4,NULL,$5::jsonb,$6::jsonb,$7::jsonb)`,
            [tenantId, factoryId, movementId, correlationId,
              JSON.stringify({ type: 'user', id: userId }),
              JSON.stringify({ system: 'FactoryOS', connector: 'inventory-service', version: process.env.APP_VERSION ?? process.env.npm_package_version ?? '0.1.0' }),
              JSON.stringify(movementPayload)],
          );
        }

        await client.query(
          `UPDATE inventory_reservations SET status = $1, updated_by_user_id = $2,
             updated_at = clock_timestamp(), version = version + 1
           WHERE id = $3 AND tenant_id = $4 AND factory_id = $5 AND status = 'ACTIVE'`,
          [targetStatus, userId, reservationId, tenantId, factoryId],
        );
        await client.query(
          `INSERT INTO inventory_reservation_events (
             tenant_id, factory_id, reservation_id, event_type, quantity, on_hand_after,
             reserved_quantity_after, reason, idempotency_key, request_hash, recorded_by_user_id,
             correlation_id, request_id, movement_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [tenantId, factoryId, reservationId, targetStatus, reservation.quantity, balanceAfter.on_hand_after,
            balanceAfter.reserved_quantity_after, reason, idempotencyKey, requestHash, userId,
            correlationId, requestId, movementId],
        );
        await this.publishReservationEvent(
          client, tenantId, factoryId, reservationId, reservation.item_id, reservation.location_code,
          targetStatus, reservation.quantity, reason, reservation.reference_ref,
          balanceAfter.on_hand_after, balanceAfter.reserved_quantity_after, movementId, correlationId, userId,
        );

        return {
          reservation: await this.getReservationInTransaction(client, tenantId, factoryId, reservationId),
          movement: movementId ? await this.getMovementInTransaction(client, tenantId, factoryId, movementId) : null,
          replayed: false,
        };
      },
    );

    if (!result.replayed) {
      await this.recordAuditSafely({
        tenantId, factoryId, userId, requestId, traceId,
        action: targetStatus,
        resourceType: 'INVENTORY_RESERVATION',
        resourceId: result.reservation.id,
        payload: {
          itemCode: result.reservation.item_code,
          locationCode: result.reservation.location_code,
          quantity: result.reservation.quantity,
          movementId: result.movement?.id ?? null,
          idempotencyKey,
        },
      });
    }
    return result;
  }

  async listReservations(tenantId: string, factoryId: string, query: ListInventoryReservationsDto) {
    this.validateIdentity(null, tenantId, factoryId);
    this.validateOptionalUuid(query.item_id ?? null, 'item_id');
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const values: unknown[] = [tenantId, factoryId];
    const where = ['r.tenant_id = $1', 'r.factory_id = $2'];
    if (query.item_id) {
      values.push(query.item_id);
      where.push(`r.item_id = ${values.length}`);
    }
    if (query.status) {
      values.push(query.status);
      where.push(`r.status = ${values.length}`);
    }
    values.push(limit, (page - 1) * limit);
    const limitIndex = values.length - 1;
    const offsetIndex = values.length;
    const result = await this.database.query<InventoryReservationRow>(
      `SELECT r.id::text AS id, r.tenant_id::text AS tenant_id, r.factory_id::text AS factory_id,
              r.item_id::text AS item_id, i.item_code, i.item_name, i.base_unit, r.location_code,
              r.quantity::text AS quantity, r.status, r.reason, r.reference_ref, r.idempotency_key,
              r.created_by_user_id::text AS created_by_user_id, r.updated_by_user_id::text AS updated_by_user_id,
              r.created_at::text AS created_at, r.updated_at::text AS updated_at, r.version::int AS version
       FROM inventory_reservations r
       INNER JOIN inventory_items i ON i.id = r.item_id AND i.tenant_id = r.tenant_id AND i.factory_id = r.factory_id
       WHERE ${where.join(' AND ')}
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT ${limitIndex} OFFSET ${offsetIndex}`,
      values,
      { tenantId },
    );
    return { page, limit, reservations: result.rows };
  }

  private validateIdempotencyKey(input: string): string {
    if (typeof input !== 'string') {
      throw new BadRequestException('Idempotency-Key must be 1-128 safe ASCII characters');
    }
    const key = input.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) {
      throw new BadRequestException('Idempotency-Key must be 1-128 safe ASCII characters');
    }
    return key;
  }

  private validateReservation(dto: CreateInventoryReservationDto): void {
    if (!isUUID(dto.item_id)) throw new BadRequestException('item_id must be a valid UUID');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(dto.location_code.trim())) {
      throw new BadRequestException('location_code is invalid');
    }
    if (
      !Number.isFinite(dto.quantity) ||
      dto.quantity <= 0 ||
      dto.quantity > 1000000000000 ||
      Number(dto.quantity.toFixed(6)) !== dto.quantity
    ) {
      throw new BadRequestException('quantity must be positive, at most 12 integer digits and 6 decimal places');
    }
    const reason = dto.reason.trim();
    if (reason.length < 8 || reason.length > 300) {
      throw new BadRequestException('reason must be between 8 and 300 characters');
    }
    if (dto.reference_ref != null && dto.reference_ref.trim().length > 255) {
      throw new BadRequestException('reference_ref must be at most 255 characters');
    }
  }

  private async getReservationInTransaction(
    client: PoolClient, tenantId: string, factoryId: string, reservationId: string,
  ): Promise<InventoryReservationRow> {
    const result = await client.query<InventoryReservationRow>(
      `SELECT r.id::text AS id, r.tenant_id::text AS tenant_id, r.factory_id::text AS factory_id,
              r.item_id::text AS item_id, i.item_code, i.item_name, i.base_unit, r.location_code,
              r.quantity::text AS quantity, r.status, r.reason, r.reference_ref, r.idempotency_key,
              r.created_by_user_id::text AS created_by_user_id, r.updated_by_user_id::text AS updated_by_user_id,
              r.created_at::text AS created_at, r.updated_at::text AS updated_at, r.version::int AS version
       FROM inventory_reservations r
       INNER JOIN inventory_items i ON i.id = r.item_id AND i.tenant_id = r.tenant_id AND i.factory_id = r.factory_id
       WHERE r.tenant_id = $1 AND r.factory_id = $2 AND r.id = $3 LIMIT 1`,
      [tenantId, factoryId, reservationId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Inventory reservation was not found in this factory');
    return row;
  }

  private async publishReservationEvent(
    client: PoolClient,
    tenantId: string,
    factoryId: string,
    reservationId: string,
    itemId: string,
    locationCode: string,
    eventType: 'RESERVED' | 'RELEASED' | 'CONSUMED',
    quantity: number | string,
    reason: string,
    referenceRef: string | null,
    onHandAfter: string,
    reservedQuantityAfter: string,
    movementId: string | null,
    correlationId: string,
    userId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO outbox_events (
         tenant_id, factory_id, aggregate_type, aggregate_id, event_type, event_version,
         occurred_at, correlation_id, causation_id, actor, source, payload
       ) VALUES ($1,$2,'INVENTORY_RESERVATION',$3,'INVENTORY.RESERVATION_CHANGED',1,clock_timestamp(),
         $4,$5,$6::jsonb,$7::jsonb,$8::jsonb)`,
      [tenantId, factoryId, reservationId, correlationId, movementId,
        JSON.stringify({ type: 'user', id: userId }),
        JSON.stringify({ system: 'FactoryOS', connector: 'inventory-service', version: process.env.APP_VERSION ?? process.env.npm_package_version ?? '0.1.0' }),
        JSON.stringify({
          reservation_id: reservationId, item_id: itemId, factory_id: factoryId,
          location_code: locationCode, event_type: eventType, quantity: String(quantity),
          on_hand_after: onHandAfter, reserved_quantity_after: reservedQuantityAfter,
          reason, reference_ref: referenceRef, movement_id: movementId, actor_user_id: userId,
        })],
    );
  }

  async listBalances(tenantId: string, factoryId: string, query: ListInventoryBalancesDto) {
    this.validateIdentity(null, tenantId, factoryId);
    this.validateOptionalUuid(query.item_id ?? null, 'item_id');
    const values: unknown[] = [tenantId, factoryId];
    const where = ['b.tenant_id = $1', 'b.factory_id = $2'];
    if (query.item_id) {
      values.push(query.item_id);
      where.push(`b.item_id = $${values.length}`);
    }
    if (query.location_code?.trim()) {
      values.push(query.location_code.trim().toUpperCase());
      where.push(`b.location_code = $${values.length}`);
    }
    const result = await this.database.query(
      `
      SELECT b.item_id::text AS item_id, i.item_code, i.item_name, i.base_unit,
             b.location_code, b.on_hand_quantity::text AS on_hand_quantity,
             b.reserved_quantity::text AS reserved_quantity,
             (b.on_hand_quantity - b.reserved_quantity)::text AS available_quantity,
             b.version::int AS version, b.updated_at::text AS updated_at
      FROM inventory_stock_balances b
      INNER JOIN inventory_items i
        ON i.id = b.item_id AND i.tenant_id = b.tenant_id AND i.factory_id = b.factory_id
      WHERE ${where.join(' AND ')}
      ORDER BY i.item_code ASC, b.location_code ASC
      LIMIT 500
      `,
      values,
      { tenantId },
    );
    return { balances: result.rows };
  }

  async listMovements(tenantId: string, factoryId: string, query: ListInventoryMovementsDto) {
    this.validateIdentity(null, tenantId, factoryId);
    this.validateOptionalUuid(query.item_id ?? null, 'item_id');
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const values: unknown[] = [tenantId, factoryId];
    const where = ['m.tenant_id = $1', 'm.factory_id = $2'];
    if (query.item_id) {
      values.push(query.item_id);
      where.push(`m.item_id = $${values.length}`);
    }
    if (query.location_code?.trim()) {
      values.push(query.location_code.trim().toUpperCase());
      where.push(`m.location_code = $${values.length}`);
    }
    if (query.movement_type) {
      values.push(query.movement_type);
      where.push(`m.movement_type = $${values.length}`);
    }
    values.push(limit, (page - 1) * limit);
    const limitIndex = values.length - 1;
    const offsetIndex = values.length;
    const result = await this.database.query(
      `
      SELECT m.id::text AS id, m.item_id::text AS item_id, i.item_code, i.item_name,
             m.location_code, m.movement_type, m.quantity_delta::text AS quantity_delta,
             m.on_hand_after::text AS on_hand_after, m.reason, m.reference_ref,
             m.idempotency_key, m.recorded_by::text AS recorded_by,
             m.correlation_id::text AS correlation_id, m.request_id::text AS request_id,
             m.created_at::text AS created_at
      FROM inventory_movements m
      INNER JOIN inventory_items i
        ON i.id = m.item_id AND i.tenant_id = m.tenant_id AND i.factory_id = m.factory_id
      WHERE ${where.join(' AND ')}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $${limitIndex} OFFSET $${offsetIndex}
      `,
      values,
      { tenantId },
    );
    return { page, limit, movements: result.rows };
  }

  private async getMovementInTransaction(
    client: PoolClient, tenantId: string, factoryId: string, movementId: string,
  ): Promise<InventoryMovementRow> {
    const result = await client.query<InventoryMovementRow>(
      `
      SELECT m.id::text AS id, m.tenant_id::text AS tenant_id, m.factory_id::text AS factory_id,
             m.item_id::text AS item_id, i.item_code, i.item_name, m.location_code,
             m.movement_type, m.quantity_delta::text AS quantity_delta,
             m.on_hand_after::text AS on_hand_after, m.reason, m.reference_ref,
             m.idempotency_key, m.recorded_by::text AS recorded_by,
             m.correlation_id::text AS correlation_id, m.request_id::text AS request_id,
             m.created_at::text AS created_at
      FROM inventory_movements m
      INNER JOIN inventory_items i
        ON i.id = m.item_id AND i.tenant_id = m.tenant_id AND i.factory_id = m.factory_id
      WHERE m.tenant_id = $1 AND m.factory_id = $2 AND m.id = $3
      LIMIT 1
      `,
      [tenantId, factoryId, movementId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Inventory movement was not found in this factory');
    return row;
  }

  private async assertActiveFactory(client: PoolClient, tenantId: string, factoryId: string): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM factories WHERE id = $1 AND tenant_id = $2 AND status = 'ACTIVE' LIMIT 1`,
      [factoryId, tenantId],
    );
    if (!result.rows[0]) throw new ForbiddenException('Factory does not belong to tenant or is not active');
  }

  private validateIdentity(userId: string | null, tenantId: string, factoryId: string): void {
    if (userId !== null && !isUUID(userId)) throw new BadRequestException('userId must be a valid UUID');
    if (!isUUID(tenantId)) throw new BadRequestException('tenantId must be a valid UUID');
    if (!isUUID(factoryId)) throw new BadRequestException('factoryId must be a valid UUID');
  }

  private validateMovement(dto: CreateInventoryMovementDto): void {
    if (!isUUID(dto.item_id)) throw new BadRequestException('item_id must be a valid UUID');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(dto.location_code.trim())) {
      throw new BadRequestException('location_code is invalid');
    }
    if (!Object.values(InventoryMovementType).includes(dto.movement_type)) {
      throw new BadRequestException('movement_type is invalid');
    }
    if (
      !Number.isFinite(dto.quantity_delta) ||
      dto.quantity_delta === 0 ||
      Math.abs(dto.quantity_delta) > 1000000000000 ||
      Number(dto.quantity_delta.toFixed(6)) !== dto.quantity_delta
    ) {
      throw new BadRequestException('quantity_delta must be non-zero, at most 12 integer digits and 6 decimal places');
    }
    if (dto.movement_type === InventoryMovementType.RECEIPT && dto.quantity_delta < 0) {
      throw new BadRequestException('RECEIPT quantity_delta must be positive');
    }
    if (dto.movement_type === InventoryMovementType.ISSUE && dto.quantity_delta > 0) {
      throw new BadRequestException('ISSUE quantity_delta must be negative');
    }
    if (!dto.reason.trim() || dto.reason.trim().length < 8 || dto.reason.trim().length > 300) {
      throw new BadRequestException('reason must be between 8 and 300 characters');
    }
    if (dto.reference_ref != null && dto.reference_ref.trim().length > 255) {
      throw new BadRequestException('reference_ref must be at most 255 characters');
    }
  }

  private validateOptionalUuid(value: string | null, field: string): void {
    if (value !== null && !isUUID(value)) {
      throw new BadRequestException(`${field} must be a valid UUID`);
    }
  }

  private pgCode(error: unknown): string | null {
    return error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : null;
  }

  private async recordAuditSafely(input: {
    tenantId: string;
    factoryId: string;
    userId: string;
    requestId: string | null;
    traceId: string | null;
    action: string;
    resourceType: string;
    resourceId: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.auditService.record({
        tenantId: input.tenantId,
        factoryId: input.factoryId,
        actorUserId: input.userId,
        eventType: 'INVENTORY',
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        correlationId: input.traceId,
        requestId: input.requestId,
        dataClass: 'INTERNAL',
        payload: input.payload,
      });
    } catch {
      // The transaction has already committed. A failed audit write must not
      // cause a caller retry to duplicate authoritative inventory movement.
    }
  }
}
