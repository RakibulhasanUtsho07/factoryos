# Edge protocol adapter normalization library

## Status and intended boundary

This is a reusable, transport-injected library slice under `services/api/src/edge/protocol-adapters`. It is not a live industrial protocol driver and does not open network sockets, resolve endpoints, load certificates, or establish broker/OPC UA/Modbus sessions. A deployment-owned host supplies the already-authorized transport implementation and the durable-spool sink.

## Implemented contracts

- MQTT uses exact, explicit topic mappings (no topic wildcards), bounded payload sizes, selected JSON fields, strict timestamp/quality/sequence validation, and deterministic event identity.
- OPC UA uses explicit NodeId mappings, source timestamps and quality, with bounded normalized values and optional source sequence.
- Modbus normalization accepts explicit unit/function/address mappings and read snapshots only. BOOL bit reads and supported integer/FLOAT32 register decoding are bounded and validated; scale/offset must be finite. This library does not provide write operations or select a target host.
- Shared utilities reject credential-like payload fields, unsafe JSON paths and invalid units/sampling intervals, and normalize observations into the durable batch contract.
- The supervisor unwinds already-started adapters in reverse order if a later binding fails, and drains accepted async work on shutdown.
- The durable spool uses bounded queue limits, single-process locking, private directory/file modes, atomic replacement, sync-before-rename, replay fingerprints, retry backoff and fail-closed recovery for malformed state.

## Security boundary that remains

Persisted agent-state and queued batch records are encrypted at rest with **AES-256-GCM**, independent random 96-bit IVs, 128-bit authentication tags, and additional authenticated data bound to each record's relative spool path. The constructor requires a 32-byte `Uint8Array` encryption key injected by the deployment host from an approved secret manager or mounted secret. The key is never written to disk.

An incorrect key, modified ciphertext/tag, malformed envelope or unexpected plaintext record fails closed with `SPOOL_CORRUPT`; no queue item is silently deleted and there is no plaintext fallback. **Do not point this encrypted implementation at an existing directory containing plaintext spool files.** Any pre-encryption queue needs an approved offline drain/migration procedure and recorded integrity checks before cutover. This library does not implement in-place key rotation; rotate only after draining the queue or through a separately reviewed atomic re-encryption procedure.

At-rest encryption complements rather than replaces restrictive filesystem permissions, approved encrypted storage, backup/key custody controls and access monitoring. Credentials, bearer tokens and secret material remain forbidden in observation payloads.

This port intentionally does not add a native MQTT client, OPC UA session/certificate manager, Modbus TCP socket driver, broker ACL, plant firewall/VLAN policy, secret-manager integration or hardware-in-the-loop commissioning. Those are separate deployment/OT acceptance gates. The adapters normalize **read-only telemetry**; they must not be treated as PLC write capability. No production commissioning or signed SRS acceptance is implied by repository CI.

## Verification

The Jest specs cover bounded spool behavior and restart/recovery invariants, MQTT/OPC UA/Modbus input validation and deterministic normalization, and lifecycle rollback/drain. API CI must pass on the exact pull-request head before this slice is promoted.
