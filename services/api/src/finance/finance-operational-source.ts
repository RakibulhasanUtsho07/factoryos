import { BadRequestException } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import {
  normalizeFinanceCurrency,
  normalizeFinanceDecimal,
  type FinanceReconciliationSourceType,
} from './finance-contract';

export interface FinanceOperationalSourceEvidence {
  quantity: string;
  rate: string;
  uomCode: string;
  currency: string;
  supplierCode?: string | null;
}
interface OperationalSourceRow extends QueryResultRow {
  quantity: string | null;
  rate: string | null;
  uom_code: string | null;
  currency: string | null;
  supplier_code?: string | null;
}

export async function resolveFinanceOperationalSource(
  client: PoolClient,
  tenantId: string,
  factoryId: string,
  sourceType: FinanceReconciliationSourceType,
  sourceRef: string,
): Promise<FinanceOperationalSourceEvidence> {
  const normalizedRef = sourceRef.trim();
  if (!normalizedRef || normalizedRef.length > 240) {
    throw new BadRequestException('expected_source_ref must identify a supported in-scope operational record');
  }

  let query: string;
  switch (sourceType) {
    case 'ORDER_LINE':
      query =
        'SELECT ol.quantity::text AS quantity,ol.unit_price::text AS rate,upper(ol.unit) AS uom_code,upper(o.currency) AS currency ' +
        'FROM order_lines ol JOIN orders o ON o.id=ol.order_id AND o.tenant_id=ol.tenant_id ' +
        'WHERE ol.tenant_id=$1 AND o.factory_id=$2 AND (ol.id::text=$3 OR (o.order_number || \':\' || ol.line_number::text)=$3) ' +
        'AND o.status IN (\'CONFIRMED\',\'IN_PROGRESS\',\'COMPLETED\') AND ol.unit_price IS NOT NULL LIMIT 2';
      break;
    case 'PURCHASE_ORDER_LINE':
      query =
        'SELECT pol.quantity::text AS quantity,pol.unit_price::text AS rate,upper(pol.unit) AS uom_code,upper(po.currency) AS currency ' +
        'FROM purchase_order_lines pol JOIN purchase_orders po ON po.id=pol.purchase_order_id AND po.tenant_id=pol.tenant_id AND po.factory_id=pol.factory_id ' +
        'WHERE pol.tenant_id=$1 AND pol.factory_id=$2 AND (pol.id::text=$3 OR (po.po_number || \':\' || pol.line_number::text)=$3) ' +
        'AND po.status=\'APPROVED\' LIMIT 2';
      break;
    case 'GOODS_RECEIPT_LINE':
      query =
        'SELECT grl.accepted_quantity::text AS quantity,pol.unit_price::text AS rate,upper(pol.unit) AS uom_code,upper(po.currency) AS currency,upper(s.code) AS supplier_code ' +
        'FROM goods_receipt_lines grl JOIN goods_receipts gr ON gr.id=grl.goods_receipt_id AND gr.tenant_id=grl.tenant_id AND gr.factory_id=grl.factory_id ' +
        'JOIN purchase_order_lines pol ON pol.id=grl.purchase_order_line_id AND pol.tenant_id=grl.tenant_id AND pol.factory_id=grl.factory_id AND pol.purchase_order_id=grl.purchase_order_id ' +
        'JOIN purchase_orders po ON po.id=pol.purchase_order_id AND po.tenant_id=pol.tenant_id AND po.factory_id=pol.factory_id ' +
        'JOIN suppliers s ON s.id=po.supplier_id AND s.tenant_id=po.tenant_id ' +
        'WHERE grl.tenant_id=$1 AND grl.factory_id=$2 AND grl.accepted_quantity>0 AND gr.status=\'POSTED\' AND po.status=\'APPROVED\' ' +
        'AND (grl.id::text=$3 OR (gr.receipt_number || \':\' || po.po_number || \':\' || pol.line_number::text)=$3) LIMIT 2';
      break;
    case 'WORK_ORDER_MATERIAL_CONSUMPTION':
      // The ref is one immutable WMS consumption-to-traceability allocation UUID.
      // Cost rate is deliberately limited to its direct posted-GRN / approved-PO source.
      // Transformed or merged identities without a direct GRN line fail closed.
      query =
        'SELECT ca.quantity::text AS quantity,pol.unit_price::text AS rate,upper(pol.unit) AS uom_code,upper(po.currency) AS currency ' +
        'FROM inventory_reservation_consumption_traceability_allocations ca ' +
        'JOIN inventory_reservation_consumptions c ON c.id=ca.consumption_id AND c.tenant_id=ca.tenant_id AND c.factory_id=ca.factory_id ' +
        'JOIN work_order_material_reservations mr ON mr.reservation_id=c.reservation_id AND mr.tenant_id=c.tenant_id AND mr.factory_id=c.factory_id AND mr.item_id=c.item_id ' +
        'JOIN traceability_units tu ON tu.id=ca.traceability_unit_id AND tu.tenant_id=ca.tenant_id AND tu.factory_id=ca.factory_id AND tu.inventory_item_id=c.item_id ' +
        'JOIN goods_receipt_lines grl ON grl.id=tu.goods_receipt_line_id AND grl.tenant_id=tu.tenant_id AND grl.factory_id=tu.factory_id AND grl.goods_receipt_id=tu.goods_receipt_id AND grl.inventory_item_id=tu.inventory_item_id ' +
        'JOIN goods_receipts gr ON gr.id=grl.goods_receipt_id AND gr.tenant_id=grl.tenant_id AND gr.factory_id=grl.factory_id AND gr.status=\'POSTED\' AND gr.posted_at IS NOT NULL ' +
        'JOIN purchase_order_lines pol ON pol.id=grl.purchase_order_line_id AND pol.tenant_id=grl.tenant_id AND pol.factory_id=grl.factory_id AND pol.purchase_order_id=grl.purchase_order_id ' +
        'JOIN purchase_orders po ON po.id=pol.purchase_order_id AND po.tenant_id=pol.tenant_id AND po.factory_id=pol.factory_id ' +
        'WHERE ca.tenant_id=$1 AND ca.factory_id=$2 AND ca.id::text=$3 ' +
        'AND mr.work_order_id IS NOT NULL AND tu.product_role=\'MATERIAL\' AND tu.unit_type IN (\'LOT\',\'SERIAL\') ' +
        'AND tu.goods_receipt_line_id IS NOT NULL AND c.quantity>0 AND ca.quantity<=c.quantity AND ca.quantity<=tu.quantity ' +
        'AND pol.inventory_item_id=grl.inventory_item_id AND pol.unit_price IS NOT NULL ' +
        'AND upper(tu.unit)=upper(pol.unit) AND po.status=\'APPROVED\' LIMIT 2';
      break;
    case 'UTILITY_METER_READING':
      query =
        'SELECT r.consumption_quantity::text AS quantity,r.unit_cost_snapshot::text AS rate,upper(r.unit_code) AS uom_code,upper(r.currency_code_snapshot) AS currency ' +
        'FROM utility_meter_readings r JOIN utility_meters m ON m.id=r.meter_id AND m.tenant_id=r.tenant_id AND m.factory_id=r.factory_id ' +
        'WHERE r.tenant_id=$1 AND r.factory_id=$2 AND (r.id::text=$3 OR (r.source_event_id IS NOT NULL AND (r.source_type || \':\' || r.source_event_id)=$3)) LIMIT 2';
      break;
    case 'UTILITY_WORK_ORDER_COST_ALLOCATION':
      query =
        'SELECT a.allocated_quantity::text AS quantity,a.unit_cost_snapshot::text AS rate,upper(a.unit_code) AS uom_code,upper(a.currency_code) AS currency ' +
        'FROM utility_reading_work_order_cost_allocations a ' +
        'JOIN utility_meter_readings r ON r.id=a.reading_id AND r.tenant_id=a.tenant_id AND r.factory_id=a.factory_id ' +
        'JOIN work_orders wo ON wo.id=a.work_order_id AND wo.tenant_id=a.tenant_id AND wo.factory_id=a.factory_id ' +
        'WHERE a.tenant_id=$1 AND a.factory_id=$2 AND a.id::text=$3 AND a.allocation_kind=\'ALLOCATE\' ' +
        'AND NOT EXISTS (SELECT 1 FROM utility_reading_work_order_cost_allocations rev ' +
        'WHERE rev.reverses_allocation_id=a.id AND rev.tenant_id=a.tenant_id AND rev.factory_id=a.factory_id) ' +
        'AND r.currency_code_snapshot IS NOT NULL LIMIT 2';
      break;
    default: {
      const neverType: never = sourceType;
      throw new BadRequestException('Unsupported operational reconciliation source: ' + neverType);
    }
  }

  const result = await client.query<OperationalSourceRow>(query, [tenantId, factoryId, normalizedRef]);
  if (result.rows.length !== 1) {
    throw new BadRequestException(
      'Expected operational source ' + sourceType + ':' + normalizedRef +
      (result.rows.length > 1 ? ' is ambiguous' : ' was not found or is not approved/posted in this factory'),
    );
  }
  const row = result.rows[0];
  if (row.quantity === null || row.rate === null || !row.uom_code || !row.currency) {
    throw new BadRequestException('Operational source must expose quantity, rate, UOM and currency before reconciliation');
  }
  try {
    return {
      quantity: normalizeFinanceDecimal(row.quantity),
      rate: normalizeFinanceDecimal(row.rate),
      uomCode: row.uom_code.trim().toUpperCase(),
      currency: normalizeFinanceCurrency(row.currency),
      ...(row.supplier_code ? { supplierCode: row.supplier_code.trim().toUpperCase() } : {}),
    };
  } catch {
    throw new BadRequestException('Operational source returned invalid financial reconciliation evidence');
  }
}

export function assertFinanceOperationalSourceMatches(
  factCurrency: string,
  expectedQuantity: string,
  expectedRate: string,
  expectedUomCode: string,
  evidence: FinanceOperationalSourceEvidence,
): void {
  if (normalizeFinanceCurrency(factCurrency) !== evidence.currency) {
    throw new BadRequestException(
      'Financial fact currency must match the operational source currency (' + evidence.currency +
      '); convert the source amount explicitly before ingestion',
    );
  }
  if (
    normalizeFinanceDecimal(expectedQuantity) !== evidence.quantity ||
    normalizeFinanceDecimal(expectedRate) !== evidence.rate ||
    expectedUomCode.trim().toUpperCase() !== evidence.uomCode
  ) {
    throw new BadRequestException(
      'Expected reconciliation quantity, rate and UOM must match the current governed operational source record',
    );
  }
}
