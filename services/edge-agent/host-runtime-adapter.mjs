/**
 * Canonical host-facing adapter for governed signed-package execution.
 *
 * This adapter ensures callers cannot accidentally omit the package supervisor:
 * signature/artifact checks and live package-control/signer checks run first,
 * then the verified package and the exact cancellation signal are forwarded to
 * the deployment-owned runtime implementation.
 *
 * This module does not implement model inference or policy interpretation.
 * The hostRuntime.execute implementation must propagate signal to its actual
 * inference/process loop and side-effecting tools. A runtime that ignores the
 * signal can continue producing side effects after the caller receives an
 * EXECUTION_ABORTED_AFTER_START outcome; reconciliation is required before retry.
 */
export class EdgePackageHostRuntimeAdapter {
  constructor(supervisor, hostRuntime) {
    if (!supervisor || typeof supervisor.runVerifiedPackage !== 'function') {
      throw new TypeError('A package supervisor with runVerifiedPackage() is required');
    }
    if (!hostRuntime || typeof hostRuntime.execute !== 'function') {
      throw new TypeError('A host runtime with execute(request) is required');
    }
    this.supervisor = supervisor;
    this.hostRuntime = hostRuntime;
  }

  execute(signedPackageInput, verificationOptions) {
    return this.supervisor.runVerifiedPackage(
      signedPackageInput,
      verificationOptions,
      (release, authorization, signal) => {
        const request = Object.freeze({
          manifest: release.manifest,
          manifestSha256: release.manifestSha256,
          artifactBytes: release.artifactBytes,
          artifacts: release.artifacts,
          authorization,
          signal,
        });
        return this.hostRuntime.execute(request);
      },
    );
  }
}
