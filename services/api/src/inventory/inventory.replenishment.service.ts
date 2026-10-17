import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { UpsertInventoryReorderPolicyDto } from './dto/upsert-inventory-reorder-policy.dto';

interface ReorderPolicyRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  item_id: string;
  minimum_quantity: string;
  maximum_quantity: string;
  lead_time_days: number;
  preferred_supplier_id: string | null;
  enabled: boolean;
  created_by_user_id: string;
  updated_by_user_id: string;
  created_at: string;
  updated_at: string;
  version: string;
}

interface ReplenishmentSignalRow extends QueryResultRow {
  policy_id: string;
  tenant_id: string;
  factory_id: string;
  item_id: string;
  sku: string;
  item_name: string;
  unit: string;
  minimum_quantity: string;
  maximum_quantity: string;
  lead_time_days: number;
  preferred_supplier_id: string | null;
  preferred_supplier_name: string | null;
  preferred_supplier_status: string | null;
  enabled: boolean;
  policy_version: string;
  quantity_on_hand: string;
  quantity_reserved: string;
  available_quantity: string;
  incoming_quantity: string;
  inventory_position: string;
  physical_shortage_quantity: string;
  uncovered_shortage_quantity: string;
  recommended_order_quantity: string;
  reorder_triggered: boolean;
  recommendation_status: 'NOT_REQUIRED' | 'COVERED_BY_INCOMING' | 'SUPPLIER_REQUIRED' | 'REVIEW_REQUIRED';
  next_incoming_date: string | null;
  estimated_replenishment_date: string;
}

const REORDER_POLICY_COLUMNS = `
  id::text AS id,
  tenant_id::text AS tenant_id,
  factory_id::text AS factory_id,
  item_id::text AS item_id,
  minimum_quantity::text AS minimum_quantity,
  maximum_quantity::text AS maximum_quantity,
  lead_time_days,
  preferred_supplier_id::text AS preferred_supplier_id,
  enabled,
  created_by_user_id::text AS created_by_user_id,
  updated_by_user_id::text AS updated_by_user_id,
  created_at::text AS created_at,
  updated_at::text AS updated_at,
  version::text AS version
`;

type PolicyWriteResult = {
  policy: ReorderPolicyRow;
  changed: boolean;
  changeType: 'CREATED' | 'UPDATED' | 'UNCHANGED';
};

@Injectable()
export class InventoryReplenishmentService {
  constructor(
    private readonly database: DatabaseService,
    private readonly auditService: AuditService,
  ) {}

  async upsertPolicy(
    userId: string,
    tenantId: string,
    factoryId: string,
    itemId: string,
    dto: UpsertInventoryReorderPolicyDto,
    requestId: string | null,
    traceId: string | null,
  ): Promise<{ policy: ReorderPolicyRow; changed: boolean }> {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(itemId, 'itemId');

    const minimumQuantity = this.normalizeQuantity(dto.minimum_quantity, 'minimum_quantity');
    const maximumQuantity = this.normalizeQuantity(dto.maximum_quantity, 'maximum_quantity');
    if (Number(minimumQuantity) >= Number(maximumQuantity)) {
      throw new BadRequestException('maximum_quantity must be greater than minimum_quantity');
    }
    if (!Number.isInteger(dto.lead_time_days) || dto.lead_time_days < 0 || dto.lead_time_days > 3650) {
      throw new BadRequestException('lead_time_days must be an integer between 0 and 3650');
    }
    if (typeof dto.enabled !== 'boolean') {
      throw new BadRequestException('enabled must be a boolean');
    }

    const preferredSupplierId = dto.preferred_supplier_id?.trim().toLowerCase() || null;
    if (preferredSupplierId) this.validateUuid(preferredSupplierId, 'preferred_supplier_id');

    const correlationId = this.correlationId(requestId, traceId);
    const writeResult = await this.database.transaction(
      { tenantId, userId },
      async (client) => {
        const itemResult = await client.query<{
          id: string;
          sku: string;
          status: 'ACTIVE' | 'DISABLED';
        }>(
          `
          SELECT id::text AS id, sku, status
          FROM inventory_items
          WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
          FOR UPDATE
          `,
          [itemId, tenantId, factoryId],
        );
        const item = itemResult.rows[0];
        if (!item) throw new NotFoundException('Inventory item not found in this factory');
        if (item.status !== 'ACTIVE') {
          throw new ConflictException('Reorder policies can only be configured for active inventory items');
        }

        if (preferredSupplierId) {
          const supplier = await client.query<{ id: string }>(
            `
            SELECT id::text AS id
            FROM suppliers
            WHERE id = $1 AND tenant_id = $2 AND status = 'ACTIVE'
            FOR KEY SHARE
            `,
            [preferredSupplierId, tenantId],
          );
          if (!supplier.rows[0]) {
            throw new NotFoundException('Preferred supplier not found, disabled, or outside this tenant');
          }
        }

        const existingResult = await client.query<ReorderPolicyRow>(
          `
          SELECT ${REORDER_POLICY_COLUMNS}
          FROM inventory_reorder_policies
          WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3
          FOR UPDATE
          `,
          [tenantId, factoryId, itemId],
        );
        const existing = existingResult.rows[0] ?? null;
        if (
          existing
          && existing.minimum_quantity === minimumQuantity
          && existing.maximum_quantity === maximumQuantity
          && Number(existing.lead_time_days) === dto.lead_time_days
          && (existing.preferred_supplier_id?.toLowerCase() ?? null) === preferredSupplierId
          && existing.enabled === dto.enabled
        ) {
          return { policy: existing, changed: false, changeType: 'UNCHANGED' } satisfies PolicyWriteResult;
        }

        let policy: ReorderPolicyRow;
        let changeType: PolicyWriteResult['changeType'];
        if (existing) {
          const updated = await client.query<ReorderPolicyRow>(
            `
            UPDATE inventory_reorder_policies
            SET minimum_quantity = $1::numeric,
                maximum_quantity = $2::numeric,
                lead_time_days = $3,
                preferred_supplier_id = $4::uuid,
                enabled = $5,
                updated_by_user_id = $6,
                updated_at = clock_timestamp(),
                version = version + 1
            WHERE id = $7 AND tenant_id = $8 AND factory_id = $9
            RETURNING ${REORDER_POLICY_COLUMNS}
            `,
            [
              minimumQuantity, maximumQuantity, dto.lead_time_days,
              preferredSupplierId, dto.enabled, userId,
              existing.id, tenantId, factoryId,
            ],
          );
          policy = updated.rows[0]!;
          changeType = 'UPDATED';
        } else {
          const inserted = await client.query<ReorderPolicyRow>(
            `
            INSERT INTO inventory_reorder_policies (
              tenant_id, factory_id, item_id, minimum_quantity, maximum_quantity,
              lead_time_days, preferred_supplier_id, enabled,
              created_by_user_id, updated_by_user_id
            )
            VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6, $7::uuid, $8, $9, $9)
            RETURNING ${REORDER_POLICY_COLUMNS}
            `,
            [
              tenantId, factoryId, itemId, minimumQuantity, maximumQuantity,
              dto.lead_time_days, preferredSupplierId, dto.enabled, userId,
            ],
          );
          policy = inserted.rows[0]!;
          changeType = 'CREATED';
        }

        await this.insertOutboxEvent(client, {
          tenantId,
          factoryId,
          aggregateId: itemId,
          eventType: changeType === 'CREATED'
            ? 'INVENTORY.REORDER_POLICY_CREATED'
            : 'INVENTORY.REORDER_POLICY_UPDATED',
          correlationId,
          userId,
          payload: {
            policy: {
              id: policy.id,
              item_id: policy.item_id,
              minimum_quantity: policy.minimum_quantity,
              maximum_quantity: policy.maximum_quantity,
              lead_time_days: policy.lead_time_days,
              preferred_supplier_id: policy.preferred_supplier_id,
              enabled: policy.enabled,
              version: policy.version,
            },
          },
        });

        return { policy, changed: true, changeType } satisfies PolicyWriteResult;
      },
    );

    if (writeResult.changed) {
      await this.recordAuditSafely({
        tenantId,
        factoryId,
        userId,
        action: writeResult.changeType === 'CREATED'
          ? 'REORDER_POLICY_CREATE'
          : 'REORDER_POLICY_UPDATE',
        resourceId: writeResult.policy.id,
        requestId,
        traceId,
        payload: {
          item_id: itemId,
          minimum_quantity: minimumQuantity,
          maximum_quantity: maximumQuantity,
          lead_time_days: dto.lead_time_days,
          preferred_supplier_id: preferredSupplierId,
          enabled: dto.enabled,
          version: writeResult.policy.version,
        },
      });
    }

    return { policy: writeResult.policy, changed: writeResult.changed };
  }

  async getPolicy(
    tenantId: string,
    factoryId: string,
    itemId: string,
  ): Promise<ReplenishmentSignalRow> {
    this.validateReadScope(tenantId, factoryId);
    this.validateUuid(itemId, 'itemId');
    const rows = await this.querySignals(tenantId, factoryId, 1, 'POLICY', itemId);
    const row = rows[0];
    if (!row) throw new NotFoundException('Reorder policy not found for this active inventory item');
    return row;
  }

  async listShortages(
    tenantId: string,
    factoryId: string,
    limit = 50,
  ): Promise<ReplenishmentSignalRow[]> {
    this.validateReadScope(tenantId, factoryId);
    this.validateLimit(limit);
    return this.querySignals(tenantId, factoryId, limit, 'SHORTAGES', null);
  }

  async listRecommendations(
    tenantId: string,
    factoryId: string,
    limit = 50,
  ): Promise<ReplenishmentSignalRow[]> {
    this.validateReadScope(tenantId, factoryId);
    this.validateLimit(limit);
    return this.querySignals(tenantId, factoryId, limit, 'RECOMMENDATIONS', null);
  }

  private async querySignals(
    tenantId: string,
    factoryId: string,
    limit: number,
    mode: 'POLICY' | 'SHORTAGES' | 'RECOMMENDATIONS',
    itemId: string | null,
  ): Promise<ReplenishmentSignalRow[]> {
    const result = await this.database.query<ReplenishmentSignalRow>(
      `
      WITH posted_receipts AS (
        SELECT
          gl.purchase_order_line_id,
          SUM(gl.received_quantity)::numeric(18,4) AS received_quantity
        FROM goods_receipt_lines gl
        INNER JOIN goods_receipts gr
          ON gr.id = gl.goods_receipt_id
         AND gr.tenant_id = gl.tenant_id
         AND gr.factory_id = gl.factory_id
        WHERE gl.tenant_id = $1
          AND gl.factory_id = $2
          AND gr.status = 'POSTED'
        GROUP BY gl.purchase_order_line_id
      ),
      approved_po_lines AS (
        SELECT
          pol.inventory_item_id,
          GREATEST(pol.quantity - COALESCE(pr.received_quantity, 0), 0)::numeric(18,4)
            AS outstanding_quantity,
          po.expected_delivery_date
        FROM purchase_orders po
        INNER JOIN purchase_order_lines pol
          ON pol.purchase_order_id = po.id
         AND pol.tenant_id = po.tenant_id
         AND pol.factory_id = po.factory_id
        LEFT JOIN posted_receipts pr
          ON pr.purchase_order_line_id = pol.id
        WHERE po.tenant_id = $1
          AND po.factory_id = $2
          AND po.status = 'APPROVED'
          AND pol.inventory_item_id IS NOT NULL
      ),
      incoming AS (
        SELECT
          inventory_item_id,
          SUM(outstanding_quantity)::numeric(18,4) AS incoming_quantity,
          MIN(expected_delivery_date) FILTER (WHERE expected_delivery_date IS NOT NULL)
            AS next_incoming_date
        FROM approved_po_lines
        WHERE outstanding_quantity > 0
        GROUP BY inventory_item_id
      ),
      current_stock AS (
        SELECT
          rp.id AS policy_id,
          rp.tenant_id,
          rp.factory_id,
          rp.item_id,
          i.sku,
          i.name AS item_name,
          i.unit,
          rp.minimum_quantity,
          rp.maximum_quantity,
          rp.lead_time_days,
          rp.preferred_supplier_id,
          s.name AS preferred_supplier_name,
          s.status AS preferred_supplier_status,
          rp.enabled,
          rp.version AS policy_version,
          b.quantity_on_hand,
          b.quantity_reserved,
          (b.quantity_on_hand - b.quantity_reserved)::numeric(18,4) AS available_quantity,
          COALESCE(incoming.incoming_quantity, 0)::numeric(18,4) AS incoming_quantity,
          incoming.next_incoming_date
        FROM inventory_reorder_policies rp
        INNER JOIN inventory_items i
          ON i.id = rp.item_id
         AND i.tenant_id = rp.tenant_id
         AND i.factory_id = rp.factory_id
        INNER JOIN inventory_stock_balances b
          ON b.item_id = rp.item_id
         AND b.tenant_id = rp.tenant_id
         AND b.factory_id = rp.factory_id
        LEFT JOIN incoming ON incoming.inventory_item_id = rp.item_id
        LEFT JOIN suppliers s
          ON s.id = rp.preferred_supplier_id
         AND s.tenant_id = rp.tenant_id
        WHERE rp.tenant_id = $1
          AND rp.factory_id = $2
          AND (rp.enabled = TRUE OR $4::text = 'POLICY')
          AND i.status = 'ACTIVE'
      ),
      metrics AS (
        SELECT
          current_stock.*,
          (available_quantity + incoming_quantity)::numeric(18,4) AS inventory_position,
          GREATEST(minimum_quantity - available_quantity, 0)::numeric(18,4)
            AS physical_shortage_quantity,
          GREATEST(minimum_quantity - available_quantity - incoming_quantity, 0)::numeric(18,4)
            AS uncovered_shortage_quantity
        FROM current_stock
      ),
      recommendations AS (
        SELECT
          metrics.*,
          CASE
            WHEN enabled AND inventory_position <= minimum_quantity
              THEN GREATEST(maximum_quantity - inventory_position, 0)::numeric(18,4)
            ELSE 0::numeric(18,4)
          END AS recommended_order_quantity
        FROM metrics
      )
      SELECT
        policy_id::text AS policy_id,
        tenant_id::text AS tenant_id,
        factory_id::text AS factory_id,
        item_id::text AS item_id,
        sku,
        item_name,
        unit,
        minimum_quantity::text AS minimum_quantity,
        maximum_quantity::text AS maximum_quantity,
        lead_time_days,
        preferred_supplier_id::text AS preferred_supplier_id,
        preferred_supplier_name,
        preferred_supplier_status,
        enabled,
        policy_version::text AS policy_version,
        quantity_on_hand::text AS quantity_on_hand,
        quantity_reserved::text AS quantity_reserved,
        available_quantity::text AS available_quantity,
        incoming_quantity::text AS incoming_quantity,
        inventory_position::text AS inventory_position,
        physical_shortage_quantity::text AS physical_shortage_quantity,
        uncovered_shortage_quantity::text AS uncovered_shortage_quantity,
        recommended_order_quantity::text AS recommended_order_quantity,
        (enabled AND inventory_position <= minimum_quantity) AS reorder_triggered,
        CASE
          WHEN NOT enabled THEN 'NOT_REQUIRED'
          WHEN recommended_order_quantity <= 0 AND physical_shortage_quantity > 0
            THEN 'COVERED_BY_INCOMING'
          WHEN recommended_order_quantity <= 0 THEN 'NOT_REQUIRED'
          WHEN preferred_supplier_id IS NULL OR preferred_supplier_status IS DISTINCT FROM 'ACTIVE'
            THEN 'SUPPLIER_REQUIRED'
          ELSE 'REVIEW_REQUIRED'
        END AS recommendation_status,
        next_incoming_date::text AS next_incoming_date,
        (CURRENT_DATE + lead_time_days)::text AS estimated_replenishment_date
      FROM recommendations
      WHERE (
          ($4::text = 'POLICY' AND item_id = $5::uuid)
          OR ($4::text = 'SHORTAGES' AND available_quantity < minimum_quantity)
          OR ($4::text = 'RECOMMENDATIONS'
              AND inventory_position <= minimum_quantity
              AND recommended_order_quantity > 0)
        )
      ORDER BY
        CASE WHEN $4::text = 'POLICY' THEN 0 ELSE 1 END,
        uncovered_shortage_quantity DESC,
        physical_shortage_quantity DESC,
        sku ASC,
        item_id ASC
      LIMIT $3
      `,
      [tenantId, factoryId, limit, mode, itemId],
      { tenantId },
    );
    return result.rows;
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
        resourceType: 'INVENTORY_REORDER_POLICY',
        resourceId: input.resourceId,
        requestId: input.requestId && isUUID(input.requestId) ? input.requestId : null,
        correlationId: input.traceId && isUUID(input.traceId) ? input.traceId : null,
        dataClass: 'INTERNAL',
        payload: input.payload,
      });
    } catch {
      // Durable outbox evidence is committed with the policy configuration.
    }
  }

  private normalizeQuantity(value: number, field: string): string {
    if (
      !Number.isFinite(value)
      || value < 0
      || value > 99999999999999
      || Math.abs(value * 10000 - Math.round(value * 10000)) > 0.000001
    ) {
      throw new BadRequestException(
        field + ' must be a non-negative quantity with at most 4 decimal places',
      );
    }
    return value.toFixed(4);
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
}
