import { compareEngineeringSnapshots, type EngineeringSnapshot } from './engineering-change-policy';

function revision(id: string, version: number, bomQuantity: string, skill: string, yieldPercent: string): EngineeringSnapshot {
  return {
    version: { id, number: version, expected_yield_percent: yieldPercent, change_summary: 'revision ' + version },
    bom: [{ line_number: 1, component_item_id: 'component-a', base_quantity_per: bomQuantity, wastage_percent: '2.0000' }],
    alternates: [{ bom_line_id: 'bom-1', alternate_item_id: 'component-b', status: 'APPROVED' }],
    routing: [{ step_number: 1, work_centre_id: 'line-a', run_minutes_per_unit: '3.0000', required_skill: skill }],
  };
}

describe('engineering revision comparison', () => {
  it('classifies BOM, alternate, routing and specification changes', () => {
    const source = revision('source', 1, '2.0000', 'sewing', '98.0000');
    const target = revision('target', 2, '2.2500', 'sewing-specialist', '96.0000');
    const result = compareEngineeringSnapshots(source, target);
    expect(result.bom_changed).toBe(true);
    expect(result.alternate_materials_changed).toBe(false);
    expect(result.routing_changed).toBe(true);
    expect(result.specification_changed).toBe(true);
    expect(result.any_change).toBe(true);
  });

  it('canonicalizes object key order and detects a genuine no-op revision', () => {
    const source = revision('source', 1, '2.0000', 'sewing', '100.0000');
    const target = revision('target', 2, '2.0000', 'sewing', '100.0000');
    target.bom = [{ wastage_percent: '2.0000', base_quantity_per: '2.0000', component_item_id: 'component-a', line_number: 1 }];
    const result = compareEngineeringSnapshots(source, target);
    expect(result.bom_changed).toBe(false);
    expect(result.routing_changed).toBe(false);
    expect(result.specification_changed).toBe(false);
    expect(result.any_change).toBe(false);
  });
});
