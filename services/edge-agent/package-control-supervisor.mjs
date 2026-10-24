const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SEMVER = /^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$/;
const USE_CASE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

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
 * It schedules polling and only calls a host operation when the current snapshot
 * is healthy, the exact configured package scope is ACTIVE, and the release signer
 * is present and ACTIVE. The operation must still verify the signed artifact bytes
 * and enforce any separate runtime/activation policy before causing side effects.
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
    // Keep the periodic retry active even when this first poll fails.
    return this.refresh();
  }

  stop() {
    this.running = false;
    if (this.timer !== null) {
      try { this.clearIntervalImpl(this.timer); } finally { this.timer = null; }
    }
    return this.getStatus();
  }

  getStatus() {
    let snapshot;
    try { snapshot = this.syncClient.getSnapshot(); }
    catch { snapshot = null; }
    const healthy = this.running && snapshot?.healthy === true;
    return {
      running: this.running,
      healthy,
      lastErrorCode: healthy ? null : (!this.running ? 'SUPERVISOR_STOPPED'
        : (typeof snapshot?.lastErrorCode === 'string' ? snapshot.lastErrorCode : 'CONTROL_SYNC_UNHEALTHY')),
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
    } catch {
      // The sync client records the failure and reports an unhealthy snapshot.
      // Swallow here so the timer can retry without an unhandled rejection.
    }
    return this.getStatus();
  }

  authorizeExecution(input) {
    const context = validateContext(input);
    if (!this.running) fail('SUPERVISOR_STOPPED', 'Package execution is blocked because the control supervisor is stopped');

    let snapshot;
    try { snapshot = this.syncClient.getSnapshot(); }
    catch { fail('CONTROL_SYNC_UNAVAILABLE', 'Package-control state cannot be read safely'); }
    if (!snapshot || snapshot.healthy !== true) {
      const code = typeof snapshot?.lastErrorCode === 'string' ? snapshot.lastErrorCode : 'CONTROL_SYNC_UNHEALTHY';
      fail('CONTROL_SYNC_UNHEALTHY', 'Package execution is blocked because package controls are not healthy (' + code + ')');
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
      packageId: context.packageId,
      packageVersion: context.version,
      useCaseId: context.useCaseId,
      signingKey: Object.freeze({
        keyId: signingKey.keyId,
        publicKeyPem: signingKey.publicKeyPem,
        fingerprintSha256: signingKey.fingerprintSha256,
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

  runAuthorized(input, operation) {
    if (typeof operation !== 'function') throw new TypeError('runAuthorized requires an operation callback');
    const authorization = this.authorizeExecution(input);
    // Invoke the operation only after every fail-closed check has completed.
    // The callback is responsible for verifying artifact bytes and activation policy.
    return operation(authorization);
  }
}
