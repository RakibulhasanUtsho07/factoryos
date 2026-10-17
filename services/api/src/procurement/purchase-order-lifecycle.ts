export const PURCHASE_ORDER_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const;

export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];
export type SupplierStatus = 'ACTIVE' | 'DISABLED';

const PURCHASE_ORDER_TRANSITIONS: Record<PurchaseOrderStatus, readonly PurchaseOrderStatus[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: [],
  REJECTED: [],
  CANCELLED: [],
};

export function canTransitionPurchaseOrder(
  current: PurchaseOrderStatus,
  target: PurchaseOrderStatus,
): boolean {
  return PURCHASE_ORDER_TRANSITIONS[current].includes(target);
}
