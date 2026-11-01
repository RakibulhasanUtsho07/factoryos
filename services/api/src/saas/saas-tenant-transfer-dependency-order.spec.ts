import { ServiceUnavailableException } from '@nestjs/common';
import { resolveSaasTenantImportOrder } from './saas-tenant-transfer-dependency-order';
import type { SaasTenantImportForeignKey } from './saas-tenant-transfer-dependency-order';

function fk(
  child_table: string,
  parent_table: string,
  overrides: Partial<SaasTenantImportForeignKey> = {},
): SaasTenantImportForeignKey {
  return {
    child_table,
    parent_table,
    constraint_name: child_table + '_' + parent_table + '_fk',
    is_deferrable: false,
    child_columns: ['parent_id'],
    ...overrides,
  };
}

describe('resolveSaasTenantImportOrder', () => {
  it('orders parents before children using the live destination FK graph', () => {
    const ordered = resolveSaasTenantImportOrder(
      ['order_lines', 'orders', 'factories', 'legal_entities'],
      [fk('orders', 'factories'), fk('orders', 'legal_entities'), fk('order_lines', 'orders')],
    );
    expect(ordered.indexOf('factories')).toBeLessThan(ordered.indexOf('orders'));
    expect(ordered.indexOf('legal_entities')).toBeLessThan(ordered.indexOf('orders'));
    expect(ordered.indexOf('orders')).toBeLessThan(ordered.indexOf('order_lines'));
    expect(ordered).toHaveLength(4);
    expect(new Set(ordered)).toEqual(new Set(['order_lines', 'orders', 'factories', 'legal_entities']));
  });

  it('deduplicates parallel FK edges and defers deferrable constraints', () => {
    const ordered = resolveSaasTenantImportOrder(
      ['child', 'independent', 'parent'],
      [
        fk('child', 'parent', { constraint_name: 'child_parent_fk_a' }),
        fk('child', 'parent', { constraint_name: 'child_parent_fk_b', child_columns: ['other_parent_id'] }),
        fk('child', 'independent', { is_deferrable: true }),
      ],
    );
    expect(ordered).toEqual(['independent', 'parent', 'child']);
  });

  it('breaks only the reviewed blueprint current-version pointer cycle', () => {
    const ordered = resolveSaasTenantImportOrder(
      ['business_blueprints', 'business_blueprint_versions'],
      [
        fk('business_blueprint_versions', 'business_blueprints', { child_columns: ['blueprint_id'] }),
        fk('business_blueprints', 'business_blueprint_versions', { child_columns: ['current_version_id'] }),
      ],
    );
    expect(ordered).toEqual(['business_blueprints', 'business_blueprint_versions']);
  });

  it('does not suppress a different blueprint FK cycle', () => {
    expect(() => resolveSaasTenantImportOrder(
      ['business_blueprints', 'business_blueprint_versions'],
      [
        fk('business_blueprint_versions', 'business_blueprints', { child_columns: ['blueprint_id'] }),
        fk('business_blueprints', 'business_blueprint_versions', { child_columns: ['owner_version_id'] }),
      ],
    )).toThrow(ServiceUnavailableException);
  });

  it('fails closed on any remaining non-deferrable FK cycle', () => {
    expect(() => resolveSaasTenantImportOrder(
      ['a', 'b', 'c'],
      [fk('a', 'b'), fk('b', 'c'), fk('c', 'a')],
    )).toThrow(/unhandled non-deferrable FK cycle/i);
  });

  it('rejects duplicate table names and malformed catalog rows', () => {
    expect(() => resolveSaasTenantImportOrder(['orders', 'orders'], []))
      .toThrow(ServiceUnavailableException);
    expect(() => resolveSaasTenantImportOrder(['orders'], [{ ...fk('orders', 'orders'), child_columns: [] }]))
      .toThrow(ServiceUnavailableException);
  });
});