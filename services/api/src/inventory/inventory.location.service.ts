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
import { UpdateInventoryLocationPolicyDto } from './dto/update-inventory-location-policy.dto';

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
  putaway_enabled: boolean;
  picking_enabled: boolean;
  putaway_priority: number;
  picking_priority: number;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

interface LocationBalanceRow extends QueryResultRow {
  location_id: string;
  quantity_on_hand: string;
  quantity_reserved: string;
  version?: string;
}

interface LocationTransferRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  item_id: string;
  source_location_id: string;
  destination_location_id: string;
  traceability_unit_id: string | null;
  movement_purpose: 'TRANSFER' | 'PUT_AWAY' | 'PICK';
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
  putaway_enabled, picking_enabled, putaway_priority, picking_priority,
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
  traceability_unit_id::text AS traceability_unit_id,
  movement_purpose,
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
    if (locationType === 'WAREHOUSE' && (dto.putaway_enabled === true || dto.picking_enabled === true)) {
      throw new BadRequestException('WAREHOUSE locations are hierarchy nodes and cannot receive or pick stock directly');
    }
    const putawayEnabled = locationType === 'WAREHOUSE' ? false : (dto.putaway_enabled ?? true);
    const pickingEnabled = locationType === 'WAREHOUSE' ? false : (dto.picking_enabled ?? true);
    const putawayPriority = dto.putaway_priority ?? 100;
    const pickingPriority = dto.picking_priority ?? 100;
    if (![putawayPriority, pickingPriority].every((value) => Number.isInteger(value) && value >= 0 && value <= 10000)) {
      throw new BadRequestException('Location priorities must be integers between 0 and 10000');
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
              location_code, name, location_type,
              putaway_enabled, picking_enabled, putaway_priority, picking_priority,
              created_by_user_id
            )
            VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING ${LOCATION_COLUMNS}
            `,
            [
              tenantId, factoryId, parentLocationId, locationCode, name, locationType,
              putawayEnabled, pickingEnabled, putawayPriority, pickingPriority, userId,
            ],
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
                putaway_enabled: row.putaway_enabled,
                picking_enabled: row.picking_enabled,
                putaway_priority: row.putaway_priority,
                picking_priority: row.picking_priority,
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
        putawayEnabled: created.putaway_enabled,
        pickingEnabled: created.picking_enabled,
        putawayPriority: created.putaway_priority,
        pickingPriority: created.picking_priority,
      },
    });
    return created;
  }

  async updateLocationPolicy(
    userId: string,
    tenantId: string,
    factoryId: string,
    locationId: string,
    dto: UpdateInventoryLocationPolicyDto,
    requestId: string | null,
    traceId: string | null,
  ): Promise<InventoryLocationRow> {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(locationId, 'locationId');
    const entries = Object.entries(dto).filter(([, value]) => value !== undefined);
    if (entries.length === 0) {
      throw new BadRequestException('At least one location policy field must be supplied');
    }
    if (entries.some(([key, value]) =>
      (key.endsWith('_priority') && (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 10000))
      || (key.endsWith('_enabled') && typeof value !== 'boolean')
    )) {
      throw new BadRequestException('Policy priorities must be integers between 0 and 10000 and policy flags must be boolean');
    }

    let updated: InventoryLocationRow;
    try {
      updated = await this.database.transaction({ tenantId, userId }, async (client) => {
        const currentResult = await client.query<InventoryLocationRow>(
          `
          SELECT ${LOCATION_COLUMNS}
          FROM inventory_locations
          WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
          FOR UPDATE
          `,
          [locationId, tenantId, factoryId],
        );
        const current = currentResult.rows[0];
        if (!current) throw new NotFoundException('Inventory location not found in this factory');
        const putawayEnabled = dto.putaway_enabled ?? current.putaway_enabled;
        const pickingEnabled = dto.picking_enabled ?? current.picking_enabled;
        const putawayPriority = dto.putaway_priority ?? current.putaway_priority;
        const pickingPriority = dto.picking_priority ?? current.picking_priority;
        if (current.location_type === 'WAREHOUSE' && (putawayEnabled || pickingEnabled)) {
          throw new BadRequestException('WAREHOUSE locations cannot receive or pick stock directly');
        }
        if (!pickingEnabled) {
          const reservations = await client.query<{ exists: boolean }>(
            `
            SELECT EXISTS (
              SELECT 1 FROM inventory_reservations
              WHERE tenant_id = $1 AND factory_id = $2 AND location_id = $3
                AND status = 'RESERVED'
            ) AS exists
            `,
            [tenantId, factoryId, locationId],
          );
          if (reservations.rows[0]?.exists) {
            throw new ConflictException('Picking cannot be disabled while active reservations are allocated to this location');
          }
        }
        const result = await client.query<InventoryLocationRow>(
          `
          UPDATE inventory_locations
          SET putaway_enabled = $1, picking_enabled = $2,
              putaway_priority = $3, picking_priority = $4,
              updated_at = clock_timestamp()
          WHERE id = $5 AND tenant_id = $6 AND factory_id = $7
          RETURNING ${LOCATION_COLUMNS}
          `,
          [putawayEnabled, pickingEnabled, putawayPriority, pickingPriority, locationId, tenantId, factoryId],
        );
        const row = result.rows[0];
        if (!row) throw new NotFoundException('Inventory location not found in this factory');
        await this.insertOutboxEvent(client, {
          tenantId, factoryId, aggregateType: 'INVENTORY_LOCATION', aggregateId: locationId,
          eventType: 'INVENTORY.LOCATION_POLICY_UPDATED',
          correlationId: this.correlationId(requestId, traceId),
          userId,
          payload: {
            location_id: locationId,
            policy: {
              putaway_enabled: row.putaway_enabled,
              picking_enabled: row.picking_enabled,
              putaway_priority: row.putaway_priority,
              picking_priority: row.picking_priority,
            },
          },
        });
        return row;
      });
    } catch (error) {
      const code = this.errorCode(error);
      if (code === '23514') {
        throw new ConflictException(error instanceof Error ? error.message : 'Location policy violates inventory constraints');
      }
      throw error;
    }

    await this.recordAuditSafely({
      tenantId, factoryId, userId, action: 'LOCATION_POLICY_UPDATE',
      resourceId: updated.id, requestId, traceId,
      payload: {
        putawayEnabled: updated.putaway_enabled,
        pickingEnabled: updated.picking_enabled,
        putawayPriority: updated.putaway_priority,
        pickingPriority: updated.picking_priority,
      },
    });
    return updated;
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

  async listPutawayTargets(
    tenantId: string,
    factoryId: string,
    itemId: string,
    rawLimit = 50,
  ) {
    this.validateReadScope(tenantId, factoryId);
    this.validateUuid(itemId, 'itemId');
    const limit = this.validateLimit(rawLimit);
    const item = await this.database.query<{ id: string }>(
      `SELECT id::text AS id FROM inventory_items
       WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 LIMIT 1`,
      [itemId, tenantId, factoryId], { tenantId },
    );
    if (!item.rows[0]) throw new NotFoundException('Inventory item not found in this factory');
    const result = await this.database.query(
      `
      SELECT l.id::text AS location_id, l.location_code, l.name AS location_name,
             l.parent_location_id::text AS parent_location_id,
             l.putaway_priority, l.picking_enabled,
             COALESCE(lb.quantity_on_hand, 0)::text AS quantity_on_hand,
             COALESCE(lb.quantity_reserved, 0)::text AS quantity_reserved
      FROM inventory_locations l
      JOIN inventory_locations parent
        ON parent.id = l.parent_location_id
       AND parent.tenant_id = l.tenant_id AND parent.factory_id = l.factory_id
      LEFT JOIN inventory_location_balances lb
        ON lb.tenant_id = l.tenant_id AND lb.factory_id = l.factory_id
       AND lb.location_id = l.id AND lb.item_id = $3
      WHERE l.tenant_id = $1 AND l.factory_id = $2
        AND l.status = 'ACTIVE' AND l.location_type = 'BIN' AND l.putaway_enabled = TRUE
        AND parent.status = 'ACTIVE' AND parent.location_type IN ('WAREHOUSE', 'STAGING')
      ORDER BY l.putaway_priority, lower(l.location_code), l.id
      LIMIT $4
      `,
      [tenantId, factoryId, itemId, limit], { tenantId },
    );
    return result.rows;
  }

  async listPickSources(
    tenantId: string,
    factoryId: string,
    itemId: string,
    rawLimit = 50,
  ) {
    this.validateReadScope(tenantId, factoryId);
    this.validateUuid(itemId, 'itemId');
    const limit = this.validateLimit(rawLimit);
    const item = await this.database.query<{ id: string }>(
      `SELECT id::text AS id FROM inventory_items
       WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 LIMIT 1`,
      [itemId, tenantId, factoryId], { tenantId },
    );
    if (!item.rows[0]) throw new NotFoundException('Inventory item not found in this factory');
    const result = await this.database.query(
      `
      SELECT l.id::text AS location_id, l.location_code, l.name AS location_name,
             l.parent_location_id::text AS parent_location_id, l.picking_priority,
             lb.quantity_on_hand::text AS quantity_on_hand,
             lb.quantity_reserved::text AS quantity_reserved,
             (lb.quantity_on_hand - lb.quantity_reserved)::text AS quantity_available
      FROM inventory_location_balances lb
      JOIN inventory_locations l
        ON l.id = lb.location_id AND l.tenant_id = lb.tenant_id AND l.factory_id = lb.factory_id
      JOIN inventory_locations parent
        ON parent.id = l.parent_location_id
       AND parent.tenant_id = l.tenant_id AND parent.factory_id = l.factory_id
      WHERE lb.tenant_id = $1 AND lb.factory_id = $2 AND lb.item_id = $3
        AND l.status = 'ACTIVE' AND l.location_type = 'BIN' AND l.picking_enabled = TRUE
        AND parent.status = 'ACTIVE' AND parent.location_type IN ('WAREHOUSE', 'STAGING')
        AND lb.quantity_on_hand > lb.quantity_reserved
      ORDER BY l.picking_priority, lower(l.location_code), l.id
      LIMIT $4
      `,
      [tenantId, factoryId, itemId, limit], { tenantId },
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
      location_quantity_reserved: string;
      location_quantity_available: string;
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
        CASE WHEN lb.quantity_reserved IS NULL THEN '0.0000' ELSE lb.quantity_reserved::text END AS location_quantity_reserved,
        CASE WHEN lb.quantity_on_hand IS NULL THEN '0.0000' ELSE (lb.quantity_on_hand - lb.quantity_reserved)::text END AS location_quantity_available,
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
    const traceabilityUnitId = dto.traceability_unit_id?.trim().toLowerCase() || null;
    this.validateUuid(sourceId, 'source_location_id');
    this.validateUuid(destinationId, 'destination_location_id');
    if (traceabilityUnitId) this.validateUuid(traceabilityUnitId, 'traceability_unit_id');
    if (sourceId === destinationId) {
      throw new BadRequestException('source_location_id and destination_location_id must differ');
    }
    const movementPurpose = dto.movement_purpose ?? 'TRANSFER';
    if (!['TRANSFER', 'PUT_AWAY', 'PICK'].includes(movementPurpose)) {
      throw new BadRequestException('movement_purpose must be TRANSFER, PUT_AWAY or PICK');
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
    // Keep the pre-policy TRANSFER fingerprint stable so already persisted transfer
    // requests replay correctly after migration 080. Directed purposes are added
    // to the identity because they change the allowed source/destination contract.
    const requestIdentity: Record<string, string | null> = {
      itemId: itemId.toLowerCase(),
      sourceId,
      destinationId,
      quantity,
      notes,
    };
    if (movementPurpose !== 'TRANSFER') requestIdentity.movementPurpose = movementPurpose;
    if (traceabilityUnitId) requestIdentity.traceabilityUnitId = traceabilityUnitId;
    const requestHash = this.hash(requestIdentity);

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

        const traceabilityPolicy = await client.query<{
          allocation_policy: 'FIFO' | 'FEFO' | 'LOT' | 'SERIAL';
          require_traceability: boolean;
          has_material_identity: boolean;
        }>(
          `
          SELECT COALESCE(
              (SELECT p.allocation_policy FROM inventory_material_allocation_policies p
               WHERE p.tenant_id=$1 AND p.factory_id=$2
                 AND p.policy_scope='MATERIAL' AND p.inventory_item_id=$3),
              (SELECT p.allocation_policy FROM inventory_material_allocation_policies p
               JOIN inventory_items selected_item
                 ON selected_item.id=$3 AND selected_item.tenant_id=p.tenant_id AND selected_item.factory_id=p.factory_id
               WHERE p.tenant_id=$1 AND p.factory_id=$2 AND p.policy_scope='SECTOR'
                 AND lower(p.sector_code)=lower(selected_item.sector_code)),
              (SELECT p.allocation_policy FROM inventory_material_allocation_policies p
               WHERE p.tenant_id=$1 AND p.factory_id=$2 AND p.policy_scope='FACTORY'),
              (SELECT ts.allocation_policy FROM traceability_settings ts
               WHERE ts.tenant_id=$1 AND ts.factory_id=$2),
              'FIFO'
            ) AS allocation_policy,
            COALESCE(
              (SELECT p.require_traceability FROM inventory_material_allocation_policies p
               WHERE p.tenant_id=$1 AND p.factory_id=$2
                 AND p.policy_scope='MATERIAL' AND p.inventory_item_id=$3),
              (SELECT p.require_traceability FROM inventory_material_allocation_policies p
               JOIN inventory_items selected_item
                 ON selected_item.id=$3 AND selected_item.tenant_id=p.tenant_id AND selected_item.factory_id=p.factory_id
               WHERE p.tenant_id=$1 AND p.factory_id=$2 AND p.policy_scope='SECTOR'
                 AND lower(p.sector_code)=lower(selected_item.sector_code)),
              (SELECT p.require_traceability FROM inventory_material_allocation_policies p
               WHERE p.tenant_id=$1 AND p.factory_id=$2 AND p.policy_scope='FACTORY'),
              FALSE
            ) AS require_traceability,
            EXISTS (
              SELECT 1 FROM traceability_units tu
              WHERE tu.tenant_id=$1 AND tu.factory_id=$2 AND tu.inventory_item_id=$3
                AND tu.product_role='MATERIAL' AND tu.unit_type IN ('LOT','SERIAL')
            ) AS has_material_identity
          FROM inventory_items i
          WHERE i.id=$3 AND i.tenant_id=$1 AND i.factory_id=$2
          `,
          [tenantId, factoryId, itemId],
        );
        const traceabilityRule = traceabilityPolicy.rows[0];
        if (!traceabilityUnitId && traceabilityRule
          && (traceabilityRule.require_traceability
            || traceabilityRule.allocation_policy === 'LOT'
            || traceabilityRule.allocation_policy === 'SERIAL'
            || traceabilityRule.has_material_identity)) {
          throw new ConflictException('This material requires an explicit lot/serial identity for put-away, picking or transfer');
        }

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
        const sourceLocation = locationResult.rows.find((row) => row.id === sourceId);
        const destinationLocation = locationResult.rows.find((row) => row.id === destinationId);
        if (!sourceLocation || !destinationLocation) {
          throw new NotFoundException('Source or destination location is unavailable');
        }
        if (!sourceLocation.picking_enabled) {
          throw new ConflictException('Source location policy does not allow picking or transfers');
        }
        if (!destinationLocation.putaway_enabled) {
          throw new ConflictException('Destination location policy does not allow put-away or receipts');
        }
        if (movementPurpose === 'PUT_AWAY') {
          if (
            !(
              sourceLocation.location_type === 'STAGING'
              || (sourceLocation.location_type === 'VIRTUAL' && sourceLocation.is_default)
            )
            || destinationLocation.location_type !== 'BIN'
          ) {
            throw new BadRequestException('PUT_AWAY must move stock from STAGING/UNASSIGNED to a BIN');
          }
        } else if (movementPurpose === 'PICK') {
          if (sourceLocation.location_type !== 'BIN' || destinationLocation.location_type !== 'STAGING') {
            throw new BadRequestException('PICK must move unreserved stock from a BIN to STAGING');
          }
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
                 quantity_reserved::text AS quantity_reserved, version::text AS version
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
        const sourceReserved = this.toUnits(sourceBalance.quantity_reserved);
        if (sourceBefore - sourceReserved < quantityUnits) {
          throw new ConflictException('Transfer quantity exceeds unreserved stock at the source location');
        }

        if (traceabilityUnitId) {
          const unitResult = await client.query<{
            id: string; status: string; attributes: Record<string, unknown>; product_role: string; unit_type: string;
          }>(
            `
            SELECT id::text AS id, status, attributes, product_role, unit_type
            FROM traceability_units
            WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 AND inventory_item_id=$4
              AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)
            FOR SHARE
            `,
            [traceabilityUnitId, tenantId, factoryId, itemId],
          );
          const unit = unitResult.rows[0];
          const attributes = unit?.attributes ?? {};
          const condition = String(attributes.condition ?? '').toUpperCase();
          if (!unit || unit.product_role !== 'MATERIAL' || !['LOT', 'SERIAL'].includes(unit.unit_type)
            || unit.status !== 'ACTIVE'
            || attributes.damaged === true || attributes.held === true || attributes.quarantined === true
            || ['DAMAGED', 'HELD', 'QUARANTINED', 'EXPIRED'].includes(condition)) {
            throw new ConflictException('Put-away/picking cannot move an inactive, expired, damaged, quarantined or held lot/serial');
          }
          const hold = await client.query<{ present: boolean }>(
            `
            SELECT EXISTS (
              SELECT 1 FROM quality_holds qh
              WHERE qh.tenant_id=$1 AND qh.factory_id=$2 AND qh.status='ACTIVE'
                AND (qh.inventory_item_id=$3 OR qh.traceability_unit_id=$4)
            ) AS present
            `,
            [tenantId, factoryId, itemId, traceabilityUnitId],
          );
          if (hold.rows[0]?.present) {
            throw new ConflictException('Quality-held material cannot be put away, picked or transferred');
          }
          const traceBalance = await client.query<{ quantity_on_hand: string; quantity_reserved: string }>(
            `
            SELECT quantity_on_hand::text AS quantity_on_hand, quantity_reserved::text AS quantity_reserved
            FROM inventory_traceability_location_balances
            WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3
              AND traceability_unit_id=$4 AND location_id=$5
            FOR UPDATE
            `,
            [tenantId, factoryId, itemId, traceabilityUnitId, sourceId],
          );
          const tracked = traceBalance.rows[0];
          if (!tracked) throw new ConflictException('Selected lot/serial has no stock at the transfer source');
          if (this.toUnits(tracked.quantity_on_hand) - this.toUnits(tracked.quantity_reserved) < quantityUnits) {
            throw new ConflictException('Transfer quantity exceeds unreserved stock for the selected lot/serial');
          }
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

        if (traceabilityUnitId) {
          const quantityDecimal = this.fromUnits(quantityUnits);
          const sourceTraceUpdate = await client.query<{ id: string }>(
            `
            UPDATE inventory_traceability_location_balances
            SET quantity_on_hand = quantity_on_hand - $1::numeric,
                version = version + 1, updated_at = clock_timestamp()
            WHERE tenant_id=$2 AND factory_id=$3 AND item_id=$4
              AND traceability_unit_id=$5 AND location_id=$6
              AND quantity_on_hand - quantity_reserved >= $1::numeric
            RETURNING id::text AS id
            `,
            [quantityDecimal, tenantId, factoryId, itemId, traceabilityUnitId, sourceId],
          );
          if (!sourceTraceUpdate.rows[0]) throw new ConflictException('Lot/serial stock changed during transfer; transaction rolled back');
          await client.query(
            `
            INSERT INTO inventory_traceability_location_balances (
              tenant_id, factory_id, item_id, traceability_unit_id, location_id, quantity_on_hand, quantity_reserved
            )
            VALUES ($1,$2,$3,$4,$5,$6::numeric,0)
            ON CONFLICT (tenant_id, factory_id, item_id, traceability_unit_id, location_id)
            DO UPDATE SET quantity_on_hand = inventory_traceability_location_balances.quantity_on_hand + EXCLUDED.quantity_on_hand,
                          version = inventory_traceability_location_balances.version + 1,
                          updated_at = clock_timestamp()
            `,
            [tenantId, factoryId, itemId, traceabilityUnitId, destinationId, quantityDecimal],
          );
        }

        const correlationId = this.correlationId(requestId, traceId);
        const inserted = await client.query<LocationTransferRow>(
          `
          INSERT INTO inventory_location_transfers (
            tenant_id, factory_id, item_id, source_location_id, destination_location_id,
            quantity, source_quantity_before, source_quantity_after,
            destination_quantity_before, destination_quantity_after,
            idempotency_key, request_hash, notes, created_by_user_id, correlation_id,
            movement_purpose, traceability_unit_id
          )
          VALUES (
            $1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric,
            $9::numeric, $10::numeric, $11, $12, $13, $14, $15::uuid, $16, $17::uuid
          )
          RETURNING ${TRANSFER_COLUMNS}
          `,
          [
            tenantId, factoryId, itemId, sourceId, destinationId,
            quantity, this.fromUnits(sourceBefore), this.fromUnits(sourceAfter),
            this.fromUnits(destinationBefore), this.fromUnits(destinationAfter),
            idempotencyKey, requestHash, notes, userId, correlationId, movementPurpose, traceabilityUnitId,
          ],
        );
        const transfer = inserted.rows[0];
        if (!transfer) throw new Error('INVENTORY_LOCATION_TRANSFER_INSERT_FAILED');

        await this.insertOutboxEvent(client, {
          tenantId, factoryId, aggregateType: 'INVENTORY_ITEM', aggregateId: itemId,
          eventType: movementPurpose === 'PUT_AWAY'
            ? 'INVENTORY.STOCK_PUT_AWAY_COMPLETED'
            : movementPurpose === 'PICK'
              ? 'INVENTORY.STOCK_PICKED_TO_STAGING'
              : 'INVENTORY.STOCK_LOCATION_TRANSFERRED',
          correlationId, userId,
          payload: {
            transfer: {
              id: transfer.id,
              movement_purpose: movementPurpose,
              traceability_unit_id: transfer.traceability_unit_id,
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
        action: result.movement_purpose === 'PUT_AWAY'
          ? 'STOCK_PUT_AWAY'
          : result.movement_purpose === 'PICK'
            ? 'STOCK_PICK'
            : 'STOCK_LOCATION_TRANSFER',
        resourceId: result.id, requestId, traceId,
        payload: {
          movementPurpose: result.movement_purpose,
          traceabilityUnitId: result.traceability_unit_id,
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
      movement_purpose, quantity, source_quantity_before, source_quantity_after,
      destination_quantity_before, destination_quantity_after,
      notes, created_by_user_id, correlation_id, created_at,
    } = row;
    return {
      id, tenant_id, factory_id, item_id, source_location_id, destination_location_id,
      movement_purpose, quantity, source_quantity_before, source_quantity_after,
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
        $6::uuid, NULL, $7::jsonb, $8::jsonb, $9::jsonb
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
