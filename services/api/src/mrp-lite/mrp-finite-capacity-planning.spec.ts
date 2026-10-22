import {
  calculateMrpOperationMinutes,
  calculateMrpRequiredMaterialQuantity,
  diffMrpCapacityPlans,
  scheduleMrpFiniteCapacity,
  type MrpCapacityBaselineOperation,
  type MrpCapacityCalendarSlot,
  type MrpCapacityJob,
  type MrpCapacitySkillPool,
} from './mrp-finite-capacity-planning';

const HORIZON_START = '2027-01-04';
const HORIZON_END = '2027-01-08';
const WORK_CENTRE = '2f9f0b52-0fc7-4f9c-b3e5-0e0a2b9b3344';
const SHIFT = '6fcd7d12-0f87-4571-b642-4d8c84ecbb11';

function slot(overrides: Partial<MrpCapacityCalendarSlot> = {}): MrpCapacityCalendarSlot {
  return {
    calendarEntryId: 'calendar-1',
    capacityDate: '2027-01-04',
    shiftTemplateId: SHIFT,
    shiftCode: 'A',
    shiftStartMinute: 480,
    shiftMinutes: 480,
    workCentreId: WORK_CENTRE,
    workCentreCode: 'CUT',
    lineCode: 'LINE-1',
    availableMinutes: 60,
    parallelLines: 1,
    capacityUnitsPerHour: null,
    ...overrides,
  };
}

function job(overrides: Partial<MrpCapacityJob> = {}): MrpCapacityJob {
  return {
    orderId: 'order-1',
    orderLineId: 'line-1',
    orderNumber: 'SO-100',
    orderLineNumber: 1,
    productCode: 'STYLE-A-S',
    productName: 'Style A Small',
    styleCode: 'STYLE-A',
    sizeCode: 'S',
    productId: 'product-1',
    productVersionId: 'version-1',
    productVersionNumber: 3,
    needByDate: '2027-01-08',
    quantity: '1.0000',
    materialAvailableDate: null,
    hasUnresolvedMaterialShortage: false,
    operations: [{
      id: 'routing-1',
      stepNumber: 1,
      operationCode: 'CUT',
      operationName: 'Cut panels',
      workCentreId: WORK_CENTRE,
      workCentreCode: 'CUT',
      setupMinutes: '10.0000',
      runMinutesPerUnit: '30.0000',
      requiredSkill: null,
      capacityUnitsPerHour: null,
    }],
    ...overrides,
  };
}

describe('MRP finite-capacity deterministic arithmetic', () => {
  it('calculates yield gross-up and wastage using ceiling at four decimal places', () => {
    expect(calculateMrpRequiredMaterialQuantity({
      remainingFinishedQuantity: '10.0000',
      expectedYieldPercent: '90.0000',
      quantityPer: '2.0000',
      wastagePercent: '10.0000',
    })).toBe('24.4445');
  });

  it('calculates operation demand as SAM/SMV run minutes plus setup minutes', () => {
    expect(calculateMrpOperationMinutes({
      quantity: '100.0000', setupMinutes: '10.0000', runMinutesPerUnit: '0.5000',
    })).toBe('60.0000');
  });

  it('honours a stricter work-centre unit rate without floating-point rounding', () => {
    expect(calculateMrpOperationMinutes({
      quantity: '100.0000', setupMinutes: '10.0000',
      runMinutesPerUnit: '0.5000', capacityUnitsPerHour: '30.0000',
    })).toBe('210.0000');
  });

  it('does not allocate more work than the finite line/shift capacity', () => {
    const jobs = [
      job({ orderId: 'order-a', orderLineId: 'line-a', orderNumber: 'SO-001', quantity: '1.0000' }),
      job({ orderId: 'order-b', orderLineId: 'line-b', orderNumber: 'SO-002', quantity: '1.0000' }),
    ];
    const result = scheduleMrpFiniteCapacity({ horizonStart: HORIZON_START, horizonEnd: HORIZON_END,
      frozenHorizonDays: 0, jobs, slots: [slot()], skillPools: [] });
    expect(result.filter(item => item.status === 'SCHEDULED')).toHaveLength(1);
    expect(result.filter(item => item.status === 'CAPACITY_CONFLICT')).toHaveLength(1);
    expect(result.find(item => item.orderLineId === 'line-a')?.scheduledMinutes).toBe('40.0000');
  });

  it('blocks material-short orders instead of reserving their capacity', () => {
    const result = scheduleMrpFiniteCapacity({
      horizonStart: HORIZON_START, horizonEnd: HORIZON_END, frozenHorizonDays: 0,
      jobs: [job({ hasUnresolvedMaterialShortage: true })], slots: [slot()], skillPools: [],
    });
    expect(result[0]?.status).toBe('BLOCKED_MATERIAL');
    expect(result[0]?.allocations).toEqual([]);
  });

  it('uses qualified worker minutes and detects a real skill bottleneck', () => {
    const skilledJob = job({ operations: [{
      id: 'routing-skill', stepNumber: 1, operationCode: 'SEW', operationName: 'Sew seam',
      workCentreId: WORK_CENTRE, workCentreCode: 'CUT', setupMinutes: '0.0000',
      runMinutesPerUnit: '60.0000', requiredSkill: 'SEWING', capacityUnitsPerHour: null,
    }] });
    const pools: MrpCapacitySkillPool[] = [{
      capacityDate: '2027-01-04', shiftTemplateId: SHIFT, workerId: 'worker-1',
      skillCode: 'SEWING', skillLevel: 3, availableMinutes: 30,
    }];
    const result = scheduleMrpFiniteCapacity({
      horizonStart: HORIZON_START, horizonEnd: HORIZON_END, frozenHorizonDays: 0,
      jobs: [skilledJob], slots: [slot()], skillPools: pools,
    });
    expect(result[0]?.status).toBe('CAPACITY_CONFLICT');
    expect(result[0]?.conflictCodes).toContain('INSUFFICIENT_QUALIFIED_CAPACITY');
  });

  it('does not double-book one worker who holds multiple skills on the same shift', () => {
    const jobs = [
      job({ orderId: 'order-a', orderLineId: 'line-a', orderNumber: 'SO-001', operations: [{
        id: 'route-a', stepNumber: 1, operationCode: 'CUT', operationName: 'Cut',
        workCentreId: WORK_CENTRE, workCentreCode: 'CUT', setupMinutes: '0.0000',
        runMinutesPerUnit: '40.0000', requiredSkill: 'CUTTING', capacityUnitsPerHour: null,
      }] }),
      job({ orderId: 'order-b', orderLineId: 'line-b', orderNumber: 'SO-002', operations: [{
        id: 'route-b', stepNumber: 1, operationCode: 'SEW', operationName: 'Sew',
        workCentreId: WORK_CENTRE, workCentreCode: 'CUT', setupMinutes: '0.0000',
        runMinutesPerUnit: '40.0000', requiredSkill: 'SEWING', capacityUnitsPerHour: null,
      }] }),
    ];
    const pools: MrpCapacitySkillPool[] = [
      { capacityDate: '2027-01-04', shiftTemplateId: SHIFT, workerId: 'worker-1', skillCode: 'CUTTING', skillLevel: 4, availableMinutes: 60 },
      { capacityDate: '2027-01-04', shiftTemplateId: SHIFT, workerId: 'worker-1', skillCode: 'SEWING', skillLevel: 4, availableMinutes: 60 },
    ];
    const result = scheduleMrpFiniteCapacity({
      horizonStart: HORIZON_START, horizonEnd: HORIZON_END, frozenHorizonDays: 0,
      jobs, slots: [slot({ availableMinutes: 120 })], skillPools: pools,
    });
    expect(result.filter(item => item.status === 'SCHEDULED')).toHaveLength(1);
    expect(result.filter(item => item.status === 'CAPACITY_CONFLICT')).toHaveLength(1);
  });

  it('pins an unchanged operation inside the frozen horizon', () => {
    const baseline: MrpCapacityBaselineOperation[] = [{
      orderLineId: 'line-1', stepNumber: 1, status: 'SCHEDULED',
      plannedStartDate: '2027-01-04', plannedFinishDate: '2027-01-04',
      requiredMinutes: '40.0000',
      allocations: [{
        calendarEntryId: 'calendar-1', capacityDate: '2027-01-04', shiftTemplateId: SHIFT,
        workCentreId: WORK_CENTRE, lineCode: 'LINE-1', allocatedMinutes: '40.0000',
        workerAllocations: [],
      }],
    }];
    const result = scheduleMrpFiniteCapacity({
      horizonStart: HORIZON_START, horizonEnd: HORIZON_END, frozenHorizonDays: 2,
      jobs: [job()], slots: [slot()], skillPools: [], baselineOperations: baseline,
    });
    expect(result[0]?.status).toBe('SCHEDULED');
    expect(result[0]?.plannedStartDate).toBe('2027-01-04');
    expect(result[0]?.allocations[0]?.allocatedMinutes).toBe('40.0000');
  });

  it('flags frozen-horizon changes in a scenario comparison', () => {
    const baseline: MrpCapacityBaselineOperation[] = [{
      orderLineId: 'line-1', stepNumber: 1, status: 'SCHEDULED',
      plannedStartDate: '2027-01-04', plannedFinishDate: '2027-01-04',
      requiredMinutes: '40.0000', allocations: [],
    }];
    const diff = diffMrpCapacityPlans({
      horizonStart: HORIZON_START, frozenHorizonDays: 2, baseline,
      current: [{
        orderId: 'order-1', orderLineId: 'line-1', orderNumber: 'SO-100', orderLineNumber: 1,
        productCode: 'STYLE-A-S', productName: 'Style A Small', styleCode: 'STYLE-A', sizeCode: 'S', productId: 'product-1',
        productVersionId: 'version-1', productVersionNumber: 3, needByDate: '2027-01-08',
        quantity: '1.0000', routingStepId: 'routing-1', stepNumber: 1,
        operationCode: 'CUT', operationName: 'Cut panels', workCentreId: WORK_CENTRE,
        workCentreCode: 'CUT', requiredSkill: null, requiredMinutes: '40.0000',
        scheduledMinutes: '0.0000', plannedStartDate: null, plannedFinishDate: null,
        status: 'FROZEN_HORIZON_CONFLICT', conflictCodes: ['FROZEN_HORIZON_CAPACITY_CHANGED'], allocations: [],
      }],
    });
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatchObject({ change: 'CHANGED', frozen_horizon: true, frozen_horizon_violation: true });
  });

  it('rejects a scenario adjustment which does not name a real calendar slot', () => {
    expect(() => scheduleMrpFiniteCapacity({
      horizonStart: HORIZON_START, horizonEnd: HORIZON_END, frozenHorizonDays: 0,
      jobs: [job()], slots: [slot()], skillPools: [],
      adjustments: [{
        workCentreId: WORK_CENTRE, shiftTemplateId: SHIFT, capacityDate: '2027-01-04',
        lineCode: 'DOES-NOT-EXIST', deltaAvailableMinutes: 10, deltaParallelLines: 0,
      }],
    })).toThrow('does not match an active dated calendar slot');
  });
});
