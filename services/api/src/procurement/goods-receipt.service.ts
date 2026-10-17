import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { QueryResultRow } from 'pg';

import { DatabaseService } from '../database/database.service';
import { CreateGoodsReceiptDto } from './dto/create-goods-receipt.dto';

export interface ReceiptHeaderRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  purchase_order_id: string;
  location_id: string;
  po_number: string;
  receipt_number: string;
  status: 'POSTED';
  supplier_delivery_reference: string | null;
  received_at: string;
  notes: string | null;
  created_by_user_id: string;
  idempotency_key?: string;
  request_hash?: string;
  request_id: string | null;
  trace_id: string | null;
  correlation_id: string;
  created_at: string;
  posted_at: string;
}
export interface ReceiptLineRow extends QueryResultRow {
  id: string;
  goods_receipt_id: string;
  purchase_order_id: string;
  purchase_order_line_id: string;
  po_line_number: number;
  inventory_item_id: string | null;
  description: string;
  unit: string;
  ordered_quantity: string;
  received_quantity: string;
  rejected_quantity: string;
  accepted_quantity: string;
  rejection_reason: string | null;
  stock_quantity_after: string | null;
}
interface InputLine {
  purchase_order_line_id: string;
  received_quantity: string;
  rejected_quantity: string;
  rejection_reason: string | null;
}
interface PurchaseOrderLineRow extends QueryResultRow {
  id: string;
  line_number: number;
  inventory_item_id: string | null;
  description: string;
  unit: string;
  ordered_quantity: string;
}
interface InventoryItemRow extends QueryResultRow {
  id: string;
  status: string;
  unit: string;
}

@Injectable()
export class GoodsReceiptService {
  constructor(private readonly database: DatabaseService) {}

  async postGoodsReceipt(
    userId: string, tenantId: string, factoryId: string, purchaseOrderId: string,
    dto: CreateGoodsReceiptDto, rawIdempotencyKey: string | null,
    requestId: string | null, traceId: string | null,
  ) {
    this.validateUuid(userId, 'userId');
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');
    this.validateUuid(purchaseOrderId, 'purchaseOrderId');

    const idempotencyKey = rawIdempotencyKey?.trim() ?? '';
    if (!idempotencyKey || idempotencyKey.length > 255) {
      throw new BadRequestException('Idempotency-Key is required and must contain at most 255 characters');
    }
    if (!Array.isArray(dto.lines) || dto.lines.length === 0) {
      throw new BadRequestException('At least one goods-receipt line is required');
    }
    if (dto.lines.length > 500) throw new BadRequestException('A goods receipt cannot contain more than 500 lines');

    const locationId = dto.location_id?.trim().toLowerCase() || null;
    if (locationId) this.validateUuid(locationId, 'location_id');
    const receivedAt = dto.received_at ? new Date(dto.received_at) : null;
    if (receivedAt && !Number.isFinite(receivedAt.getTime())) {
      throw new BadRequestException('received_at must be a valid ISO date/time');
    }
    const deliveryReference = dto.supplier_delivery_reference?.trim() || null;
    const notes = dto.notes?.trim() || null;
    const inputLines: InputLine[] = dto.lines.map(line => {
      const received = line.received_quantity;
      const rejected = line.rejected_quantity ?? 0;
      if (!Number.isFinite(received) || received <= 0 || !this.hasAtMostFourDecimals(received)) {
        throw new BadRequestException('received_quantity must be positive with at most four decimal places');
      }
      if (!Number.isFinite(rejected) || rejected < 0 || !this.hasAtMostFourDecimals(rejected) || rejected > received) {
        throw new BadRequestException('rejected_quantity must be between zero and received_quantity, with at most four decimal places');
      }
      const reason = line.rejection_reason?.trim() || null;
      if (rejected > 0 && !reason) {
        throw new BadRequestException('rejection_reason is required when rejected_quantity is greater than zero');
      }
      this.validateUuid(line.purchase_order_line_id, 'purchase_order_line_id');
      return {
        purchase_order_line_id: line.purchase_order_line_id.toLowerCase(),
        received_quantity: received.toFixed(4),
        rejected_quantity: rejected.toFixed(4),
        rejection_reason: reason,
      };
    });
    if (new Set(inputLines.map(line => line.purchase_order_line_id)).size !== inputLines.length) {
      throw new BadRequestException('Each purchase-order line may appear only once per goods receipt');
    }
    inputLines.sort((a, b) => a.purchase_order_line_id.localeCompare(b.purchase_order_line_id));

    const requestHash = createHash('sha256').update(JSON.stringify({
      operation: 'GOODS_RECEIPT.POST',
      tenant_id: tenantId,
      factory_id: factoryId,
      purchase_order_id: purchaseOrderId.toLowerCase(),
      location_id: locationId,
      supplier_delivery_reference: deliveryReference,
      received_at: receivedAt?.toISOString() ?? null,
      notes,
      lines: inputLines,
    })).digest('hex');
    const requestUuid = this.uuidOrNull(requestId);
    const traceUuid = this.uuidOrNull(traceId);
    const correlationId = traceUuid ?? requestUuid ?? randomUUID();

    let receiptId: string;
    let replayed: boolean;
    try {
      const result = await this.database.transaction({
        tenantId, userId, requestId: requestUuid, traceId: traceUuid,
      }, async client => {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
          [tenantId + ':' + factoryId + ':goods-receipt:' + idempotencyKey],
        );

        const existing = await client.query<{ id: string; request_hash: string }>(`
          SELECT id::text AS id, request_hash
          FROM goods_receipts
          WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3
          FOR UPDATE
        `, [tenantId, factoryId, idempotencyKey]);
        if (existing.rows[0]) {
          if (existing.rows[0].request_hash.trim() !== requestHash) {
            throw new ConflictException('Idempotency-Key was already used for a different goods-receipt request');
          }
          return { id: existing.rows[0].id, replayed: true };
        }

        const poResult = await client.query<{ id: string; po_number: string; status: string }>(`
          SELECT id::text AS id, po_number, status
          FROM purchase_orders
          WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
          FOR UPDATE
        `, [purchaseOrderId, tenantId, factoryId]);
        const purchaseOrder = poResult.rows[0];
        if (!purchaseOrder) throw new NotFoundException('Purchase order not found in this factory');
        if (purchaseOrder.status !== 'APPROVED') {
          throw new ConflictException('Goods can only be received against an APPROVED purchase order');
        }

        const lineIds = inputLines.map(line => line.purchase_order_line_id);
        const poLinesResult = await client.query<PurchaseOrderLineRow>(`
          SELECT pol.id::text AS id, pol.line_number, pol.inventory_item_id::text AS inventory_item_id,
            pol.description, pol.unit, pol.quantity::text AS ordered_quantity
          FROM purchase_order_lines pol
          WHERE pol.tenant_id = $1 AND pol.factory_id = $2
            AND pol.purchase_order_id = $3 AND pol.id = ANY($4::uuid[])
          ORDER BY pol.line_number, pol.id
          FOR UPDATE OF pol
        `, [tenantId, factoryId, purchaseOrderId, lineIds]);
        const poLines = poLinesResult.rows;
        const poLineMap = new Map(poLines.map(line => [line.id, line]));
        if (poLineMap.size !== inputLines.length) {
          throw new BadRequestException('Every goods-receipt line must belong to the specified purchase order');
        }

        const itemIds = [...new Set(poLines.map(line => line.inventory_item_id).filter((id): id is string => id !== null))].sort();
        const itemMap = new Map<string, InventoryItemRow>();
        if (itemIds.length) {
          const items = await client.query<InventoryItemRow>(`
            SELECT id::text AS id, status, unit
            FROM inventory_items
            WHERE tenant_id = $1 AND factory_id = $2 AND id = ANY($3::uuid[])
            ORDER BY id
            FOR UPDATE
          `, [tenantId, factoryId, itemIds]);
          for (const item of items.rows) itemMap.set(item.id, item);
        }

        for (const input of inputLines) {
          const poLine = poLineMap.get(input.purchase_order_line_id)!;
          const accepted = Number(input.received_quantity) - Number(input.rejected_quantity);
          if (accepted > 0) {
            if (!poLine.inventory_item_id) {
              throw new ConflictException('Map an inventory item to each PO line before accepting stock');
            }
            const item = itemMap.get(poLine.inventory_item_id);
            if (!item || item.status !== 'ACTIVE') {
              throw new ConflictException('Accepted quantity requires an active inventory item in this factory');
            }
            if (item.unit.trim().toUpperCase() !== poLine.unit.trim().toUpperCase()) {
              throw new ConflictException('PO line unit must match its inventory item unit before stock posting');
            }
          }
          const receivedBefore = await client.query<{ quantity: string }>(`
            SELECT COALESCE(SUM(gl.received_quantity), 0)::text AS quantity
            FROM goods_receipt_lines gl
            JOIN goods_receipts gr
              ON gr.id = gl.goods_receipt_id
             AND gr.tenant_id = gl.tenant_id
             AND gr.factory_id = gl.factory_id
            WHERE gl.tenant_id = $1 AND gl.factory_id = $2
              AND gl.purchase_order_line_id = $3 AND gr.status = 'POSTED'
          `, [tenantId, factoryId, input.purchase_order_line_id]);
          const receivedTotal = Number(receivedBefore.rows[0]?.quantity ?? 0) + Number(input.received_quantity);
          if (receivedTotal > Number(poLine.ordered_quantity) + 0.0000001) {
            throw new ConflictException('Received quantity exceeds the remaining ordered quantity on PO line ' + poLine.line_number);
          }
        }

        const receiptId = randomUUID();
        const receiptNumber = 'GRN-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') +
          '-' + receiptId.slice(0, 8).toUpperCase();
        let targetLocationId: string;
        if (locationId) {
          const location = await client.query<{ id: string }>(`
            SELECT id::text AS id
            FROM inventory_locations
            WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
              AND status = 'ACTIVE' AND location_type IN ('WAREHOUSE', 'STAGING', 'BIN')
            LIMIT 1
          `, [locationId, tenantId, factoryId]);
          if (!location.rows[0]) throw new NotFoundException('Active receiving warehouse, staging area, or bin not found in this factory');
          targetLocationId = location.rows[0].id;
        } else {
          const location = await client.query<{ id: string }>(`
            SELECT id::text AS id
            FROM inventory_locations
            WHERE tenant_id = $1 AND factory_id = $2 AND is_default = TRUE AND status = 'ACTIVE'
            LIMIT 1
          `, [tenantId, factoryId]);
          if (!location.rows[0]) throw new ConflictException('The factory default inventory location is missing');
          targetLocationId = location.rows[0].id;
        }

        await client.query(
          "SELECT set_config('app.inventory_location_id', $1, TRUE)",
          [targetLocationId],
        );

        await client.query(`
          INSERT INTO goods_receipts (
            id, tenant_id, factory_id, purchase_order_id, location_id, receipt_number, status,
            supplier_delivery_reference, received_at, notes, created_by_user_id,
            idempotency_key, request_hash, request_id, trace_id, correlation_id
          ) VALUES (
            $1,$2,$3,$4,$5,$6,'POSTING',$7,COALESCE($8::timestamptz, clock_timestamp()),
            $9,$10,$11,$12,$13,$14,$15
          )
        `, [
          receiptId, tenantId, factoryId, purchaseOrderId, targetLocationId, receiptNumber,
          deliveryReference, receivedAt?.toISOString() ?? null, notes, userId, idempotencyKey,
          requestHash, requestUuid, traceUuid, correlationId,
        ]);

        const postedLines: Array<Record<string, unknown>> = [];
        for (const input of inputLines.sort((a, b) => {
          const aa = poLineMap.get(a.purchase_order_line_id)!.line_number;
          const bb = poLineMap.get(b.purchase_order_line_id)!.line_number;
          return aa - bb || a.purchase_order_line_id.localeCompare(b.purchase_order_line_id);
        })) {
          const poLine = poLineMap.get(input.purchase_order_line_id)!;
          const insertedLine = await client.query<{
            id: string; accepted_quantity: string; inventory_item_id: string | null;
          }>(`
            INSERT INTO goods_receipt_lines (
              tenant_id, factory_id, goods_receipt_id, purchase_order_id, purchase_order_line_id,
              inventory_item_id, received_quantity, rejected_quantity, rejection_reason
            ) VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8::numeric,$9)
            RETURNING id::text AS id, accepted_quantity::text AS accepted_quantity,
              inventory_item_id::text AS inventory_item_id
          `, [
            tenantId, factoryId, receiptId, purchaseOrderId, poLine.id, poLine.inventory_item_id,
            input.received_quantity, input.rejected_quantity, input.rejection_reason,
          ]);
          const line = insertedLine.rows[0];
          if (!line) throw new Error('GOODS_RECEIPT_LINE_INSERT_FAILED');

          if (Number(line.accepted_quantity) > 0) {
            const itemId = line.inventory_item_id!;
            const balance = await client.query<{ quantity_on_hand: string }>(`
              UPDATE inventory_stock_balances
              SET quantity_on_hand = quantity_on_hand + $1::numeric,
                  version = version + 1, updated_at = clock_timestamp()
              WHERE tenant_id = $2 AND factory_id = $3 AND item_id = $4
                AND quantity_on_hand + $1::numeric >= quantity_reserved
              RETURNING quantity_on_hand::text AS quantity_on_hand
            `, [line.accepted_quantity, tenantId, factoryId, itemId]);
            if (!balance.rows[0]) {
              throw new ConflictException('Stock balance is missing or cannot accept the accepted GRN quantity');
            }

            const movementKey = 'GRN:' + receiptId + ':' + poLine.id;
            const movementHash = createHash('sha256').update(JSON.stringify({
              operation: 'GOODS_RECEIPT.STOCK_POST', receipt_id: receiptId,
              purchase_order_line_id: poLine.id, item_id: itemId,
              accepted_quantity: line.accepted_quantity,
            })).digest('hex');
            await client.query(`
              INSERT INTO inventory_movements (
                tenant_id, factory_id, item_id, location_id, movement_type, quantity,
                quantity_delta, quantity_after, idempotency_key, request_hash,
                reference_type, reference_id, notes, created_by_user_id, correlation_id
              ) VALUES (
                $1,$2,$3,$4,'RECEIPT',$5::numeric,$5::numeric,$6::numeric,$7,$8,
                'GOODS_RECEIPT',$9,$10,$11,$12
              )
            `, [
              tenantId, factoryId, itemId, targetLocationId, line.accepted_quantity,
              balance.rows[0].quantity_on_hand, movementKey, movementHash,
              receiptId, 'Goods receipt ' + receiptNumber + ' for PO ' + purchaseOrder.po_number,
              userId, correlationId,
            ]);
            postedLines.push({
              purchase_order_line_id: poLine.id,
              inventory_item_id: itemId,
              received_quantity: input.received_quantity,
              rejected_quantity: input.rejected_quantity,
              accepted_quantity: line.accepted_quantity,
              quantity_after: balance.rows[0].quantity_on_hand,
            });
          } else {
            postedLines.push({
              purchase_order_line_id: poLine.id,
              inventory_item_id: line.inventory_item_id,
              received_quantity: input.received_quantity,
              rejected_quantity: input.rejected_quantity,
              accepted_quantity: line.accepted_quantity,
              quantity_after: null,
            });
          }
        }

        await client.query(`
          INSERT INTO outbox_events (
            tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
          ) VALUES ($1,$2,'GOODS_RECEIPT',$3,'PROCUREMENT.GOODS_RECEIPT_POSTED',$4::jsonb)
        `, [
          tenantId, factoryId, receiptId,
          JSON.stringify({
            goods_receipt_id: receiptId, receipt_number: receiptNumber,
            purchase_order_id: purchaseOrderId, po_number: purchaseOrder.po_number,
            supplier_delivery_reference: deliveryReference, location_id: targetLocationId,
            lines: postedLines,
          }),
        ]);
        await client.query(`
          INSERT INTO audit_events (
            tenant_id, factory_id, actor_user_id, event_type, action,
            resource_type, resource_id, correlation_id, request_id, data_class, payload
          ) VALUES (
            $1,$2,$3,'PROCUREMENT','POSTED','GOODS_RECEIPT',$4,$5,$6,'INTERNAL',$7::jsonb
          )
        `, [
          tenantId, factoryId, userId, receiptId, correlationId, requestUuid,
          JSON.stringify({
            receipt_number: receiptNumber, purchase_order_id: purchaseOrderId,
            po_number: purchaseOrder.po_number, supplier_delivery_reference: deliveryReference,
            location_id: targetLocationId, line_count: postedLines.length,
            total_received: inputLines.reduce((sum, line) => sum + Number(line.received_quantity), 0),
            total_rejected: inputLines.reduce((sum, line) => sum + Number(line.rejected_quantity), 0),
            total_accepted: inputLines.reduce((sum, line) => sum + Number(line.received_quantity) - Number(line.rejected_quantity), 0),
          }),
        ]);

        await client.query(`
          UPDATE goods_receipts SET status = 'POSTED', posted_at = clock_timestamp()
          WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 AND status = 'POSTING'
        `, [receiptId, tenantId, factoryId]);

        return { id: receiptId, replayed: false };
      });

      receiptId = result.id;
      replayed = result.replayed;
    } catch (error) {
      const code = this.errorCode(error);
      if (code === '23505') throw new ConflictException('Goods receipt conflicts with an existing receipt number, line, movement, or idempotency key');
      if (code === '23503') throw new BadRequestException('Goods receipt references a PO line, inventory item, location, or actor outside the authorized tenant/factory scope');
      if (code === '23514') throw new ConflictException((error as Error).message || 'Goods receipt violates a posting or remaining-quantity invariant');
      throw error;
    }

    const receipt = await this.getGoodsReceipt(userId, tenantId, factoryId, receiptId);
    return { ...receipt, replayed };
  }

  async getGoodsReceipt(userId: string, tenantId: string, factoryId: string, receiptId: string) {
    this.validateReadScope(userId, tenantId, factoryId);
    this.validateUuid(receiptId, 'receiptId');
    const header = await this.database.query<ReceiptHeaderRow>(`
      SELECT gr.id::text AS id, gr.tenant_id::text AS tenant_id, gr.factory_id::text AS factory_id,
        gr.purchase_order_id::text AS purchase_order_id, gr.location_id::text AS location_id,
        po.po_number, gr.receipt_number, gr.status,
        gr.supplier_delivery_reference, gr.received_at::text AS received_at, gr.notes,
        gr.created_by_user_id::text AS created_by_user_id, gr.request_id::text AS request_id,
        gr.trace_id::text AS trace_id, gr.correlation_id::text AS correlation_id,
        gr.created_at::text AS created_at, gr.posted_at::text AS posted_at
      FROM goods_receipts gr
      JOIN purchase_orders po ON po.id = gr.purchase_order_id
        AND po.tenant_id = gr.tenant_id AND po.factory_id = gr.factory_id
      WHERE gr.id = $1 AND gr.tenant_id = $2 AND gr.factory_id = $3 AND gr.status = 'POSTED'
      LIMIT 1
    `, [receiptId, tenantId, factoryId], { tenantId, userId });
    if (!header.rows[0]) throw new NotFoundException('Goods receipt not found in this factory');

    const lines = await this.database.query<ReceiptLineRow>(`
      SELECT gl.id::text AS id, gl.goods_receipt_id::text AS goods_receipt_id,
        gl.purchase_order_id::text AS purchase_order_id, gl.purchase_order_line_id::text AS purchase_order_line_id,
        pol.line_number AS po_line_number, gl.inventory_item_id::text AS inventory_item_id,
        pol.description, pol.unit, pol.quantity::text AS ordered_quantity,
        gl.received_quantity::text AS received_quantity, gl.rejected_quantity::text AS rejected_quantity,
        gl.accepted_quantity::text AS accepted_quantity, gl.rejection_reason,
        (SELECT im.quantity_after::text FROM inventory_movements im
          WHERE im.tenant_id = gl.tenant_id AND im.factory_id = gl.factory_id
            AND im.reference_type = 'GOODS_RECEIPT' AND im.reference_id = gl.goods_receipt_id
            AND im.item_id = gl.inventory_item_id
            AND im.idempotency_key = 'GRN:' || gl.goods_receipt_id::text || ':' || gl.purchase_order_line_id::text
          LIMIT 1) AS stock_quantity_after
      FROM goods_receipt_lines gl
      JOIN purchase_order_lines pol ON pol.id = gl.purchase_order_line_id
        AND pol.tenant_id = gl.tenant_id AND pol.factory_id = gl.factory_id
        AND pol.purchase_order_id = gl.purchase_order_id
      WHERE gl.goods_receipt_id = $1 AND gl.tenant_id = $2 AND gl.factory_id = $3
      ORDER BY pol.line_number, pol.id
    `, [receiptId, tenantId, factoryId], { tenantId, userId });
    return { ...header.rows[0], lines: lines.rows };
  }

  async listGoodsReceipts(userId: string, tenantId: string, factoryId: string, purchaseOrderId: string, limit = 50) {
    this.validateReadScope(userId, tenantId, factoryId);
    this.validateUuid(purchaseOrderId, 'purchaseOrderId');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be between 1 and 100');
    }
    const po = await this.database.query<{ id: string }>(`
      SELECT id::text AS id FROM purchase_orders
      WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 LIMIT 1
    `, [purchaseOrderId, tenantId, factoryId], { tenantId, userId });
    if (!po.rows[0]) throw new NotFoundException('Purchase order not found in this factory');

    const receipts = await this.database.query<ReceiptHeaderRow & {
      line_count: number; total_received: string; total_rejected: string; total_accepted: string;
    }>(`
      SELECT gr.id::text AS id, gr.tenant_id::text AS tenant_id, gr.factory_id::text AS factory_id,
        gr.purchase_order_id::text AS purchase_order_id, gr.location_id::text AS location_id,
        po.po_number, gr.receipt_number, gr.status,
        gr.supplier_delivery_reference, gr.received_at::text AS received_at, gr.notes,
        gr.created_by_user_id::text AS created_by_user_id, gr.request_id::text AS request_id,
        gr.trace_id::text AS trace_id, gr.correlation_id::text AS correlation_id,
        gr.created_at::text AS created_at, gr.posted_at::text AS posted_at,
        count(gl.id)::int AS line_count,
        COALESCE(sum(gl.received_quantity),0)::text AS total_received,
        COALESCE(sum(gl.rejected_quantity),0)::text AS total_rejected,
        COALESCE(sum(gl.accepted_quantity),0)::text AS total_accepted
      FROM goods_receipts gr
      JOIN purchase_orders po ON po.id = gr.purchase_order_id
        AND po.tenant_id = gr.tenant_id AND po.factory_id = gr.factory_id
      LEFT JOIN goods_receipt_lines gl ON gl.goods_receipt_id = gr.id
        AND gl.tenant_id = gr.tenant_id AND gl.factory_id = gr.factory_id
      WHERE gr.tenant_id = $1 AND gr.factory_id = $2 AND gr.purchase_order_id = $3 AND gr.status = 'POSTED'
      GROUP BY gr.id, po.po_number
      ORDER BY gr.created_at DESC, gr.id DESC
      LIMIT $4
    `, [tenantId, factoryId, purchaseOrderId, limit], { tenantId, userId });
    return { purchase_order_id: purchaseOrderId, receipts: receipts.rows };
  }

  private validateUuid(value: string, field: string) {
    if (!isUUID(value)) throw new BadRequestException(field + ' must be a UUID');
  }
  private validateReadScope(userId: string, tenantId: string, factoryId: string) {
    this.validateUuid(userId, 'userId');
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');
  }
  private uuidOrNull(value: string | null | undefined) {
    return value && isUUID(value) ? value : null;
  }
  private hasAtMostFourDecimals(value: number) {
    return Math.abs(value * 10000 - Math.round(value * 10000)) < 0.000001;
  }
  private errorCode(error: unknown): string | undefined {
    if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
    return String((error as { code?: unknown }).code ?? '');
  }
}
