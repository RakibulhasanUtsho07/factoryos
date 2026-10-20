# OT device registry and OPC UA — first bounded read slice

## Scope and traceability boundary

This is the first OPC UA integration slice layered over the device registry and server-side telemetry spool in migration 148. It advances Round 39 in docs/operational-rounds-35-43-traceability.md; it is not a signed SRS acceptance report because the authoritative approved SRS/HLD source files are not stored in this repository snapshot.

The API owns the tenant/factory-scoped device registry, lifecycle approval, immutable registered NodeId allowlist, authorization and auditable read requests. A separately deployed trusted OT edge gateway owns the industrial network connection, endpoint resolution, OPC UA session security and secret-manager lookup. The API does not accept an endpoint URL, password, certificate private key or credential value from the caller.

## Device registration profile

For a new OPC_UA device, include a small unique read allowlist under metadata.opcua.allowed_node_ids. The allowlist is immutable after registration, so review it as part of the device registration/approval process.

    {
      "display_name": "Machine 01",
      "device_key": "MACHINE-01",
      "protocol": "OPC_UA",
      "connection_reference": "config://PLC_A",
      "secret_reference": "env://OT_SECRET_PLC_A",
      "metadata": {
        "opcua": {
          "allowed_node_ids": [
            "ns=2;s=Machine01.Temperature",
            "ns=2;i=101"
          ]
        }
      }
    }

Only the deliberately restricted NodeId grammar implemented in services/api/src/ot/ot-device.contract.ts is accepted; unsupported escaped NodeId forms require a separately reviewed contract update rather than a permissive bypass. One profile can allow 1–20 nodes. One read call can request 1–10 unique nodes, and every requested NodeId must exactly match the registered allowlist.

## API contract and authorization

Endpoint: POST /api/ot/devices/:deviceId/opcua/read

Permission: ot.opcua.read; the controller also requires authenticated tenant and factory scope. The target device must belong to that scope, use OPC_UA, and be ACTIVE. Paused, pending-review, revoked, non-OPC-UA or out-of-scope devices fail closed. This endpoint is a single read operation only; it does not expose write, method-call, node-browse, subscription or polling operations.

Successful responses contain a request ID and bounded node_id, GOOD|UNCERTAIN|BAD quality, JSON value, source/server timestamps and optional safe source sequence. The response is rejected if its request ID, node count, NodeId set, data types, timestamps or quality values do not satisfy the gateway contract. A read is discarded if device status/version changes before the successful audit outcome can be committed.

## Trusted gateway configuration

The API accepts no target URL from the request. Deployment configuration must provide:

| Environment variable | Contract |
|---|---|
| FACTORYOS_OPCUA_GATEWAY_URL | Fixed URL whose path ends in /api/v1/read; HTTPS is mandatory in production. HTTP is allowed only for a loopback host outside production. URL user info, query and fragment are rejected. |
| FACTORYOS_OPCUA_GATEWAY_TOKEN | Service-to-service bearer token, at least 32 characters; store and rotate through the deployment secret manager. Never commit it. |
| FACTORYOS_OPCUA_GATEWAY_TIMEOUT_MS | Optional integer between 100 and 5000 ms; default is 3500 ms. |

The adapter posts a schema-versioned envelope containing the server-generated request ID, tenant/factory/device scope, device key, opaque connection_reference and allowlisted NodeIds. It deliberately does not transmit the stored secret_reference or any credential value. The gateway is expected to resolve the reference to an approved target using its own allowlist and secret manager, enforce the configured OPC UA security policy/certificate trust, execute value reads only, and return one result per requested NodeId with the exact request ID. The gateway must not treat caller-provided scope fields as proof of authorization; it should verify the service identity and device mapping.

Remote non-HTTPS URLs, unconfigured credentials, timeout values outside the safe range, gateway errors, response bodies over 16 KiB, values above 4 KiB, credential-like value fields and unsolicited/duplicate/missing NodeIds fail closed. Public API errors do not echo upstream response bodies or credentials.

## Audit and data boundaries

ot_device_history appends OPCUA_READ_COMPLETED and OPCUA_READ_FAILED outcomes. Success metadata includes request ID, requested NodeIds and quality counts; failure metadata stores only a coarse failure class. Telemetry values, endpoint URLs and credentials are not copied into this history event. Existing device lifecycle and telemetry ledger rows retain forced RLS, tenant/factory predicates and scoped foreign keys. A failed gateway call is never represented as a successful read.

This endpoint is an on-demand read and returns normalized values to the authenticated caller. It does not silently create telemetry ledger events, run a scheduler, persist a connection session, or subscribe to changing nodes. The separately authorized telemetry ingestion path remains responsible for accepted telemetry batches and replay/sequence classification.

## Verification in CI

- Contract unit tests cover allowlist shape, supported NodeId forms, unsafe credential-like values, exact gateway response binding and batch bounds.
- Service unit tests cover successful reads, unapproved NodeId rejection, paused device rejection and audit outcome persistence.
- Migration 157 grants the explicit read permission and adds success/failure action types to the append-only OT history contract.
- services/api/test/ot-opcua-read-contract.sql asserts permission grants and audit schema. API PostgreSQL CI applies and reapplies migration 157, checks that no SQL migration is omitted and runs this contract alongside the existing device registry contract.

A green CI run proves the API/gateway contract tests, not a live controller connection. Before production commissioning, deploy and review the actual gateway driver; verify OPC UA certificates/security mode, endpoint and NodeId mapping, network segmentation, rate limits, source clock/quality behavior, secret rotation and log minimization; then capture simulated fault tests and hardware-in-the-loop operator acceptance.

## Explicitly not included

No direct node-opcua session driver or edge gateway executable is shipped in this API slice. OPC UA session renewal, certificate enrollment/rotation, node browsing, subscriptions, periodic polling, write/method execution, edge-disk spool encryption/quotas, MQTT or Modbus connectors, broker QoS and automatic reconnect remain separate work items. The adapter is intentionally read-only and disabled until deployment configuration is present.
