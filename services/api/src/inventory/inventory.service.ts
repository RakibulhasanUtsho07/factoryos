import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { CreateInventoryItemDto } from './dto/create-inventory-item.dto';
import { CreateStockMovementDto } from './dto/create-stock-movement.dto';
import { UnitOfMeasureService } from './uom.service';

type InventoryItemRow = QueryResultRow & {
  id: string;
  tenant_id: string;
  factory_id: string;
  sku: string;
  name: string;
  unit: string;
  sector_code: string | null;
  status: 'ACTIVE' | 'DISABLED';
  quantity_on_hand: string;
  quantity_reserved: string;
  quantity_available: string;
  version: string;
  created_at: string;
};

export interface InventoryStockSummary extends QueryResultRow {
  item_id: string;
  sku: string;
  name: string;
  unit: string;
  status: 'ACTIVE' | 'DISABLED';
  quantity_on_hand: string;
  quantity_reserved: string;
  quantity_available: string;
  balance_version: string;
}


export interface InventoryAffectedProductionOrder {
  production_order_id: string;
  production_order_number: string;
  work_order_id: string;
  work_order_number: string;
  work_order_status: 'RELEASED' | 'IN_PROGRESS' | 'ON_HOLD';
  due_date: string | null;
  required_quantity: string;
  allocated_quantity: string;
  consumed_quantity: string;
  unallocated_requirement_quantity: string;
}

export interface InventoryAvailabilityExposure extends QueryResultRow {
  item_id: string;
  sku: string;
  name: string;
  unit: string;
  status: 'ACTIVE' | 'DISABLED';
  quantity_on_hand: string;
  allocated_quantity: string;
  available_quantity: string;
  quarantined_quantity: string;
  damaged_quantity: string;
  expired_quantity: string;
  expected_quantity: string;
  next_expected_delivery_date: string | null;
  expected_quantity_basis: 'APPROVED_PO_OPEN_QUANTITY_MINUS_POSTED_GRN_RECEIVED';
  condition_evidence_scope:
    | 'ITEM_WIDE_QUALITY_HOLD'
    | 'TRACEABILITY_LOCATION_BALANCES'
    | 'NO_TRACEABILITY_CONDITION_EVIDENCE';
  first_affected_production_order: InventoryAffectedProductionOrder | null;
}

type InventoryMovementRow = QueryResultRow & {
  id: string;
  tenant_id: string;
  factory_id: string;
  item_id: string;
  location_id: string | null;
  movement_type: 'RECEIPT' | 'ISSUE';
  quantity: string;
  input_quantity: string;
  input_unit_code: string;
  conversion_rule_id: string | null;
  conversion_factor_numerator: string | null;
  conversion_factor_denominator: string | null;
  conversion_rounding_mode: 'REJECT' | 'HALF_UP' | null;
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
    @Optional() private readonly uomService?: UnitOfMeasureService,
  ) {}

  /**
   * Return the authoritative aggregate stock snapshot for one item.
   * The item, factory and tenant predicates are explicit in addition to
   * transaction-local RLS context. This method is read-only.
   */
  async getStockSummary(
    userId: string,
    tenantId: string,
    factoryId: string,
    itemId: string,
  ): Promise<InventoryStockSummary> {
    this.validateScope(userId, tenantId, factoryId);
    if (!isUUID(itemId)) throw new BadRequestException('itemId must be a valid UUID');

    const result = await this.database.query<InventoryStockSummary>(
      `
      SELECT i.id::text AS item_id,
             i.sku,
             i.name,
             i.unit,
             i.status,
             b.quantity_on_hand::text AS quantity_on_hand,
             b.quantity_reserved::text AS quantity_reserved,
             (b.quantity_on_hand - b.quantity_reserved)::text AS quantity_available,
             b.version::text AS balance_version
      FROM inventory_items i
      JOIN inventory_stock_balances b
        ON b.item_id = i.id
       AND b.tenant_id = i.tenant_id
       AND b.factory_id = i.factory_id
      WHERE i.id = $1
        AND i.tenant_id = $2
        AND i.factory_id = $3
      LIMIT 1
      `,
      [itemId.toLowerCase(), tenantId, factoryId],
      { tenantId, userId },
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Inventory item not found in this factory');
    return row;
  }


  /**
   * Read-only WMS availability/exposure snapshot for FR-WMS-04/05.
   *
   * Aggregate stock and active reservations come from the stock ledger.
   * Quarantine/damage are classified only from traceability-location
   * balances and active quality holds. Expected supply is the unreceived
   * remainder of approved PO lines after POSTED GRN physical receipts.
   * The first affected order is the earliest-due released work order whose
   * component requirement is not yet covered by remaining reservations and
   * already-consumed material.
   */
  async getAvailabilityExposure(
    userId: string,
    tenantId: string,
    factoryId: string,
    itemId: string,
  ): Promise<InventoryAvailabilityExposure> {
    this.validateScope(userId, tenantId, factoryId);
    if (!isUUID(itemId)) throw new BadRequestException('itemId must be a valid UUID');

    const row = await this.database.transaction(
      { tenantId, userId, readOnly: true },
      async (client) => {
        const result = await client.query<InventoryAvailabilityExposure>(
          `
          WITH selected_item AS (
            SELECT
              i.id, i.tenant_id, i.factory_id, i.sku, i.name, i.unit, i.status,
              b.quantity_on_hand, b.quantity_reserved,
              EXISTS (
                SELECT 1
                FROM quality_holds qh
                WHERE qh.tenant_id = i.tenant_id
                  AND qh.factory_id = i.factory_id
                  AND qh.inventory_item_id = i.id
                  AND qh.traceability_unit_id IS NULL
                  AND qh.status = 'ACTIVE'
              ) AS item_wide_quality_hold
            FROM inventory_items i
            JOIN inventory_stock_balances b
              ON b.item_id = i.id
             AND b.tenant_id = i.tenant_id
             AND b.factory_id = i.factory_id
            WHERE i.id = $1
              AND i.tenant_id = $2
              AND i.factory_id = $3
            LIMIT 1
          ),
          traceability_balances AS (
            SELECT
              tu.id AS traceability_unit_id,
              tu.status,
              tu.attributes,
              tu.expires_at,
              SUM(tlb.quantity_on_hand)::numeric(18,4) AS quantity_on_hand,
              SUM(tlb.quantity_reserved)::numeric(18,4) AS quantity_reserved,
              EXISTS (
                SELECT 1
                FROM quality_holds qh
                WHERE qh.tenant_id = tu.tenant_id
                  AND qh.factory_id = tu.factory_id
                  AND qh.traceability_unit_id = tu.id
                  AND qh.status = 'ACTIVE'
              ) AS has_active_quality_hold
            FROM selected_item s
            JOIN inventory_traceability_location_balances tlb
              ON tlb.item_id = s.id
             AND tlb.tenant_id = s.tenant_id
             AND tlb.factory_id = s.factory_id
            JOIN traceability_units tu
              ON tu.id = tlb.traceability_unit_id
             AND tu.inventory_item_id = tlb.item_id
             AND tu.tenant_id = tlb.tenant_id
             AND tu.factory_id = tlb.factory_id
            GROUP BY tu.id, tu.status, tu.attributes, tu.expires_at, tu.tenant_id, tu.factory_id
          ),
          classified_traceability AS (
            SELECT
              traceability_unit_id,
              quantity_on_hand,
              quantity_reserved,
              expires_at,
              (
                status IN ('QUARANTINED', 'RECALLED')
                OR attributes @> '{"quarantined":true}'::jsonb
                OR attributes @> '{"held":true}'::jsonb
                OR upper(COALESCE(attributes->>'condition', '')) IN ('QUARANTINED', 'HELD', 'RECALLED')
                OR has_active_quality_hold
              ) AS is_quarantined,
              (
                attributes @> '{"damaged":true}'::jsonb
                OR upper(COALESCE(attributes->>'condition', '')) = 'DAMAGED'
              ) AS is_damaged,
              (
                (expires_at IS NOT NULL AND expires_at < CURRENT_DATE)
                OR upper(COALESCE(attributes->>'condition', '')) = 'EXPIRED'
              ) AS is_expired
            FROM traceability_balances
          ),
          condition_totals AS (
            SELECT
              COALESCE(SUM(CASE WHEN is_quarantined THEN quantity_on_hand ELSE 0 END), 0)::numeric(18,4)
                AS quarantined_quantity,
              COALESCE(SUM(CASE WHEN NOT is_quarantined AND is_damaged THEN quantity_on_hand ELSE 0 END), 0)::numeric(18,4)
                AS damaged_quantity,
              COALESCE(SUM(CASE WHEN NOT is_quarantined AND NOT is_damaged AND is_expired THEN quantity_on_hand ELSE 0 END), 0)::numeric(18,4)
                AS expired_quantity,
              COALESCE(SUM(CASE WHEN is_quarantined THEN quantity_on_hand - quantity_reserved ELSE 0 END), 0)::numeric(18,4)
                AS quarantined_unallocated_quantity,
              COALESCE(SUM(CASE WHEN NOT is_quarantined AND is_damaged THEN quantity_on_hand - quantity_reserved ELSE 0 END), 0)::numeric(18,4)
                AS damaged_unallocated_quantity,
              COALESCE(SUM(CASE WHEN NOT is_quarantined AND NOT is_damaged AND is_expired THEN quantity_on_hand - quantity_reserved ELSE 0 END), 0)::numeric(18,4)
                AS expired_unallocated_quantity,
              COUNT(*)::integer AS tracked_identity_count
            FROM classified_traceability
          ),
          expected_supply AS (
            SELECT
              s.id AS item_id,
              COALESCE(SUM(
                CASE WHEN po.status = 'APPROVED'
                  THEN GREATEST(pol.quantity - COALESCE(received.received_quantity, 0), 0)
                  ELSE 0
                END
              ), 0)::numeric(18,4) AS expected_quantity,
              MIN(po.expected_delivery_date) FILTER (
                WHERE po.status = 'APPROVED'
                  AND GREATEST(pol.quantity - COALESCE(received.received_quantity, 0), 0) > 0
              ) AS next_expected_delivery_date
            FROM selected_item s
            LEFT JOIN purchase_order_lines pol
              ON pol.tenant_id = s.tenant_id
             AND pol.factory_id = s.factory_id
             AND pol.inventory_item_id = s.id
            LEFT JOIN purchase_orders po
              ON po.id = pol.purchase_order_id
             AND po.tenant_id = pol.tenant_id
             AND po.factory_id = pol.factory_id
             AND po.status = 'APPROVED'
            LEFT JOIN LATERAL (
              SELECT COALESCE(SUM(gl.received_quantity), 0)::numeric AS received_quantity
              FROM goods_receipt_lines gl
              JOIN goods_receipts gr
                ON gr.id = gl.goods_receipt_id
               AND gr.tenant_id = gl.tenant_id
               AND gr.factory_id = gl.factory_id
               AND gr.purchase_order_id = gl.purchase_order_id
              WHERE gl.tenant_id = pol.tenant_id
                AND gl.factory_id = pol.factory_id
                AND gl.purchase_order_line_id = pol.id
                AND gr.status = 'POSTED'
            ) received ON TRUE
            GROUP BY s.id
          ),
          first_affected_order AS (
            SELECT
              jsonb_build_object(
                'production_order_id', wo.source_order_id::text,
                'production_order_number', o.order_number,
                'work_order_id', wo.id::text,
                'work_order_number', wo.work_order_number,
                'work_order_status', wo.status,
                'due_date', wo.due_date::text,
                'required_quantity', req.required_quantity::text,
                'allocated_quantity', COALESCE(usage.remaining_quantity, 0)::text,
                'consumed_quantity', COALESCE(usage.consumed_quantity, 0)::text,
                'unallocated_requirement_quantity',
                  GREATEST(
                    req.required_quantity
                      - COALESCE(usage.remaining_quantity, 0)
                      - COALESCE(usage.consumed_quantity, 0),
                    0
                  )::text
              ) AS order_evidence
            FROM selected_item s
            JOIN work_order_material_requirements req
              ON req.component_item_id = s.id
             AND req.tenant_id = s.tenant_id
             AND req.factory_id = s.factory_id
            JOIN work_orders wo
              ON wo.id = req.work_order_id
             AND wo.tenant_id = req.tenant_id
             AND wo.factory_id = req.factory_id
            JOIN orders o
              ON o.id = wo.source_order_id
             AND o.tenant_id = wo.tenant_id
             AND o.factory_id = wo.factory_id
            LEFT JOIN LATERAL (
              SELECT
                COALESCE(SUM(ir.remaining_quantity), 0)::numeric(18,4) AS remaining_quantity,
                COALESCE(SUM(ir.consumed_quantity), 0)::numeric(18,4) AS consumed_quantity
              FROM work_order_material_reservations wmr
              JOIN inventory_reservations ir
                ON ir.id = wmr.reservation_id
               AND ir.tenant_id = wmr.tenant_id
               AND ir.factory_id = wmr.factory_id
               AND ir.item_id = wmr.item_id
              WHERE wmr.tenant_id = req.tenant_id
                AND wmr.factory_id = req.factory_id
                AND wmr.work_order_id = wo.id
                AND wmr.requirement_id = req.id
                AND wmr.item_id = req.component_item_id
                AND ir.reference_type = 'WORK_ORDER_MATERIAL'
                AND ir.reference_id = wo.id
            ) usage ON TRUE
            WHERE wo.status IN ('RELEASED', 'IN_PROGRESS', 'ON_HOLD')
              AND req.required_quantity >
                COALESCE(usage.remaining_quantity, 0) + COALESCE(usage.consumed_quantity, 0)
            ORDER BY wo.due_date ASC NULLS LAST, wo.created_at ASC, wo.id ASC, req.line_number ASC, req.id ASC
            LIMIT 1
          )
          SELECT
            s.id::text AS item_id,
            s.sku,
            s.name,
            s.unit,
            s.status,
            s.quantity_on_hand::text AS quantity_on_hand,
            s.quantity_reserved::text AS allocated_quantity,
            CASE
              WHEN s.status <> 'ACTIVE' OR s.item_wide_quality_hold THEN 0::numeric(18,4)
              ELSE GREATEST(
                s.quantity_on_hand
                  - s.quantity_reserved
                  - COALESCE(c.quarantined_unallocated_quantity, 0)
                  - COALESCE(c.damaged_unallocated_quantity, 0)
                  - COALESCE(c.expired_unallocated_quantity, 0),
                0
              )::numeric(18,4)
            END::text AS available_quantity,
            CASE WHEN s.item_wide_quality_hold
              THEN s.quantity_on_hand
              ELSE COALESCE(c.quarantined_quantity, 0)
            END::text AS quarantined_quantity,
            CASE WHEN s.item_wide_quality_hold
              THEN 0::numeric(18,4)
              ELSE COALESCE(c.damaged_quantity, 0)
            END::text AS damaged_quantity,
            COALESCE(c.expired_quantity, 0)::text AS expired_quantity,
            COALESCE(e.expected_quantity, 0)::text AS expected_quantity,
            e.next_expected_delivery_date::text AS next_expected_delivery_date,
            'APPROVED_PO_OPEN_QUANTITY_MINUS_POSTED_GRN_RECEIVED'::text AS expected_quantity_basis,
            CASE
              WHEN s.item_wide_quality_hold THEN 'ITEM_WIDE_QUALITY_HOLD'
              WHEN COALESCE(c.tracked_identity_count, 0) > 0 THEN 'TRACEABILITY_LOCATION_BALANCES'
              ELSE 'NO_TRACEABILITY_CONDITION_EVIDENCE'
            END::text AS condition_evidence_scope,
            a.order_evidence AS first_affected_production_order
          FROM selected_item s
          CROSS JOIN condition_totals c
          LEFT JOIN expected_supply e ON e.item_id = s.id
          LEFT JOIN first_affected_order a ON TRUE
          LIMIT 1
          `,
          [itemId.toLowerCase(), tenantId, factoryId],
        );
        return result.rows[0] ?? null;
      },
    );

    if (!row) throw new NotFoundException('Inventory item not found in this factory');
    return row;
  }


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
    const sectorCode = dto.sector_code?.trim().toUpperCase() || null;
    if (sectorCode && sectorCode.length > 64) throw new BadRequestException('sector_code must be at most 64 characters');
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
              tenant_id, factory_id, sku, name, unit, sector_code, created_by_user_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING
              id::text AS id,
              tenant_id::text AS tenant_id,
              factory_id::text AS factory_id,
              sku, name, unit, sector_code, status,
              version::text AS version,
              created_at::text AS created_at
            `,
            [tenantId, factoryId, sku, name, unit, sectorCode, userId],
          );
          const created = itemResult.rows[0];
          if (!created) throw new Error('INVENTORY_ITEM_INSERT_FAILED');

          const balanceResult = await client.query<{
            quantity_on_hand: string;
            quantity_reserved: string;
            quantity_available: string;
          }>(
            `
            INSERT INTO inventory_stock_balances (
              tenant_id, factory_id, item_id, quantity_on_hand
            )
            VALUES ($1, $2, $3, 0)
            RETURNING
              quantity_on_hand::text AS quantity_on_hand,
              quantity_reserved::text AS quantity_reserved,
              (quantity_on_hand - quantity_reserved)::text AS quantity_available
            `,
            [tenantId, factoryId, created.id],
          );
          created.quantity_on_hand = balanceResult.rows[0]?.quantity_on_hand ?? '0.0000';
          created.quantity_reserved = balanceResult.rows[0]?.quantity_reserved ?? '0.0000';
          created.quantity_available = balanceResult.rows[0]?.quantity_available ?? '0.0000';

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
                sector_code: created.sector_code,
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
      payload: { sku: item.sku, unit: item.unit, sectorCode: item.sector_code },
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
        i.sku, i.name, i.unit, i.sector_code, i.status,
        b.quantity_on_hand::text AS quantity_on_hand,
        b.quantity_reserved::text AS quantity_reserved,
        (b.quantity_on_hand - b.quantity_reserved)::text AS quantity_available,
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
    const inputUnitCode = dto.input_unit_code?.trim().toUpperCase() || null;
    if (inputUnitCode && !/^[A-Z0-9][A-Z0-9._-]{0,49}$/.test(inputUnitCode)) {
      throw new BadRequestException('input_unit_code must be a valid 1–50 character UoM code');
    }
    const inputPrecision = inputUnitCode ? 8 : 4;
    if (Math.abs(dto.quantity * (10 ** inputPrecision) - Math.round(dto.quantity * (10 ** inputPrecision))) > 0.000001) {
      throw new BadRequestException('quantity exceeds the supported input precision of ' + inputPrecision + ' decimal places');
    }
    if (!['RECEIPT', 'ISSUE'].includes(dto.movement_type)) {
      throw new BadRequestException('movement_type must be RECEIPT or ISSUE');
    }

    const locationId = dto.location_id?.trim().toLowerCase() || null;
    if (locationId) this.validateUuid(locationId, 'location_id');
    const expectedBalanceVersion = dto.expected_balance_version?.trim() || null;
    if (expectedBalanceVersion && !/^\d{1,19}$/.test(expectedBalanceVersion)) {
      throw new BadRequestException('expected_balance_version must be an unsigned integer string of at most 19 digits');
    }
    const referenceType = dto.reference_type?.trim().toUpperCase() || null;
    const referenceId = dto.reference_id?.toLowerCase() || null;
    if (referenceId) this.validateUuid(referenceId, 'reference_id');
    const notes = dto.notes?.trim() || null;
    const quantityForHash = dto.quantity.toFixed(inputPrecision);
    const hashInput: Record<string, unknown> = {
      itemId: itemId.toLowerCase(),
      movementType: dto.movement_type,
      locationId,
      quantity: quantityForHash,
      referenceType,
      referenceId,
      notes,
    };
    if (inputUnitCode) hashInput.inputUnitCode = inputUnitCode;
    if (expectedBalanceVersion !== null) hashInput.expectedBalanceVersion = expectedBalanceVersion;
    const requestHash = createHash('sha256').update(JSON.stringify(hashInput)).digest('hex');

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
            id: string; sku: string; name: string; unit: string; status: 'ACTIVE' | 'DISABLED';
          }>(
            `
            SELECT id::text AS id, sku, name, unit, status
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

          // An offline transaction is valid only against the stock snapshot the
          // device observed. Check the version while holding the item/balance locks
          // so a stale offline issue cannot silently apply after reconnect.
          if (expectedBalanceVersion !== null) {
            const versionResult = await client.query<{ version: string }>(
              `SELECT version::text AS version
               FROM inventory_stock_balances
               WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3
               FOR UPDATE`,
              [tenantId, factoryId, itemId],
            );
            const currentVersion = versionResult.rows[0]?.version;
            if (currentVersion === undefined) {
              throw new ConflictException('Inventory balance is unavailable for offline version check');
            }
            if (currentVersion !== expectedBalanceVersion) {
              throw new ConflictException(
                `Inventory balance version changed; expected ${expectedBalanceVersion}, current ${currentVersion}`,
              );
            }
          }

          if (locationId) {
            const locationResult = await client.query<{
              id: string; putaway_enabled: boolean; picking_enabled: boolean;
            }>(
              `SELECT id::text AS id, putaway_enabled, picking_enabled
               FROM inventory_locations
               WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 AND status = 'ACTIVE'
               LIMIT 1`,
              [locationId, tenantId, factoryId],
            );
            const selectedLocation = locationResult.rows[0];
            if (!selectedLocation) {
              throw new NotFoundException('Active inventory location not found in this factory');
            }
            if (dto.movement_type === 'RECEIPT' && !selectedLocation.putaway_enabled) {
              throw new ConflictException('Selected location policy does not allow stock receipts/put-away');
            }
            if (dto.movement_type === 'ISSUE' && !selectedLocation.picking_enabled) {
              throw new ConflictException('Selected location policy does not allow picking/stock issues');
            }
            // The migration trigger applies the aggregate stock delta to this bin atomically.
            await client.query(
              `SELECT set_config('app.inventory_location_id', $1, TRUE)`,
              [locationId],
            );
          }

          let quantity: string;
          let inputQuantity: string;
          let movementInputUnitCode: string;
          let conversionRuleId: string | null = null;
          let conversionFactorNumerator: string | null = null;
          let conversionFactorDenominator: string | null = null;
          let conversionRoundingMode: 'REJECT' | 'HALF_UP' | null = null;
          if (this.uomService) {
            // An omitted input_unit_code is a base-unit request, but it must
            // still pass the configured unit precision validation.
            const effectiveInputUnitCode = inputUnitCode ?? item.unit;
            const converted = await this.uomService.convertForStockMovement(
              client, tenantId, factoryId, effectiveInputUnitCode, item.unit, dto.quantity.toFixed(8),
            );
            quantity = converted.quantity;
            inputQuantity = converted.inputQuantity;
            movementInputUnitCode = effectiveInputUnitCode;
            conversionRuleId = converted.conversionRuleId;
            conversionFactorNumerator = converted.factorNumerator;
            conversionFactorDenominator = converted.factorDenominator;
            conversionRoundingMode = converted.roundingMode;
          } else {
            if (inputUnitCode) throw new ConflictException('Unit-of-measure conversion service is unavailable');
            quantity = dto.quantity.toFixed(4);
            inputQuantity = dto.quantity.toFixed(8);
            movementInputUnitCode = item.unit;
          }
          const delta = dto.movement_type === 'RECEIPT' ? quantity : '-' + quantity;
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
              AND quantity_on_hand + $1::numeric >= quantity_reserved
            RETURNING quantity_on_hand::text AS quantity_on_hand
            `,
            [delta, tenantId, factoryId, itemId],
          );
          const balance = balanceResult.rows[0];
          if (!balance) {
            throw new ConflictException('Insufficient stock or inventory balance is unavailable');
          }

          const correlationId = this.correlationId(requestId, traceId);
          const movementResult = await client.query<InventoryMovementRow>(
            `
            INSERT INTO inventory_movements (
              tenant_id, factory_id, item_id, location_id, movement_type, quantity,
              quantity_delta, quantity_after, input_quantity, input_unit_code, conversion_rule_id,
              conversion_factor_numerator, conversion_factor_denominator, conversion_rounding_mode,
              idempotency_key, request_hash, reference_type, reference_id, notes,
              created_by_user_id, correlation_id
            )
            VALUES (
              $1, $2, $3, $4::uuid, $5, $6::numeric, $7::numeric, $8::numeric,
              $9::numeric, $10, $11::uuid, $12::numeric, $13::numeric, $14,
              $15, $16, $17, $18::uuid, $19, $20, $21::uuid
            )
            RETURNING
              id::text AS id,
              tenant_id::text AS tenant_id,
              factory_id::text AS factory_id,
              item_id::text AS item_id,
              location_id::text AS location_id,
              movement_type,
              quantity::text AS quantity,
              input_quantity::text AS input_quantity,
              input_unit_code,
              conversion_rule_id::text AS conversion_rule_id,
              conversion_factor_numerator::text AS conversion_factor_numerator,
              conversion_factor_denominator::text AS conversion_factor_denominator,
              conversion_rounding_mode,
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
              tenantId, factoryId, itemId, locationId, dto.movement_type, quantity,
              delta, balance.quantity_on_hand, inputQuantity, movementInputUnitCode, conversionRuleId,
              conversionFactorNumerator, conversionFactorDenominator, conversionRoundingMode,
              idempotencyKey, requestHash, referenceType, referenceId, notes, userId, correlationId,
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
                location_id: movement.location_id,
                movement_type: movement.movement_type,
                quantity: movement.quantity,
                input_quantity: movement.input_quantity,
                input_unit_code: movement.input_unit_code,
                conversion_rule_id: movement.conversion_rule_id,
                conversion_factor_numerator: movement.conversion_factor_numerator,
                conversion_factor_denominator: movement.conversion_factor_denominator,
                conversion_rounding_mode: movement.conversion_rounding_mode,
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
      const code = this.errorCode(error);
      if (code === '23514' && locationId) {
        throw new ConflictException('Insufficient stock at the selected location or inventory location balance is inconsistent');
      }
      if (code !== '23505') throw error;

      // The database unique key arbitrates the rare race where two requests
      // reuse one key while holding different item-row locks.
      const stored = await this.database.query<InventoryMovementRow>(
        `
        SELECT
          id::text AS id,
          tenant_id::text AS tenant_id,
          factory_id::text AS factory_id,
          item_id::text AS item_id,
          location_id::text AS location_id,
          movement_type,
          quantity::text AS quantity,
          input_quantity::text AS input_quantity,
          input_unit_code,
          conversion_rule_id::text AS conversion_rule_id,
          conversion_factor_numerator::text AS conversion_factor_numerator,
          conversion_factor_denominator::text AS conversion_factor_denominator,
          conversion_rounding_mode,
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
          locationId: result.location_id,
          quantity: result.quantity,
          inputQuantity: result.input_quantity,
          inputUnitCode: result.input_unit_code,
          conversionRuleId: result.conversion_rule_id,
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
        location_id::text AS location_id,
        movement_type,
        quantity::text AS quantity,
        input_quantity::text AS input_quantity,
        input_unit_code,
        conversion_rule_id::text AS conversion_rule_id,
        conversion_factor_numerator::text AS conversion_factor_numerator,
        conversion_factor_denominator::text AS conversion_factor_denominator,
        conversion_rounding_mode,
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
        location_id::text AS location_id,
        movement_type,
        quantity::text AS quantity,
        input_quantity::text AS input_quantity,
        input_unit_code,
        conversion_rule_id::text AS conversion_rule_id,
        conversion_factor_numerator::text AS conversion_factor_numerator,
        conversion_factor_denominator::text AS conversion_factor_denominator,
        conversion_rounding_mode,
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
      id, tenant_id, factory_id, item_id, location_id, movement_type, quantity,
      input_quantity, input_unit_code, conversion_rule_id, conversion_factor_numerator,
      conversion_factor_denominator, conversion_rounding_mode,
      quantity_delta, quantity_after, reference_type, reference_id, notes,
      created_by_user_id, correlation_id, created_at,
    } = stored;
    return {
      id, tenant_id, factory_id, item_id, location_id, movement_type, quantity,
      input_quantity, input_unit_code, conversion_rule_id, conversion_factor_numerator,
      conversion_factor_denominator, conversion_rounding_mode,
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
