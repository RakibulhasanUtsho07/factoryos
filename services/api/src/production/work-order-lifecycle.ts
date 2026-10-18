export type WorkOrderStatus =
  | 'DRAFT'
  | 'RELEASED'
  | 'IN_PROGRESS'
  | 'ON_HOLD'
  | 'COMPLETED'
  | 'CANCELLED';

export type OperationStatus =
  | 'PLANNED'
  | 'READY'
  | 'IN_PROGRESS'
  | 'PAUSED'
  | 'ON_HOLD'
  | 'COMPLETED'
  | 'SKIPPED';

export type OperationCommand =
  | 'START'
  | 'PAUSE'
  | 'RESUME'
  | 'HOLD'
  | 'COMPLETE'
  | 'SKIP'
  | 'DOWNTIME_START'
  | 'DOWNTIME_END'
  | 'WIP_REPORTED'
  | 'WIP_TRANSFERRED'
  | 'REWORK_REPORTED';

const WORK_ORDER_TRANSITIONS: Readonly<Record<WorkOrderStatus, readonly WorkOrderStatus[]>> = {
  DRAFT: ['RELEASED', 'CANCELLED'],
  RELEASED: ['IN_PROGRESS', 'ON_HOLD', 'CANCELLED'],
  IN_PROGRESS: ['ON_HOLD', 'COMPLETED', 'CANCELLED'],
  ON_HOLD: ['IN_PROGRESS', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

const OPERATION_TRANSITIONS: Readonly<Record<OperationStatus, readonly OperationStatus[]>> = {
  PLANNED: ['READY', 'SKIPPED'],
  READY: ['IN_PROGRESS', 'ON_HOLD', 'SKIPPED'],
  IN_PROGRESS: ['PAUSED', 'ON_HOLD', 'COMPLETED'],
  PAUSED: ['IN_PROGRESS', 'ON_HOLD', 'COMPLETED'],
  ON_HOLD: ['READY', 'PAUSED'],
  COMPLETED: [],
  SKIPPED: [],
};

export function assertWorkOrderTransition(current: WorkOrderStatus, next: WorkOrderStatus): void {
  if (!WORK_ORDER_TRANSITIONS[current].includes(next)) {
    throw new Error(`INVALID_WORK_ORDER_TRANSITION:${current}:${next}`);
  }
}

export function nextOperationStatus(
  current: OperationStatus,
  command: OperationCommand,
  qualityGate: boolean,
): OperationStatus {
  switch (command) {
    case 'START':
      if (current === 'READY') return 'IN_PROGRESS';
      break;
    case 'PAUSE':
      if (current === 'IN_PROGRESS') return 'PAUSED';
      break;
    case 'RESUME':
      if (current === 'PAUSED' || current === 'ON_HOLD') return current === 'ON_HOLD' ? 'PAUSED' : 'IN_PROGRESS';
      break;
    case 'HOLD':
      if (current === 'READY' || current === 'IN_PROGRESS' || current === 'PAUSED') return 'ON_HOLD';
      break;
    case 'COMPLETE':
      if (current === 'IN_PROGRESS' || current === 'PAUSED') return 'COMPLETED';
      break;
    case 'SKIP':
      if (!qualityGate && (current === 'PLANNED' || current === 'READY')) return 'SKIPPED';
      if (qualityGate && (current === 'PLANNED' || current === 'READY')) {
        throw new Error('QUALITY_GATE_OPERATION_CANNOT_BE_SKIPPED');
      }
      break;
    case 'DOWNTIME_START':
    case 'DOWNTIME_END':
      if (current === 'IN_PROGRESS') return current;
      break;
    case 'WIP_REPORTED':
    case 'WIP_TRANSFERRED':
    case 'REWORK_REPORTED':
      if (current === 'IN_PROGRESS' || current === 'PAUSED') return current;
      break;
    default: {
      const exhaustive: never = command;
      throw new Error(`UNSUPPORTED_OPERATION_COMMAND:${exhaustive}`);
    }
  }

  throw new Error(`INVALID_OPERATION_COMMAND:${current}:${command}`);
}

export function assertPrecedingOperationsComplete(
  preceding: readonly { status: OperationStatus; step_number: number }[],
): void {
  const blocked = preceding.find((operation) => operation.status !== 'COMPLETED' && operation.status !== 'SKIPPED');
  if (blocked) {
    throw new Error(`PRECEDING_OPERATION_INCOMPLETE:${blocked.step_number}:${blocked.status}`);
  }
}

export function assertTargetQuantityNotExceeded(
  targetQuantity: bigint,
  processedQuantity: bigint,
  nextQuantity: bigint,
): void {
  if (targetQuantity <= 0n || processedQuantity < 0n || nextQuantity <= 0n) {
    throw new Error('INVALID_WORK_ORDER_OUTPUT_QUANTITY');
  }
  if (processedQuantity + nextQuantity > targetQuantity) {
    throw new Error('WORK_ORDER_TARGET_QUANTITY_EXCEEDED');
  }
}

export function assertDowntimeCanStart(input: {
  workOrderStatus: WorkOrderStatus;
  operationStatus: OperationStatus;
  activeTimerOpen: boolean;
  downtimeAlreadyOpen: boolean;
}): void {
  if (
    input.workOrderStatus !== 'IN_PROGRESS'
    || input.operationStatus !== 'IN_PROGRESS'
    || !input.activeTimerOpen
    || input.downtimeAlreadyOpen
  ) {
    throw new Error('DOWNTIME_START_REQUIRES_ACTIVE_OPERATION_TIMER');
  }
}

export function assertDowntimeCanEnd(input: {
  workOrderStatus: WorkOrderStatus;
  operationStatus: OperationStatus;
  downtimeAlreadyOpen: boolean;
}): void {
  if (
    input.workOrderStatus !== 'IN_PROGRESS'
    || input.operationStatus !== 'IN_PROGRESS'
    || !input.downtimeAlreadyOpen
  ) {
    throw new Error('DOWNTIME_END_REQUIRES_OPEN_INTERVAL');
  }
}

export function assertWipSnapshotQuantity(
  quantity: bigint,
  targetQuantity: bigint,
  otherOperationWip = 0n,
): void {
  if (quantity < 0n || otherOperationWip < 0n) {
    throw new Error('WIP_QUANTITY_CANNOT_BE_NEGATIVE');
  }
  if (targetQuantity <= 0n || quantity + otherOperationWip > targetQuantity) {
    throw new Error('WIP_QUANTITY_EXCEEDS_WORK_ORDER_TARGET');
  }
}

export function assertReworkQuantity(quantity: bigint): void {
  if (quantity <= 0n) throw new Error('REWORK_QUANTITY_MUST_BE_POSITIVE');
}

export function assertWipTransfer(
  sourceWip: bigint,
  targetWip: bigint,
  transferQuantity: bigint,
  workOrderTarget: bigint,
): void {
  if (sourceWip < 0n || targetWip < 0n || transferQuantity <= 0n || workOrderTarget <= 0n) {
    throw new Error('INVALID_WIP_TRANSFER_QUANTITY');
  }
  if (transferQuantity > sourceWip) {
    throw new Error('WIP_TRANSFER_EXCEEDS_SOURCE_OPERATION_QUANTITY');
  }
  if (targetWip + transferQuantity > workOrderTarget) {
    throw new Error('WIP_TRANSFER_EXCEEDS_WORK_ORDER_TARGET');
  }
}
