# Edge device gateway and credential-bound ingest

## Scope of this slice

Migrations 191–192 add the tenant/factory-scoped edge device registry, immutable observation and reconnect-batch ledgers, opaque device credentials and immutable credential lifecycle events. The API supports registration, device status changes, credential issue/revocation, authenticated machine ingress and authorized observation reads.

## Security and idempotency

Human administration routes require edge.devices.* or edge.telemetry.* IAM permissions and verified factory context. Machine ingress uses the device's opaque bearer credential to resolve tenant/factory/device scope; it does not accept scope from caller-supplied headers. The database rechecks credential/device status during ingestion, stores only SHA-256 token hashes, and allows only one active credential for a device. Credentials expire within 366 days and can be revoked. Batch keys and per-device event IDs are unique, payload replays are idempotent, and changed-payload replays conflict. Observation, batch and credential lifecycle evidence is append-only under forced tenant RLS.

Observation stream metadata accepts a unit plus sampling_interval_ms as a pair (0 denotes event-driven ingest, positive values denote periodic sampling). Raw device credentials are never written to audit or application ledgers.

## Deployment boundary

This slice supplies the authenticated server gateway and persistence contract. It does not claim a live MQTT/OPC UA/Modbus transport, hardware-in-loop validation, device certificate/mTLS rollout, or an installed local spool deployment. Those remain later integration gates.
