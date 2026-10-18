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
}
interface OperationalSourceRow extends QueryResultRow {
  quantity: string | null;
  rate: string | null;
  uom_code: string | null;
  currency: string | null;
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
        'WHERE ol.tenant_id=$1 AND o.factory_id=$2 AND (ol.id::text=$3 OR (o.order_number || \\':\\' || ol.line_number::text)=$3) ' +
        'AND o.status IN (\\'CONFIRMED\\',\\'IN_PROGRESS\\',\\'COMPLETED\\') AND ol.unit_price IS NOT NULL LIMIT 2';
      break;
    case 'PURCHASE_ORDER_LINE':
      query =
        'SELECT pol.quantity::text AS quantity,pol.unit_price::text AS rate,upper(pol.unit) AS uom_code,upper(po.currency) AS currency ' +
        'FROM purchase_order_lines pol JOIN purchase_orders po ON po.id=pol.purchase_order_id AND po.tenant_id=pol.tenant_id AND po.factory_id=pol.factory_id ' +
        'WHERE pol.tenant_id=$1 AND pol.factory_id=$2 AND (pol.id::text=$3 OR (po.po_number || \\':\\' || pol.line_number::text)=$3) ' +
        'AND po.status=\\'APPROVED\\' LIMIT 2';
      break;
    case 'GOODS_RECEIPT_LINE':
      query =
        'SELECT grl.accepted_quantity::text AS quantity,pol.unit_price::text AS rate,upper(pol.unit) AS uom_code,upper(po.currency) AS currency ' +
        'FROM goods_receipt_lines grl JOIN goods_receipts gr ON gr.id=grl.goods_receipt_id AND gr.tenant_id=grl.tenant_id AND gr.factory_id=grl.factory_id ' +
        'JOIN purchase_order_lines pol ON pol.id=grl.purchase_order_line_id AND pol.tenant_id=grl.tenant_id AND pol.factory_id=grl.factory_id AND pol.purchase_order_id=grl.purchase_order_id ' +
        'JOIN purchase_orders po ON po.id=pol.purchase_order_id AND po.tenant_id=pol.tenant_id AND po.factory_id=pol.factory_id ' +
        'WHERE grl.tenant_id=$1 AND grl.factory_id=$2 AND gr.status=\\'POSTED\\' AND po.status=\\'APPROVED\\' ' +
        'AND (grl.id::text=$3 OR (gr.receipt_number || \\':\\' || po.po_number || \\':\\' || pol.line_number::text)=$3) LIMIT 2';
      break;
    case 'UTILITY_METER_READING':
      query =
        'SELECT r.consumption_quantity::text AS quantity,r.unit_cost_snapshot::text AS rate,upper(r.unit_code) AS uom_code,upper(m.currency_code) AS currency ' +
        'FROM utility_meter_readings r JOIN utility_meters m ON m.id=r.meter_id AND m.tenant_id=r.tenant_id AND m.factory_id=r.factory_id ' +
        'WHERE r.tenant_id=$1 AND r.factory_id=$2 AND (r.id::text=$3 OR (r.source_event_id IS NOT NULL AND (r.source_type || \\':\\' || r.source_event_id)=$3)) LIMIT 2';
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
    };
  } catch {
    throw new BadRequestException('Operational source returned invalid financial reconciliation evidence');
  }
}
