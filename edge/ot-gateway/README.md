# FactoryOS OT Edge Gateway

This is a separate long-running, container-ready edge executable. It is intentionally outside the API workspace: the API remains an authenticated control/telemetry plane and must not open PLC sockets itself.

## Protocol behavior

- **OPC UA** creates a secure client session using SignAndEncrypt / Basic256Sha256, verifies the configured server trust certificate, and supports subscriptions, polling, or both. Monitored and polled scalar values enter the durable spool before upload.
- **MQTT** uses a persistent MQTT 5 session, exact configured topic subscriptions, QoS 1 and mutual-TLS broker credentials. The MQTT.js acknowledgement callback is invoked only after the encrypted spool snapshot has been committed, fsynced and atomically renamed. If persistence fails, the callback receives an error and broker acknowledgement is withheld.
- **Modbus TCP** exposes holding/input-register reads only (functions 3 and 4). The HTTP request selects a registered device and exact registered map entries; it cannot select a host/port, register, unit ID or write function. Periodic reads also enqueue samples for offline replay. No coil/register write API exists.

All network destinations are fixed in the read-only gateway JSON configuration and must also appear in security.approvedTargets. The API request cannot alter endpoint addresses. Deployments should enforce the accompanying network policy and broker ACLs independently; a JSON allowlist is not a replacement for network segmentation.

## Build and run

The direct protocol-library versions are pinned in package.json. Build from the repository root:

    docker build -t factoryos-ot-edge-gateway:0.1.0 edge/ot-gateway

Create a deployment-controlled configuration from deploy/gateway-config.example.json, then store it as the gateway.json key in ConfigMap factoryos-ot-gateway-config. Replace every example address, identifier, NodeId, register map, and target list with the reviewed site values. Do not copy example tenant/device IDs into a production site.

Create secret material through the approved secret manager (or Kubernetes Secret as an interim mount mechanism). Required files are referenced by the configuration, not passed in request bodies:

- gateway HTTPS server certificate and matching private key
- gateway API bearer token (at least 32 characters)
- 32-byte spool encryption key, encoded as 64 hex characters or base64
- FactoryOS API workload token (at least 32 characters)
- MQTT CA, client certificate and matching private key
- OPC UA client certificate/private key and the operator-approved server trust certificate, for every configured OPC UA trust domain

Mount the files read-only under /run/secrets. The gateway checks certificate/private-key correspondence before connecting and never logs their contents. The spool key is **not** auto-rotated: changing it without re-encrypting the existing spool correctly makes recovery fail closed. Run the documented key-migration procedure with the gateway stopped before replacing that key.

The gateway expects a trusted HTTPS origin in api.baseUrl and exposes:

- GET /healthz: process/liveness summary (HTTP 200 while the process can serve health)
- GET /readyz: HTTP 200 only when configured drivers are ready, otherwise 503
- POST /api/v1/modbus/read: bearer-authenticated, scope-bound, read-only gateway API; optional mTLS client verification is enabled when security.clientCaFile is configured

The existing FactoryOS API client must point FACTORYOS_OT_PROTOCOL_GATEWAY_URL at the fixed HTTPS /api/v1/modbus/read endpoint and set FACTORYOS_OT_PROTOCOL_GATEWAY_TOKEN to the corresponding service credential. In production, use the mTLS ingress/service-mesh policy used by the API deployment and restrict network policy ingress to the API workload. Do not expose this service directly to the public internet.

## Restart, reconnect and replay

The process polls its encrypted spool and sends batches of at most 20 events to POST /api/ot/devices/:deviceId/telemetry/batch. It removes an entry only after the API response has the right tenant/device, exactly one accepted result per source ID, and an accepted status. A timeout after the API commits is treated as ambiguous: the same source IDs are retried. The API's duplicate replay response can then safely complete the spool acknowledgement.

The encrypted spool uses AES-256-GCM, fresh IVs, file mode 0600, directory mode 0700, file and directory fsync, atomic replacement, fingerprint validation and bounded storage. Wrong keys, truncated snapshots and tampered contents fail closed; the process does not reset the queue. Entries are not silently evicted at capacity. After 12 consecutive failed replays an entry is blocked, remains durable, and requires operator review plus the exact fingerprint to requeue.

Mounted HTTPS, MQTT and OPC UA certificate/key/trust files are fingerprinted every 30 seconds. A valid certificate/key change updates the HTTPS secure context and recreates protocol sessions with the replacement credentials. FactoryOS API and gateway bearer tokens are read on use so token replacement takes effect without writing secrets to config. If certificate pairing or trust validation fails, the driver remains unavailable and readiness stays false rather than silently switching to anonymous or plaintext transport.

## Local test and simulator

    cd edge/ot-gateway
    npm install --no-audit --no-fund
    npm run check
    npm test

The automated fault suite exercises encrypted spool restart, wrong-key rejection, source sequence-gap preservation, MQTT durable-ack ordering and duplicate delivery after simulated PUBACK loss, API commit/acknowledgement loss, blocked-record review/requeue, secret fingerprint changes, actual Modbus TCP reads against a local socket simulator, dropped responses, wrong unit IDs and refusal of write functions.

The CI job also builds the container. It is suitable for simulator/fault-injection acceptance, but is not evidence of a commissioned PLC site by itself.

## Secure deployment sequence

1. Provision a dedicated OT subnet/VLAN and firewall rules first. Permit only the reviewed broker, OPC UA server, Modbus meter, DNS and FactoryOS API target. Keep all PLC write-capable ports outside this gateway's contract.
2. Create least-privilege MQTT broker credentials/ACLs bound to the configured client ID and exact topic list. Reject wildcard subscriptions and limit publish/subscribe rights at the broker.
3. Issue and install the gateway server certificate, MQTT client identity and OPC UA client identity through the site-approved PKI. Confirm certificate fingerprints and trust roots with the OT operator before rollout.
4. Apply the ConfigMap and Secret names/paths referenced by deploy/deployment.yaml; replace the sample CIDRs in deploy/network-policy.yaml with the exact approved address/port set. Never widen the policy to 0.0.0.0/0.
5. Start in simulator/staging mode, disconnect each upstream path, confirm the spool grows, restart the container, reconnect, and reconcile source IDs and sequence statuses against the API ledger.
6. Perform operator-approved HIL commissioning using deploy/commissioning-evidence.template.md. Record the real hardware/site/build/certificate fingerprints, fault result, restoration evidence and operator sign-off. Only then approve a production staged rollout.

## Explicit acceptance boundary

No live PLC, production broker, customer key store or site hardware was available during repository implementation. This repository therefore does not claim completed HIL commissioning evidence. The simulator tests are automated; the commissioned site test record must be completed and signed by the authorized OT operator after using the actual site hardware.
