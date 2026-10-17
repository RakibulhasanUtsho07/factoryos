import { canTransitionPurchaseOrder, PURCHASE_ORDER_STATUSES, PurchaseOrderStatus } from './purchase-order-lifecycle';

describe('purchase-order lifecycle', () => {
  it('allows only the documented draft and submitted transitions', () => {
    expect(canTransitionPurchaseOrder('DRAFT', 'SUBMITTED')).toBe(true);
    expect(canTransitionPurchaseOrder('DRAFT', 'CANCELLED')).toBe(true);
    expect(canTransitionPurchaseOrder('SUBMITTED', 'APPROVED')).toBe(true);
    expect(canTransitionPurchaseOrder('SUBMITTED', 'REJECTED')).toBe(true);
    expect(canTransitionPurchaseOrder('SUBMITTED', 'CANCELLED')).toBe(true);
  });

  it('keeps approved, rejected and cancelled states terminal', () => {
    const terminal: PurchaseOrderStatus[] = ['APPROVED', 'REJECTED', 'CANCELLED'];
    for (const current of terminal) {
      for (const target of PURCHASE_ORDER_STATUSES) {
        expect(canTransitionPurchaseOrder(current, target)).toBe(false);
      }
    }
  });

  it('rejects skips, reverse transitions and duplicate transitions', () => {
    expect(canTransitionPurchaseOrder('DRAFT', 'APPROVED')).toBe(false);
    expect(canTransitionPurchaseOrder('DRAFT', 'REJECTED')).toBe(false);
    expect(canTransitionPurchaseOrder('SUBMITTED', 'DRAFT')).toBe(false);
    expect(canTransitionPurchaseOrder('SUBMITTED', 'SUBMITTED')).toBe(false);
    expect(canTransitionPurchaseOrder('DRAFT', 'DRAFT')).toBe(false);
  });
});
