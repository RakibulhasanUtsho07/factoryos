import { createHash } from 'node:crypto';
import {
  capturePostgresqlWalPitrProviderInventory,
  POSTGRESQL_WAL_PITR_PROVIDER_SOURCE_KINDS,
  POSTGRESQL_WAL_PITR_PROVIDER_CAPTURE_SCHEMA,
  scanPostgresqlWalPitrResidualsIndependently,
  POSTGRESQL_WAL_PITR_RESIDUAL_SCAN_SCHEMA,
  type PostgresqlWalPitrIndependentResidualGateway,
  type PostgresqlWalPitrProviderInventoryGateway,
  type PostgresqlWalPitrProviderScope,
  type PostgresqlWalPitrProviderScopeDiscovery,
  type PostgresqlWalPitrResidualIdentity,
} from './postgresql-wal-pitr-provider-evidence';

const scopeA: PostgresqlWalPitrProviderScope = {
  provider_reference: 'provider.aws.primary',
  account_reference: 'account.production-a',
  region_reference: 'region.ap-southeast-1',
};
const scopeB: PostgresqlWalPitrProviderScope = {
  provider_reference: 'provider.aws.primary',
  account_reference: 'account.production-b',
  region_reference: 'region.ap-south-1',
};
const scopes = [scopeB, scopeA];
const principal = 'principal.wal-inventory-reader';
const now = new Date('2026-11-02T04:00:00.000Z');
const tenantId = '31000000-0000-4000-8000-000000000001';
const inventoryId = '31000000-0000-4000-8000-000000000002';
const candidate: PostgresqlWalPitrResidualIdentity = {
  candidate_reference: 'candidate.pg.archive.one.segment-01',
  archive_reference: 'archive.pg.primary',
  object_reference: 'object.wal.segment-01',
  generation_reference: 'generation.object.0001',
};

function discovery(overrides: Partial<PostgresqlWalPitrProviderScopeDiscovery> = {}):
PostgresqlWalPitrProviderScopeDiscovery {
  return {
    scopes,
    principal_reference: principal,
    discovery_reference: 'audit.provider.scope-discovery',
    provider_policy_audit_reference: 'audit.provider.readonly-policy',
    discovery_audit_reference: 'audit.provider.scope-query',
    read_only_access_verified: true,
    all_accounts_discovered: true,
    all_regions_discovered: true,
    pagination_exhausted: true,
    pages_fetched: 3,
    ...overrides,
  };
}

function inventoryGateway(
  options: {
    discovery?: Partial<PostgresqlWalPitrProviderScopeDiscovery>;
    nextToken?: string;
    repeatToken?: boolean;
    duplicateReference?: boolean;
    nonReadOnly?: boolean;
    outsideScope?: boolean;
    sensitiveValue?: boolean;
  } = {},
): PostgresqlWalPitrProviderInventoryGateway {
  const calls = new Map<string, number>();
  return {
    discoverScopes: async () => discovery(options.discovery),
    listSourcePage: async ({ source_kind, scope, page_token }) => {
      const key = source_kind + ':' + scope.account_reference;
      const count = (calls.get(key) ?? 0) + 1;
      calls.set(key, count);
      const returnedScope = options.outsideScope ? scopeA : scope;
      const reference = options.duplicateReference ? 'same.provider.item'
        : source_kind.toLowerCase() + '.' + scope.account_reference;
      const value: Record<string, unknown> = options.sensitiveValue
        ? { archive_reference: 'archive.one', secret_access_key: 'do-not-capture' }
        : { resource_reference: reference, discovered: true, object_count: 2 };
      const next = options.repeatToken ? 'cursor.loop'
        : options.nextToken && page_token === null ? options.nextToken : null;
      if (options.nextToken && page_token !== null) {
        return {
          scope, principal_reference: principal, read_only_access_verified: true,
          audit_reference: 'audit.provider.page.' + count,
          items: [{ reference: reference + '.page2', value }],
          next_page_token: null,
        };
      }
      return {
        scope: returnedScope,
        principal_reference: principal,
        read_only_access_verified: !options.nonReadOnly,
        audit_reference: 'audit.provider.page.' + count,
        items: [{ reference, value }],
        next_page_token: next,
      };
    },
  };
}

function captureInput() {
  return {
    tenant_id: tenantId,
    category_code: 'CUSTOMER_DATA',
    inventory_id: inventoryId,
    collection_run_reference: 'run.wal.capture.20261102',
    now,
  };
}

function expectedScopeDigest(): string {
  const canonicalScopes = [...scopes].sort((left, right) => {
    const a = [left.provider_reference, left.account_reference, left.region_reference].join('\u0000');
    const b = [right.provider_reference, right.account_reference, right.region_reference].join('\u0000');
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return createHash('sha256').update(JSON.stringify(canonicalScopes), 'utf8').digest('hex');
}

function residualGateway(options: {
  discovery?: Partial<PostgresqlWalPitrProviderScopeDiscovery>;
  principal?: string;
  items?: PostgresqlWalPitrResidualIdentity[];
  nextToken?: string;
  repeatToken?: boolean;
  nonReadOnly?: boolean;
  duplicateItems?: boolean;
  outsideScope?: boolean;
} = {}): PostgresqlWalPitrIndependentResidualGateway {
  const calls = new Map<string, number>();
  return {
    discoverScopes: async () => discovery({
      ...options.discovery,
      principal_reference: options.principal ?? 'principal.independent.residual-reader',
    }),
    listResidualPage: async ({ scope, page_token }) => {
      const key = scope.account_reference;
      const count = (calls.get(key) ?? 0) + 1;
      calls.set(key, count);
      const returnedItems = options.duplicateItems
        ? [candidate, candidate]
        : options.items ?? [];
      return {
        scope: options.outsideScope ? scopeA : scope,
        principal_reference: options.principal ?? 'principal.independent.residual-reader',
        read_only_access_verified: !options.nonReadOnly,
        audit_reference: 'audit.provider.independent-residual.' + count,
        items: options.nextToken && page_token === null ? [] : returnedItems,
        next_page_token: options.repeatToken ? 'cursor.loop'
          : options.nextToken && page_token === null ? options.nextToken : null,
      };
    },
  };
}

function residualInput() {
  return {
    tenant_id: tenantId,
    expected_provider_scopes: scopes,
    expected_scope_sha256: expectedScopeDigest(),
    candidate_identities: [candidate],
    inventory_collector_principal_reference: principal,
    deletion_executor_principal_reference: 'principal.wal-deletion-executor',
    archive_writer_principal_references: ['principal.pg-archive-writer'],
    verification_reference: 'verification.wal.residual.001',
    now,
  };
}

describe('PostgreSQL WAL/PITR provider inventory capture contract', () => {
  it('enumerates all six catalogs across every discovered account/region using bounded read-only pages', async () => {
    const result = await capturePostgresqlWalPitrProviderInventory(inventoryGateway(), captureInput());

    expect(result.schema).toBe(POSTGRESQL_WAL_PITR_PROVIDER_CAPTURE_SCHEMA);
    expect(result.status).toBe('ENUMERATION_COMPLETE_UNATTESTED');
    expect(result.tenant_id).toBe(tenantId);
    expect(result.provider_scopes).toEqual([scopeA, scopeB]);
    expect(result.source_captures.map((source) => source.source_kind))
      .toEqual([...POSTGRESQL_WAL_PITR_PROVIDER_SOURCE_KINDS]);
    expect(result.source_captures.every((source) => source.pages_fetched === 2)).toBe(true);
    expect(result.source_captures.every((source) => source.item_count === 2)).toBe(true);
    expect(result.provider_native_inventory_complete).toBe(false);
    expect(result.source_receipts_signable).toBe(false);
    expect(result.manifest_eligible).toBe(false);
  });

  it('exhausts continuation pages and never returns opaque provider page tokens', async () => {
    const result = await capturePostgresqlWalPitrProviderInventory(
      inventoryGateway({ nextToken: 'cursor.page.2' }), captureInput(),
    );
    expect(result.source_captures.every((source) => source.pages_fetched === 4)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('cursor.page.2');
  });

  it('fails closed when account/region discovery is incomplete', async () => {
    await expect(capturePostgresqlWalPitrProviderInventory(
      inventoryGateway({ discovery: { all_accounts_discovered: false } }), captureInput(),
    )).rejects.toThrow(/account\/project or region discovery is incomplete/);
  });

  it('fails closed when provider IAM read-only evidence is absent', async () => {
    await expect(capturePostgresqlWalPitrProviderInventory(
      inventoryGateway({ discovery: { read_only_access_verified: false } }), captureInput(),
    )).rejects.toThrow(/not verified read-only/);
  });

  it('fails closed when an individual source page claims write-capable access', async () => {
    await expect(capturePostgresqlWalPitrProviderInventory(
      inventoryGateway({ nonReadOnly: true }), captureInput(),
    )).rejects.toThrow(/unexpected or non-read-only collector identity/);
  });

  it('rejects pages returned for an account/region outside the requested scope', async () => {
    await expect(capturePostgresqlWalPitrProviderInventory(
      inventoryGateway({ outsideScope: true }), captureInput(),
    )).rejects.toThrow(/outside the requested provider\/account\/region scope/);
  });

  it('rejects repeated pagination tokens instead of looping forever', async () => {
    await expect(capturePostgresqlWalPitrProviderInventory(
      inventoryGateway({ repeatToken: true }), captureInput(),
    )).rejects.toThrow(/repeated continuation token/);
  });

  it('rejects duplicate source identities across provider scopes', async () => {
    await expect(capturePostgresqlWalPitrProviderInventory(
      inventoryGateway({ duplicateReference: true }), captureInput(),
    )).rejects.toThrow(/duplicate provider item reference/);
  });

  it('rejects sensitive provider fields and oversized normalized records', async () => {
    await expect(capturePostgresqlWalPitrProviderInventory(
      inventoryGateway({ sensitiveValue: true }), captureInput(),
    )).rejects.toThrow(/sensitive field name/);
  });

  it('rejects malformed tenant/inventory identities and unbounded scan parameters', async () => {
    await expect(capturePostgresqlWalPitrProviderInventory(
      inventoryGateway(), { ...captureInput(), tenant_id: 'not-a-uuid' },
    )).rejects.toThrow(/tenant, inventory and category identity are invalid/);
    await expect(capturePostgresqlWalPitrProviderInventory(
      inventoryGateway(), { ...captureInput(), page_size: 5000 },
    )).rejects.toThrow(/outside supported limits/);
  });
});

describe('PostgreSQL WAL/PITR independent residual verification contract', () => {
  it('returns ZERO_RESIDUALS_OBSERVED only after a complete independent read-only scan of the exact provider scope', async () => {
    const result = await scanPostgresqlWalPitrResidualsIndependently(
      residualGateway(), residualInput(),
    );
    expect(result.schema).toBe(POSTGRESQL_WAL_PITR_RESIDUAL_SCAN_SCHEMA);
    expect(result.status).toBe('ZERO_RESIDUALS_OBSERVED');
    expect(result.pages_fetched).toBe(2);
    expect(result.copies_scanned).toBe(0);
    expect(result.residuals).toEqual([]);
    expect(result.independent_verifier_principal_reference).toBe('principal.independent.residual-reader');
    expect(result.destructive_action_permitted).toBe(false);
    expect(result.deletion_authorized).toBe(false);
    expect(result.requires_independent_review).toBe(true);
  });

  it('reports an exact matching immutable object generation as residual', async () => {
    const result = await scanPostgresqlWalPitrResidualsIndependently(
      residualGateway({ items: [candidate] }), residualInput(),
    );
    expect(result.status).toBe('RESIDUALS_FOUND');
    expect(result.residuals).toEqual([candidate]);
  });

  it('does not match a different object version as the candidate residual', async () => {
    const result = await scanPostgresqlWalPitrResidualsIndependently(
      residualGateway({ items: [{ ...candidate, generation_reference: 'generation.object.0002' }] }),
      residualInput(),
    );
    expect(result.status).toBe('ZERO_RESIDUALS_OBSERVED');
  });

  it('rejects reuse of the inventory collector, deletion executor or archive writer principal', async () => {
    for (const identity of [
      principal,
      'principal.wal-deletion-executor',
      'principal.pg-archive-writer',
    ]) {
      await expect(scanPostgresqlWalPitrResidualsIndependently(
        residualGateway({ principal: identity }), residualInput(),
      )).rejects.toThrow(/reuses an inventory, deletion or archive-writer principal/);
    }
  });

  it('rejects a different account/region inventory from the original sealed scope', async () => {
    await expect(scanPostgresqlWalPitrResidualsIndependently(
      residualGateway({ discovery: { scopes: [scopeA] } }), residualInput(),
    )).rejects.toThrow(/exact expected provider\/account\/region scope/);
  });

  it('requires the independent residual gateway itself to be read-only', async () => {
    await expect(scanPostgresqlWalPitrResidualsIndependently(
      residualGateway({ discovery: { read_only_access_verified: false } }), residualInput(),
    )).rejects.toThrow(/not verified read-only/);
    await expect(scanPostgresqlWalPitrResidualsIndependently(
      residualGateway({ nonReadOnly: true }), residualInput(),
    )).rejects.toThrow(/did not use its verified read-only principal/);
  });

  it('rejects repeated residual page tokens and duplicate residual object generations', async () => {
    await expect(scanPostgresqlWalPitrResidualsIndependently(
      residualGateway({ repeatToken: true }), residualInput(),
    )).rejects.toThrow(/repeated continuation token/);
    await expect(scanPostgresqlWalPitrResidualsIndependently(
      residualGateway({ duplicateItems: true }), residualInput(),
    )).rejects.toThrow(/duplicate object generation/);
  });

  it('rejects malformed candidate object-generation identities', async () => {
    await expect(scanPostgresqlWalPitrResidualsIndependently(
      residualGateway(), { ...residualInput(), candidate_identities: [{ ...candidate, generation_reference: '' }] },
    )).rejects.toThrow(/generation reference must be a non-secret opaque reference/);
  });

  it('rejects a scope digest that does not bind the expected provider scopes', async () => {
    await expect(scanPostgresqlWalPitrResidualsIndependently(
      residualGateway(), { ...residualInput(), expected_scope_sha256: 'a'.repeat(64) },
    )).rejects.toThrow(/scope digest does not match its canonical scope/);
  });
});
