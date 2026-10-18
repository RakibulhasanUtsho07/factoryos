import { describe, expect, it, jest } from '@jest/globals';
import type { PoolClient } from 'pg';
import { resolveFinanceOperationalSource } from './finance-operational-source';

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
    expect(mock.query).toHaveBeenCalledWith(expect.stringContaining("po.status=\\\\'APPROVED\\\\'"), [
      'tenant-1', 'factory-1', 'PO-100:2',
    ]);
  });

  it('resolves posted GRN lines to accepted quantity and the corresponding purchase rate', async () => {
    const mock = fakeClient([{ quantity: '9.5', rate: '3.25', uom_code: 'KG', currency: 'USD' }]);
    await expect(resolveFinanceOperationalSource(
      mock.client, 'tenant-1', 'factory-1', 'GOODS_RECEIPT_LINE', 'gr-line-1',
    )).resolves.toMatchObject({ quantity: '9.5', rate: '3.25', uomCode: 'KG', currency: 'USD' });
    expect(mock.query.mock.calls[0][0]).toContain("gr.status=\\\\'POSTED\\\\'");
  });

  it('resolves confirmed order lines and utility meter rate snapshots', async () => {
    const order = fakeClient([{ quantity: '12', rate: '0', uom_code: 'PCS', currency: 'BDT' }]);
    await expect(resolveFinanceOperationalSource(
      order.client, 'tenant-1', 'factory-1', 'ORDER_LINE', 'ORD-100:1',
    )).resolves.toMatchObject({ quantity: '12', rate: '0' });
    expect(order.query.mock.calls[0][0]).toContain("o.status IN (\\\\'CONFIRMED\\\\',\\\\'IN_PROGRESS\\\\',\\\\'COMPLETED\\\\')");

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
