export type WorkOrderGenealogyTargetKind = 'FINISHED_GOOD' | 'SCRAP';
export type WorkOrderGenealogyRelationship = 'CONSUMED_INTO' | 'PROCESSED_INTO';

export interface WorkOrderGenealogySource {
  unitId: string;
  itemId: string;
  unitType: 'LOT' | 'SERIAL';
  unit: string;
  quantity: string;
}

export interface WorkOrderGenealogyTarget {
  unitId: string;
  reportId: string;
  kind: WorkOrderGenealogyTargetKind;
  quantity: string;
}

export interface WorkOrderGenealogyEdge {
  sourceUnitId: string;
  targetUnitId: string;
  quantity: string;
  relationshipType: WorkOrderGenealogyRelationship;
}

/** Parse manufacturing quantities without routing exact decimal values through binary floating point. */
function quantityUnits(value: string, label: string): bigint {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,4}))?$/.exec(String(value).trim());
  if (!match) throw new Error(label + ' must be a non-negative four-decimal quantity');
  return BigInt(match[1]!) * 10_000n + BigInt((match[2] ?? '').padEnd(4, '0'));
}

function formatQuantity(value: bigint): string {
  return (value / 10_000n).toString() + '.' + (value % 10_000n).toString().padStart(4, '0');
}

/**
 * Build deterministic batch-level links after a work order's inventory issues
 * have been written inside the same transaction. Lot quantities are apportioned
 * by reported good+scrap output. A serialized source is never split across target
 * batches; it is assigned to one target using the same stable output-weight basis.
 * This is a transparent batch allocation, not a substitute for a per-unit shop-floor scan.
 */
export function allocateWorkOrderOutputGenealogy(
  sources: WorkOrderGenealogySource[],
  targets: WorkOrderGenealogyTarget[],
): WorkOrderGenealogyEdge[] {
  if (targets.length === 0) {
    if (sources.length > 0) throw new Error('Traceable material consumption requires a finished-output or scrap genealogy target');
    return [];
  }
  const targetWeights = targets.map((target, index) => {
    const units = quantityUnits(target.quantity, 'target[' + index + '].quantity');
    if (units <= 0n) throw new Error('Genealogy targets must have positive quantities');
    return units;
  });
  const totalTargetWeight = targetWeights.reduce((sum, weight) => sum + weight, 0n);
  if (totalTargetWeight <= 0n) throw new Error('Genealogy target quantity must be positive');

  const serialOrdinalByUnit = new Map<string, { ordinal: number; count: number }>();
  const serialByItem = new Map<string, WorkOrderGenealogySource[]>();
  for (const source of sources) {
    if (!source.unitId || !source.itemId || !source.unit.trim()) {
      throw new Error('Genealogy source identity, item and unit are required');
    }
    const units = quantityUnits(source.quantity, 'source.quantity');
    if (units <= 0n) throw new Error('Genealogy source quantity must be positive');
    if (source.unitType === 'SERIAL') {
      const group = serialByItem.get(source.itemId) ?? [];
      group.push(source);
      serialByItem.set(source.itemId, group);
    }
  }
  for (const group of serialByItem.values()) {
    group.forEach((source, ordinal) => serialOrdinalByUnit.set(source.unitId, { ordinal, count: group.length }));
  }

  const edges: WorkOrderGenealogyEdge[] = [];
  for (const source of sources) {
    const sourceUnits = quantityUnits(source.quantity, 'source.quantity');
    if (source.unitType === 'SERIAL') {
      const serial = serialOrdinalByUnit.get(source.unitId);
      if (!serial) throw new Error('Serialized genealogy source ordering is inconsistent');
      const midpoint = (BigInt(2 * serial.ordinal + 1) * totalTargetWeight) / BigInt(2 * serial.count);
      let cumulative = 0n;
      let targetIndex = targetWeights.length - 1;
      for (let index = 0; index < targetWeights.length; index += 1) {
        cumulative += targetWeights[index]!;
        if (midpoint < cumulative) {
          targetIndex = index;
          break;
        }
      }
      edges.push({
        sourceUnitId: source.unitId,
        targetUnitId: targets[targetIndex]!.unitId,
        quantity: formatQuantity(sourceUnits),
        relationshipType: targets[targetIndex]!.kind === 'SCRAP' ? 'PROCESSED_INTO' : 'CONSUMED_INTO',
      });
      continue;
    }

    let remaining = sourceUnits;
    for (let index = 0; index < targets.length; index += 1) {
      const allocated = index === targets.length - 1
        ? remaining
        : (sourceUnits * targetWeights[index]!) / totalTargetWeight;
      remaining -= allocated;
      if (allocated === 0n) continue;
      const target = targets[index]!;
      edges.push({
        sourceUnitId: source.unitId,
        targetUnitId: target.unitId,
        quantity: formatQuantity(allocated),
        relationshipType: target.kind === 'SCRAP' ? 'PROCESSED_INTO' : 'CONSUMED_INTO',
      });
    }
    if (remaining !== 0n) throw new Error('Genealogy allocation failed to conserve source quantity');
  }

  return edges;
}
