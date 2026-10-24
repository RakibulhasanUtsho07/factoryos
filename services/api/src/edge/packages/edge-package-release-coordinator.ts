import type { EdgePackageActivationResult, EdgePackageActivationStore } from './edge-package-activation.store.js';
import {
  verifyEdgePackage,
  type EdgePackageVerificationPolicy,
  type SignedEdgePackageInput,
} from './edge-package-manifest-verifier.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PACKAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PACKAGE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const USE_CASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

export interface EdgePackageActivationScope {
  tenantId: string;
  factoryId: string;
  packageId: string;
  version: string;
  useCaseId?: string;
  allowedToolIds: ReadonlySet<string>;
  now?: Date;
  maxClockSkewMs?: number;
  maxPackageLifetimeMs?: number;
  maxTotalArtifactBytes?: number;
}

export interface EdgePackageActivationRuntime {
  isPackageExecutionAllowed(packageId: string, version: string, useCaseId?: string): boolean;
  createPackageVerificationPolicy(
    policy: Omit<EdgePackageVerificationPolicy, 'trustedSigningKeys'>,
  ): EdgePackageVerificationPolicy;
}

export type EdgePackageActivationStorePort = Pick<EdgePackageActivationStore, 'activate'>;

export type EdgePackageActivationCoordinatorErrorCode =
  | 'INVALID_ACTIVATION_SCOPE'
  | 'PACKAGE_SCOPE_MISMATCH'
  | 'PACKAGE_CONTROL_DENIED';

export class EdgePackageActivationCoordinatorError extends Error {
  constructor(readonly code: EdgePackageActivationCoordinatorErrorCode, message: string) {
    super(message);
    this.name = 'EdgePackageActivationCoordinatorError';
  }
}

/**
 * Mandatory host-facing path for governed package activation.
 *
 * The requested package/version comes from the deployment's explicit target
 * scope, not from an untrusted manifest. The manifest must match that scope;
 * the runtime's fresh control decision must be ACTIVE; and the store then
 * independently verifies the signed manifest and artifact bytes before any
 * filesystem state is changed.
 */
export class EdgePackageReleaseCoordinator {
  constructor(
    private readonly activationStore: EdgePackageActivationStorePort,
    private readonly runtime: EdgePackageActivationRuntime,
  ) {}

  async activate(
    input: SignedEdgePackageInput,
    scope: EdgePackageActivationScope,
  ): Promise<EdgePackageActivationResult> {
    this.assertScope(scope);
    this.assertManifestScope(input, scope);

    // Polling state must be current and exact for this package release.
    // Unknown, stale, paused, failed, absent and revoked decisions all deny.
    if (!this.runtime.isPackageExecutionAllowed(scope.packageId, scope.version, scope.useCaseId)) {
      throw new EdgePackageActivationCoordinatorError(
        'PACKAGE_CONTROL_DENIED',
        'The package cannot be activated without a fresh ACTIVE package-control decision',
      );
    }

    // Construct the signing policy only after the control check so a recent
    // signer revocation or failed synchronization is reflected in the policy.
    const policyInput: Omit<EdgePackageVerificationPolicy, 'trustedSigningKeys'> = {
      tenantId: scope.tenantId,
      factoryId: scope.factoryId,
      allowedToolIds: scope.allowedToolIds,
      ...(scope.now === undefined ? {} : { now: scope.now }),
      ...(scope.maxClockSkewMs === undefined ? {} : { maxClockSkewMs: scope.maxClockSkewMs }),
      ...(scope.maxPackageLifetimeMs === undefined
        ? {}
        : { maxPackageLifetimeMs: scope.maxPackageLifetimeMs }),
      ...(scope.maxTotalArtifactBytes === undefined
        ? {}
        : { maxTotalArtifactBytes: scope.maxTotalArtifactBytes }),
    };
    const policy = this.runtime.createPackageVerificationPolicy(policyInput);

    // The activation store performs the cryptographic and artifact-integrity
    // checks again; failed verification never changes its active pointer.
    return this.activationStore.activate(input, policy);
  }

  private assertScope(scope: EdgePackageActivationScope): void {
    if (
      !scope ||
      typeof scope !== 'object' ||
      !UUID_PATTERN.test(scope.tenantId) ||
      !UUID_PATTERN.test(scope.factoryId) ||
      !PACKAGE_ID_PATTERN.test(scope.packageId) ||
      !PACKAGE_VERSION_PATTERN.test(scope.version) ||
      (scope.useCaseId !== undefined && !USE_CASE_ID_PATTERN.test(scope.useCaseId)) ||
      !scope.allowedToolIds ||
      typeof scope.allowedToolIds.has !== 'function'
    ) {
      throw new EdgePackageActivationCoordinatorError(
        'INVALID_ACTIVATION_SCOPE',
        'Package activation requires a valid tenant, factory, package, version and tool scope',
      );
    }
  }

  private assertManifestScope(input: SignedEdgePackageInput, scope: EdgePackageActivationScope): void {
    const manifest = input?.manifest;
    if (
      typeof manifest !== 'object' ||
      manifest === null ||
      Array.isArray(manifest) ||
      !Object.hasOwn(manifest, 'tenantId') ||
      !Object.hasOwn(manifest, 'factoryId') ||
      !Object.hasOwn(manifest, 'packageId') ||
      !Object.hasOwn(manifest, 'version')
    ) {
      throw new EdgePackageActivationCoordinatorError(
        'PACKAGE_SCOPE_MISMATCH',
        'The package manifest does not declare an explicit activation scope',
      );
    }

    const value = manifest as Record<string, unknown>;
    if (
      value.tenantId !== scope.tenantId ||
      value.factoryId !== scope.factoryId ||
      value.packageId !== scope.packageId ||
      value.version !== scope.version
    ) {
      throw new EdgePackageActivationCoordinatorError(
        'PACKAGE_SCOPE_MISMATCH',
        'The signed package manifest must match the requested activation target exactly',
      );
    }
  }
}
