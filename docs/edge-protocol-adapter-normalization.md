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

The durable spool file format in this library is **not encrypted at rest**. Mode-restricted files and atomic writes do not substitute for encryption. Before storing sensitive production telemetry, the deployment must place the spool on an approved encrypted volume/filesystem with strict OS ownership and backup controls, and must never send credentials or secrets in observation payloads. Corruption or wrong structure must trigger operational investigation rather than queue reset.

This port intentionally does not add a native MQTT client, OPC UA session/certificate manager, Modbus TCP socket driver, broker ACL, plant firewall/VLAN policy, secret-manager integration or hardware-in-the-loop commissioning. Those are separate deployment/OT acceptance gates. The adapters normalize **read-only telemetry**; they must not be treated as PLC write capability. No production commissioning or signed SRS acceptance is implied by repository CI.

## Verification

The Jest specs cover bounded spool behavior and restart/recovery invariants, MQTT/OPC UA/Modbus input validation and deterministic normalization, and lifecycle rollback/drain. API CI must pass on the exact pull-request head before this slice is promoted.
