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
import { CreateInventoryItemDto } from './dto/create-inventory-item.dto';
import { CreateStockMovementDto } from './dto/create-stock-movement.dto';

type InventoryItemRow = QueryResultRow & {
  id: string;
  tenant_id: string;
  factory_id: string;
  sku: string;
  name: string;
  unit: string;
  status: 'ACTIVE' | 'DISABLED';
  quantity_on_hand: string;
  version: string;
  created_at: string;
};

type InventoryMovementRow = QueryResultRow & {
  id: string;
  tenant_id: string;
  factory_id: string;
  item_id: string;
  movement_type: 'RECEIPT' | 'ISSUE';
  quantity: string;
  quantity_delta: string;
  quantity_after: string;
  request_hash?: string;
  reference_type: string | null;
  reference_id: string | null;
  notes: string | null;
  created_by_user_id: string;
  correlation_id: string;
  created_at: string;
};

type InventoryMovementResult = Omit<InventoryMovementRow, 'request_hash'> & {
  replayed: boolean;
};

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
    this.validateScope(userId, tenantId, factoryId);
    const sku = dto.sku.trim().toUpperCase();
    const name = dto.name.trim();
    const unit = dto.unit.trim().toUpperCase();
    if (!sku || !name || !unit) {
      throw new BadRequestException('SKU, name and unit are required');
    }
    if (sku.length > 100 || name.length > 255 || unit.length > 50) {
      throw new BadRequestException('Inventory item fields exceed their allowed length');
    }

    let item: InventoryItemRow;
    try {
      item = await this.database.transaction(
        { tenantId, userId },
        async (client) => {
          const factoryResult = await client.query<{ id: string }>(
            `
            SELECT id::text AS id
            FROM factories
            WHERE id = $1
              AND tenant_id = $2
              AND status = 'ACTIVE'
            LIMIT 1
            `,
            [factoryId, tenantId],
          );
          if (!factoryResult.rows[0]) {
            throw new ForbiddenException('Factory does not belong to tenant or is not active');
          }

          const itemResult = await client.query<InventoryItemRow>(
            `
            INSERT INTO inventory_items (
              tenant_id, factory_id, sku, name, unit, created_by_user_id
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING
              id::text AS id,
              tenant_id::text AS tenant_id,
              factory_id::text AS factory_id,
              sku, name, unit, status,
              version::text AS version,
              created_at::text AS created_at
            `,
            [tenantId, factoryId, sku, name, unit, userId],
          );
          const created = itemResult.rows[0];
          if (!created) throw new Error('INVENTORY_ITEM_INSERT_FAILED');

          const balanceResult = await client.query<{ quantity_on_hand: string }>(
            `
            INSERT INTO inventory_stock_balances (
              tenant_id, factory_id, item_id, quantity_on_hand
            )
            VALUES ($1, $2, $3, 0)
            RETURNING quantity_on_hand::text AS quantity_on_hand
            `,
            [tenantId, factoryId, created.id],
          );
          created.quantity_on_hand = balanceResult.rows[0]?.quantity_on_hand ?? '0.0000';

          await this.insertOutboxEvent(client, {
            tenantId,
            factoryId,
            aggregateId: created.id,
            eventType: 'INVENTORY.ITEM_CREATED',
            correlationId: this.correlationId(requestId, traceId),
            userId,
            payload: {
              item: {
                id: created.id,
                sku: created.sku,
                name: created.name,
                unit: created.unit,
                status: created.status,
              },
            },
          });
          return created;
        },
      );
    } catch (error) {
      if (this.errorCode(error) === '23505') {
        throw new ConflictException('An inventory item with this SKU already exists in the factory');
      }
      throw error;
    }

    await this.recordAuditSafely({
      tenantId, factoryId, userId, action: 'ITEM_CREATE',
      resourceId: item.id, requestId, traceId,
      payload: { sku: item.sku, unit: item.unit },
    });
    return item;
  }

  async listItems(
    tenantId: string,
    factoryId: string,
    search?: string,
    limit = 50,
  ): Promise<InventoryItemRow[]> {
    this.validateReadScope(tenantId, factoryId);
    this.validateLimit(limit);
    const normalizedSearch = search?.trim();
    const result = await this.database.query<InventoryItemRow>(
      `
      SELECT
        i.id::text AS id,
        i.tenant_id::text AS tenant_id,
        i.factory_id::text AS factory_id,
        i.sku, i.name, i.unit, i.status,
        b.quantity_on_hand::text AS quantity_on_hand,
        i.version::text AS version,
        i.created_at::text AS created_at
      FROM inventory_items i
      INNER JOIN inventory_stock_balances b
        ON b.item_id = i.id
       AND b.tenant_id = i.tenant_id
       AND b.factory_id = i.factory_id
      WHERE i.tenant_id = $1
        AND i.factory_id = $2
        AND (
          $3::text IS NULL
          OR i.sku ILIKE $3
          OR i.name ILIKE $3
        )
      ORDER BY i.sku ASC
      LIMIT $4
      `,
      [tenantId, factoryId, normalizedSearch ? '%' + normalizedSearch + '%' : null, limit],
      { tenantId },
    );
    return result.rows;
  }

  async createStockMovement(
    userId: string,
    tenantId: string,
    factoryId: string,
    itemId: string,
    dto: CreateStockMovementDto,
    rawIdempotencyKey: string | null,
    requestId: string | null,
    traceId: string | null,
  ): Promise<InventoryMovementResult> {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(itemId, 'itemId');

    const idempotencyKey = rawIdempotencyKey?.trim() ?? '';
    if (!idempotencyKey) {
      throw new BadRequestException('Idempotency-Key is required for inventory stock movements');
    }
    if (idempotencyKey.length > 255) {
      throw new BadRequestException('Idempotency-Key must be at most 255 characters');
    }
    if (!Number.isFinite(dto.quantity) || dto.quantity <= 0) {
      throw new BadRequestException('quantity must be a positive number');
    }
    if (Math.abs(dto.quantity * 10000 - Math.round(dto.quantity * 10000)) > 0.000001) {
      throw new BadRequestException('quantity supports at most 4 decimal places');
    }
    if (!['RECEIPT', 'ISSUE'].includes(dto.movement_type)) {
      throw new BadRequestException('movement_type must be RECEIPT or ISSUE');
    }

    const referenceType = dto.reference_type?.trim().toUpperCase() || null;
    const referenceId = dto.reference_id?.toLowerCase() || null;
    if (referenceId) this.validateUuid(referenceId, 'reference_id');
    const notes = dto.notes?.trim() || null;
    const quantity = dto.quantity.toFixed(4);
    const requestHash = createHash('sha256')
      .update(JSON.stringify({
        itemId: itemId.toLowerCase(),
        movementType: dto.movement_type,
        quantity,
        referenceType,
        referenceId,
        notes,
      }))
      .digest('hex');

    let result: InventoryMovementResult;
    try {
      result = await this.database.transaction(
        { tenantId, userId },
        async (client) => {
          const existingBeforeLock = await this.findMovementByKey(
            client, tenantId, factoryId, idempotencyKey,
          );
          if (existingBeforeLock) return this.replayOrConflict(existingBeforeLock, requestHash);

          const itemResult = await client.query<{
            id: string; sku: string; name: string; status: 'ACTIVE' | 'DISABLED';
          }>(
            `
            SELECT id::text AS id, sku, name, status
            FROM inventory_items
            WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
            FOR UPDATE
            `,
            [itemId, tenantId, factoryId],
          );
          const item = itemResult.rows[0];
          if (!item) throw new NotFoundException('Inventory item not found in this factory');
          if (item.status !== 'ACTIVE') {
            throw new ConflictException('Disabled inventory items cannot receive stock movements');
          }

          // Recheck after locking the item so concurrent requests for the same
          // key cannot both change the stock balance.
          const existingAfterLock = await this.findMovementByKey(
            client, tenantId, factoryId, idempotencyKey,
          );
          if (existingAfterLock) return this.replayOrConflict(existingAfterLock, requestHash);

          const delta = dto.movement_type === 'RECEIPT' ? dto.quantity : -dto.quantity;
          const balanceResult = await client.query<{ quantity_on_hand: string }>(
            `
            UPDATE inventory_stock_balances
            SET
              quantity_on_hand = quantity_on_hand + $1::numeric,
              version = version + 1,
              updated_at = clock_timestamp()
            WHERE tenant_id = $2
              AND factory_id = $3
              AND item_id = $4
              AND quantity_on_hand + $1::numeric >= 0
            RETURNING quantity_on_hand::text AS quantity_on_hand
            `,
            [delta.toFixed(4), tenantId, factoryId, itemId],
          );
          const balance = balanceResult.rows[0];
          if (!balance) {
            throw new ConflictException('Insufficient stock or inventory balance is unavailable');
          }

          const correlationId = this.correlationId(requestId, traceId);
          const movementResult = await client.query<InventoryMovementRow>(
            `
            INSERT INTO inventory_movements (
              tenant_id, factory_id, item_id, movement_type, quantity,
              quantity_delta, quantity_after, idempotency_key, request_hash,
              reference_type, reference_id, notes, created_by_user_id, correlation_id
            )
            VALUES (
              $1, $2, $3, $4, $5::numeric, $6::numeric, $7::numeric,
              $8, $9, $10, $11::uuid, $12, $13, $14::uuid
            )
            RETURNING
              id::text AS id,
              tenant_id::text AS tenant_id,
              factory_id::text AS factory_id,
              item_id::text AS item_id,
              movement_type,
              quantity::text AS quantity,
              quantity_delta::text AS quantity_delta,
              quantity_after::text AS quantity_after,
              request_hash,
              reference_type,
              reference_id::text AS reference_id,
              notes,
              created_by_user_id::text AS created_by_user_id,
              correlation_id::text AS correlation_id,
              created_at::text AS created_at
            `,
            [
              tenantId, factoryId, itemId, dto.movement_type, quantity,
              delta.toFixed(4), balance.quantity_on_hand, idempotencyKey,
              requestHash, referenceType, referenceId, notes, userId, correlationId,
            ],
          );
          const movement = movementResult.rows[0];
          if (!movement) throw new Error('INVENTORY_MOVEMENT_INSERT_FAILED');

          await this.insertOutboxEvent(client, {
            tenantId,
            factoryId,
            aggregateId: itemId,
            eventType: dto.movement_type === 'RECEIPT'
              ? 'INVENTORY.STOCK_RECEIVED'
              : 'INVENTORY.STOCK_ISSUED',
            correlationId,
            userId,
            payload: {
              movement: {
                id: movement.id,
                item_id: itemId,
                movement_type: movement.movement_type,
                quantity: movement.quantity,
                quantity_delta: movement.quantity_delta,
                quantity_after: movement.quantity_after,
                reference_type: movement.reference_type,
                reference_id: movement.reference_id,
              },
            },
          });
          return this.toMovementResult(movement, false);
        },
      );
    } catch (error) {
      if (this.errorCode(error) !== '23505') throw error;

      // The database unique key arbitrates the rare race where two requests
      // reuse one key while holding different item-row locks.
      const stored = await this.database.query<InventoryMovementRow>(
        `
        SELECT
          id::text AS id,
          tenant_id::text AS tenant_id,
          factory_id::text AS factory_id,
          item_id::text AS item_id,
          movement_type,
          quantity::text AS quantity,
          quantity_delta::text AS quantity_delta,
          quantity_after::text AS quantity_after,
          request_hash,
          reference_type,
          reference_id::text AS reference_id,
          notes,
          created_by_user_id::text AS created_by_user_id,
          correlation_id::text AS correlation_id,
          created_at::text AS created_at
        FROM inventory_movements
        WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3
        LIMIT 1
        `,
        [tenantId, factoryId, idempotencyKey],
        { tenantId, userId },
      );
      if (!stored.rows[0]) {
        throw new ConflictException('Inventory movement conflicts with an existing record');
      }
      result = this.replayOrConflict(stored.rows[0], requestHash);
    }

    if (!result.replayed) {
      await this.recordAuditSafely({
        tenantId, factoryId, userId,
        action: result.movement_type === 'RECEIPT' ? 'STOCK_RECEIPT' : 'STOCK_ISSUE',
        resourceId: result.id, requestId, traceId,
        payload: {
          itemId,
          quantity: result.quantity,
          quantityAfter: result.quantity_after,
          referenceType: result.reference_type,
          referenceId: result.reference_id,
        },
      });
    }
    return result;
  }

  async listMovements(
    tenantId: string,
    factoryId: string,
    itemId: string,
    limit = 50,
  ): Promise<Omit<InventoryMovementRow, 'request_hash'>[]> {
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
    if (!item.rows[0]) throw new NotFoundException('Inventory item not found in this factory');

    const result = await this.database.query<Omit<InventoryMovementRow, 'request_hash'>>(
      `
      SELECT
        id::text AS id,
        tenant_id::text AS tenant_id,
        factory_id::text AS factory_id,
        item_id::text AS item_id,
        movement_type,
        quantity::text AS quantity,
        quantity_delta::text AS quantity_delta,
        quantity_after::text AS quantity_after,
        reference_type,
        reference_id::text AS reference_id,
        notes,
        created_by_user_id::text AS created_by_user_id,
        correlation_id::text AS correlation_id,
        created_at::text AS created_at
      FROM inventory_movements
      WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3
      ORDER BY created_at DESC, id DESC
      LIMIT $4
      `,
      [tenantId, factoryId, itemId, limit],
      { tenantId },
    );
    return result.rows;
  }

  private async findMovementByKey(
    client: PoolClient,
    tenantId: string,
    factoryId: string,
    idempotencyKey: string,
  ): Promise<InventoryMovementRow | null> {
    const result = await client.query<InventoryMovementRow>(
      `
      SELECT
        id::text AS id,
        tenant_id::text AS tenant_id,
        factory_id::text AS factory_id,
        item_id::text AS item_id,
        movement_type,
        quantity::text AS quantity,
        quantity_delta::text AS quantity_delta,
        quantity_after::text AS quantity_after,
        request_hash,
        reference_type,
        reference_id::text AS reference_id,
        notes,
        created_by_user_id::text AS created_by_user_id,
        correlation_id::text AS correlation_id,
        created_at::text AS created_at
      FROM inventory_movements
      WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3
      LIMIT 1
      `,
      [tenantId, factoryId, idempotencyKey],
    );
    return result.rows[0] ?? null;
  }

  private replayOrConflict(
    stored: InventoryMovementRow,
    requestHash: string,
  ): InventoryMovementResult {
    if (stored.request_hash !== requestHash) {
      throw new ConflictException('Idempotency-Key has already been used for a different inventory movement');
    }
    return this.toMovementResult(stored, true);
  }

  private toMovementResult(
    stored: InventoryMovementRow,
    replayed: boolean,
  ): InventoryMovementResult {
    const {
      id, tenant_id, factory_id, item_id, movement_type, quantity,
      quantity_delta, quantity_after, reference_type, reference_id, notes,
      created_by_user_id, correlation_id, created_at,
    } = stored;
    return {
      id, tenant_id, factory_id, item_id, movement_type, quantity,
      quantity_delta, quantity_after, reference_type, reference_id, notes,
      created_by_user_id, correlation_id, created_at, replayed,
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
        input.tenantId,
        input.factoryId,
        input.aggregateId,
        input.eventType,
        input.correlationId,
        JSON.stringify({ type: 'user', id: input.userId }),
        JSON.stringify({
          system: 'FactoryOS',
          connector: 'inventory-service',
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
        resourceType: 'INVENTORY',
        resourceId: input.resourceId,
        requestId: input.requestId && isUUID(input.requestId) ? input.requestId : null,
        correlationId: input.traceId && isUUID(input.traceId) ? input.traceId : null,
        dataClass: 'INTERNAL',
        payload: input.payload,
      });
    } catch {
      // The business transaction and durable outbox event have already committed.
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
