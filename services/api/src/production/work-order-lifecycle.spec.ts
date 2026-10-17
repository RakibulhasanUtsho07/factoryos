import {
  assertPrecedingOperationsComplete,
  assertTargetQuantityNotExceeded,
  assertWorkOrderTransition,
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
    expect(nextOperationStatus('PLANNED', 'START', false)).toThrow;
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
});
