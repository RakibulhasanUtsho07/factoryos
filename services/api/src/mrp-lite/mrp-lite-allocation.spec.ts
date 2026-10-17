import { allocateMrpRequirements, type MrpAllocationDemand, type MrpIncomingSupply, type MrpStockPosition } from './mrp-lite-allocation';

function demand(overrides: Partial<MrpAllocationDemand> = {}): MrpAllocationDemand {
  return {
    requirementId: 'req-1',
    orderId: 'order-1',
    orderLineId: 'line-1',
    orderNumber: 'SO-001',
    orderDate: '2026-10-01',
    lineNumber: 1,
    bomLineNumber: 1,
    componentItemId: 'material-a',
    needByDate: '2026-10-20',
    requiredQuantity: '5.0000',
    ...overrides,
  };
}

function supply(overrides: Partial<MrpIncomingSupply> = {}): MrpIncomingSupply {
  return {
    id: 'supply-1',
    itemId: 'material-a',
    purchaseOrderNumber: 'PO-001',
    expectedDeliveryDate: '2026-10-20',
    remainingQuantity: '3.0000',
    eligibleForAllocation: true,
    ...overrides,
  };
}

describe('allocateMrpRequirements', () => {
  it('allocates shared on-hand and due-date supply in due-date FIFO order', () => {
    const result = allocateMrpRequirements(
      [
        demand({ requirementId: 'later', orderId: 'order-later', orderLineId: 'line-later', orderNumber: 'SO-002', needByDate: '2026-10-22' }),
        demand({ requirementId: 'earlier', needByDate: '2026-10-20' }),
      ],
      new Map<string, MrpStockPosition>([['material-a', { onHandQuantity: '7.0000', reservedQuantity: '0.0000' }]]),
      [supply({ expectedDeliveryDate: '2026-10-22', remainingQuantity: '3.0000' })],
    );

    expect(result.map((row) => row.requirementId)).toEqual(['earlier', 'later']);
    expect(result[0]).toMatchObject({
      plannedOnHandAllocationQuantity: '5.0000',
      plannedIncomingAllocationQuantity: '0.0000',
      shortageQuantity: '0.0000',
      allocationStatus: 'COVERED',
    });
    expect(result[1]).toMatchObject({
      plannedOnHandAllocationQuantity: '2.0000',
      plannedIncomingAllocationQuantity: '3.0000',
      availableByNeedDateQuantity: '5.0000',
      shortageQuantity: '0.0000',
      allocationStatus: 'COVERED',
    });
  });

  it('reports a shortage on the required date even when a later PO date explains recovery', () => {
    const result = allocateMrpRequirements(
      [demand({ requiredQuantity: '10.0000', needByDate: '2026-10-30' })],
      new Map<string, MrpStockPosition>([['material-a', { onHandQuantity: '2.0000', reservedQuantity: '0.0000' }]]),
      [supply({ expectedDeliveryDate: '2026-11-02', remainingQuantity: '8.0000' })],
    );

    expect(result[0]).toMatchObject({
      availableByNeedDateQuantity: '2.0000',
      shortageQuantity: '8.0000',
      shortageDate: '2026-10-30',
      plannedIncomingAllocationQuantity: '8.0000',
      projectedAvailableDate: '2026-11-02',
      allocationStatus: 'LATE_SUPPLY',
    });
  });

  it('never allocates stock already reserved by operational inventory reservations', () => {
    const result = allocateMrpRequirements(
      [demand({ requiredQuantity: '5.0000' })],
      new Map<string, MrpStockPosition>([['material-a', { onHandQuantity: '10.0000', reservedQuantity: '7.0000' }]]),
      [],
    );

    expect(result[0]).toMatchObject({
      onHandQuantity: '10.0000',
      allocatedQuantity: '7.0000',
      availableOnHandQuantity: '3.0000',
      plannedOnHandAllocationQuantity: '3.0000',
      shortageQuantity: '2.0000',
      shortageDate: '2026-10-20',
      projectedAvailableDate: null,
      allocationStatus: 'UNSUPPLIED',
    });
  });

  it('does not treat undated or overdue incoming supply as reliable allocation', () => {
    const result = allocateMrpRequirements(
      [demand({ requiredQuantity: '4.0000' })],
      new Map<string, MrpStockPosition>([['material-a', { onHandQuantity: '0.0000', reservedQuantity: '0.0000' }]]),
      [
        supply({ id: 'undated', expectedDeliveryDate: null, remainingQuantity: '2.0000' }),
        supply({ id: 'overdue', expectedDeliveryDate: '2026-10-01', remainingQuantity: '2.0000', eligibleForAllocation: false }),
      ],
    );

    expect(result[0]).toMatchObject({
      incomingQuantity: '4.0000',
      availableByNeedDateQuantity: '0.0000',
      shortageQuantity: '4.0000',
      projectedAvailableDate: null,
      allocationStatus: 'UNSUPPLIED',
    });
  });

  it('uses four-decimal integer arithmetic without floating point drift', () => {
    const result = allocateMrpRequirements(
      [demand({ requiredQuantity: '0.3333' })],
      new Map<string, MrpStockPosition>([['material-a', { onHandQuantity: '0.1000', reservedQuantity: '0.0000' }]]),
      [supply({ remainingQuantity: '0.2333' })],
    );

    expect(result[0]).toMatchObject({
      plannedOnHandAllocationQuantity: '0.1000',
      plannedIncomingAllocationQuantity: '0.2333',
      availableByNeedDateQuantity: '0.3333',
      shortageQuantity: '0.0000',
      allocationStatus: 'COVERED',
    });
  });

  it('does not spend a supply bucket after it has been allocated once', () => {
    const result = allocateMrpRequirements(
      [
        demand({ requirementId: 'first', orderNumber: 'SO-001', requiredQuantity: '4.0000', needByDate: '2026-10-20' }),
        demand({ requirementId: 'second', orderNumber: 'SO-002', requiredQuantity: '4.0000', needByDate: '2026-10-21' }),
      ],
      new Map<string, MrpStockPosition>([['material-a', { onHandQuantity: '0.0000', reservedQuantity: '0.0000' }]]),
      [supply({ remainingQuantity: '5.0000', expectedDeliveryDate: '2026-10-20' })],
    );

    expect(result[0]?.plannedIncomingAllocationQuantity).toBe('4.0000');
    expect(result[0]?.shortageQuantity).toBe('0.0000');
    expect(result[1]?.plannedIncomingAllocationQuantity).toBe('1.0000');
    expect(result[1]?.shortageQuantity).toBe('3.0000');
  });

  it('uses non-overdue incoming supply even when its ETA is before a future planning horizon start', () => {
    const result = allocateMrpRequirements(
      [demand({ requiredQuantity: '4.0000', needByDate: '2026-11-05' })],
      new Map<string, MrpStockPosition>([['material-a', { onHandQuantity: '0.0000', reservedQuantity: '0.0000' }]]),
      [supply({ expectedDeliveryDate: '2026-10-25', remainingQuantity: '4.0000', eligibleForAllocation: true })],
    );

    expect(result[0]).toMatchObject({
      incomingQuantity: '4.0000',
      availableByNeedDateQuantity: '4.0000',
      shortageQuantity: '0.0000',
      shortageDate: null,
      allocationStatus: 'COVERED',
    });
  });
});
