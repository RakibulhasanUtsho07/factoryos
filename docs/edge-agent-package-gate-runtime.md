# Standalone edge-agent package-governance runtime

## Run boundary

The edge-agent runtime is a separate process from the NestJS HTTP API. Build the API workspace and launch it with `npm --workspace services/api run start:edge-agent`. Configure it from `services/api/.env.edge-agent.example` or an equivalent deployment environment. The example is a template, not a secrets file. Only expose the agent's local intake on loopback; the API origin must be HTTPS outside local loopback tests.

## Durable spool key

`EDGE_SPOOL_ENCRYPTION_KEY` is mandatory. It must be canonical Base64 decoding to exactly 32 random bytes. The entrypoint validates both the Base64 representation and decoded length before constructing the runtime. Load the key from an approved secret manager or mounted secret, keep it separate from `EDGE_AGENT_LOCAL_TOKEN`, and never store it beside the queue files.

The durable queue and sync state use AES-256-GCM. A wrong key, modified tag or corrupted record fails closed; there is no plaintext fallback. Do not start this agent on an existing plaintext spool. Existing queues require a separately reviewed offline drain/migration process. In-place key rotation is not implemented; changing the key while encrypted files exist will make authentication fail and requires an approved recovery procedure.

## Package trust and control polling

At startup, the runtime validates the one-time-issued device credential, initializes encrypted spool and local package-control/signer-key stores, and restores only terminal local revocations. Its background worker polls the server's device-token-authenticated full signer snapshot and each configured effective package-control scope, while continuing bounded telemetry replay and health reporting.

The tenant scope is derived from the tenant and device IDs encoded in the one-time-issued credential and cross-checked against the server snapshot. Caller-controlled tenant/factory headers do not establish scope. Complete signer snapshots are validated for tenant/factory, public-key material and SHA-256 fingerprints; stale, malformed, oversized or failed snapshots fail closed. Locally persisted REVOKED signer keys and package controls are terminal.

Only entries explicitly listed in `EDGE_MANAGED_PACKAGES_JSON` are governed. Unknown, stale, PAUSED, REVOKED or failed control states deny activation/execution. Package activation must use `EdgeAgentRuntime.activateSignedPackage(...)`, which invokes the signed-manifest verifier/coordinator and demands a fresh exact-scope ACTIVE decision and valid trusted signer policy before calling the activation store.

## Execution-time enforcement boundary

The coordinator and runtime expose `isPackageExecutionAllowed(packageId, version, useCaseId)`, but this function cannot stop arbitrary code automatically. The deployment-owned model/policy host must invoke the gate immediately before every model package invocation or side effect and deny unless the function returns true. Direct use of the lower-level activation store or execution without that check bypasses this boundary.

The runtime polls server controls but does not operate MQTT/OPC UA/Modbus connections, provision device PKI, set broker ACLs, configure plant VLAN/firewall rules, or change PLC state. Those remain site/deployment work. CI verifies software contracts, not hardware-in-loop commissioning or signed SRS production acceptance.
