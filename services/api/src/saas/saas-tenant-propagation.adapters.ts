import { SaasTransferDatasetCategory } from './dto/create-saas-schema-compatibility-rule.dto';

export const SAAS_TENANT_EXTERNAL_PROPAGATION_ADAPTERS = Symbol('SAAS_TENANT_EXTERNAL_PROPAGATION_ADAPTERS');
export const SAAS_TENANT_FINANCE_RETENTION_ADAPTER = Symbol('SAAS_TENANT_FINANCE_RETENTION_ADAPTER');

export const REQUIRED_EXTERNAL_STORE_KINDS = [
  'OBJECT_STORAGE',
  'CACHE',
  'SEARCH_INDEX',
  'VECTOR_STORE',
  'LEARNING_ARTIFACT',
  'EXTERNAL_PROVIDER',
  'REPLICA',
  'BACKUP',
] as const;

export type SaasExternalStoreKind = typeof REQUIRED_EXTERNAL_STORE_KINDS[number];

export interface SaasTenantExternalDataTarget {
  tenantId: string;
  targetId: string;
  storeKind: SaasExternalStoreKind;
  adapterKey: string;
  configReference: string;
  categories: SaasTransferDatasetCategory[];
  required: boolean;
}

export type SaasExternalPropagationOutcome =
  | 'COMPLETED'
  | 'BLOCKED'
  | 'RETAINED'
  | 'FAILED_RETRYABLE';

export type SaasExternalManifestKind = 'RESOURCE_IDENTITIES' | 'SCOPE_INTENT';

export interface SaasExternalPropagationContext {
  tenantId: string;
  requestId: string;
  requestVersion: number;
  runId: string;
  categories: SaasTransferDatasetCategory[];
  /** Immutable, latest DELETE retention-policy version captured for every category. */
  policyVersions: Record<string, number>;
  sourceExportDigest: string;
  sourceManifest: Record<string, unknown>;
  idempotencyKey: string;
  target: SaasTenantExternalDataTarget;
}

/** A non-destructive capability/policy probe; it never authorizes mutation by itself. */
export interface SaasExternalPropagationPreflight {
  outcome: 'READY' | 'BLOCKED' | 'RETAINED';
  resourceClass: string;
  adapterVersion: string;
  maxPageSize: number;
  maxBatchSize: number;
  reason?: string;
}

export interface SaasExternalPropagationPlan {
  /** SHA-256 of the exact sorted external object/record identity manifest. */
  manifestDigest: string;
  plannedCopies: string;
  /** Opaque provider-side snapshot/cursor reference; never a raw URL or credential. */
  planReference: string;
}

export interface SaasExternalPropagationDeleteReceipt {
  deletedCopies: string;
  /** Must equal the prepare() manifest digest, proving the exact planned scope was acted on. */
  manifestDigest: string;
  providerReceiptReference: string;
}

export interface SaasExternalPropagationVerification {
  verifiedManifestDigest: string;
  residualCopies: string;
  /** Opaque object identifiers only; never include payloads, tokens, connection strings or keys. */
  residualReferences: string[];
  verificationReference: string;
}

export interface SaasTenantExternalDataPropagationAdapter {
  readonly storeKind: SaasExternalStoreKind;
  readonly adapterKey: string;
  /** Semver-like immutable implementation version; written into every receipt. */
  readonly adapterVersion: string;

  /** Resolves the opaque config reference through deployment secret/config management. */
  isConfigured(target: SaasTenantExternalDataTarget): Promise<boolean>;

  /**
   * Non-destructive capability/policy preflight. Page and batch sizes are hard upper bounds;
   * the orchestrator rejects unbounded, missing, or out-of-range declarations.
   */
  preflight(input: SaasExternalPropagationContext): Promise<SaasExternalPropagationPreflight>;

  /**
   * Dry-run: enumerate every known copy for the tenant/category scope and snapshot exact identities.
   * This operation must be non-destructive and use bounded pages/batches. Include applicable
   * replicas, object versions, tombstones, vector metadata and delayed-delete queues; incomplete
   * enumeration must reject the request.
   */
  prepare(input: SaasExternalPropagationContext): Promise<SaasExternalPropagationPlan>;

  /**
   * Execute only the prepared identities. Retrying the same run/target key must reconcile the
   * prior attempt instead of widening scope or double-counting removals.
   */
  execute(input: SaasExternalPropagationContext & { plan: SaasExternalPropagationPlan }): Promise<SaasExternalPropagationDeleteReceipt>;

  /**
   * Independently read back the scope after deletion, reconcile provider receipts and report residuals.
   * VERIFIED is allowed only when the digest matches and residualCopies is exactly zero.
   */
  verify(input: SaasExternalPropagationContext & {
    plan: SaasExternalPropagationPlan;
    deletion: SaasExternalPropagationDeleteReceipt;
  }): Promise<SaasExternalPropagationVerification>;

  /**
   * Recover an uncertain previous attempt using the stable idempotency key and provider-side receipt.
   * This runs before re-issuing erase after a timeout or process crash.
   */
  recover(input: SaasExternalPropagationContext & { plan?: SaasExternalPropagationPlan }): Promise<void>;
}

export interface SaasFinanceRetentionContext {
  tenantId: string;
  policyVersion: number;
  retentionDays: number;
  cutoffAt: string;
  legalBasis: string;
  adapterKey: string;
  idempotencyKey: string;
  reason: string;
}

export interface SaasFinanceRetentionResult {
  plannedRows: string;
  deletedRows: string;
  residualRows: string;
  tableManifest: Record<string, unknown>;
  manifestDigest: string;
  adapterReceiptReference: string;
}

export interface SaasTenantFinanceRetentionAdapter {
  readonly adapterKey: string;
  isConfigured(tenantId: string): Promise<boolean>;
  dryRun(context: SaasFinanceRetentionContext): Promise<SaasFinanceRetentionResult>;
  execute(context: SaasFinanceRetentionContext): Promise<SaasFinanceRetentionResult>;
  /** Must independently verify ledger scope, deletion counts, digest, and residual rows. */
  verify(context: SaasFinanceRetentionContext, result: SaasFinanceRetentionResult): Promise<{
    verifiedManifestDigest: string;
    residualRows: string;
    verificationReference: string;
  }>;
}
