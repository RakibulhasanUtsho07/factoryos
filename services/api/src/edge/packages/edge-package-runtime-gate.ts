import type { EdgePackageSigningKeyStore } from '../edge-package-signing-key.store.js';
import {
  EdgePackageControlStateStore,
  type DurableEdgePackageControlState,
} from '../edge-package-control-state.store.js';
import type {
  EdgePackageActivationRuntime,
  EdgePackageActivationScope,
} from './edge-package-release-coordinator.js';
import type { EdgePackageActivationStore } from './edge-package-activation.store.js';
import type { EdgePackageVerificationPolicy } from './edge-package-manifest-verifier.js';
import type { VerifiedEdgePackageRelease } from './edge-package-activation.store.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PACKAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PACKAGE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const USE_CASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const MAX_MANAGED_SCOPES = 64;
const MAX_FRESHNESS_MS = 24 * 60 * 60 * 1000;

export type EdgePackageRuntimeGateErrorCode =
  | 'INVALID_RUNTIME_SCOPE'
  | 'CONTROL_SYNC_UNVERIFIED'
  | 'PACKAGE_CONTROL_DENIED'
  | 'SIGNING_KEY_CHANGED'
  | 'EXECUTION_ABORTED_AFTER_START';

export class EdgePackageRuntimeGateError extends Error {
  constructor(readonly code: EdgePackageRuntimeGateErrorCode, message: string) {
    super(message);
    this.name = 'EdgePackageRuntimeGateError';
  }
}

export interface EdgePackageManagedScope {
  packageId: string;
  version: string;
  useCaseId?: string;
}

export interface EdgePackageRuntimeGateOptions {
  maxControlAgeMs: number;
  maxSigningKeyAgeMs: number;
  /** Fixed package/version/use-case set this host is configured to execute. */
  managedScopes: readonly EdgePackageManagedScope[];
  clock?: () => Date;
}

type ActiveReleaseVerifier = Pick<EdgePackageActivationStore, 'verifyActiveRelease'>;

/**
 * Host-side execution boundary for signed edge packages.
 *
 * The host must call execute() for every model/policy execution attempt. It
 * verifies a complete, fresh control-sync result, checks exact package/version/use-case,
 * re-verifies the active release against the current signer snapshot and artifact bytes,
 * then checks control state again immediately before invoking the executor.
 *
 * This is a fail-closed gate primitive, not an automatically wired model runtime.
 * A host that calls the lower-level release store or executor directly can bypass it.
 */
export class EdgePackageRuntimeGate implements EdgePackageActivationRuntime {
  private controlSyncHealthy = false;
  private readonly confirmedScopes = new Set<string>();
  private readonly maxControlAgeMs: number;
  private readonly maxSigningKeyAgeMs: number;
  private readonly expectedScopes: ReadonlySet<string>;
  private readonly clock: () => Date;
  private readonly expectedTenantId: string;
  private readonly expectedFactoryId: string;
  private readonly activeExecutions = new Map<symbol, {
    scope: EdgePackageActivationScope;
    controller: AbortController;
    signingKeyId: string;
    signingKeyPem: string;
  }>();

  constructor(
    private readonly activationStore: ActiveReleaseVerifier,
    private readonly controlStore: EdgePackageControlStateStore,
    private readonly signingKeyStore: EdgePackageSigningKeyStore,
    tenantId: string,
    factoryId: string,
    options: EdgePackageRuntimeGateOptions,
  ) {
    if (!UUID_PATTERN.test(tenantId) || !UUID_PATTERN.test(factoryId)) {
      throw new EdgePackageRuntimeGateError('INVALID_RUNTIME_SCOPE', 'A valid tenant and factory scope is required');
    }
    if (
      !options ||
      !this.validMaxAge(options.maxControlAgeMs) ||
      !this.validMaxAge(options.maxSigningKeyAgeMs) ||
      !Array.isArray(options.managedScopes) ||
      options.managedScopes.length < 1 ||
      options.managedScopes.length > MAX_MANAGED_SCOPES ||
      !options.managedScopes.every((scope) =>
        this.validManagedScope(scope?.packageId, scope?.version, scope?.useCaseId))
    ) {
      throw new EdgePackageRuntimeGateError(
        'INVALID_RUNTIME_SCOPE',
        'Runtime freshness limits and a bounded valid managed-scope set are required',
      );
    }
    const expectedScopes = new Set(options.managedScopes.map((scope) =>
      this.scopeKey(scope.packageId, scope.version, scope.useCaseId)));
    if (expectedScopes.size !== options.managedScopes.length) {
      throw new EdgePackageRuntimeGateError(
        'INVALID_RUNTIME_SCOPE',
        'Configured managed scopes must be unique',
      );
    }
    this.expectedScopes = expectedScopes;
    this.expectedTenantId = tenantId.toLowerCase();
    this.expectedFactoryId = factoryId.toLowerCase();
    this.maxControlAgeMs = options.maxControlAgeMs;
    this.maxSigningKeyAgeMs = options.maxSigningKeyAgeMs;
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Call only after a complete poll of every configured managed scope has
   * been validated and durably saved. A partial or failed poll must call
   * recordControlSyncFailure() instead.
   */
  confirmControlSync(scopes: readonly EdgePackageManagedScope[]): void {
    this.controlSyncHealthy = false;
    this.confirmedScopes.clear();
    try {
      if (
        !Array.isArray(scopes) ||
        scopes.length !== this.expectedScopes.size ||
        scopes.length < 1 ||
        scopes.length > MAX_MANAGED_SCOPES
      ) {
        throw new EdgePackageRuntimeGateError(
          'CONTROL_SYNC_UNVERIFIED',
          'Control sync must cover every configured managed scope exactly once',
        );
      }

      const nextScopes = new Set<string>();
      for (const scope of scopes) {
        this.assertManagedScope(scope);
        const key = this.scopeKey(scope.packageId, scope.version, scope.useCaseId);
        if (nextScopes.has(key)) {
          throw new EdgePackageRuntimeGateError('CONTROL_SYNC_UNVERIFIED', 'The managed-scope snapshot contains duplicates');
        }
        if (!this.expectedScopes.has(key)) {
          throw new EdgePackageRuntimeGateError(
            'CONTROL_SYNC_UNVERIFIED',
            'The control-sync snapshot contains an unconfigured managed scope',
          );
        }
        const state = this.readControlState(scope.packageId, scope.version, scope.useCaseId);
        if (!state || state.lastErrorCode !== null || !this.isFresh(state)) {
          throw new EdgePackageRuntimeGateError('CONTROL_SYNC_UNVERIFIED', 'A managed scope is missing, stale or has a control-sync error');
        }
        nextScopes.add(key);
      }

      for (const key of nextScopes) this.confirmedScopes.add(key);
      this.controlSyncHealthy = true;
      // A completed control/signer refresh must also re-authorize active work.
      // PAUSED/REVOKED controls and removed/rotated/revoked signers cancel it.
      this.recheckActiveExecutions();
    } catch (error) {
      this.controlSyncHealthy = false;
      this.confirmedScopes.clear();
      this.abortActiveExecutions(
        'CONTROL_SYNC_UNVERIFIED',
        'Package execution must stop because a complete trusted control sync could not be confirmed',
      );
      throw error;
    }
  }

  /** A transport, parsing or persistence error closes every managed scope until a complete poll succeeds. */
  recordControlSyncFailure(): void {
    this.controlSyncHealthy = false;
    this.confirmedScopes.clear();
    this.abortActiveExecutions(
      'CONTROL_SYNC_UNVERIFIED',
      'Package execution must stop because package-control synchronization failed',
    );
  }

  private abortActiveExecutions(
    code: 'CONTROL_SYNC_UNVERIFIED' | 'PACKAGE_CONTROL_DENIED' | 'SIGNING_KEY_CHANGED',
    message: string,
  ): void {
    for (const execution of this.activeExecutions.values()) {
      if (!execution.controller.signal.aborted) {
        execution.controller.abort(new EdgePackageRuntimeGateError(code, message));
      }
    }
  }

  private recheckActiveExecutions(): void {
    for (const execution of this.activeExecutions.values()) {
      if (execution.controller.signal.aborted) continue;
      if (!this.isPackageExecutionAllowed(
        execution.scope.packageId,
        execution.scope.version,
        execution.scope.useCaseId,
      )) {
        this.abortActiveExecutionsForExecution(
          execution,
          'PACKAGE_CONTROL_DENIED',
          'Package control changed while a model/policy execution was active',
        );
        continue;
      }

      try {
        const currentPolicy = this.createExecutionVerificationPolicy(execution.scope);
        const signer = currentPolicy.trustedSigningKeys[execution.signingKeyId];
        if (!signer || signer.status !== 'ACTIVE' || signer.publicKeyPem !== execution.signingKeyPem) {
          this.abortActiveExecutionsForExecution(
            execution,
            'SIGNING_KEY_CHANGED',
            'The package signer was revoked, removed or rebound while execution was active',
          );
        }
      } catch {
        this.abortActiveExecutionsForExecution(
          execution,
          'SIGNING_KEY_CHANGED',
          'Current signer trust could not be verified while execution was active',
        );
      }
    }
  }

  private abortActiveExecutionsForExecution(
    execution: { controller: AbortController },
    code: 'PACKAGE_CONTROL_DENIED' | 'SIGNING_KEY_CHANGED',
    message: string,
  ): void {
    if (!execution.controller.signal.aborted) {
      execution.controller.abort(new EdgePackageRuntimeGateError(code, message));
    }
  }

  private createExecutionVerificationPolicy(scope: EdgePackageActivationScope): EdgePackageVerificationPolicy {
    return this.createPackageVerificationPolicy({
      tenantId: this.expectedTenantId,
      factoryId: this.expectedFactoryId,
      allowedToolIds: scope.allowedToolIds,
      now: this.clock(),
      ...(scope.maxClockSkewMs === undefined ? {} : { maxClockSkewMs: scope.maxClockSkewMs }),
      ...(scope.maxPackageLifetimeMs === undefined ? {} : { maxPackageLifetimeMs: scope.maxPackageLifetimeMs }),
      ...(scope.maxTotalArtifactBytes === undefined ? {} : { maxTotalArtifactBytes: scope.maxTotalArtifactBytes }),
    });
  }

  isPackageExecutionAllowed(packageId: string, version: string, useCaseId?: string): boolean {
    if (!this.controlSyncHealthy || !this.validManagedScope(packageId, version, useCaseId)) return false;
    if (!this.confirmedScopes.has(this.scopeKey(packageId, version, useCaseId))) return false;
    try {
      const state = this.readControlState(packageId, version, useCaseId);
      return state !== null &&
        state.status === 'ACTIVE' &&
        state.lastErrorCode === null &&
        this.isFresh(state);
    } catch {
      return false;
    }
  }

  createPackageVerificationPolicy(
    policy: Omit<EdgePackageVerificationPolicy, 'trustedSigningKeys'>,
  ): EdgePackageVerificationPolicy {
    if (
      !policy ||
      typeof policy.tenantId !== 'string' ||
      typeof policy.factoryId !== 'string' ||
      policy.tenantId.toLowerCase() !== this.expectedTenantId ||
      policy.factoryId.toLowerCase() !== this.expectedFactoryId
    ) {
      throw new EdgePackageRuntimeGateError('INVALID_RUNTIME_SCOPE', 'Signing policy scope does not match this runtime instance');
    }
    return this.signingKeyStore.createVerificationPolicy(
      policy,
      this.maxSigningKeyAgeMs,
    );
  }

  async execute<T>(
    scope: EdgePackageActivationScope,
    executor: (release: Readonly<VerifiedEdgePackageRelease>, signal: AbortSignal) => Promise<T> | T,
  ): Promise<T> {
    this.assertExecutionScope(scope);
    if (!this.isPackageExecutionAllowed(scope.packageId, scope.version, scope.useCaseId)) {
      throw new EdgePackageRuntimeGateError('PACKAGE_CONTROL_DENIED', 'Package execution requires a fresh exact-scope ACTIVE control decision');
    }

    const verificationPolicy = this.createExecutionVerificationPolicy(scope);

    // Recheck active pointer, signature, signer trust and every artifact on the
    // exact release immediately before passing verified bytes to the host.
    const release = await this.activationStore.verifyActiveRelease(
      scope.packageId,
      scope.version,
      verificationPolicy,
    );

    // PAUSE/REVOKE may arrive while file/signature verification is in flight.
    // Do not invoke any model/policy callback if the live control has changed.
    if (!this.isPackageExecutionAllowed(scope.packageId, scope.version, scope.useCaseId)) {
      throw new EdgePackageRuntimeGateError('PACKAGE_CONTROL_DENIED', 'Package control changed during execution admission');
    }
    const signingKey = verificationPolicy.trustedSigningKeys[release.manifest.signingKeyId];
    if (!signingKey || signingKey.status !== 'ACTIVE') {
      throw new EdgePackageRuntimeGateError('SIGNING_KEY_CHANGED', 'The verified release signer is no longer active');
    }

    const executionId = Symbol('edge-package-runtime-execution');
    const controller = new AbortController();
    const activeScope: EdgePackageActivationScope = {
      ...scope,
      allowedToolIds: new Set(scope.allowedToolIds),
    };
    this.activeExecutions.set(executionId, {
      scope: activeScope,
      controller,
      signingKeyId: release.manifest.signingKeyId,
      signingKeyPem: signingKey.publicKeyPem,
    });

    let executorInvoked = false;
    const cancellationBeforeStart = () => {
      const reason = controller.signal.reason;
      if (reason instanceof Error) return reason;
      return new EdgePackageRuntimeGateError(
        'CONTROL_SYNC_UNVERIFIED',
        'Execution was denied because package authorization was cancelled before host invocation',
      );
    };
    const abortedAfterStart = () => new EdgePackageRuntimeGateError(
      'EXECUTION_ABORTED_AFTER_START',
      'Cancellation was requested after the host executor started; its work may still be running, so reconcile possible side effects before retrying',
    );
    const cancellationOutcome = () => executorInvoked ? abortedAfterStart() : cancellationBeforeStart();

    // Cancellation can arrive after admission but before this microtask runs.
    // Re-check the signal before invoking any host code, otherwise a just-revoked
    // execution could start side effects after the caller was already denied.
    const executionPromise = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw cancellationBeforeStart();
      executorInvoked = true;
      return executor(release, controller.signal);
    });
    // Keep the execution registered until the host callback really settles. If
    // it ignores AbortSignal, the caller still gets an ambiguous result promptly,
    // but the gate does not pretend the underlying work has stopped.
    void executionPromise.then(
      () => { this.activeExecutions.delete(executionId); },
      () => { this.activeExecutions.delete(executionId); },
    );

    let onAbort: (() => void) | undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(cancellationOutcome());
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener('abort', onAbort, { once: true });
    });

    try {
      const outcome = await Promise.race([executionPromise, abortPromise]);
      if (controller.signal.aborted) throw cancellationOutcome();
      return outcome;
    } catch (error) {
      if (controller.signal.aborted) throw cancellationOutcome();
      throw error;
    } finally {
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    }
  }

  private assertExecutionScope(scope: EdgePackageActivationScope): void {
    if (
      !scope ||
      typeof scope.tenantId !== 'string' ||
      typeof scope.factoryId !== 'string' ||
      scope.tenantId.toLowerCase() !== this.expectedTenantId ||
      scope.factoryId.toLowerCase() !== this.expectedFactoryId ||
      !scope.allowedToolIds ||
      typeof scope.allowedToolIds.has !== 'function' ||
      !this.validManagedScope(scope.packageId, scope.version, scope.useCaseId)
    ) {
      throw new EdgePackageRuntimeGateError('INVALID_RUNTIME_SCOPE', 'Execution scope does not match the runtime tenant/factory binding');
    }
  }

  private assertManagedScope(scope: EdgePackageManagedScope): void {
    if (!this.validManagedScope(scope?.packageId, scope?.version, scope?.useCaseId)) {
      throw new EdgePackageRuntimeGateError('CONTROL_SYNC_UNVERIFIED', 'The managed-scope snapshot contains an invalid package scope');
    }
  }

  private validManagedScope(packageId: unknown, version: unknown, useCaseId?: unknown): boolean {
    return typeof packageId === 'string' && PACKAGE_ID_PATTERN.test(packageId) &&
      typeof version === 'string' && PACKAGE_VERSION_PATTERN.test(version) &&
      (useCaseId === undefined || (typeof useCaseId === 'string' && USE_CASE_ID_PATTERN.test(useCaseId)));
  }

  private readControlState(
    packageId: string,
    version: string,
    useCaseId?: string,
  ): DurableEdgePackageControlState | null {
    return this.controlStore.get({
      packageId,
      packageVersion: version,
      useCaseId: useCaseId ?? null,
    });
  }

  private isFresh(state: DurableEdgePackageControlState): boolean {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
        state.checkedAt === null || !Number.isFinite(Date.parse(state.checkedAt))) return false;
    const ageMs = now.getTime() - Date.parse(state.checkedAt);
    return ageMs >= 0 && ageMs <= this.maxControlAgeMs;
  }

  private scopeKey(packageId: string, version: string, useCaseId?: string): string {
    return JSON.stringify([packageId, version, useCaseId ?? null]);
  }

  private validMaxAge(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= MAX_FRESHNESS_MS;
  }
}
