import { describe, expect, it, jest } from '@jest/globals';
import type { PoolClient } from 'pg';
import { assertFinanceOperationalSourceMatches, resolveFinanceOperationalSource } from './finance-operational-source';

function fakeClient(rows: Array<Record<string, unknown>>) {
  const query = jest.fn(async (_sql: string, _params: unknown[]) => ({ rows, rowCount: rows.length }));
  return { client: { query } as unknown as PoolClient, query };
}

describe('finance operational source resolver', () => {
  it('resolves an approved purchase-order line using tenant/factory-scoped SQL parameters', async () => {
    const mock = fakeClient([{ quantity: '20.0000', rate: '12.5000', uom_code: 'PCS', currency: 'bdt' }]);
    const result = await resolveFinanceOperationalSource(
      mock.client, 'tenant-1', 'factory-1', 'PURCHASE_ORDER_LINE', 'PO-100:2',
    );
    expect(result).toEqual({ quantity: '20', rate: '12.5', uomCode: 'PCS', currency: 'BDT' });
    expect(mock.query).toHaveBeenCalledWith(expect.stringContaining("po.status='APPROVED'"), [
      'tenant-1', 'factory-1', 'PO-100:2',
    ]);
  });

  it('resolves posted GRN lines to accepted quantity and the corresponding purchase rate', async () => {
    const mock = fakeClient([{ quantity: '9.5', rate: '3.25', uom_code: 'KG', currency: 'USD' }]);
    await expect(resolveFinanceOperationalSource(
      mock.client, 'tenant-1', 'factory-1', 'GOODS_RECEIPT_LINE', 'gr-line-1',
    )).resolves.toMatchObject({ quantity: '9.5', rate: '3.25', uomCode: 'KG', currency: 'USD' });
    expect(mock.query.mock.calls[0][0]).toContain("gr.status='POSTED'");
  });

  it('returns canonical supplier code for a posted GRN line and excludes rejected-only lines', async () => {
    const mock = fakeClient([{
      quantity: '9.5', rate: '3.25', uom_code: 'kg', currency: 'usd', supplier_code: 'sup-001',
    }]);
    await expect(resolveFinanceOperationalSource(
      mock.client, 'tenant-1', 'factory-1', 'GOODS_RECEIPT_LINE', 'gr-line-1',
    )).resolves.toEqual({
      quantity: '9.5', rate: '3.25', uomCode: 'KG', currency: 'USD', supplierCode: 'SUP-001',
    });
    const sql = mock.query.mock.calls[0][0];
    expect(sql).toContain('JOIN suppliers s ON s.id=po.supplier_id AND s.tenant_id=po.tenant_id');
    expect(sql).toContain("gr.status='POSTED'");
    expect(sql).toContain("po.status='APPROVED'");
    expect(sql).toContain('grl.accepted_quantity>0');
  });

  it('resolves work-order material consumption only through direct posted-GRN and approved-PO provenance', async () => {
    const mock = fakeClient([{ quantity: '2.5000', rate: '18.7500', uom_code: 'kg', currency: 'bdt' }]);
    await expect(resolveFinanceOperationalSource(
      mock.client, 'tenant-1', 'factory-1', 'WORK_ORDER_MATERIAL_CONSUMPTION', 'consumption-allocation-1',
    )).resolves.toEqual({ quantity: '2.5', rate: '18.75', uomCode: 'KG', currency: 'BDT' });
    const [sql, params] = mock.query.mock.calls[0];
    expect(params).toEqual(['tenant-1', 'factory-1', 'consumption-allocation-1']);
    for (const fragment of [
      'inventory_reservation_consumption_traceability_allocations ca',
      'inventory_reservation_consumptions c',
      'work_order_material_reservations mr',
      'traceability_units tu',
      'goods_receipt_lines grl',
      "gr.status='POSTED'",
      'gr.posted_at IS NOT NULL',
      'purchase_order_lines pol',
      "po.status='APPROVED'",
      'ca.id::text=$3',
      "tu.product_role='MATERIAL'",
      "tu.unit_type IN ('LOT','SERIAL')",
      'ca.quantity<=c.quantity',
      'ca.quantity<=tu.quantity',
      'pol.inventory_item_id=grl.inventory_item_id',
      'upper(tu.unit)=upper(pol.unit)',
    ]) expect(sql).toContain(fragment);
  });

  it('fails closed when consumed material has no direct posted-GRN rate source', async () => {
    const unbacked = fakeClient([]);
    await expect(resolveFinanceOperationalSource(
      unbacked.client, 'tenant-1', 'factory-1', 'WORK_ORDER_MATERIAL_CONSUMPTION', 'unbacked-allocation',
    )).rejects.toThrow('was not found or is not approved/posted in this factory');
  });

  it('resolves only a live, unreversed utility work-order allocation', async () => {
    const allocation = fakeClient([{ quantity: '8.25', rate: '0.125', uom_code: 'KWH', currency: 'BDT' }]);
    await expect(resolveFinanceOperationalSource(
      allocation.client, 'tenant-1', 'factory-1', 'UTILITY_WORK_ORDER_COST_ALLOCATION',
      '7b9c7247-1c4f-44eb-8b62-8d1ae4f3ee3a',
    )).resolves.toEqual({ quantity: '8.25', rate: '0.125', uomCode: 'KWH', currency: 'BDT' });
    const sql = allocation.query.mock.calls[0][0];
    expect(sql).toContain('utility_reading_work_order_cost_allocations');
    expect(sql).toContain("a.allocation_kind='ALLOCATE'");
    expect(sql).toContain('rev.reverses_allocation_id=a.id');
    expect(sql).toContain('r.currency_code_snapshot IS NOT NULL');
    const reversed = fakeClient([]);
    await expect(resolveFinanceOperationalSource(
      reversed.client, 'tenant-1', 'factory-1', 'UTILITY_WORK_ORDER_COST_ALLOCATION',
      '7b9c7247-1c4f-44eb-8b62-8d1ae4f3ee3a',
    )).rejects.toThrow('was not found');
  });

  it('resolves confirmed order lines and utility meter rate snapshots', async () => {
    const order = fakeClient([{ quantity: '12', rate: '0', uom_code: 'PCS', currency: 'BDT' }]);
    await expect(resolveFinanceOperationalSource(
      order.client, 'tenant-1', 'factory-1', 'ORDER_LINE', 'ORD-100:1',
    )).resolves.toMatchObject({ quantity: '12', rate: '0' });
    expect(order.query.mock.calls[0][0]).toContain("o.status IN ('CONFIRMED','IN_PROGRESS','COMPLETED')");

    const utility = fakeClient([{ quantity: '40.12500000', rate: '0.08000000', uom_code: 'KWH', currency: 'BDT' }]);
    await expect(resolveFinanceOperationalSource(
      utility.client, 'tenant-1', 'factory-1', 'UTILITY_METER_READING', 'METER_GATEWAY:event-7',
    )).resolves.toMatchObject({ quantity: '40.125', rate: '0.08', uomCode: 'KWH' });
    expect(utility.query.mock.calls[0][0]).toContain('utility_meter_readings');
  });

  it('rejects missing, ambiguous and incomplete operational source evidence', async () => {
    const missing = fakeClient([]);
    await expect(resolveFinanceOperationalSource(
      missing.client, 'tenant-1', 'factory-1', 'PURCHASE_ORDER_LINE', 'PO-NOT-FOUND:1',
    )).rejects.toThrow('was not found');

    const ambiguous = fakeClient([
      { quantity: '1', rate: '1', uom_code: 'PCS', currency: 'BDT' },
      { quantity: '1', rate: '1', uom_code: 'PCS', currency: 'BDT' },
    ]);
    await expect(resolveFinanceOperationalSource(
      ambiguous.client, 'tenant-1', 'factory-1', 'ORDER_LINE', 'DUPLICATE',
    )).rejects.toThrow('is ambiguous');

    const incomplete = fakeClient([{ quantity: '1', rate: null, uom_code: 'PCS', currency: 'BDT' }]);
    await expect(resolveFinanceOperationalSource(
      incomplete.client, 'tenant-1', 'factory-1', 'UTILITY_METER_READING', 'reading-1',
    )).rejects.toThrow('must expose quantity, rate, UOM and currency');
  });
});

describe('finance operational source assertions', () => {
  const evidence = { quantity: '9.5', rate: '3.25', uomCode: 'KG', currency: 'USD' };

  it('accepts exact source values only when currency, quantity, rate and UOM agree', () => {
    expect(() => assertFinanceOperationalSourceMatches('USD', '9.5000', '3.2500', 'kg', evidence)).not.toThrow();
    expect(() => assertFinanceOperationalSourceMatches('BDT', '9.5', '3.25', 'KG', evidence))
      .toThrow('must match the operational source currency');
    expect(() => assertFinanceOperationalSourceMatches('USD', '9.4', '3.25', 'KG', evidence))
      .toThrow('must match the current governed operational source record');
    expect(() => assertFinanceOperationalSourceMatches('USD', '9.5', '3.26', 'KG', evidence))
      .toThrow('must match the current governed operational source record');
    expect(() => assertFinanceOperationalSourceMatches('USD', '9.5', '3.25', 'PCS', evidence))
      .toThrow('must match the current governed operational source record');
  });
});
