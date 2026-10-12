# WP11-A/B/C/D/E/F/G — Edge/OT gateway, offline recovery, health reporting, and protocol adapters

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
- **FR-EDG-12:** supports factory-scoped pause/resume/revoke status. Device-group and use-case package revocation remain follow-up work.

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

