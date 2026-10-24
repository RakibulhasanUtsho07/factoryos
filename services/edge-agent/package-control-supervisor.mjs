import { verifySynchronizedEdgePackage } from './verified-package-runtime.mjs';

const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const USE_CASE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_ERROR_CODE = /^[A-Z0-9_]{1,64}$/;

export class EdgePackageSupervisorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EdgePackageSupervisorError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new EdgePackageSupervisorError(code, message);
}

function validateContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)
    || typeof context.packageId !== 'string' || !PACKAGE_ID.test(context.packageId)
    || typeof context.version !== 'string' || !SEMVER.test(context.version)
    || (context.useCaseId !== undefined && context.useCaseId !== null
      && (typeof context.useCaseId !== 'string' || !USE_CASE.test(context.useCaseId)))
    || typeof context.signingKeyId !== 'string' || !KEY_ID.test(context.signingKeyId)) {
    throw new TypeError('Execution context requires packageId, semantic version, optional useCaseId, and signingKeyId');
  }
  return {
    packageId: context.packageId,
    version: context.version,
    useCaseId: context.useCaseId ?? null,
    signingKeyId: context.signingKeyId,
  };
}

/**
 * Host-side fail-closed supervisor for EdgePackageControlSyncClient.
 *
 * Managed signed packages should use runVerifiedPackage(), which validates the
 * canonical Ed25519 manifest signature and every artifact byte, then rechecks
 * the package control and signer immediately before calling the host executor.
 * runAuthorized() remains a lower-level guard for callers that perform their own
 * verification; it is not sufficient on its own for signed package execution.
 */
export class EdgePackageExecutionSupervisor {
  constructor(syncClient, options = {}) {
    if (!syncClient || typeof syncClient.pollOnce !== 'function' || typeof syncClient.getSnapshot !== 'function') {
      throw new TypeError('A package-control sync client with pollOnce() and getSnapshot() is required');
    }
    this.pollIntervalMs = options.pollIntervalMs === undefined ? 30_000 : options.pollIntervalMs;
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 1000 || this.pollIntervalMs > 3_600_000) {
      throw new TypeError('pollIntervalMs must be between 1000 and 3600000 milliseconds');
    }
    this.setIntervalImpl = options.setIntervalImpl ?? globalThis.setInterval;
    this.clearIntervalImpl = options.clearIntervalImpl ?? globalThis.clearInterval;
    if (typeof this.setIntervalImpl !== 'function' || typeof this.clearIntervalImpl !== 'function') {
      throw new TypeError('Interval scheduling functions are required');
    }
    this.syncClient = syncClient;
    this.running = false;
    this.timer = null;
    this.refreshPromise = null;
    this.lastPollErrorCode = null;
    this.activeExecutions = new Map();
  }

  async start() {
    if (this.running) return this.getStatus();
    this.running = true;
    try {
      this.timer = this.setIntervalImpl(() => this.refresh(), this.pollIntervalMs);
    } catch {
      this.running = false;
      fail('SUPERVISOR_SCHEDULER_FAILED', 'Package-control polling could not be scheduled; execution remains blocked');
    }
    return this.refresh();
  }

  stop() {
    this.running = false;
    this.abortActiveExecutions('SUPERVISOR_STOPPED');
    if (this.timer !== null) {
      try { this.clearIntervalImpl(this.timer); } finally { this.timer = null; }
    }
    return this.getStatus();
  }

  getStatus() {
    let snapshot;
    try { snapshot = this.syncClient.getSnapshot(); }
    catch { snapshot = null; }
    const healthy = this.running && snapshot?.healthy === true && this.lastPollErrorCode === null;
    return {
      running: this.running,
      healthy,
      lastErrorCode: healthy ? null : (!this.running ? 'SUPERVISOR_STOPPED'
        : (this.lastPollErrorCode ?? (typeof snapshot?.lastErrorCode === 'string'
          ? snapshot.lastErrorCode : 'CONTROL_SYNC_UNHEALTHY'))),
      syncedAt: typeof snapshot?.syncedAt === 'string' ? snapshot.syncedAt : null,
      freshnessAgeMs: Number.isFinite(snapshot?.freshnessAgeMs) ? snapshot.freshnessAgeMs : null,
      controls: Array.isArray(snapshot?.controls) ? snapshot.controls.map((entry) => ({
        packageId: entry?.packageId,
        packageVersion: entry?.packageVersion,
        useCaseId: entry?.useCaseId ?? null,
        status: entry?.status,
        checkedAt: entry?.checkedAt ?? null,
      })) : [],
    };
  }

  refresh() {
    if (!this.running) return Promise.resolve(this.getStatus());
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.refreshInternal().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  async refreshInternal() {
    try {
      await this.syncClient.pollOnce();
      this.lastPollErrorCode = null;
    } catch (error) {
      let snapshotErrorCode;
      try { snapshotErrorCode = this.syncClient.getSnapshot()?.lastErrorCode; } catch { /* unavailable snapshot */ }
      this.lastPollErrorCode = typeof error?.code === 'string' && SAFE_ERROR_CODE.test(error.code)
        ? error.code
        : (typeof snapshotErrorCode === 'string' && SAFE_ERROR_CODE.test(snapshotErrorCode)
          ? snapshotErrorCode : 'EDGE_SYNC_FAILED');
    }

    // In-flight executions are not allowed to outlive a control poll failure.
    if (this.lastPollErrorCode !== null) this.abortActiveExecutions(this.lastPollErrorCode);
    else this.recheckActiveExecutions();
    return this.getStatus();
  }

  abortActiveExecutions(code) {
    const safeCode = typeof code === 'string' && SAFE_ERROR_CODE.test(code) ? code : 'CONTROL_SYNC_UNHEALTHY';
    for (const execution of this.activeExecutions.values()) {
      if (execution.controller.signal.aborted) continue;
      execution.controller.abort(new EdgePackageSupervisorError(
        safeCode,
        'Package execution must stop because runtime authorization is no longer available',
      ));
    }
  }

  recheckActiveExecutions() {
    for (const execution of this.activeExecutions.values()) {
      if (execution.controller.signal.aborted) continue;
      try {
        const current = this.authorizeExecution(execution.context);
        const original = execution.authorization;
        if (current.tenantId !== original.tenantId
          || current.factoryId !== original.factoryId
          || current.signingKey.keyId !== original.signingKey.keyId
          || current.signingKey.fingerprintSha256 !== original.signingKey.fingerprintSha256) {
          execution.controller.abort(new EdgePackageSupervisorError(
            'PACKAGE_AUTHORIZATION_CHANGED',
            'Package signer or target scope changed while the host runtime was executing',
          ));
        }
      } catch (error) {
        const code = typeof error?.code === 'string' && SAFE_ERROR_CODE.test(error.code)
          ? error.code : 'CONTROL_SYNC_UNHEALTHY';
        execution.controller.abort(new EdgePackageSupervisorError(
          code,
          'Package execution must stop because current control or signer authorization was denied',
        ));
      }
    }
  }

  authorizeExecution(input) {
    const context = validateContext(input);
    if (!this.running) fail('SUPERVISOR_STOPPED', 'Package execution is blocked because the control supervisor is stopped');

    let snapshot;
    try { snapshot = this.syncClient.getSnapshot(); }
    catch { fail('CONTROL_SYNC_UNAVAILABLE', 'Package-control state cannot be read safely'); }
    if (!snapshot || snapshot.healthy !== true || this.lastPollErrorCode !== null) {
      fail('CONTROL_SYNC_UNHEALTHY', 'Package execution is blocked because package controls are not healthy');
    }
    if (!Array.isArray(snapshot.controls) || !Array.isArray(snapshot.signingKeys)) {
      fail('CONTROL_SYNC_UNHEALTHY', 'Package-control snapshot is incomplete');
    }

    const control = snapshot.controls.find((entry) => entry.packageId === context.packageId
      && entry.packageVersion === context.version
      && (entry.useCaseId ?? null) === context.useCaseId);
    if (!control) fail('PACKAGE_SCOPE_NOT_CONFIGURED', 'Package execution scope is not explicitly managed by this edge agent');
    if (control.status !== 'ACTIVE') {
      const status = ['PAUSED', 'REVOKED'].includes(control.status) ? control.status : 'INACTIVE';
      fail('PACKAGE_CONTROL_' + status, 'Package execution is blocked by the effective package-control status');
    }

    const signingKey = snapshot.signingKeys.find((entry) => entry.keyId === context.signingKeyId);
    if (!signingKey) fail('SIGNING_KEY_NOT_TRUSTED', 'Package signing key is absent from the synchronized trust snapshot');
    if (signingKey.status === 'REVOKED') fail('SIGNING_KEY_REVOKED', 'Package execution is blocked because its signing key is revoked');
    if (signingKey.status !== 'ACTIVE' || typeof signingKey.publicKeyPem !== 'string'
      || typeof signingKey.fingerprintSha256 !== 'string') {
      fail('SIGNING_KEY_NOT_ACTIVE', 'Package signing key is not an active validated public key');
    }

    return Object.freeze({
      tenantId: snapshot.tenantId,
      factoryId: snapshot.factoryId,
      packageId: context.packageId,
      packageVersion: context.version,
      useCaseId: context.useCaseId,
      signingKey: Object.freeze({
        keyId: signingKey.keyId,
        publicKeyPem: signingKey.publicKeyPem,
        fingerprintSha256: signingKey.fingerprintSha256,
        status: signingKey.status,
      }),
      control: Object.freeze({
        status: control.status,
        checkedAt: control.checkedAt ?? null,
        reason: control.reason ?? null,
      }),
      syncedAt: snapshot.syncedAt,
      authorizedAt: new Date().toISOString(),
    });
  }

  runVerifiedPackage(input, options, executor) {
    if (typeof executor !== 'function') throw new TypeError('runVerifiedPackage requires an executor callback');
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || !(options.allowedToolIds instanceof Set)) {
      throw new TypeError('runVerifiedPackage requires a host-controlled allowedToolIds Set');
    }
    const manifest = input && typeof input === 'object' ? input.manifest : null;
    const context = {
      packageId: manifest?.packageId,
      version: manifest?.version,
      useCaseId: options.useCaseId ?? null,
      signingKeyId: manifest?.signingKeyId,
    };
    const firstAuthorization = this.authorizeExecution(context);
    const { useCaseId, allowedToolIds, ...verificationPolicy } = options;
    const verifiedRelease = verifySynchronizedEdgePackage(input, firstAuthorization, {
      ...verificationPolicy,
      allowedToolIds,
    });

    // Re-read sync health, exact-scope control, and signer after signature/hash
    // verification, immediately before the callback which may create side effects.
    const currentAuthorization = this.authorizeExecution(context);
    if (currentAuthorization.tenantId !== firstAuthorization.tenantId
      || currentAuthorization.factoryId !== firstAuthorization.factoryId
      || currentAuthorization.signingKey.keyId !== firstAuthorization.signingKey.keyId
      || currentAuthorization.signingKey.fingerprintSha256 !== firstAuthorization.signingKey.fingerprintSha256) {
      fail('PACKAGE_AUTHORIZATION_CHANGED', 'Package signer or target scope changed during verification');
    }
    const executionId = Symbol('edge-package-execution');
    const controller = new AbortController();
    this.activeExecutions.set(executionId, {
      context,
      authorization: currentAuthorization,
      controller,
    });

    let outcome;
    try {
      // The host adapter must propagate this signal into its runtime/process loop.
      outcome = executor(verifiedRelease, currentAuthorization, controller.signal);
    } catch (error) {
      this.activeExecutions.delete(executionId);
      throw error;
    }

    const finish = (value) => {
      this.activeExecutions.delete(executionId);
      if (controller.signal.aborted) {
        fail(
          'EXECUTION_ABORTED_AFTER_START',
          'Package execution was cancelled after host invocation; reconcile possible side effects before retrying',
        );
      }
      return value;
    };
    const reject = (error) => {
      this.activeExecutions.delete(executionId);
      throw error;
    };

    let then;
    try {
      then = outcome !== null && (typeof outcome === 'object' || typeof outcome === 'function')
        ? outcome.then : undefined;
    } catch (error) {
      this.activeExecutions.delete(executionId);
      throw error;
    }
    if (typeof then === 'function') return Promise.resolve(outcome).then(finish, reject);
    return finish(outcome);
  }

  runAuthorized(input, operation) {
    if (typeof operation !== 'function') throw new TypeError('runAuthorized requires an operation callback');
    const authorization = this.authorizeExecution(input);
    return operation(authorization);
  }
}
