import { allocateWorkOrderOutputGenealogy, type WorkOrderGenealogySource, type WorkOrderGenealogyTarget } from './work-order-output-genealogy';

const source = (overrides: Partial<WorkOrderGenealogySource> = {}): WorkOrderGenealogySource => ({
  unitId: 'source-lot-1',
  itemId: 'material-1',
  unitType: 'LOT',
  unit: 'KG',
  quantity: '7.5000',
  ...overrides,
});

const target = (overrides: Partial<WorkOrderGenealogyTarget> = {}): WorkOrderGenealogyTarget => ({
  unitId: 'finished-lot-1',
  reportId: 'report-1',
  kind: 'FINISHED_GOOD',
  quantity: '6.0000',
  ...overrides,
});

describe('work-order output genealogy allocation', () => {
  it('conserves material-lot quantity across good output and scrap targets', () => {
    const edges = allocateWorkOrderOutputGenealogy(
      [source()],
      [target(), target({ unitId: 'scrap-1', reportId: 'report-2', kind: 'SCRAP', quantity: '2.0000' })],
    );

    expect(edges).toEqual([
      { sourceUnitId: 'source-lot-1', targetUnitId: 'finished-lot-1', quantity: '5.6250', relationshipType: 'CONSUMED_INTO' },
      { sourceUnitId: 'source-lot-1', targetUnitId: 'scrap-1', quantity: '1.8750', relationshipType: 'PROCESSED_INTO' },
    ]);
    expect(edges.reduce((sum, edge) => sum + BigInt(edge.quantity.replace('.', '')), 0n)).toBe(75000n);
  });

  it('conserves precision when a small lot allocation rounds to zero for an early batch', () => {
    const edges = allocateWorkOrderOutputGenealogy(
      [source({ quantity: '0.0001' })],
      [
        target({ quantity: '9999.0000' }),
        target({ unitId: 'finished-lot-2', reportId: 'report-2', quantity: '1.0000' }),
      ],
    );

    expect(edges).toEqual([
      { sourceUnitId: 'source-lot-1', targetUnitId: 'finished-lot-2', quantity: '0.0001', relationshipType: 'CONSUMED_INTO' },
    ]);
  });

  it('never splits one serialized material identity across multiple output batches', () => {
    const edges = allocateWorkOrderOutputGenealogy(
      [
        source({ unitId: 'serial-1', unitType: 'SERIAL', quantity: '1.0000' }),
        source({ unitId: 'serial-2', unitType: 'SERIAL', quantity: '1.0000' }),
      ],
      [
        target({ unitId: 'finished-lot-1', quantity: '2.0000' }),
        target({ unitId: 'finished-lot-2', reportId: 'report-2', quantity: '2.0000' }),
      ],
    );

    expect(edges).toHaveLength(2);
    expect(edges.every(edge => edge.quantity === '1.0000')).toBe(true);
    expect(new Set(edges.map(edge => edge.sourceUnitId)).size).toBe(2);
    expect(new Set(edges.map(edge => edge.targetUnitId))).toEqual(new Set(['finished-lot-1', 'finished-lot-2']));
  });

  it('fails closed when traced consumption has no output or scrap target', () => {
    expect(() => allocateWorkOrderOutputGenealogy([source()], [])).toThrow(
      'Traceable material consumption requires a finished-output or scrap genealogy target',
    );
    expect(allocateWorkOrderOutputGenealogy([], [])).toEqual([]);
  });

  it('rejects non-positive or malformed quantities', () => {
    expect(() => allocateWorkOrderOutputGenealogy([source({ quantity: '0.0000' })], [target()])).toThrow(
      'Genealogy source quantity must be positive',
    );
    expect(() => allocateWorkOrderOutputGenealogy([source()], [target({ quantity: '1.00001' })])).toThrow(
      'target[0].quantity must be a non-negative four-decimal quantity',
    );
  });
});
