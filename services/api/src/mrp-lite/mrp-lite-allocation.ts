export interface MrpAllocationDemand {
  requirementId: string;
  orderId: string;
  orderLineId: string;
  orderNumber: string;
  orderDate: string;
  lineNumber: number;
  bomLineNumber: number;
  componentItemId: string;
  needByDate: string;
  requiredQuantity: string;
}

export interface MrpStockPosition {
  onHandQuantity: string;
  reservedQuantity: string;
}

export interface MrpIncomingSupply {
  id: string;
  itemId: string;
  purchaseOrderNumber: string;
  expectedDeliveryDate: string | null;
  remainingQuantity: string;
  eligibleForAllocation: boolean;
}

export interface MrpAllocationResult {
  requirementId: string;
  onHandQuantity: string;
  allocatedQuantity: string;
  availableOnHandQuantity: string;
  incomingQuantity: string;
  plannedOnHandAllocationQuantity: string;
  plannedIncomingAllocationQuantity: string;
  availableByNeedDateQuantity: string;
  shortageQuantity: string;
  shortageDate: string | null;
  projectedAvailableDate: string | null;
  allocationStatus: 'COVERED' | 'LATE_SUPPLY' | 'UNSUPPLIED';
}

const SCALE = 10_000n;

function parseQuantity(value: string, field: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(value)) {
    throw new Error(`${field} must be a non-negative decimal with at most four places`);
  }
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt((fraction + '0000').slice(0, 4));
}

function formatQuantity(value: bigint): string {
  if (value < 0n) throw new Error('Quantity arithmetic produced a negative result');
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(4, '0');
  return `${whole.toString()}.${fraction}`;
}

function minQuantity(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function demandOrder(left: MrpAllocationDemand, right: MrpAllocationDemand): number {
  return left.needByDate.localeCompare(right.needByDate)
    || left.orderDate.localeCompare(right.orderDate)
    || left.orderNumber.localeCompare(right.orderNumber)
    || left.lineNumber - right.lineNumber
    || left.bomLineNumber - right.bomLineNumber
    || left.orderLineId.localeCompare(right.orderLineId)
    || left.requirementId.localeCompare(right.requirementId);
}

function supplyOrder(left: MrpIncomingSupply, right: MrpIncomingSupply): number {
  return (left.expectedDeliveryDate ?? '9999-12-31').localeCompare(right.expectedDeliveryDate ?? '9999-12-31')
    || left.purchaseOrderNumber.localeCompare(right.purchaseOrderNumber)
    || left.id.localeCompare(right.id);
}

/**
 * Allocates advisory material availability in strict due-date FIFO order.
 * Only eligible, dated supply can satisfy a date. Late dated supply may explain
 * a projected recovery date, but never masks a shortage on the required date.
 * This is a pure planner: it does not mutate inventory or purchase orders.
 */
export function allocateMrpRequirements(
  demands: readonly MrpAllocationDemand[],
  stockByItem: ReadonlyMap<string, MrpStockPosition>,
  incomingSupply: readonly MrpIncomingSupply[],
  planningStartDate: string,
): MrpAllocationResult[] {
  const sortedDemands = [...demands].sort(demandOrder);
  const remainingStock = new Map<string, bigint>();
  const stockSnapshot = new Map<string, { onHand: bigint; reserved: bigint; free: bigint }>();

  for (const demand of sortedDemands) {
    if (!stockSnapshot.has(demand.componentItemId)) {
      const source = stockByItem.get(demand.componentItemId) ?? {
        onHandQuantity: '0.0000',
        reservedQuantity: '0.0000',
      };
      const onHand = parseQuantity(source.onHandQuantity, 'onHandQuantity');
      const reserved = parseQuantity(source.reservedQuantity, 'reservedQuantity');
      const free = onHand > reserved ? onHand - reserved : 0n;
      stockSnapshot.set(demand.componentItemId, { onHand, reserved, free });
      remainingStock.set(demand.componentItemId, free);
    }
  }

  const supply = incomingSupply
    .map((entry) => ({ ...entry, remaining: parseQuantity(entry.remainingQuantity, 'remainingQuantity') }))
    .sort(supplyOrder);
  const totalIncomingByItem = new Map<string, bigint>();
  for (const entry of supply) {
    totalIncomingByItem.set(entry.itemId, (totalIncomingByItem.get(entry.itemId) ?? 0n) + entry.remaining);
  }

  const results: MrpAllocationResult[] = [];
  for (const demand of sortedDemands) {
    const required = parseQuantity(demand.requiredQuantity, 'requiredQuantity');
    const position = stockSnapshot.get(demand.componentItemId) ?? { onHand: 0n, reserved: 0n, free: 0n };
    let remaining = required;
    let stockAllocated = 0n;
    let timelyIncomingAllocated = 0n;
    let lateIncomingAllocated = 0n;

    const freeStock = remainingStock.get(demand.componentItemId) ?? 0n;
    stockAllocated = minQuantity(remaining, freeStock);
    remaining -= stockAllocated;
    remainingStock.set(demand.componentItemId, freeStock - stockAllocated);

    for (const bucket of supply) {
      if (remaining === 0n) break;
      if (bucket.itemId !== demand.componentItemId || bucket.remaining === 0n || !bucket.eligibleForAllocation) continue;
      if (!bucket.expectedDeliveryDate || bucket.expectedDeliveryDate < planningStartDate
        || bucket.expectedDeliveryDate > demand.needByDate) continue;
      const take = minQuantity(remaining, bucket.remaining);
      bucket.remaining -= take;
      remaining -= take;
      timelyIncomingAllocated += take;
    }

    const availableByNeedDate = stockAllocated + timelyIncomingAllocated;
    const shortageAtNeedDate = remaining;
    let projectedDate: string | null = null;
    let futureShortage = remaining;

    if (futureShortage > 0n) {
      for (const bucket of supply) {
        if (futureShortage === 0n) break;
        if (bucket.itemId !== demand.componentItemId || bucket.remaining === 0n || !bucket.eligibleForAllocation) continue;
        if (!bucket.expectedDeliveryDate || bucket.expectedDeliveryDate <= demand.needByDate) continue;
        const take = minQuantity(futureShortage, bucket.remaining);
        bucket.remaining -= take;
        futureShortage -= take;
        lateIncomingAllocated += take;
        projectedDate = bucket.expectedDeliveryDate;
      }
      if (futureShortage > 0n) projectedDate = null;
    }

    const status: MrpAllocationResult['allocationStatus'] = shortageAtNeedDate === 0n
      ? 'COVERED'
      : futureShortage === 0n
        ? 'LATE_SUPPLY'
        : 'UNSUPPLIED';

    results.push({
      requirementId: demand.requirementId,
      onHandQuantity: formatQuantity(position.onHand),
      allocatedQuantity: formatQuantity(position.reserved),
      availableOnHandQuantity: formatQuantity(position.free),
      incomingQuantity: formatQuantity(totalIncomingByItem.get(demand.componentItemId) ?? 0n),
      plannedOnHandAllocationQuantity: formatQuantity(stockAllocated),
      plannedIncomingAllocationQuantity: formatQuantity(timelyIncomingAllocated + lateIncomingAllocated),
      availableByNeedDateQuantity: formatQuantity(availableByNeedDate),
      shortageQuantity: formatQuantity(shortageAtNeedDate),
      shortageDate: shortageAtNeedDate > 0n ? demand.needByDate : null,
      projectedAvailableDate: status === 'LATE_SUPPLY' ? projectedDate : null,
      allocationStatus: status,
    });
  }

  return results;
}
