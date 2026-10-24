# Edge agent: durable observation spool

This is a Node.js library component for edge runtimes that need to preserve normalized telemetry while the cloud API is unavailable. It contains a durable observation spool, an authenticated package-control synchronization client, and a host-callable package execution supervisor. It is not a complete service supervisor and does not contain physical-device drivers or a production model/policy executor.

## Basic use

Generate and persist a batch key before the first send attempt, then keep that exact key and body until the server confirms the durable receipt.

    import { DurableObservationSpool, createEdgeGatewaySender } from './durable-observation-spool.mjs';

    const spool = new DurableObservationSpool('/var/lib/factoryos-edge/spool', {
      maxBatches: 1024,
      maxBytes: 64 * 1024 * 1024,
      maxBatchBytes: 1024 * 1024,
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

    const send = createEdgeGatewaySender({
      baseUrl: process.env.FACTORYOS_API_BASE_URL,
      deviceId: process.env.FACTORYOS_EDGE_DEVICE_ID,
      token: process.env.FACTORYOS_EDGE_DEVICE_TOKEN,
    });
    const outcome = await spool.flush(send, { maxAttempts: 5, baseDelayMs: 250 });

The sample values are illustrative. Supply real device IDs and tokens through the deployment's secret manager or protected environment; never put credentials in an observation payload or spool file.

## Durability and retry contract

- Enqueue writes a versioned JSON envelope to a temporary file, syncs it, atomically renames it into the pending queue, then attempts to sync the containing directory. Files and directories are restricted to owner access where supported.
- Every loaded batch is validated and checked against its SHA-256 payload digest. Unexpected files, symlinks, invalid envelopes, duplicate local sequence numbers, or digest mismatch fail closed rather than discarding data.
- Identical batch_key plus content is idempotent. Reusing a key with different content is rejected. Capacity limits reject newly enqueued work instead of silently evicting pending batches.
- Flushes run FIFO. The first pending batch keeps the queue blocked until a matching gateway receipt is obtained or the configured bounded retry attempts are exhausted. Transport errors and HTTP 408, 429, and 5xx are retryable; other 4xx responses and malformed or mismatched receipts are not.
- A batch is removed only after the receipt's summary.batchKey, observation count, and inserted/deduplicated counts reconcile to the exact queued batch. Failed sends and untrusted receipts leave the batch on disk for inspection and a later deliberate retry.

## Signed package-control synchronization

The package-control synchronization client polls the existing device endpoints:

- GET /api/v2/edge/device-package-signing-keys/:deviceId for the complete signer snapshot.
- GET /api/v2/edge/device-package-controls/:deviceId/effective with package_id, package_version, and optional use_case_id for every configured managed package scope.

Example:

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
    const snapshot = await sync.pollOnce();
    if (!snapshot.healthy) {
      // The host must keep package execution blocked.
    }

The poller requires HTTPS except explicitly enabled loopback HTTP outside production, sends the opaque device token only as bearer authorization, rejects redirects, limits response/state sizes, validates tenant/factory scope and Ed25519 public-key fingerprints, and persists the full snapshot atomically with owner-only file permissions. A partial, invalid, stale, failed, or unpersisted sync cannot replace the prior usable snapshot; it marks the cached state unhealthy. Previously revoked signing keys remain revoked if omitted or later reported active, and package-control REVOKED state is terminal locally. A process restart does not turn a persisted snapshot into fresh authorization: call pollOnce successfully before allowing execution.

## Host runtime supervision and execution guard

The supervisor schedules polling, retries after failed polls, and fails closed at the callback boundary if polling is unhealthy, the exact package/version/use-case is not configured and ACTIVE, or the selected signer is missing, inactive, or revoked.

    import { EdgePackageExecutionSupervisor } from './package-control-supervisor.mjs';

    const supervisor = new EdgePackageExecutionSupervisor(sync, {
      pollIntervalMs: 30_000,
    });
    const initialHealth = await supervisor.start();
    if (!initialHealth.healthy) {
      // Do not activate or execute managed packages; scheduled polling will retry.
    }

    await supervisor.runAuthorized({
      packageId: 'quality-defect',
      version: '1.2.0',
      useCaseId: 'inspection',
      signingKeyId: release.signingKeyId,
    }, async (authorization) => {
      // Host integration must verify the exact release bytes and signature using
      // authorization.signingKey.publicKeyPem, enforce activation policy, and only
      // then call the real package/model executor.
      return hostRuntime.execute(release);
    });

    supervisor.stop();

Call runAuthorized at each managed package activation or execution boundary. It checks current supervisor state and invokes the callback only after authorization checks pass. stop disables the guard. The supervisor also marks its state unhealthy when a poll throws, even if a custom sync adapter mistakenly leaves a prior snapshot marked healthy.

This is a host integration primitive, not proof that a particular production executor uses it. The callback remains responsible for verifying the actual artifact bytes/signature and any separate activation or runtime policy. This library does not discover or automatically wrap an existing production model/policy executor.

## Operational boundary

One process must own a spool directory. Provision adequate durable storage and monitor disk usage; capacity exhaustion is surfaced as an error and should trigger an operator/health alert. Filesystem permissions are not a substitute for encrypted disks, backups, or host security controls. The edge-agent library does not supply native MQTT/OPC UA/Modbus collectors, hardware-in-loop commissioning, complete deployment orchestration, or end-to-end production runtime wiring. Those require separate integration and deployment acceptance.
