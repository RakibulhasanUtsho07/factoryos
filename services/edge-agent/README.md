# Edge agent: durable observation spool and package runtime controls

## Workspace package

The module is published inside the repository as the private npm workspace `@factoryos/edge-agent`. Use the stable entry point instead of importing implementation file paths from another service:

    import {
      EdgePackageControlSyncClient,
      EdgePackageExecutionSupervisor,
      verifySynchronizedEdgePackage,
    } from '@factoryos/edge-agent';

Subpath exports are available for `./durable-observation-spool`, `./package-control-sync`, `./package-control-supervisor`, and `./verified-package-runtime`. The package intentionally has no third-party runtime dependencies; its supported minimum Node.js version is 22. Workspace checks are `npm --workspace @factoryos/edge-agent run check`, `npm --workspace @factoryos/edge-agent run build`, and `npm --workspace @factoryos/edge-agent test`.

This Node.js library provides a durable telemetry spool, an authenticated package-control sync client, a recurring fail-closed supervisor, and a signed-package verification boundary. It is not a complete service supervisor, native hardware driver suite, or proof that a particular production model/policy executor has been wired to these APIs.

## Durable observations

Generate and persist a batch key before the first send attempt, then keep that exact key and body until the server confirms the durable receipt.

    import { DurableObservationSpool, createEdgeGatewaySender } from './durable-observation-spool.mjs';

    const spool = new DurableObservationSpool('/var/lib/factoryos-edge/spool', {
      maxBatches: 1024,
      maxBytes: 64 * 1024 * 1024,
      maxBatchBytes: 1024 * 1024,
    });

    const send = createEdgeGatewaySender({
      baseUrl: process.env.FACTORYOS_API_BASE_URL,
      deviceId: process.env.FACTORYOS_EDGE_DEVICE_ID,
      token: process.env.FACTORYOS_EDGE_DEVICE_TOKEN,
    });

    await spool.enqueue({
      batch_key: 'line-1-boot42-batch00017',
      observations: [{
        event_id: 'bbbbbb63-c447-46ce-950d-deebdd7f5f34',
        signal_key: 'line.temperature',
        observed_at: new Date().toISOString(),
        source_mode: 'EDGE_OFFLINE',
        quality: 'GOOD',
        unit: 'degC',
        sampling_interval_ms: 1000,
        payload: { value: 21.5 },
      }],
    });
    const outcome = await spool.flush(send, { maxAttempts: 5, baseDelayMs: 250 });

The sample values are illustrative. Use a secret manager or protected environment for real credentials; never put tokens in observation payloads or spool files.

The spool fsyncs and atomically renames files where supported, validates stored payload digests, rejects sensitive credential-like fields, preserves FIFO order, and removes a batch only after a matching durable receipt. Capacity exhaustion is an explicit error rather than silent eviction.

## Authenticated package-control synchronization

The sync client polls these authenticated endpoints for the device:

- GET /api/v2/edge/device-package-signing-keys/:deviceId for the complete signer snapshot.
- GET /api/v2/edge/device-package-controls/:deviceId/effective with package_id, package_version, and optional use_case_id for every configured managed scope.

    import { EdgePackageControlSyncClient } from './package-control-sync.mjs';

    const sync = new EdgePackageControlSyncClient({
      baseUrl: process.env.FACTORYOS_API_BASE_URL,
      deviceId: process.env.FACTORYOS_EDGE_DEVICE_ID,
      tenantId: process.env.FACTORYOS_EDGE_TENANT_ID,
      factoryId: process.env.FACTORYOS_EDGE_FACTORY_ID,
      token: process.env.FACTORYOS_EDGE_DEVICE_TOKEN,
      stateFile: '/var/lib/factoryos-edge/package-sync/state.json',
      managedScopes: [
        { packageId: 'quality-defect', version: '1.2.0', useCaseId: 'inspection' },
      ],
      maxSnapshotAgeMs: 5 * 60 * 1000,
    });

    await sync.initialize();

The poller requires HTTPS except explicitly enabled loopback HTTP outside production, uses bearer authorization, rejects redirects, bounds response and persisted-state sizes, verifies tenant/factory scope and Ed25519 public-key fingerprints, and atomically persists a complete snapshot with owner-only permissions. Partial, invalid, stale, failed, or unpersisted polls cannot authorize execution. Signer and package REVOKED states are terminal locally. A persisted snapshot is not fresh runtime authorization after a process restart: the first successful poll must complete before execution is allowed.

## Supervisor and verified execution boundary

Start a periodic fail-closed supervisor, then use runVerifiedPackage for managed signed package execution:

    import { EdgePackageExecutionSupervisor } from './package-control-supervisor.mjs';

    const supervisor = new EdgePackageExecutionSupervisor(sync, { pollIntervalMs: 30_000 });
    const health = await supervisor.start();
    if (!health.healthy) {
      // Keep the package runtime blocked. The scheduled poller will retry.
    }

    await supervisor.runVerifiedPackage(
      signedPackageInput, // { manifest, signature, artifacts: { relativePath: Uint8Array } }
      {
        useCaseId: 'inspection',
        allowedToolIds: new Set(['AI.RUNTIME.NOOP']), // host-owned, not manifest-owned
      },
      async (verifiedRelease, authorization, signal) => {
        // Integrate the existing trusted model/policy loader here. Consume the
        // exact verified byte copies, not a path re-read from untrusted storage.
        // Propagate signal to the host runtime's cancellation/stop mechanism.
        return hostRuntime.loadAndExecute(verifiedRelease, { authorization, signal });
      },
    );

    supervisor.stop();

runVerifiedPackage:

1. Requires a currently healthy synchronized state and an exact configured ACTIVE package/version/use-case.
2. Requires the selected signer to be ACTIVE, then validates the signed manifest using the same sorted-key canonical JSON contract as the API.
3. Verifies the Ed25519 signature, tenant/factory/package/version scope, issue and expiry window, host-owned tool allow-list, exact artifact set, artifact sizes and SHA-256 digests.
4. Rechecks the live control and signer after verification, immediately before invoking the host callback. A pause/revoke or signer/scope change blocks the callback.

The executor callback is invoked only after these checks pass and receives copied bytes that were checked against the signed manifest. It receives a third argument, an `AbortSignal`: `stop()`, a failed control poll, an unhealthy snapshot, a pause/revoke, or a signer/scope change aborts active work. The host adapter must propagate this signal into the actual inference/process loop and stop side effects cooperatively. If the callback resolves successfully after cancellation, the wrapper rejects with `EXECUTION_ABORTED_AFTER_START`; this is an ambiguous outcome, not proof that side effects were rolled back. Reconcile the operation before retrying. An AbortSignal cannot forcibly kill a callback or external process that ignores it. runAuthorized is a lower-level admission guard for integrations that supply their own verifier; do not use it alone to execute signed model/policy packages. stop() disables new execution and requests cancellation of active signed-package callbacks.

## Important production boundary

This integration provides an executable verification boundary, not a claim that the repository has automatically replaced every model/policy executor. Deployment code must call runVerifiedPackage at the actual activation/execution path and must load the returned verified bytes rather than reopening a mutable source path. Hardware-in-loop commissioning, production network/service supervision, native OPC UA/MQTT/Modbus drivers, and rollout/rollback evidence remain separate deployment acceptance items.

Persist runtime state on a durable local filesystem with a single owner process. Provision adequate disk, monitoring, encryption and backups; file permissions alone are not a complete host-security boundary.
