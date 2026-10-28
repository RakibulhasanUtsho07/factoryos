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

export interface SaasExternalPropagationContext {
  tenantId: string;
  requestId: string;
  requestVersion: number;
  runId: string;
  categories: SaasTransferDatasetCategory[];
  sourceExportDigest: string;
  sourceManifest: Record<string, unknown>;
  idempotencyKey: string;
  target: SaasTenantExternalDataTarget;
}

import { createHash } from 'node:crypto';

export interface SaasExternalPropagationResourceIdentity {
  /** Provider-specific resource class within one store target, never a payload. */
  resourceKind: string;
  /** Opaque stable provider identity; URLs, paths to credentials and secrets are forbidden. */
  resourceReference: string;
  /** Optional opaque immutable provider version/generation identity. */
  resourceVersionReference?: string | null;
  /** Optional SHA-256 of the exact provider bytes captured before mutation. */
  resourceContentDigest?: string | null;
}

/**
 * Canonical digest shared by adapters and the erasure ledger. Fields are normalized
 * to an explicit nullable version reference and sorted bytewise, not locale-wise.
 */
export function canonicalizeSaasExternalPropagationResources(
  resources: SaasExternalPropagationResourceIdentity[],
): Array<{
  resourceKind: string;
  resourceReference: string;
  resourceVersionReference: string | null;
  resourceContentDigest: string | null;
}> {
  return resources.map((resource) => ({
    resourceKind: resource.resourceKind,
    resourceReference: resource.resourceReference,
    resourceVersionReference: resource.resourceVersionReference ?? null,
    resourceContentDigest: resource.resourceContentDigest ?? null,
  })).sort((left, right) => {
    const fields: Array<keyof typeof left> = [
      'resourceKind', 'resourceReference', 'resourceVersionReference', 'resourceContentDigest',
    ];
    for (const field of fields) {
      const a = left[field] ?? '';
      const b = right[field] ?? '';
      if (a < b) return -1;
      if (a > b) return 1;
    }
    return 0;
  });
}

export function digestSaasExternalPropagationResources(
  resources: SaasExternalPropagationResourceIdentity[],
): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeSaasExternalPropagationResources(resources)), 'utf8')
    .digest('hex');
}

export interface SaasExternalPropagationPlan {
  /** SHA-256 of canonicalizeSaasExternalPropagationResources(resources). */
  manifestDigest: string;
  /** Must equal resources.length; the service independently checks both values. */
  plannedCopies: string;
  /** Opaque provider-side snapshot/cursor reference; never a raw URL or credential. */
  planReference: string;
  /** Semantic version of the exact adapter implementation/policy contract. */
  adapterVersion: string;
  /** Kind of resource represented in this provider's bounded identity list. */
  resourceClass: string;
  /** Provider's maximum identity enumeration page size. */
  maxPageSize: number;
  /** Maximum number of ledger identities inserted per database batch. */
  maxBatchSize: number;
  /** Small object of non-secret policy/version labels used for the delete decision. */
  policyVersions: Record<string, string>;
  /**
   * Complete, duplicate-free identity set covered by manifestDigest. The adapter
   * must refuse preparation if provider enumeration is incomplete; the service
   * seals these identities before it issues any destructive operation.
   */
  resources: SaasExternalPropagationResourceIdentity[];
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
  /** Build/version contract must match every plan this adapter creates or resumes. */
  readonly adapterVersion: string;

  /** Resolves the opaque config reference through deployment secret/config management. */
  isConfigured(target: SaasTenantExternalDataTarget): Promise<boolean>;

  /**
   * Enumerate every known copy for the tenant/category scope and snapshot the exact identity set.
   * Adapters must include replicas, versioned objects, tombstones, vector metadata and delayed-delete
   * queues applicable to their store; incomplete enumeration must reject the request.
   */
  prepare(input: SaasExternalPropagationContext): Promise<SaasExternalPropagationPlan>;

  /**
   * Idempotently delete exactly the prepared identities. Retrying the same run/target key must
   * reconcile the prior attempt instead of widening scope or double-counting removals.
   */
  erase(input: SaasExternalPropagationContext & { plan: SaasExternalPropagationPlan }): Promise<SaasExternalPropagationDeleteReceipt>;

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
