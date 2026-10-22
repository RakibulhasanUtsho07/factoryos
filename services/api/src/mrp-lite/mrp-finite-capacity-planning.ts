export interface MrpCapacityRoutingStep {
  id: string;
  stepNumber: number;
  operationCode: string;
  operationName: string;
  workCentreId: string;
  workCentreCode: string;
  setupMinutes: string;
  runMinutesPerUnit: string;
  requiredSkill: string | null;
  capacityUnitsPerHour: string | null;
}

export interface MrpCapacityJob {
  orderId: string;
  orderLineId: string;
  orderNumber: string;
  orderLineNumber: number;
  productCode: string;
  productName: string;
  styleCode: string | null;
  sizeCode: string | null;
  productId: string;
  productVersionId: string;
  productVersionNumber: number;
  needByDate: string;
  quantity: string;
  materialAvailableDate: string | null;
  hasUnresolvedMaterialShortage: boolean;
  operations: MrpCapacityRoutingStep[];
}

export interface MrpCapacityCalendarSlot {
  calendarEntryId: string;
  capacityDate: string;
  shiftTemplateId: string;
  shiftCode: string;
  shiftStartMinute: number;
  shiftMinutes: number;
  workCentreId: string;
  workCentreCode: string;
  lineCode: string;
  availableMinutes: number;
  parallelLines: number;
  capacityUnitsPerHour: string | null;
}

export interface MrpCapacitySkillPool {
  capacityDate: string;
  shiftTemplateId: string;
  workerId: string;
  skillCode: string;
  skillLevel: number;
  availableMinutes: number;
}

export interface MrpCapacityScenarioAdjustment {
  workCentreId: string;
  shiftTemplateId: string;
  capacityDate: string;
  lineCode: string;
  deltaAvailableMinutes: number;
  deltaParallelLines: number;
}

export interface MrpCapacityAllocation {
  calendarEntryId: string;
  capacityDate: string;
  shiftTemplateId: string;
  shiftCode: string;
  workCentreId: string;
  workCentreCode: string;
  lineCode: string;
  allocatedMinutes: string;
  requiredSkill: string | null;
  workerAllocations: Array<{ workerId: string; allocatedMinutes: string }>;
}

export type MrpCapacityOperationStatus =
  | 'SCHEDULED'
  | 'CAPACITY_CONFLICT'
  | 'BLOCKED_MATERIAL'
  | 'BLOCKED_ROUTING'
  | 'BLOCKED_PREDECESSOR'
  | 'FROZEN_HORIZON_CONFLICT';

export interface MrpCapacityOperationResult {
  orderId: string;
  orderLineId: string;
  orderNumber: string;
  orderLineNumber: number;
  productCode: string;
  productName: string;
  styleCode: string | null;
  sizeCode: string | null;
  productId: string;
  productVersionId: string;
  productVersionNumber: number;
  needByDate: string;
  quantity: string;
  routingStepId: string | null;
  stepNumber: number;
  operationCode: string;
  operationName: string;
  workCentreId: string | null;
  workCentreCode: string | null;
  requiredSkill: string | null;
  requiredMinutes: string;
  scheduledMinutes: string;
  plannedStartDate: string | null;
  plannedFinishDate: string | null;
  status: MrpCapacityOperationStatus;
  conflictCodes: string[];
  allocations: MrpCapacityAllocation[];
}

export interface MrpCapacityBaselineAllocation {
  calendarEntryId: string;
  capacityDate: string;
  shiftTemplateId: string;
  workCentreId: string;
  lineCode: string;
  allocatedMinutes: string;
  workerAllocations: Array<{ workerId: string; allocatedMinutes: string }>;
}

export interface MrpCapacityBaselineOperation {
  orderLineId: string;
  stepNumber: number;
  status: string;
  plannedStartDate: string | null;
  plannedFinishDate: string | null;
  requiredMinutes: string;
  allocations: MrpCapacityBaselineAllocation[];
}

export interface MrpCapacityScheduleInput {
  horizonStart: string;
  horizonEnd: string;
  frozenHorizonDays: number;
  jobs: readonly MrpCapacityJob[];
  slots: readonly MrpCapacityCalendarSlot[];
  skillPools: readonly MrpCapacitySkillPool[];
  adjustments?: readonly MrpCapacityScenarioAdjustment[];
  baselineOperations?: readonly MrpCapacityBaselineOperation[];
}

const SCALE = 10_000n;

function parseFixed(value: string, field: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(value)) {
    throw new Error(field + ' must be a non-negative decimal with at most four places');
  }
  const parts = value.split('.');
  return BigInt(parts[0] ?? '0') * SCALE
    + BigInt(((parts[1] ?? '') + '0000').slice(0, 4));
}

function formatFixed(value: bigint): string {
  if (value < 0n) throw new Error('Capacity arithmetic produced a negative result');
  return (value / SCALE).toString() + '.' + (value % SCALE).toString().padStart(4, '0');
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('Capacity arithmetic denominator must be positive');
  return (numerator + denominator - 1n) / denominator;
}

export function calculateMrpRequiredMaterialQuantity(input: {
  remainingFinishedQuantity: string;
  expectedYieldPercent: string;
  quantityPer: string;
  wastagePercent: string;
}): string {
  const quantity = parseFixed(input.remainingFinishedQuantity, 'remainingFinishedQuantity');
  const yieldPercent = parseFixed(input.expectedYieldPercent, 'expectedYieldPercent');
  const quantityPer = parseFixed(input.quantityPer, 'quantityPer');
  const wastage = parseFixed(input.wastagePercent, 'wastagePercent');
  if (quantity <= 0n || yieldPercent <= 0n || yieldPercent > 100n * SCALE
    || quantityPer <= 0n || wastage > 100n * SCALE) {
    throw new Error('MRP material inputs are outside the supported positive range');
  }
  // Fixed-point rational arithmetic: output units are rounded upward to 0.0001.
  const numerator = quantity * quantityPer * (100n * SCALE + wastage);
  const denominator = SCALE * yieldPercent;
  return formatFixed(ceilDivide(numerator, denominator));
}

export function calculateMrpOperationMinutes(input: {
  quantity: string;
  setupMinutes: string;
  runMinutesPerUnit: string;
  capacityUnitsPerHour?: string | null;
}): string {
  const quantity = parseFixed(input.quantity, 'quantity');
  const setup = parseFixed(input.setupMinutes, 'setupMinutes');
  const runPerUnit = parseFixed(input.runMinutesPerUnit, 'runMinutesPerUnit');
  if (quantity <= 0n) throw new Error('Production quantity must be positive');
  if (input.capacityUnitsPerHour !== null && input.capacityUnitsPerHour !== undefined) {
    const rate = parseFixed(input.capacityUnitsPerHour, 'capacityUnitsPerHour');
    if (rate <= 0n) throw new Error('Work-centre unit rate must be positive');
    const rateLimitedMinutes = ceilDivide(60n * SCALE * SCALE, rate);
    const effectiveRunMinutes = runPerUnit > rateLimitedMinutes ? runPerUnit : rateLimitedMinutes;
    return formatFixed(setup + ceilDivide(quantity * effectiveRunMinutes, SCALE));
  }
  return formatFixed(setup + ceilDivide(quantity * runPerUnit, SCALE));
}

function dateOrdinal(value: string): number {
  const parsed = Date.parse(value + 'T00:00:00.000Z');
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new Error('Capacity planner received an invalid calendar date: ' + value);
  }
  return Math.floor(parsed / 86_400_000);
}

function ordinalDate(value: number): string {
  return new Date(value * 86_400_000).toISOString().slice(0, 10);
}

function operationDemand(job: MrpCapacityJob, step: MrpCapacityRoutingStep): bigint {
  return parseFixed(calculateMrpOperationMinutes({
    quantity: job.quantity,
    setupMinutes: step.setupMinutes,
    runMinutesPerUnit: step.runMinutesPerUnit,
    capacityUnitsPerHour: step.capacityUnitsPerHour,
  }), 'requiredMinutes');
}

function adjustedSlots(input: MrpCapacityScheduleInput): MrpCapacityCalendarSlot[] {
  const adjustmentByKey = new Map<string, MrpCapacityScenarioAdjustment>();
  for (const adjustment of input.adjustments ?? []) {
    const key = [adjustment.workCentreId, adjustment.shiftTemplateId, adjustment.capacityDate, adjustment.lineCode].join('|');
    if (adjustmentByKey.has(key)) throw new Error('Duplicate capacity adjustment for the same line, shift and date');
    adjustmentByKey.set(key, adjustment);
  }
  const adjusted = input.slots.map((slot) => {
    const key = [slot.workCentreId, slot.shiftTemplateId, slot.capacityDate, slot.lineCode].join('|');
    const adjustment = adjustmentByKey.get(key);
    if (!adjustment) return { ...slot };
    const availableMinutes = slot.availableMinutes + adjustment.deltaAvailableMinutes;
    const parallelLines = slot.parallelLines + adjustment.deltaParallelLines;
    if (!Number.isInteger(availableMinutes) || availableMinutes < 0 || availableMinutes > 1440
      || !Number.isInteger(parallelLines) || parallelLines < 1 || parallelLines > 100) {
      throw new Error('Scenario capacity adjustment would create an invalid calendar capacity');
    }
    adjustmentByKey.delete(key);
    return { ...slot, availableMinutes, parallelLines };
  });
  if (adjustmentByKey.size > 0) {
    throw new Error('A scenario capacity adjustment does not match an active dated calendar slot');
  }
  return adjusted.sort((left, right) =>
    left.capacityDate.localeCompare(right.capacityDate)
    || left.shiftStartMinute - right.shiftStartMinute
    || left.shiftCode.localeCompare(right.shiftCode)
    || left.workCentreCode.localeCompare(right.workCentreCode)
    || left.lineCode.localeCompare(right.lineCode)
    || left.calendarEntryId.localeCompare(right.calendarEntryId),
  );
}

function slotKey(slot: Pick<MrpCapacityCalendarSlot, 'calendarEntryId'>): string {
  return slot.calendarEntryId;
}

function skillKey(capacityDate: string, shiftTemplateId: string, skillCode: string): string {
  return capacityDate + '|' + shiftTemplateId + '|' + skillCode.trim().toUpperCase();
}

function workerKey(capacityDate: string, shiftTemplateId: string, workerId: string): string {
  return capacityDate + '|' + shiftTemplateId + '|' + workerId;
}

function buildSkillCapacity(pools: readonly MrpCapacitySkillPool[]): {
  workerRemaining: Map<string, bigint>;
  workerIdsBySkill: Map<string, string[]>;
} {
  const workerRemaining = new Map<string, bigint>();
  const workerIdsBySkill = new Map<string, string[]>();
  for (const pool of pools) {
    if (!Number.isInteger(pool.availableMinutes) || pool.availableMinutes < 0
      || !Number.isInteger(pool.skillLevel) || pool.skillLevel < 1 || pool.skillLevel > 5) {
      throw new Error('Qualified worker capacity values are outside the supported range');
    }
    const wKey = workerKey(pool.capacityDate, pool.shiftTemplateId, pool.workerId);
    const minutes = BigInt(pool.availableMinutes) * SCALE;
    const previous = workerRemaining.get(wKey);
    if (previous === undefined || minutes < previous) workerRemaining.set(wKey, minutes);
    const sKey = skillKey(pool.capacityDate, pool.shiftTemplateId, pool.skillCode);
    const workers = workerIdsBySkill.get(sKey) ?? [];
    if (!workers.includes(wKey)) workers.push(wKey);
    workerIdsBySkill.set(sKey, workers);
  }
  for (const workers of workerIdsBySkill.values()) workers.sort();
  return { workerRemaining, workerIdsBySkill };
}

function remainingSkillMinutes(
  capacityDate: string,
  shiftTemplateId: string,
  skillCode: string,
  workerRemaining: ReadonlyMap<string, bigint>,
  workerIdsBySkill: ReadonlyMap<string, string[]>,
): bigint {
  const workers = workerIdsBySkill.get(skillKey(capacityDate, shiftTemplateId, skillCode)) ?? [];
  return workers.reduce((total, key) => total + (workerRemaining.get(key) ?? 0n), 0n);
}

function allocateSkillMinutes(
  amount: bigint,
  capacityDate: string,
  shiftTemplateId: string,
  skillCode: string,
  workerRemaining: Map<string, bigint>,
  workerIdsBySkill: ReadonlyMap<string, string[]>,
): Array<{ workerId: string; allocated: bigint }> | null {
  const workers = workerIdsBySkill.get(skillKey(capacityDate, shiftTemplateId, skillCode)) ?? [];
  let remaining = amount;
  const result: Array<{ workerId: string; allocated: bigint }> = [];
  for (const key of workers) {
    const available = workerRemaining.get(key) ?? 0n;
    if (available <= 0n) continue;
    const used = available < remaining ? available : remaining;
    if (used <= 0n) continue;
    workerRemaining.set(key, available - used);
    result.push({ workerId: key.split('|').slice(2).join('|'), allocated: used });
    remaining -= used;
    if (remaining === 0n) break;
  }
  if (remaining > 0n) {
    for (const entry of result) {
      const key = workerKey(capacityDate, shiftTemplateId, entry.workerId);
      workerRemaining.set(key, (workerRemaining.get(key) ?? 0n) + entry.allocated);
    }
    return null;
  }
  return result;
}

function makeResult(
  job: MrpCapacityJob,
  step: MrpCapacityRoutingStep | null,
  status: MrpCapacityOperationStatus,
  conflictCodes: string[],
): MrpCapacityOperationResult {
  return {
    orderId: job.orderId,
    orderLineId: job.orderLineId,
    orderNumber: job.orderNumber,
    orderLineNumber: job.orderLineNumber,
    productCode: job.productCode,
    productName: job.productName,
    styleCode: job.styleCode,
    sizeCode: job.sizeCode,
    productId: job.productId,
    productVersionId: job.productVersionId,
    productVersionNumber: job.productVersionNumber,
    needByDate: job.needByDate,
    quantity: job.quantity,
    routingStepId: step?.id ?? null,
    stepNumber: step?.stepNumber ?? 0,
    operationCode: step?.operationCode ?? 'ROUTING',
    operationName: step?.operationName ?? 'Routing',
    workCentreId: step?.workCentreId ?? null,
    workCentreCode: step?.workCentreCode ?? null,
    requiredSkill: step?.requiredSkill ?? null,
    requiredMinutes: step ? formatFixed(operationDemand(job, step)) : '0.0000',
    scheduledMinutes: '0.0000',
    plannedStartDate: null,
    plannedFinishDate: null,
    status,
    conflictCodes,
    allocations: [],
  };
}

function jobOrder(left: MrpCapacityJob, right: MrpCapacityJob): number {
  return left.needByDate.localeCompare(right.needByDate)
    || left.orderNumber.localeCompare(right.orderNumber)
    || left.orderLineNumber - right.orderLineNumber
    || left.orderLineId.localeCompare(right.orderLineId);
}

function baselineMap(operations: readonly MrpCapacityBaselineOperation[]): Map<string, MrpCapacityBaselineOperation> {
  return new Map(operations.map((operation) => [operation.orderLineId + '|' + operation.stepNumber, operation]));
}

export function scheduleMrpFiniteCapacity(input: MrpCapacityScheduleInput): MrpCapacityOperationResult[] {
  const horizonStartOrdinal = dateOrdinal(input.horizonStart);
  const horizonEndOrdinal = dateOrdinal(input.horizonEnd);
  if (horizonEndOrdinal < horizonStartOrdinal) throw new Error('Capacity horizon end must not precede its start');
  if (!Number.isInteger(input.frozenHorizonDays) || input.frozenHorizonDays < 0 || input.frozenHorizonDays > 365) {
    throw new Error('Frozen horizon must be between 0 and 365 days');
  }
  const frozenCutoffOrdinal = horizonStartOrdinal + input.frozenHorizonDays;
  const slots = adjustedSlots(input).filter((slot) =>
    dateOrdinal(slot.capacityDate) >= horizonStartOrdinal
    && dateOrdinal(slot.capacityDate) <= horizonEndOrdinal
    && slot.availableMinutes > 0,
  );
  const slotIndex = new Map(slots.map((slot, index) => [slotKey(slot), index]));
  const slotRemaining = slots.map((slot) => BigInt(slot.availableMinutes) * BigInt(slot.parallelLines) * SCALE);
  const skillCapacity = buildSkillCapacity(input.skillPools);
  const workerRemaining = skillCapacity.workerRemaining;
  const workerIdsBySkill = skillCapacity.workerIdsBySkill;
  const jobs = [...input.jobs].sort(jobOrder);
  const outputByKey = new Map<string, MrpCapacityOperationResult>();
  const jobMeta = new Map(jobs.map((job) => [job.orderLineId, job]));
  const pinnedKeys = new Set<string>();

  if (input.frozenHorizonDays > 0) {
    for (const baseline of [...(input.baselineOperations ?? [])]
      .filter((operation) => operation.status === 'SCHEDULED' && operation.plannedStartDate !== null
        && dateOrdinal(operation.plannedStartDate) < frozenCutoffOrdinal)
      .sort((left, right) => left.orderLineId.localeCompare(right.orderLineId) || left.stepNumber - right.stepNumber)) {
      const job = jobMeta.get(baseline.orderLineId);
      const step = job?.operations.find((candidate) => candidate.stepNumber === baseline.stepNumber) ?? null;
      if (!job || !step || job.hasUnresolvedMaterialShortage) continue;
      const key = job.orderLineId + '|' + step.stepNumber;
      const allocations = baseline.allocations;
      const required = operationDemand(job, step);
      const found = allocations.reduce((total, allocation) => total + parseFixed(allocation.allocatedMinutes, 'baseline allocatedMinutes'), 0n);
      let fits = allocations.length > 0 && found === required;
      const decrementedSlots: Array<{ index: number; amount: bigint }> = [];
      const decrementedSkills: Array<{ key: string; amount: bigint }> = [];
      if (fits) {
        for (const allocation of allocations) {
          const index = slotIndex.get(allocation.calendarEntryId);
          if (index === undefined) { fits = false; break; }
          const amount = parseFixed(allocation.allocatedMinutes, 'baseline allocatedMinutes');
          if (slotRemaining[index] < amount) { fits = false; break; }
          slotRemaining[index] -= amount;
          decrementedSlots.push({ index, amount });
          if (step.requiredSkill) {
            const poolKey = skillKey(allocation.capacityDate, allocation.shiftTemplateId, step.requiredSkill);
            const workerEntries = allocation.workerAllocations ?? [];
            if (!workerEntries.length) { fits = false; break; }
            for (const workerEntry of workerEntries) {
              const workerIdentity = workerKey(allocation.capacityDate, allocation.shiftTemplateId, workerEntry.workerId);
              const workerAmount = parseFixed(workerEntry.allocatedMinutes, 'baseline worker allocated minutes');
              const workerBalance = workerRemaining.get(workerIdentity) ?? 0n;
              if (workerBalance < workerAmount
                || !(workerIdsBySkill.get(poolKey) ?? []).includes(workerIdentity)) {
                fits = false;
                break;
              }
              workerRemaining.set(workerIdentity, workerBalance - workerAmount);
              decrementedSkills.push({ key: workerIdentity, amount: workerAmount });
            }
            if (!fits) break;
          }
        }
      }
      if (!fits) {
        for (const entry of decrementedSlots) slotRemaining[entry.index] += entry.amount;
        for (const entry of decrementedSkills) workerRemaining.set(entry.key, (workerRemaining.get(entry.key) ?? 0n) + entry.amount);
      }
      const result = makeResult(job, step, fits ? 'SCHEDULED' : 'FROZEN_HORIZON_CONFLICT',
        fits ? [] : ['FROZEN_HORIZON_CAPACITY_CHANGED']);
      if (fits) {
        result.allocations = allocations.map((allocation) => {
          const slot = slots[slotIndex.get(allocation.calendarEntryId) as number];
          return {
            calendarEntryId: allocation.calendarEntryId,
            capacityDate: allocation.capacityDate,
            shiftTemplateId: allocation.shiftTemplateId,
            shiftCode: slot.shiftCode,
            workCentreId: allocation.workCentreId,
            workCentreCode: slot.workCentreCode,
            lineCode: allocation.lineCode,
            allocatedMinutes: allocation.allocatedMinutes,
            requiredSkill: step.requiredSkill,
            workerAllocations: allocation.workerAllocations ?? [],
          };
        });
        result.requiredMinutes = formatFixed(required);
        result.scheduledMinutes = formatFixed(required);
        result.plannedStartDate = baseline.plannedStartDate;
        result.plannedFinishDate = baseline.plannedFinishDate;
      }
      outputByKey.set(key, result);
      pinnedKeys.add(key);
    }
  }

  for (const job of jobs) {
    const route = [...job.operations].sort((left, right) => left.stepNumber - right.stepNumber
      || left.id.localeCompare(right.id));
    if (!route.length) {
      outputByKey.set(job.orderLineId + '|0', makeResult(job, null, 'BLOCKED_ROUTING', ['MISSING_APPROVED_ROUTING']));
      continue;
    }
    if (job.hasUnresolvedMaterialShortage) {
      for (const step of route) {
        const key = job.orderLineId + '|' + step.stepNumber;
        if (!pinnedKeys.has(key)) outputByKey.set(key, makeResult(job, step, 'BLOCKED_MATERIAL', ['UNSUPPLIED_MATERIAL']));
      }
      continue;
    }

    let firstSlotIndex = 0;
    if (job.materialAvailableDate) {
      const materialDateOrdinal = dateOrdinal(job.materialAvailableDate);
      firstSlotIndex = slots.findIndex((slot) => dateOrdinal(slot.capacityDate) >= materialDateOrdinal);
      if (firstSlotIndex < 0) firstSlotIndex = slots.length;
    }
    for (let position = 0; position < route.length; position += 1) {
      const step = route[position];
      const key = job.orderLineId + '|' + step.stepNumber;
      if (pinnedKeys.has(key)) {
        const pinned = outputByKey.get(key);
        if (!pinned || pinned.status !== 'SCHEDULED') {
          for (const blockedStep of route.slice(position + 1)) {
            outputByKey.set(job.orderLineId + '|' + blockedStep.stepNumber,
              makeResult(job, blockedStep, 'BLOCKED_PREDECESSOR', ['FROZEN_PREDECESSOR_CONFLICT']));
          }
          break;
        }
        const lastPinnedAllocation = pinned.allocations[pinned.allocations.length - 1];
        const lastPinnedSlot = lastPinnedAllocation ? slotIndex.get(lastPinnedAllocation.calendarEntryId) : undefined;
        firstSlotIndex = Math.max(firstSlotIndex, (lastPinnedSlot ?? -1) + 1);
        continue;
      }
      const required = operationDemand(job, step);
      const attempted: Array<{ index: number; amount: bigint; key: string | null }> = [];
      const allocations: MrpCapacityAllocation[] = [];
      let remaining = required;
      let firstIndex: number | null = null;
      let lastIndex: number | null = null;
      for (let index = firstSlotIndex; index < slots.length && remaining > 0n; index += 1) {
        const slot = slots[index];
        if (slot.workCentreId !== step.workCentreId) continue;
        const slotOrdinal = dateOrdinal(slot.capacityDate);
        if (slotOrdinal < horizonStartOrdinal || slotOrdinal > horizonEndOrdinal) continue;
        if (job.materialAvailableDate && slot.capacityDate < job.materialAvailableDate) continue;
        if (step.requiredSkill) {
          const availableSkill = remainingSkillMinutes(
            slot.capacityDate, slot.shiftTemplateId, step.requiredSkill,
            workerRemaining, workerIdsBySkill,
          );
          if (availableSkill <= 0n) continue;
          const amount = slotRemaining[index] < availableSkill ? slotRemaining[index] : availableSkill;
          if (amount <= 0n) continue;
          const used = amount < remaining ? amount : remaining;
          const workerEntries = allocateSkillMinutes(
            used, slot.capacityDate, slot.shiftTemplateId, step.requiredSkill,
            workerRemaining, workerIdsBySkill,
          );
          if (!workerEntries) continue;
          slotRemaining[index] -= used;
          attempted.push({ index, amount: used, key: null });
          for (const workerEntry of workerEntries) {
            attempted.push({
              index: -1,
              amount: workerEntry.allocated,
              key: workerKey(slot.capacityDate, slot.shiftTemplateId, workerEntry.workerId),
            });
          }
          allocations.push({
            calendarEntryId: slot.calendarEntryId,
            capacityDate: slot.capacityDate,
            shiftTemplateId: slot.shiftTemplateId,
            shiftCode: slot.shiftCode,
            workCentreId: slot.workCentreId,
            workCentreCode: slot.workCentreCode,
            lineCode: slot.lineCode,
            allocatedMinutes: formatFixed(used),
            requiredSkill: step.requiredSkill,
            workerAllocations: workerEntries.map((entry) => ({
              workerId: entry.workerId, allocatedMinutes: formatFixed(entry.allocated),
            })),
          });
          remaining -= used;
          if (firstIndex === null) firstIndex = index;
          lastIndex = index;
        } else {
          const amount = slotRemaining[index] < remaining ? slotRemaining[index] : remaining;
          if (amount <= 0n) continue;
          slotRemaining[index] -= amount;
          attempted.push({ index, amount, key: null });
          allocations.push({
            calendarEntryId: slot.calendarEntryId,
            capacityDate: slot.capacityDate,
            shiftTemplateId: slot.shiftTemplateId,
            shiftCode: slot.shiftCode,
            workCentreId: slot.workCentreId,
            workCentreCode: slot.workCentreCode,
            lineCode: slot.lineCode,
            allocatedMinutes: formatFixed(amount),
            requiredSkill: null,
            workerAllocations: [],
          });
          remaining -= amount;
          if (firstIndex === null) firstIndex = index;
          lastIndex = index;
        }
      }

      if (remaining > 0n || firstIndex === null || lastIndex === null) {
        for (const entry of attempted) {
          if (entry.index >= 0) slotRemaining[entry.index] += entry.amount;
          if (entry.key) workerRemaining.set(entry.key, (workerRemaining.get(entry.key) ?? 0n) + entry.amount);
        }
        const result = makeResult(job, step, 'CAPACITY_CONFLICT', ['INSUFFICIENT_QUALIFIED_CAPACITY']);
        result.requiredMinutes = formatFixed(required);
        outputByKey.set(key, result);
        for (const blockedStep of route.slice(position + 1)) {
          outputByKey.set(job.orderLineId + '|' + blockedStep.stepNumber,
            makeResult(job, blockedStep, 'BLOCKED_PREDECESSOR', ['ROUTING_PREDECESSOR_CAPACITY_CONFLICT']));
        }
        break;
      }

      const result = makeResult(job, step, 'SCHEDULED', []);
      result.requiredMinutes = formatFixed(required);
      result.scheduledMinutes = formatFixed(required);
      result.plannedStartDate = slots[firstIndex].capacityDate;
      result.plannedFinishDate = slots[lastIndex].capacityDate;
      result.allocations = allocations;
      outputByKey.set(key, result);
      firstSlotIndex = lastIndex + 1;
      if (result.plannedFinishDate > job.needByDate) result.conflictCodes.push('FINISH_AFTER_NEED_BY_DATE');
    }
  }

  const output = [...outputByKey.values()];
  output.sort((left, right) =>
    left.needByDate.localeCompare(right.needByDate)
    || left.orderNumber.localeCompare(right.orderNumber)
    || left.orderLineNumber - right.orderLineNumber
    || left.stepNumber - right.stepNumber
    || left.orderLineId.localeCompare(right.orderLineId),
  );

  // Remove work that cannot be placed before due date? Keep scheduled-late rows as explainable, not hidden.
  return output;
}

export function diffMrpCapacityPlans(input: {
  horizonStart: string;
  frozenHorizonDays: number;
  baseline: readonly MrpCapacityBaselineOperation[];
  current: readonly MrpCapacityOperationResult[];
}): Array<Record<string, unknown>> {
  const cutoff = ordinalDate(dateOrdinal(input.horizonStart) + input.frozenHorizonDays);
  const baselineMapValue = baselineMap(input.baseline);
  const currentMap = new Map(input.current.map((operation) => [
    operation.orderLineId + '|' + operation.stepNumber, operation,
  ]));
  const keys = new Set([...baselineMapValue.keys(), ...currentMap.keys()]);
  const result: Array<Record<string, unknown>> = [];
  for (const key of [...keys].sort()) {
    const before = baselineMapValue.get(key);
    const after = currentMap.get(key);
    let change: string;
    const baselineAllocationSignature = (allocations: MrpCapacityBaselineAllocation[]) =>
      allocations.map((allocation) => ({
        calendarEntryId: allocation.calendarEntryId,
        capacityDate: allocation.capacityDate,
        shiftTemplateId: allocation.shiftTemplateId,
        workCentreId: allocation.workCentreId,
        lineCode: allocation.lineCode,
        allocatedMinutes: allocation.allocatedMinutes,
        workerAllocations: [...(allocation.workerAllocations ?? [])]
          .map((worker) => ({ workerId: worker.workerId, allocatedMinutes: worker.allocatedMinutes }))
          .sort((left, right) => left.workerId.localeCompare(right.workerId)),
      })).sort((left, right) =>
        left.capacityDate.localeCompare(right.capacityDate)
        || left.shiftTemplateId.localeCompare(right.shiftTemplateId)
        || left.workCentreId.localeCompare(right.workCentreId)
        || left.lineCode.localeCompare(right.lineCode)
        || left.calendarEntryId.localeCompare(right.calendarEntryId),
      );
    const currentAllocationSignature = (allocations: MrpCapacityAllocation[]) =>
      allocations.map((allocation) => ({
        calendarEntryId: allocation.calendarEntryId,
        capacityDate: allocation.capacityDate,
        shiftTemplateId: allocation.shiftTemplateId,
        workCentreId: allocation.workCentreId,
        lineCode: allocation.lineCode,
        allocatedMinutes: allocation.allocatedMinutes,
        workerAllocations: [...allocation.workerAllocations]
          .map((worker) => ({ workerId: worker.workerId, allocatedMinutes: worker.allocatedMinutes }))
          .sort((left, right) => left.workerId.localeCompare(right.workerId)),
      })).sort((left, right) =>
        left.capacityDate.localeCompare(right.capacityDate)
        || left.shiftTemplateId.localeCompare(right.shiftTemplateId)
        || left.workCentreId.localeCompare(right.workCentreId)
        || left.lineCode.localeCompare(right.lineCode)
        || left.calendarEntryId.localeCompare(right.calendarEntryId),
      );
    if (!before) change = 'ADDED';
    else if (!after) change = 'REMOVED';
    else if (before.plannedStartDate !== after.plannedStartDate
      || before.plannedFinishDate !== after.plannedFinishDate
      || before.status !== after.status
      || before.requiredMinutes !== after.requiredMinutes
      || JSON.stringify(baselineAllocationSignature(before.allocations))
        !== JSON.stringify(currentAllocationSignature(after.allocations))) change = 'CHANGED';
    else change = 'UNCHANGED';
    if (change === 'UNCHANGED') continue;
    const frozen = Boolean(before?.plannedStartDate && before.plannedStartDate < cutoff);
    result.push({
      order_line_id: before?.orderLineId ?? after?.orderLineId,
      step_number: before?.stepNumber ?? after?.stepNumber,
      change,
      frozen_horizon: frozen,
      frozen_horizon_violation: frozen && change !== 'UNCHANGED',
      before: before ? {
        status: before.status,
        planned_start_date: before.plannedStartDate,
        planned_finish_date: before.plannedFinishDate,
      } : null,
      after: after ? {
        status: after.status,
        planned_start_date: after.plannedStartDate,
        planned_finish_date: after.plannedFinishDate,
      } : null,
    });
  }
  return result;
}
