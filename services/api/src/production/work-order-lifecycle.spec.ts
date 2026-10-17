import {
  assertPrecedingOperationsComplete,
  assertTargetQuantityNotExceeded,
  assertWorkOrderTransition,
  assertDowntimeCanStart,
  assertDowntimeCanEnd,
  assertWipSnapshotQuantity,
  assertReworkQuantity,
  nextOperationStatus,
} from './work-order-lifecycle';

describe('production work-order lifecycle contracts', () => {
  it('permits only explicit work-order state transitions', () => {
    expect(() => assertWorkOrderTransition('DRAFT', 'RELEASED')).not.toThrow();
    expect(() => assertWorkOrderTransition('ON_HOLD', 'IN_PROGRESS')).not.toThrow();
    expect(() => assertWorkOrderTransition('COMPLETED', 'IN_PROGRESS')).toThrow('INVALID_WORK_ORDER_TRANSITION');
    expect(() => assertWorkOrderTransition('CANCELLED', 'RELEASED')).toThrow('INVALID_WORK_ORDER_TRANSITION');
  });

  it('requires release readiness before the first operation starts', () => {
    expect(nextOperationStatus('READY', 'START', false)).toBe('IN_PROGRESS');
    expect(() => nextOperationStatus('PLANNED', 'START', false)).toThrow('INVALID_OPERATION_COMMAND:PLANNED:START');
  });

  it('supports measured start, pause, resume, hold and completion transitions', () => {
    expect(nextOperationStatus('IN_PROGRESS', 'PAUSE', false)).toBe('PAUSED');
    expect(nextOperationStatus('PAUSED', 'RESUME', false)).toBe('IN_PROGRESS');
    expect(nextOperationStatus('IN_PROGRESS', 'HOLD', false)).toBe('ON_HOLD');
    expect(nextOperationStatus('ON_HOLD', 'RESUME', false)).toBe('PAUSED');
    expect(nextOperationStatus('IN_PROGRESS', 'COMPLETE', false)).toBe('COMPLETED');
  });

  it('prevents skipping a quality-gate operation', () => {
    expect(nextOperationStatus('READY', 'SKIP', false)).toBe('SKIPPED');
    expect(() => nextOperationStatus('READY', 'SKIP', true)).toThrow('QUALITY_GATE_OPERATION_CANNOT_BE_SKIPPED');
  });

  it('does not start a downstream operation until all prior steps finish', () => {
    expect(() => assertPrecedingOperationsComplete([
      { step_number: 1, status: 'COMPLETED' },
      { step_number: 2, status: 'SKIPPED' },
    ])).not.toThrow();

    expect(() => assertPrecedingOperationsComplete([
      { step_number: 1, status: 'COMPLETED' },
      { step_number: 2, status: 'IN_PROGRESS' },
    ])).toThrow('PRECEDING_OPERATION_INCOMPLETE:2:IN_PROGRESS');
  });

  it('permits WIP and rework evidence only for an active or paused operation', () => {
    expect(nextOperationStatus('IN_PROGRESS', 'WIP_REPORTED', false)).toBe('IN_PROGRESS');
    expect(nextOperationStatus('PAUSED', 'REWORK_REPORTED', false)).toBe('PAUSED');
    expect(() => nextOperationStatus('READY', 'WIP_REPORTED', false)).toThrow('INVALID_OPERATION_COMMAND');
  });

  it('keeps processed good plus scrap output within the work-order target', () => {
    expect(() => assertTargetQuantityNotExceeded(1000000n, 600000n, 400000n)).not.toThrow();
    expect(() => assertTargetQuantityNotExceeded(1000000n, 600000n, 400001n)).toThrow('WORK_ORDER_TARGET_QUANTITY_EXCEEDED');
  });

  it('uses WIP as a current-operation snapshot and permits an explicit zero reset', () => {
    expect(() => assertWipSnapshotQuantity(0n, 1000000n)).not.toThrow();
    expect(() => assertWipSnapshotQuantity(250000n, 1000000n)).not.toThrow();
    expect(() => assertWipSnapshotQuantity(1000001n, 1000000n)).toThrow('WIP_QUANTITY_EXCEEDS_WORK_ORDER_TARGET');
    expect(() => assertWipSnapshotQuantity(-1n, 1000000n)).toThrow('WIP_QUANTITY_CANNOT_BE_NEGATIVE');
  });

  it('only opens downtime while the operation timer is running and only closes an open interval', () => {
    expect(() => assertDowntimeCanStart({
      workOrderStatus: 'IN_PROGRESS', operationStatus: 'IN_PROGRESS',
      activeTimerOpen: true, downtimeAlreadyOpen: false,
    })).not.toThrow();
    expect(() => assertDowntimeCanStart({
      workOrderStatus: 'IN_PROGRESS', operationStatus: 'IN_PROGRESS',
      activeTimerOpen: false, downtimeAlreadyOpen: false,
    })).toThrow('DOWNTIME_START_REQUIRES_ACTIVE_OPERATION_TIMER');
    expect(() => assertDowntimeCanEnd({
      workOrderStatus: 'IN_PROGRESS', operationStatus: 'IN_PROGRESS', downtimeAlreadyOpen: true,
    })).not.toThrow();
    expect(() => assertDowntimeCanEnd({
      workOrderStatus: 'IN_PROGRESS', operationStatus: 'IN_PROGRESS', downtimeAlreadyOpen: false,
    })).toThrow('DOWNTIME_END_REQUIRES_OPEN_INTERVAL');
  });

  it('requires positive rework quantities while preserving zero as a valid WIP snapshot', () => {
    expect(() => assertReworkQuantity(1n)).not.toThrow();
    expect(() => assertReworkQuantity(0n)).toThrow('REWORK_QUANTITY_MUST_BE_POSITIVE');
  });
});
