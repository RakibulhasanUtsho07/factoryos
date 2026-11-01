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
    parent_columns: ['id'],
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

  it('handles only the reviewed blueprint, release-evaluation and evidence-revision cycles', () => {
    const ordered = resolveSaasTenantImportOrder(
      [
        'research_release_evaluations',
        'business_blueprints',
        'business_evidence',
        'business_blueprint_versions',
        'research_knowledge_releases',
      ],
      [
        fk('business_blueprint_versions', 'business_blueprints', {
          child_columns: ['blueprint_id', 'tenant_id', 'factory_id'],
          parent_columns: ['id', 'tenant_id', 'factory_id'],
        }),
        fk('business_blueprints', 'business_blueprint_versions', {
          constraint_name: 'fk_business_blueprints_current_version',
          child_columns: ['current_version_id', 'tenant_id', 'factory_id'],
          parent_columns: ['id', 'tenant_id', 'factory_id'],
        }),
        fk('research_release_evaluations', 'research_knowledge_releases', {
          constraint_name: 'fk_research_release_eval_release',
          child_columns: ['release_id', 'tenant_id', 'namespace'],
          parent_columns: ['id', 'tenant_id', 'namespace'],
        }),
        fk('research_knowledge_releases', 'research_release_evaluations', {
          constraint_name: 'fk_research_release_evaluation_owner',
          child_columns: ['evaluation_id', 'id'],
          parent_columns: ['id', 'release_id'],
        }),
        fk('business_evidence', 'business_evidence', {
          constraint_name: 'fk_business_evidence_supersedes_scope',
          child_columns: ['supersedes_evidence_id', 'tenant_id', 'factory_id'],
          parent_columns: ['id', 'tenant_id', 'factory_id'],
        }),
      ],
    );
    expect(ordered.indexOf('business_blueprints')).toBeLessThan(ordered.indexOf('business_blueprint_versions'));
    expect(ordered.indexOf('research_knowledge_releases')).toBeLessThan(ordered.indexOf('research_release_evaluations'));
    expect(ordered).toContain('business_evidence');
    expect(ordered).toHaveLength(5);
  });

  it('does not suppress reviewed constraint names when either ordered composite FK side drifts', () => {
    expect(() => resolveSaasTenantImportOrder(
      ['business_blueprints', 'business_blueprint_versions'],
      [
        fk('business_blueprint_versions', 'business_blueprints', {
          child_columns: ['blueprint_id', 'tenant_id', 'factory_id'],
          parent_columns: ['id', 'tenant_id', 'factory_id'],
        }),
        fk('business_blueprints', 'business_blueprint_versions', {
          constraint_name: 'fk_business_blueprints_current_version',
          child_columns: ['current_version_id', 'tenant_id', 'factory_id', 'owner_version_id'],
          parent_columns: ['id', 'tenant_id', 'factory_id', 'owner_version_id'],
        }),
      ],
    )).toThrow(/unhandled non-deferrable FK cycle/i);

    expect(() => resolveSaasTenantImportOrder(
      ['research_knowledge_releases', 'research_release_evaluations'],
      [
        fk('research_release_evaluations', 'research_knowledge_releases', {
          constraint_name: 'fk_research_release_eval_release',
          child_columns: ['release_id', 'tenant_id', 'namespace'],
          parent_columns: ['id', 'tenant_id', 'namespace'],
        }),
        fk('research_knowledge_releases', 'research_release_evaluations', {
          constraint_name: 'fk_research_release_evaluation_owner',
          child_columns: ['evaluation_id', 'id'],
          parent_columns: ['release_id', 'id'],
        }),
      ],
    )).toThrow(/unhandled non-deferrable FK cycle/i);

    expect(() => resolveSaasTenantImportOrder(['business_evidence'], [
      fk('business_evidence', 'business_evidence', {
        constraint_name: 'fk_business_evidence_supersedes_scope',
        child_columns: ['supersedes_evidence_id', 'tenant_id', 'factory_id'],
        parent_columns: ['supersedes_evidence_id', 'tenant_id', 'factory_id'],
      }),
    ])).toThrow(/unhandled non-deferrable FK cycle/i);
  });

  it('does not suppress a blueprint cycle on a different FK column or constraint', () => {
    expect(() => resolveSaasTenantImportOrder(
      ['business_blueprints', 'business_blueprint_versions'],
      [
        fk('business_blueprint_versions', 'business_blueprints', { child_columns: ['blueprint_id'] }),
        fk('business_blueprints', 'business_blueprint_versions', {
          constraint_name: 'fk_unreviewed_blueprint_pointer', child_columns: ['owner_version_id'],
        }),
      ],
    )).toThrow(ServiceUnavailableException);
  });

  it('does not suppress an unknown self-reference or unknown research release cycle', () => {
    expect(() => resolveSaasTenantImportOrder(['business_evidence'], [
      fk('business_evidence', 'business_evidence', { constraint_name: 'fk_unreviewed_evidence_self', child_columns: ['parent_id'] }),
    ])).toThrow(ServiceUnavailableException);

    expect(() => resolveSaasTenantImportOrder(['research_knowledge_releases', 'research_release_evaluations'], [
      fk('research_release_evaluations', 'research_knowledge_releases', { constraint_name: 'fk_research_release_eval_release' }),
      fk('research_knowledge_releases', 'research_release_evaluations', { constraint_name: 'fk_unreviewed_release_pointer', child_columns: ['evaluation_id'] }),
    ])).toThrow(ServiceUnavailableException);
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
    expect(() => resolveSaasTenantImportOrder(['orders'], [{ ...fk('orders', 'orders'), parent_columns: [] }]))
      .toThrow(ServiceUnavailableException);
  });
});