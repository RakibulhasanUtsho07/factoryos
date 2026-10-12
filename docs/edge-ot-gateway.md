# WP11-A — Edge/OT device gateway foundation

This backend slice establishes the cloud-side identity and replay boundary for edge gateways. It is intentionally read-first: it stores device metadata and observations, but does not issue machine commands or connect to physical PLCs.

## API

All endpoints require a verified user identity, tenant membership, an authorized factory scope, and the relevant IAM permission.

| Method | Endpoint | Permission | Purpose |
| --- | --- | --- | --- |
| POST | `/api/v2/edge/devices` | `edge.devices.write` | Register a device/gateway in the verified factory |
| GET | `/api/v2/edge/devices?limit=25&offset=0` | `edge.devices.read` | Read the factory-scoped fleet and last-sync state |
| POST | `/api/v2/edge/devices/:deviceId/status` | `edge.devices.control` | Pause, resume a paused device, or permanently revoke it |
| POST | `/api/v2/edge/devices/:deviceId/sync` | `edge.telemetry.ingest` | Synchronize a bounded batch of edge-buffered observations |
| GET | `/api/v2/edge/devices/:deviceId/observations?limit=25&offset=0` | `edge.telemetry.read` | Read the device observation timeline |

Registration accepts protocol metadata `OPC_UA`, `MQTT`, `MODBUS`, or `GENERIC`. These values identify the intended transport; this slice does not implement or claim a live OPC UA, MQTT, or Modbus connection.

## Reconnect and replay contract

- Each batch includes a stable `batch_key` and 1–100 observations. The normalized batch is limited to 64 KiB.
- Each observation has a stable UUID `event_id`, signal key, event time, source-mode declaration, quality, and bounded JSON payload.
- Replaying the same batch key with the same content returns the original summary. Reusing the key with different content returns a conflict.
- Replaying an observation under a different batch is accepted as a duplicate only when its event ID and normalized content hash match. Conflicting reuse fails the entire transaction.
- Observation and synchronization records are append-only. A failed item aborts the whole batch so callers can safely retry the stable event identities.
- The `source_mode` value is reported edge metadata, not cryptographic proof that an event was captured offline. Ingested event time and server ingest time are both retained.

## Safety and isolation

Device operations are bound to the verified tenant and factory context, re-authorized by IAM in the service, and protected by PostgreSQL tenant RLS plus composite tenant/factory foreign keys. Device status controls block new ingestion while paused or revoked; a revoked device cannot be reactivated. Credential-like fields are rejected from capability and observation JSON, and audit payloads retain hashes and counts rather than raw telemetry.

The authenticated user API is not a device-credential protocol. Before production deployment with direct device connectivity, a separate device authentication scheme (for example certificate-bound identity), transport adapters, key rotation/revocation handling, and network-level allow-lists must be implemented.

## SRS traceability and boundaries

- **FR-EDG-03:** preserves the submitted observation quality/time and a source-mode label; it does not fabricate absent live values.
- **FR-EDG-04:** implements the cloud-side durable synchronization ledger and deterministic deduplication needed by reconnecting clients. A local edge spool/queue and edge-runtime persistence remain follow-up work.
- **FR-EDG-07:** restricts the API to IAM-authorized factory scopes and rejects credential material in payloads; OS/network sandboxing for an edge agent remains follow-up work.
- **FR-EDG-08:** exposes fleet status and last successful synchronization timestamps through the device list. Model version, drift, and package health reporting remain follow-up work.
- **FR-EDG-12:** supports factory-scoped pause/resume/revoke status. Device-group and use-case package revocation remain follow-up work.

Migration `040_edge_ot_device_gateway.sql` adds the scoped device registry, observation ledger, synchronization batches, RLS, immutable-ledger triggers, and IAM permissions. PostgreSQL CI applies the migration after the WP10 migrations.
