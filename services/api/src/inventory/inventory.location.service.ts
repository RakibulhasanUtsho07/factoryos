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
import { CreateInventoryLocationDto } from './dto/create-inventory-location.dto';
import { TransferInventoryLocationDto } from './dto/transfer-inventory-location.dto';

export interface InventoryLocationRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  parent_location_id: string | null;
  location_code: string;
  name: string;
  location_type: 'WAREHOUSE' | 'BIN' | 'STAGING' | 'VIRTUAL';
  is_default: boolean;
  status: 'ACTIVE' | 'DISABLED';
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

interface LocationBalanceRow extends QueryResultRow {
  location_id: string;
  quantity_on_hand: string;
  version?: string;
}

interface LocationTransferRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  item_id: string;
  source_location_id: string;
  destination_location_id: string;
  quantity: string;
  source_quantity_before: string;
  source_quantity_after: string;
  destination_quantity_before: string;
  destination_quantity_after: string;
  idempotency_key: string;
  request_hash: string;
  notes: string | null;
  created_by_user_id: string;
  correlation_id: string;
  created_at: string;
}

const LOCATION_COLUMNS = `
  id::text AS id,
  tenant_id::text AS tenant_id,
  factory_id::text AS factory_id,
  parent_location_id::text AS parent_location_id,
  location_code, name, location_type, is_default, status,
  created_by_user_id::text AS created_by_user_id,
  created_at::text AS created_at,
  updated_at::text AS updated_at
`;

const TRANSFER_COLUMNS = `
  id::text AS id,
  tenant_id::text AS tenant_id,
  factory_id::text AS factory_id,
  item_id::text AS item_id,
  source_location_id::text AS source_location_id,
  destination_location_id::text AS destination_location_id,
  quantity::text AS quantity,
  source_quantity_before::text AS source_quantity_before,
  source_quantity_after::text AS source_quantity_after,
  destination_quantity_before::text AS destination_quantity_before,
  destination_quantity_after::text AS destination_quantity_after,
  idempotency_key, request_hash, notes,
  created_by_user_id::text AS created_by_user_id,
  correlation_id::text AS correlation_id,
  created_at::text AS created_at
`;

export type InventoryLocationTransferResult = Omit<
  LocationTransferRow,
  'idempotency_key' | 'request_hash'
> & { replayed: boolean };

@Injectable()
export class InventoryLocationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly auditService: AuditService,
  ) {}

  async createLocation(
    userId: string,
    tenantId: string,
    factoryId: string,
    dto: CreateInventoryLocationDto,
    requestId: string | null,
    traceId: string | null,
  ): Promise<InventoryLocationRow> {
    this.validateScope(userId, tenantId, factoryId);
    const locationCode = dto.location_code.trim().toUpperCase();
    const name = dto.name.trim();
    const locationType = dto.location_type;
    const parentLocationId = dto.parent_location_id?.toLowerCase() ?? null;

    if (!locationCode || locationCode.length > 100 || !name || name.length > 255) {
      throw new BadRequestException('Location code and name are required and must be within their length limits');
    }
    if (!['WAREHOUSE', 'BIN', 'STAGING'].includes(locationType)) {
      throw new BadRequestException('location_type must be WAREHOUSE, BIN or STAGING');
    }
    if (locationType === 'BIN' && !parentLocationId) {
      throw new BadRequestException('parent_location_id is required for a BIN location');
    }
    if (parentLocationId) this.validateUuid(parentLocationId, 'parent_location_id');

    let created: InventoryLocationRow;
    try {
      created = await this.database.transaction(
        { tenantId, userId },
        async (client) => {
          const factory = await client.query<{ id: string }>(
            `
            SELECT id::text AS id FROM factories
            WHERE id = $1 AND tenant_id = $2 AND status = 'ACTIVE'
            LIMIT 1
            `,
            [factoryId, tenantId],
          );
          if (!factory.rows[0]) {
            throw new NotFoundException('Active factory not found in this tenant');
          }

          const inserted = await client.query<InventoryLocationRow>(
            `
            INSERT INTO inventory_locations (
              tenant_id, factory_id, parent_location_id,
              location_code, name, location_type, created_by_user_id
            )
            VALUES ($1, $2, $3::uuid, $4, $5, $6, $7)
            RETURNING ${LOCATION_COLUMNS}
            `,
            [tenantId, factoryId, parentLocationId, locationCode, name, locationType, userId],
          );
          const row = inserted.rows[0];
          if (!row) throw new Error('INVENTORY_LOCATION_INSERT_FAILED');

          await this.insertOutboxEvent(client, {
            tenantId, factoryId, aggregateType: 'INVENTORY_LOCATION', aggregateId: row.id,
            eventType: 'INVENTORY.LOCATION_CREATED',
            correlationId: this.correlationId(requestId, traceId),
            userId,
            payload: {
              location: {
                id: row.id,
                parent_location_id: row.parent_location_id,
                location_code: row.location_code,
                name: row.name,
                location_type: row.location_type,
                status: row.status,
              },
            },
          });
          return row;
        },
      );
    } catch (error) {
      if (this.errorCode(error) === '23505') {
        throw new ConflictException('A location with this code already exists in the factory');
      }
      if (this.errorCode(error) === '23514' || this.errorCode(error) === '23503') {
        throw new BadRequestException(
          error instanceof Error ? error.message : 'Invalid parent location or location type',
        );
      }
      throw error;
    }

    await this.recordAuditSafely({
      tenantId, factoryId, userId,
      action: 'LOCATION_CREATE',
      resourceId: created.id, requestId, traceId,
      payload: {
        locationCode: created.location_code,
        locationType: created.location_type,
        parentLocationId: created.parent_location_id,
      },
    });
    return created;
  }

  async listLocations(
    tenantId: string,
    factoryId: string,
    rawLimit = 50,
  ): Promise<InventoryLocationRow[]> {
    this.validateReadScope(tenantId, factoryId);
    const limit = this.validateLimit(rawLimit);

    const result = await this.database.query<InventoryLocationRow>(
      `
      SELECT ${LOCATION_COLUMNS}
      FROM inventory_locations
      WHERE tenant_id = $1 AND factory_id = $2
      ORDER BY is_default DESC, location_type, location_code
      LIMIT $3
      `,
      [tenantId, factoryId, limit],
      { tenantId },
    );
    return result.rows;
  }

  async listItemBalances(
    tenantId: string,
    factoryId: string,
    itemId: string,
    rawLimit = 100,
  ) {
    this.validateReadScope(tenantId, factoryId);
    this.validateUuid(itemId, 'itemId');
    const limit = this.validateLimit(rawLimit);

    const result = await this.database.query<{
      item_id: string;
      location_id: string;
      parent_location_id: string | null;
      location_code: string;
      location_name: string;
      location_type: string;
      is_default: boolean;
      location_status: string;
      quantity_on_hand: string;
      location_balance_version: string | null;
      item_quantity_on_hand: string;
      item_quantity_reserved: string;
      item_quantity_available: string;
    }>(
      `
      SELECT
        i.id::text AS item_id,
        l.id::text AS location_id,
        l.parent_location_id::text AS parent_location_id,
        l.location_code,
        l.name AS location_name,
        l.location_type,
        l.is_default,
        l.status AS location_status,
        CASE WHEN lb.quantity_on_hand IS NULL THEN '0.0000' ELSE lb.quantity_on_hand::text END AS quantity_on_hand,
        lb.version::text AS location_balance_version,
        b.quantity_on_hand::text AS item_quantity_on_hand,
        b.quantity_reserved::text AS item_quantity_reserved,
        (b.quantity_on_hand - b.quantity_reserved)::text AS item_quantity_available
      FROM inventory_items i
      JOIN inventory_stock_balances b
        ON b.item_id = i.id
       AND b.tenant_id = i.tenant_id
       AND b.factory_id = i.factory_id
      JOIN inventory_locations l
        ON l.tenant_id = i.tenant_id
       AND l.factory_id = i.factory_id
      LEFT JOIN inventory_location_balances lb
        ON lb.tenant_id = i.tenant_id
       AND lb.factory_id = i.factory_id
       AND lb.item_id = i.id
       AND lb.location_id = l.id
      WHERE i.id = $1 AND i.tenant_id = $2 AND i.factory_id = $3
      ORDER BY l.is_default DESC, l.location_type, l.location_code
      LIMIT $4
      `,
      [itemId, tenantId, factoryId, limit],
      { tenantId },
    );
    if (!result.rows[0]) {
      const item = await this.database.query<{ id: string }>(
        `SELECT id::text AS id FROM inventory_items
         WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 LIMIT 1`,
        [itemId, tenantId, factoryId],
        { tenantId },
      );
      if (!item.rows[0]) throw new NotFoundException('Inventory item not found in this factory');
      return [];
    }
    return result.rows;
  }

  async transferStock(
    userId: string,
    tenantId: string,
    factoryId: string,
    itemId: string,
    dto: TransferInventoryLocationDto,
    rawIdempotencyKey: string | null,
    requestId: string | null,
    traceId: string | null,
  ): Promise<InventoryLocationTransferResult> {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(itemId, 'itemId');
    const sourceId = dto.source_location_id.toLowerCase();
    const destinationId = dto.destination_location_id.toLowerCase();
    this.validateUuid(sourceId, 'source_location_id');
    this.validateUuid(destinationId, 'destination_location_id');
    if (sourceId === destinationId) {
      throw new BadRequestException('source_location_id and destination_location_id must differ');
    }

    const idempotencyKey = rawIdempotencyKey?.trim() ?? '';
    if (!idempotencyKey) throw new BadRequestException('Idempotency-Key is required for location transfers');
    if (idempotencyKey.length > 255) {
      throw new BadRequestException('Idempotency-Key must be at most 255 characters');
    }
    if (!Number.isFinite(dto.quantity) || dto.quantity <= 0) {
      throw new BadRequestException('quantity must be a positive number');
    }
    if (Math.abs(dto.quantity * 10000 - Math.round(dto.quantity * 10000)) > 0.000001) {
      throw new BadRequestException('quantity supports at most 4 decimal places');
    }

    const quantity = dto.quantity.toFixed(4);
    const notes = dto.notes?.trim() || null;
    const requestHash = this.hash({
      itemId: itemId.toLowerCase(),
      sourceId,
      destinationId,
      quantity,
      notes,
    });

    const result = await this.database.transaction(
      { tenantId, userId },
      async (client) => {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`inventory-location-transfer:${tenantId}:${factoryId}:${idempotencyKey}`],
        );
        const existing = await this.findTransferByKey(client, tenantId, factoryId, idempotencyKey);
        if (existing) return this.replayOrConflict(existing, requestHash);

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
        if (item.status !== 'ACTIVE') throw new ConflictException('Disabled items cannot be transferred');

        const locationResult = await client.query<InventoryLocationRow>(
          `
          SELECT ${LOCATION_COLUMNS}
          FROM inventory_locations
          WHERE tenant_id = $1 AND factory_id = $2
            AND id = ANY($3::uuid[])
            AND status = 'ACTIVE'
          ORDER BY id
          FOR UPDATE
          `,
          [tenantId, factoryId, [sourceId, destinationId]],
        );
        if (locationResult.rows.length !== 2) {
          throw new NotFoundException('Both locations must be active and belong to this factory');
        }

        const aggregateResult = await client.query<{
          quantity_on_hand: string;
          quantity_reserved: string;
        }>(
          `
          SELECT quantity_on_hand::text AS quantity_on_hand,
                 quantity_reserved::text AS quantity_reserved
          FROM inventory_stock_balances
          WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3
          FOR UPDATE
          `,
          [tenantId, factoryId, itemId],
        );
        const aggregate = aggregateResult.rows[0];
        if (!aggregate) throw new ConflictException('Inventory aggregate balance is unavailable');
        if (this.toUnits(aggregate.quantity_on_hand) - this.toUnits(aggregate.quantity_reserved) < this.toUnits(quantity)) {
          throw new ConflictException('Transfer quantity exceeds item stock not reserved for open work');
        }

        await client.query(
          `
          INSERT INTO inventory_location_balances (
            tenant_id, factory_id, item_id, location_id, quantity_on_hand
          )
          SELECT $1, $2, $3, l.id, 0
          FROM inventory_locations l
          WHERE l.tenant_id = $1 AND l.factory_id = $2
            AND l.id = ANY($4::uuid[])
          ON CONFLICT (tenant_id, factory_id, item_id, location_id) DO NOTHING
          `,
          [tenantId, factoryId, itemId, [sourceId, destinationId]],
        );

        const balancesResult = await client.query<LocationBalanceRow>(
          `
          SELECT location_id::text AS location_id, quantity_on_hand::text AS quantity_on_hand,
                 version::text AS version
          FROM inventory_location_balances
          WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3
            AND location_id = ANY($4::uuid[])
          ORDER BY location_id
          FOR UPDATE
          `,
          [tenantId, factoryId, itemId, [sourceId, destinationId]],
        );
        if (balancesResult.rows.length !== 2) {
          throw new ConflictException('Location balance records could not be initialized');
        }
        const sourceBalance = balancesResult.rows.find((row) => row.location_id === sourceId);
        const destinationBalance = balancesResult.rows.find((row) => row.location_id === destinationId);
        if (!sourceBalance || !destinationBalance) {
          throw new ConflictException('Source or destination location balance is unavailable');
        }

        const sourceBefore = this.toUnits(sourceBalance.quantity_on_hand);
        const destinationBefore = this.toUnits(destinationBalance.quantity_on_hand);
        const quantityUnits = this.toUnits(quantity);
        if (sourceBefore < quantityUnits) {
          throw new ConflictException('Insufficient stock at the source location');
        }

        const sourceAfter = sourceBefore - quantityUnits;
        const destinationAfter = destinationBefore + quantityUnits;
        await client.query(
          `
          UPDATE inventory_location_balances
          SET quantity_on_hand = $1::numeric, version = version + 1, updated_at = clock_timestamp()
          WHERE tenant_id = $2 AND factory_id = $3 AND item_id = $4 AND location_id = $5
          `,
          [this.fromUnits(sourceAfter), tenantId, factoryId, itemId, sourceId],
        );
        await client.query(
          `
          UPDATE inventory_location_balances
          SET quantity_on_hand = $1::numeric, version = version + 1, updated_at = clock_timestamp()
          WHERE tenant_id = $2 AND factory_id = $3 AND item_id = $4 AND location_id = $5
          `,
          [this.fromUnits(destinationAfter), tenantId, factoryId, itemId, destinationId],
        );

        const correlationId = this.correlationId(requestId, traceId);
        const inserted = await client.query<LocationTransferRow>(
          `
          INSERT INTO inventory_location_transfers (
            tenant_id, factory_id, item_id, source_location_id, destination_location_id,
            quantity, source_quantity_before, source_quantity_after,
            destination_quantity_before, destination_quantity_after,
            idempotency_key, request_hash, notes, created_by_user_id, correlation_id
          )
          VALUES (
            $1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric,
            $9::numeric, $10::numeric, $11, $12, $13, $14, $15::uuid
          )
          RETURNING ${TRANSFER_COLUMNS}
          `,
          [
            tenantId, factoryId, itemId, sourceId, destinationId,
            quantity, this.fromUnits(sourceBefore), this.fromUnits(sourceAfter),
            this.fromUnits(destinationBefore), this.fromUnits(destinationAfter),
            idempotencyKey, requestHash, notes, userId, correlationId,
          ],
        );
        const transfer = inserted.rows[0];
        if (!transfer) throw new Error('INVENTORY_LOCATION_TRANSFER_INSERT_FAILED');

        await this.insertOutboxEvent(client, {
          tenantId, factoryId, aggregateType: 'INVENTORY_ITEM', aggregateId: itemId,
          eventType: 'INVENTORY.STOCK_LOCATION_TRANSFERRED',
          correlationId, userId,
          payload: {
            transfer: {
              id: transfer.id,
              item_id: transfer.item_id,
              source_location_id: transfer.source_location_id,
              destination_location_id: transfer.destination_location_id,
              quantity: transfer.quantity,
              source_quantity_before: transfer.source_quantity_before,
              source_quantity_after: transfer.source_quantity_after,
              destination_quantity_before: transfer.destination_quantity_before,
              destination_quantity_after: transfer.destination_quantity_after,
            },
          },
        });
        return this.toPublicResult(transfer, false);
      },
    );

    if (!result.replayed) {
      await this.recordAuditSafely({
        tenantId, factoryId, userId,
        action: 'STOCK_LOCATION_TRANSFER',
        resourceId: result.id, requestId, traceId,
        payload: {
          itemId: result.item_id,
          sourceLocationId: result.source_location_id,
          destinationLocationId: result.destination_location_id,
          quantity: result.quantity,
        },
      });
    }
    return result;
  }

  async listTransfers(
    tenantId: string,
    factoryId: string,
    itemId: string,
    rawLimit = 50,
  ): Promise<InventoryLocationTransferResult[]> {
    this.validateReadScope(tenantId, factoryId);
    this.validateUuid(itemId, 'itemId');
    const limit = this.validateLimit(rawLimit);

    const item = await this.database.query<{ id: string }>(
      `
      SELECT id::text AS id FROM inventory_items
      WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 LIMIT 1
      `,
      [itemId, tenantId, factoryId],
      { tenantId },
    );
    if (!item.rows[0]) throw new NotFoundException('Inventory item not found in this factory');

    const result = await this.database.query<LocationTransferRow>(
      `
      SELECT ${TRANSFER_COLUMNS}
      FROM inventory_location_transfers
      WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3
      ORDER BY created_at DESC, id DESC
      LIMIT $4
      `,
      [tenantId, factoryId, itemId, limit],
      { tenantId },
    );
    return result.rows.map((row) => this.toPublicResult(row, false));
  }

  private async findTransferByKey(
    client: PoolClient,
    tenantId: string,
    factoryId: string,
    key: string,
  ): Promise<LocationTransferRow | null> {
    const result = await client.query<LocationTransferRow>(
      `
      SELECT ${TRANSFER_COLUMNS}
      FROM inventory_location_transfers
      WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3
      LIMIT 1
      `,
      [tenantId, factoryId, key],
    );
    return result.rows[0] ?? null;
  }

  private replayOrConflict(
    row: LocationTransferRow,
    hash: string,
  ): InventoryLocationTransferResult {
    if (row.request_hash !== hash) {
      throw new ConflictException('Idempotency-Key has already been used for a different location transfer');
    }
    return this.toPublicResult(row, true);
  }

  private toPublicResult(
    row: LocationTransferRow,
    replayed: boolean,
  ): InventoryLocationTransferResult {
    const {
      id, tenant_id, factory_id, item_id, source_location_id, destination_location_id,
      quantity, source_quantity_before, source_quantity_after,
      destination_quantity_before, destination_quantity_after,
      notes, created_by_user_id, correlation_id, created_at,
    } = row;
    return {
      id, tenant_id, factory_id, item_id, source_location_id, destination_location_id,
      quantity, source_quantity_before, source_quantity_after,
      destination_quantity_before, destination_quantity_after,
      notes, created_by_user_id, correlation_id, created_at, replayed,
    };
  }

  private async insertOutboxEvent(
    client: PoolClient,
    input: {
      tenantId: string;
      factoryId: string;
      aggregateType: string;
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
        $1, $2, $3, $4, $5, 1, clock_timestamp(),
        $5::uuid, NULL, $6::jsonb, $7::jsonb, $8::jsonb
      )
      `,
      [
        input.tenantId,
        input.factoryId,
        input.aggregateType,
        input.aggregateId,
        input.eventType,
        input.correlationId,
        JSON.stringify({ type: 'user', id: input.userId }),
        JSON.stringify({
          system: 'FactoryOS',
          connector: 'inventory-location-service',
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
        resourceType: 'INVENTORY_LOCATION',
        resourceId: input.resourceId,
        requestId: input.requestId && isUUID(input.requestId) ? input.requestId : null,
        correlationId: input.traceId && isUUID(input.traceId) ? input.traceId : null,
        dataClass: 'INTERNAL',
        payload: input.payload,
      });
    } catch {
      // The transactional outbox is durable, so an audit sink failure cannot undo committed inventory work.
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
    if (!isUUID(value)) throw new BadRequestException(`${field} must be a valid UUID`);
  }

  private validateLimit(value: number): number {
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }
    return value;
  }

  private requiredIdempotencyKey(value: string | null): string {
    const key = value?.trim() ?? '';
    if (!key) throw new BadRequestException('Idempotency-Key is required');
    if (key.length > 255) throw new BadRequestException('Idempotency-Key must be at most 255 characters');
    return key;
  }

  private normalizeQuantity(value: number, field: string): string {
    if (!Number.isFinite(value) || value <= 0 || Math.abs(value * 10000 - Math.round(value * 10000)) > 0.000001) {
      throw new BadRequestException(`${field} must be positive with at most four decimal places`);
    }
    return value.toFixed(4);
  }

  private toUnits(value: string): bigint {
    const [whole = '0', fraction = ''] = value.split('.');
    return BigInt(whole) * 10000n + BigInt((fraction + '0000').slice(0, 4));
  }

  private fromUnits(value: bigint): string {
    return `${value / 10000n}.${String(value % 10000n).padStart(4, '0')}`;
  }

  private hash(value: Record<string, string | null>): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
