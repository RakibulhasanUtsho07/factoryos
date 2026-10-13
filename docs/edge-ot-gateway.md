# WP11-A/B/C/D/E/F/G/H/I/J — Edge/OT gateway, offline recovery, health reporting, protocol adapters, and signed package governance

This backend slice establishes the cloud-side identity, telemetry replay, edge-agent health, and offline recovery boundary. It stores device and health metadata plus observations, but does not issue machine commands or connect to physical PLCs.

## API

Human-admin and history-read endpoints require a verified user identity, tenant membership, an authorized factory scope, and the relevant IAM permission. Device-ingest and health-report endpoints instead resolve tenant/factory/device from an active device bearer credential and re-check it inside the write transaction.

| Method | Endpoint | Permission | Purpose |
| --- | --- | --- | --- |
| POST | `/api/v2/edge/devices` | `edge.devices.write` | Register a device/gateway in the verified factory |
| GET | `/api/v2/edge/devices?limit=25&offset=0` | `edge.devices.read` | Read the factory-scoped fleet and last-sync state |
| POST | `/api/v2/edge/devices/:deviceId/status` | `edge.devices.control` | Pause, resume a paused device, or permanently revoke it |
| POST | `/api/v2/edge/devices/:deviceId/sync` | `edge.telemetry.ingest` | Synchronize a bounded batch of edge-buffered observations |
| GET | `/api/v2/edge/devices/:deviceId/observations?limit=25&offset=0` | `edge.telemetry.read` | Read the device observation timeline |
| POST | `/api/v2/edge/device-health/:deviceId` | Active device bearer credential | Append a device-agent health/model/drift report |
| GET | `/api/v2/edge/devices/:deviceId/health?limit=25&offset=0` | `edge.devices.health.read` | Read health-report history with model versions, queue state, and reported drift |
| GET | `/api/v2/edge/package-signing-keys` | `edge.packages.keys.read` | List scoped signer fingerprints and lifecycle state without returning key material in the admin response |
| POST | `/api/v2/edge/package-signing-keys` | `edge.packages.keys.manage` | Register an Ed25519 public key or add a replacement key during overlap rotation |
| POST | `/api/v2/edge/package-signing-keys/:keyId/revoke` | `edge.packages.keys.manage` | Permanently revoke a trusted signer key |
| GET | `/api/v2/edge/package-controls` | `edge.packages.controls.read` | List package control state scoped to the selected factory |
| POST | `/api/v2/edge/package-controls` | `edge.packages.controls.manage` | Pause/resume/revoke a package at factory, device, device-group, or use-case scope |
| GET | `/api/v2/edge/device-package-controls/:deviceId/effective?package_id=quality-defect&package_version=1.2.0` | Active device bearer credential | Resolve the strongest matching factory/device/group/use-case package control for an edge agent |

Registration accepts protocol metadata `OPC_UA`, `MQTT`, `MODBUS`, or `GENERIC`. The protocol adapter layer below normalizes allow-listed MQTT/OPC UA/Modbus samples into the durable spool. A deployment must supply a pre-authorized transport/client bridge; this slice does not open live broker/session connections or ship a native Modbus client driver.

## Device credential lifecycle

Human admins issue or rotate a device credential through `POST /api/v2/edge/devices/:deviceId/credentials` with the `edge.devices.credentials.manage` permission. The API returns a high-entropy bearer token once; PostgreSQL stores only its SHA-256 hash. The token includes the tenant and device identifiers as routing scope, but authorization comes only from a hash match against an ACTIVE, non-expired credential joined to an ACTIVE device. Its secret portion contains 256 bits of random entropy.

A new issue rotates away any previous active credential in the same transaction. Explicit revocation is available at `POST /api/v2/edge/devices/:deviceId/credentials/:credentialId/revoke`. Credential lifecycle events are append-only; raw tokens are excluded from audit records. If the one-time response is lost, rotate again rather than expecting the original token to be recoverable.

Machines send `Authorization: Bearer <device-token>` to `POST /api/v2/edge/device-ingest/:deviceId`. This separate route does not trust user identity headers or human JWT claims. It resolves tenant/factory/device from the token scope, checks the hashed active credential, then re-checks credential status inside the telemetry transaction to close a revoke-versus-ingest race. Telemetry rows identify the machine credential, rather than attributing machine writes to the human who enrolled the device.

Use HTTPS only and store the device token in an OS-protected secret store on the gateway. This implementation provides an opaque shared-secret identity; certificate-bound mTLS, per-device network policy and automated secret-store integration remain future hardening work.

## Reconnect and replay contract

- Each batch includes a stable `batch_key` and 1–100 observations. The normalized batch is limited to 64 KiB.
- Each observation has a stable UUID `event_id`, signal key, event time, source-mode declaration, quality, and bounded JSON payload. New local-agent intake also requires a top-level `unit` and `sampling_interval_ms` (0 means event-driven; positive values represent the periodic sample interval). Both values are persisted separately from the payload. The cloud endpoint accepts both metadata fields together or neither field for backward-compatible replay of pre-metadata spool files; historical records without metadata retain `NULL` rather than fabricated values.
- Replaying the same batch key with the same content returns the original summary. Reusing the key with different content returns a conflict.
- Replaying an observation under a different batch is accepted as a duplicate only when its event ID and normalized content hash match. Conflicting reuse fails the entire transaction.
- Observation and synchronization records are append-only. A failed item aborts the whole batch so callers can safely retry the stable event identities.
- The `source_mode` value is reported edge metadata, not cryptographic proof that an event was captured offline. Ingested event time and server ingest time are both retained.

## Edge-agent health, model versions, drift, and stream metadata

The edge agent posts an authenticated health report to `POST /api/v2/edge/device-health/:deviceId` on a 30-second default interval. Configure `EDGE_HEALTH_REPORT_INTERVAL_MS` between 10 seconds and one hour. `EDGE_AGENT_VERSION` defaults to `1.0.0`; optional `EDGE_MODEL_VERSIONS_JSON` supplies model-key/version pairs, and `EDGE_CAPABILITIES_JSON` overrides the default runtime/OS/architecture description.

Each report carries a stable UUID event key, the device-reported timestamp, runtime status, local queue depth/bytes, last successful cloud sync time, model-version map, bounded structured drift signals, and a bounded capabilities object. The server preserves both reported time and receive time. Event-ID replay with identical content is idempotent; reuse with different content conflicts. The append-only report ledger is tenant/factory/device scoped and linked to the credential that reported it. The fleet list includes the newest health snapshot for each device; admins with `edge.devices.health.read` can inspect the per-device history.

Reported model versions and drift signals are **device assertions**, not a verification result, calibrated drift determination, or permission to deploy a model. Drift signals must reference a model key present in the same report. Credential-like fields, unknown drift fields, unknown model references, oversize reports, and invalid values are rejected. Audit records contain queue counts, status and counts of models/signals, not model payloads or credentials.

Health reporting is best-effort and does not delete/alter the observation queue on failure. The agent reports a stable non-secret error code locally, retries on the next health interval, and separately continues the observation retry/ack flow. Last successful sync time is persisted in the local agent state file and restored on restart. The cloud's last received health report timestamp is useful for offline/staleness monitoring; when WAN access is down, the server cannot receive a new report until reconnect.

## WP11-E — MQTT and OPC UA adapter normalization

The adapter code lives under `services/api/src/edge/protocol-adapters/`:

- `MqttEdgeProtocolAdapter` subscribes only to exact, configured MQTT topics (wildcards and whitespace are rejected). Every mapping requires an explicit JSON value path and source timestamp path; source ID/sequence/quality paths are optional. If the message does not carry mapped quality, it is recorded as `UNCERTAIN`, not guessed as `GOOD`.
- `OpcUaEdgeProtocolAdapter` subscribes only to exact configured NodeIds and preserves the OPC UA source timestamp and mapped `GOOD`/`UNCERTAIN`/`BAD` quality.
- Both adapters require explicit signal key, unit, and sampling interval mappings, allow only bounded scalar values, and write one stable event into the same `DurableEdgeSpool`. Deterministic UUIDv5 identities include protocol, source identifier, optional source sequence, signal key, timestamp, value and quality. A retransmitted source sample therefore uses the same local batch/event identity.
- The supervisor starts bindings in order and rolls back earlier subscriptions/watches if a later binding fails. It shuts subscriptions down in reverse order and routes message/queue failures to the host-provided error callback.

Example mapping configuration (the transport clients themselves are injected by the deployment):

```ts
const mqttMappings = [{
  topic: 'factory-a/line-1/temperature',
  signalKey: 'line-1.temperature',
  unit: 'degC',
  samplingIntervalMs: 1000,
  valueField: 'reading.value',
  timestampField: 'reading.timestamp',
  sourceIdentifierField: 'device_id',
  sourceSequenceField: 'sequence',
  qualityField: 'reading.quality',
}];

const opcUaMappings = [{
  nodeId: 'ns=2;s=Factory.Line1.MotorTemperature',
  signalKey: 'line-1.motor-temperature',
  unit: 'degC',
  samplingIntervalMs: 500,
}];
```

The adapter contracts deliberately do not call `mqtt.connect`, create an OPC UA session, resolve arbitrary endpoint URLs, or handle private keys. A transport bridge must enforce TLS/certificate validation, topic/node authorization, OT network segmentation, timeouts, and least-privilege credentials before passing messages to these adapters. The host must provide a truthful current source-mode callback and monitor adapter errors; the adapter does not infer that a sample was offline merely because cloud sync later failed.

This is the driver-neutral adapter/normalization slice for **FR-IOT-03/04/05**, now covering MQTT, OPC UA and Modbus contracts. Hardware-in-the-loop tests, production MQTT broker and OPC UA server sessions, certificate-bound mTLS, and deployment wiring are intentionally still exit criteria rather than claimed as complete live connectivity.

## Safety and isolation

Device operations are bound to the verified tenant and factory context, re-authorized by IAM in the service, and protected by PostgreSQL tenant RLS plus composite tenant/factory foreign keys. Device status controls block new ingestion while paused or revoked; a revoked device cannot be reactivated. Credential-like fields are rejected from capability and observation JSON, and audit payloads retain hashes and counts rather than raw telemetry.

The authenticated user API is not a device-credential protocol. Before production deployment with direct device connectivity, certificate-bound device identity, reviewed MQTT/OPC UA client bindings, key rotation/revocation operations, and network-level allow-lists must be implemented.

## SRS traceability and boundaries

- **FR-EDG-03:** preserves the submitted observation quality/time and a source-mode label; it does not fabricate absent live values.
- **FR-EDG-04:** implements both the cloud-side immutable synchronization ledger and the edge agent's bounded durable local queue, restart recovery, capped retry scheduling, and deterministic replay boundary.
- **FR-IOT-05:** stores telemetry quality plus optional-compatible top-level unit/sampling metadata; new local-agent batches require both fields, and older persisted batches can replay without invented metadata.
- **FR-IOT-04:** provides exact topic/node allow-listing, deterministic sample normalization, source-timestamp/quality preservation, and adapter lifecycle contracts for MQTT/OPC UA; production driver/session integration remains deployment-owned.
- **FR-EDG-07:** restricts the API to IAM-authorized factory scopes and rejects credential material in payloads; OS/network sandboxing for an edge agent remains follow-up work.
- **FR-EDG-08:** exposes fleet status/last-sync state, agent and model versions, queue health, reported drift signals, and append-only per-device health history; values sent by a device remain unverified telemetry.
- **FR-EDG-12:** the control-plane API stores pause/resume/revoke rules scoped to a factory, registered device, registered device group, or supplied use-case ID. WP11-K adds device-token polling and a fail-closed execution-decision contract in the edge agent. An actual model-runtime kill-switch integration is still outstanding; a deployment-owned host must call the decision contract at the execution boundary.

Migration `040_edge_ot_device_gateway.sql` adds the scoped device registry, observation ledger, synchronization batches, RLS, immutable-ledger triggers, and IAM permissions. Migration `041_edge_device_credentials.sql` adds hashed machine credentials and identity-linked telemetry; migration `042_edge_device_health_and_stream_metadata.sql` adds health/drift history, stream unit and sampling fields, RLS, and the immutable health ledger. PostgreSQL CI applies the migrations after the WP10 migrations.


## WP11-F — graceful adapter shutdown and source timestamp validity

The MQTT and OPC UA adapter lifecycle now tracks each accepted asynchronous source callback through normalization and its durable-spool enqueue. `stop()` first releases subscriptions, then drains in-flight ingestion operations before returning. Hosts should stop protocol adapters before closing their durable spool, so an already accepted source sample is not raced against spool shutdown.

The shared timestamp normalizer requires an explicit timezone and validates the actual calendar components before accepting the timestamp. This prevents runtime date parsing from silently rolling an impossible date such as February 30 into a different timestamp, which would change the identity and meaning of the source event. The existing maximum-future-time bound remains in force.

Regression tests cover impossible source calendar dates and a deliberately blocked spool enqueue for both MQTT and OPC UA: adapter shutdown must remain pending until the enqueue settles. Transport drivers, broker credentials, OPC UA certificate/session creation and hardware-in-loop behavior remain outside this slice.


## WP11-G — Modbus register normalization

The ModbusEdgeProtocolAdapter adds the third protocol-normalization contract, aligned with WP11 Edge/OT scope. Each mapping is an explicit allow-listed tuple of unit ID, function code, and zero-based register/coil address, with a logical signal key, unit, source identifier, and polling interval. Unit IDs are restricted to 1–247, addresses to 0–65535, duplicate read mappings are rejected, and polling faster than 250 ms is rejected.

Supported read shapes:
- Function codes 1/2: one BOOL value from a coil/discrete-input read.
- Function codes 3/4: UINT16, INT16, UINT32, INT32, or FLOAT32 from one or two unsigned 16-bit registers.
- 32-bit values use explicit BIG_ENDIAN or LITTLE_ENDIAN register-word order. Optional finite scale/offset transforms are applied after decoding; BOOL cannot use numeric transforms.
- Read timestamps pass shared timezone/calendar validation; source quality is preserved as GOOD/UNCERTAIN/BAD and missing quality defaults to UNCERTAIN. Optional source sequence is preserved.
- Normalized events use the same stable UUIDv5 identity and durable spool path, making retries/reconnect consistent across protocols.

The adapter depends on an injected transport bridge that performs authorized register polling and presents read snapshots. It does not open TCP sockets, parse arbitrary endpoint configuration, create credentials, or claim native Modbus TCP/RTU connectivity. The deployment bridge remains responsible for network segmentation, device access policy, transport timeouts, client lifecycle, and hardware-in-loop verification. Supervisor tests cover startup/rollback; Modbus decoding and shutdown-drain tests cover the adapter data contract.



## WP11-H — signed edge package manifest verification

The services/api/src/edge/packages module verifies the signed package envelope before a deployment-specific installer is allowed to consume its files:

- Manifest schema v1 binds package/version, tenant and factory, issue/expiry timestamps, model version, policy-bundle version, the package tool allow-list, artifact paths and SHA-256 digests, and rollback target metadata.
- The release signature uses Ed25519 and a trusted public-key registry supplied by the host. Missing/revoked keys and non-Ed25519 keys fail closed; private signing keys never belong in the API or edge package.
- Verification enforces the exact target tenant/factory, an explicit host tool allow-list, strict timezone/calendar timestamp validation, a maximum validity window, unique safe relative artifact paths, exact artifact-set membership, declared byte lengths, and SHA-256 content hashes.
- Unknown manifest fields are rejected, so a package cannot smuggle credentials or unreviewed execution settings through additional JSON properties. Artifact paths containing traversal, absolute-path, drive-letter, hidden-path, or backslash forms are rejected.
- The verifier returns the normalized manifest, manifest digest, and aggregate artifact byte count. It does not extract archives or execute model code.

This provides the signed metadata and artifact-integrity gate for FR-EDG-02 / FR-EDG-05 and the signed-release-integrity aspect of NFR-AI-05. WP11-I adds the local filesystem activation/rollback contract below; WP11-J/M add cloud signer lifecycle and local public-key synchronization. Production deployment still needs integration with a real model/policy runtime, installer integration, and hardware/runtime acceptance tests.


## WP11-I — atomic activation pointer and persisted rollback

The services/api/src/edge/packages/EdgePackageActivationStore implements a local filesystem release store for one edge-agent writer:

- It verifies the Ed25519 signature, active signer, target tenant/factory, tool allow-list, expiry window, and every artifact hash again before activation.
- Verified artifact files, normalized manifest, signature and release metadata are written to a private staging directory. Files are synced before the staging directory is renamed into an immutable content-addressed release directory.
- The active state is kept in a per-package JSON pointer. A temporary pointer file is synced and atomically renamed into place, so a failed staging/write step leaves the existing active pointer untouched.
- The persisted pointer records the active and previous version plus manifest digest. Re-activating the same verified version/digest is idempotent; attempting to bind different contents to the same active version is rejected.
- A newly activated manifest that enables rollback must name the currently active version as its rollback target. Rollback re-verifies the current and previous signed releases and their stored artifacts, then atomically swaps the pointer only when the signed rollback target matches the persisted previous release.
- A missing, tampered, expired, untrusted, or revoked previous release fails closed and leaves the active pointer unchanged. State files use restrictive POSIX modes where supported.

This store requires a trusted local root directory on a filesystem with atomic same-volume rename semantics and a **single writer** per package. The implementation does not unpack archives, start model runtimes, or execute policy/tool code. WP11-J adds the cloud signer registry and control plane; WP11-K adds agent polling/decision contracts. OS-level service sandboxing, local verifier trust injection, integration with an actual model runtime, and hardware-in-loop acceptance remain follow-up gates.


## WP11-J — signer rotation/revocation and remote package controls

Migration 043_edge_package_governance.sql adds tenant/factory-isolated signing-key state and package control state with append-only lifecycle event tables, restrictive foreign keys, indexes, and RLS policies.

### Signing-key registry

- Only Ed25519 public-key PEM is accepted. Private-key PEM, other asymmetric key types, malformed key IDs, and duplicate key IDs with conflicting material are rejected.
- Registration records a SHA-256 fingerprint, not a private signing key. A rotation request may name the previous key; the new key is added as ACTIVE and the previous key deliberately remains trusted during the overlap window. The previous key is not implicitly retired because still-valid releases can rely on it.
- Revocation is terminal and idempotent. The key registry returns ACTIVE/REVOKED state to an internal verifier bridge, while the admin list returns key IDs/fingerprints/lifecycle metadata without the PEM.
- Registration, rotation-addition, and revocation are recorded transactionally in an append-only key event ledger. Audit payloads omit key material.

### Pause/resume/revoke by target

POST /api/v2/edge/package-controls accepts package ID, package_version (* or a semantic version), target kind (FACTORY, DEVICE, DEVICE_GROUP, USE_CASE), target key, action (PAUSE, RESUME, REVOKE), and an operator reason. Device/group targets are checked against the selected tenant/factory registry. A control can be resumed only while it has not been permanently revoked.

GET /api/v2/edge/device-package-controls/:deviceId/effective authenticates a device bearer credential and resolves matching rules for the device, its registered group, the factory, and an optional use-case ID. Any matching REVOKED rule wins over PAUSED; any PAUSED rule wins over ACTIVE. Narrower scopes cannot override a broader revocation. Package-control state changes and their append-only event records commit in one database transaction.

These are cloud-side trust/control-plane primitives aligned to FR-EDG-05 / NFR-AI-05 and the remote-scope management intent of FR-EDG-12. WP11-K adds authenticated edge-agent polling and a fail-closed local decision contract for explicitly configured packages; WP11-M adds public signing-key synchronization and a verifier-policy provider. Since this repository does not yet launch model/policy runtimes, deployment hosts must call `isPackageExecutionAllowed(packageId, version, useCaseId)` immediately before starting or continuing package execution; the agent's spool/telemetry worker does not pretend to be a model runtime. Integration with an actual model runtime, device-group/use-case package assignment semantics, key rollover grace policy, and online/offline hardware acceptance remain release gates.


## WP11-K — edge-agent package-control polling and execution gate

The local edge agent can be configured with `EDGE_MANAGED_PACKAGES_JSON`, an array of exact package scopes, for example:

```json
[
  { "package_id": "quality-defect", "package_version": "1.2.0", "use_case_id": "inspection" }
]
```

It polls `GET /api/v2/edge/device-package-controls/:deviceId/effective` with its device bearer credential and exact package/version/use-case query. `EDGE_PACKAGE_CONTROL_POLL_INTERVAL_MS` defaults to 30 seconds (allowed range 5 seconds–1 hour); at most ten explicit package scopes are accepted to bound polling fan-out. The API remains the authority for tenant/factory/device scope and matching control precedence.

The local decision contract is fail-closed: a package that is not configured, has never received a successful control decision, reports PAUSED/REVOKED, encounters an invalid/error response, or has stale state is not allowed to execute. A REVOKED result is latched for the life of the agent process; remote control decisions are shown in the loopback-only `/healthz` response without including operator reason text. A deployment-owned model/policy host must consult `isPackageExecutionAllowed(packageId, version, useCaseId)` at the execution boundary; no model runtime or package auto-launcher is claimed. Cloud connectivity loss causes an UNKNOWN decision and blocks governed execution until a successful poll recovers it. This does not stop telemetry spool/replay, which remains independent.

Validation adds runtime tests for authenticated scope polling, explicit package allow-listing, fail-closed behavior on HTTP failure, and terminal local revoke latching. This covers the agent-polling/decision-contract portion of **FR-EDG-12**; actual model-runtime kill-switch integration and hardware-in-loop acceptance remain open.


## WP11-L — durable local package-control revocation

The edge agent now stores its package-control decision ledger at `package-controls.json` in the same private local spool directory. State updates use a temporary file, fsync, atomic rename and directory sync; the file is mode-restricted where the operating system supports POSIX permissions. Concurrent package polls serialize updates to avoid losing another package's latest state.

On restart, only a persisted `REVOKED` decision is restored as an immediate execution denial. Previously cached ACTIVE/PAUSED decisions are deliberately treated as UNKNOWN until the control endpoint is reached successfully again. Malformed, oversized, symlinked, or structurally invalid state files prevent startup rather than being silently reset. A poll whose result cannot be durably saved cannot authorize execution.

The restart regression test revokes a package, closes the first runtime, then starts a second runtime on the same spool directory while the mock server reports ACTIVE. The package remains denied. This is local defense-in-depth; server-side terminal revocation remains the authority, and OS-level protection/backup of the spool directory is still required.


## WP11-M — cloud signer-key synchronization and local verifier policy

The device-token endpoint `GET /api/v2/edge/device-package-signing-keys/:deviceId` returns the complete tenant/factory-scoped public Ed25519 key registry, including ACTIVE and REVOKED entries. Device credentials are authenticated through the existing device credential service; caller-supplied tenant/factory headers are not used. The snapshot is bounded to 512 registry entries; a larger registry fails rather than silently truncating older revoked keys. Public-key PEM and SHA-256 fingerprint are returned, never private signing material.

The edge agent polls this endpoint using its device bearer credential. Configure `EDGE_PACKAGE_SIGNING_KEY_POLL_INTERVAL_MS` (default 60 seconds; range 10 seconds–1 hour). The local `EdgePackageSigningKeyStore` verifies each key's Ed25519 type and SHA-256 fingerprint, binds the snapshot to the device token's tenant and the initially synchronized factory, and durably stores it using fsync plus atomic rename. Rebinding a key ID to different public-key material is rejected. A key that was revoked, or disappears from the server's complete snapshot, remains locally REVOKED and cannot be reactivated by a later snapshot. Failed synchronization immediately invalidates ACTIVE trust; the verifier policy also fails closed when the last successful snapshot becomes stale.

The host can construct the policy consumed by `verifyEdgePackage` / `EdgePackageActivationStore` through `runtime.createPackageVerificationPolicy({ tenantId, factoryId, allowedToolIds })`. Only a recent, successfully synchronized ACTIVE key is passed as ACTIVE; revoked/stale/failed-sync keys are represented as REVOKED so signature verification cannot accept them. `/healthz` reports key counts and synchronization status, not public-key PEM. This wires the key registry into a verifier-policy source, but a deployment still has to route package activation through that policy provider and connect the activation/control gates to its actual model/policy runtime. Local trust-store directory protection and hardware-in-loop acceptance remain release gates.
