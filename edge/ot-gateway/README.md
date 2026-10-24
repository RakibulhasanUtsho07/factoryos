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
- GET /readyz: HTTP 200 only when configured drivers are ready, spool state is readable, no entry is blocked for operator review, and the durable queue has free capacity; otherwise 503. `/healthz` remains a process-liveness check and still returns HTTP 200 while the process can serve health, even if readiness is false.
- POST /api/v1/modbus/read: bearer-authenticated, scope-bound, read-only gateway API; optional mTLS client verification is enabled when security.clientCaFile is configured

The existing FactoryOS API client must point FACTORYOS_OT_PROTOCOL_GATEWAY_URL at the fixed HTTPS /api/v1/modbus/read endpoint and set FACTORYOS_OT_PROTOCOL_GATEWAY_TOKEN to the corresponding service credential. In production, use the mTLS ingress/service-mesh policy used by the API deployment and restrict network policy ingress to the API workload. Do not expose this service directly to the public internet.

## Restart, reconnect and replay

The process polls its encrypted spool and sends batches of at most 20 events to POST /api/ot/devices/:deviceId/telemetry/batch. It removes an entry only after the API response has the right tenant/device, exactly one accepted result per source ID, and an accepted status. A timeout after the API commits is treated as ambiguous: the same source IDs are retried. The API's duplicate replay response can then safely complete the spool acknowledgement.

The encrypted spool uses AES-256-GCM, fresh IVs, file mode 0600, directory mode 0700, file and directory fsync, atomic replacement, fingerprint validation and bounded storage. Wrong keys, truncated snapshots and tampered contents fail closed; the process does not reset the queue. Entries are not silently evicted at capacity. After 12 consecutive failed replays an entry is blocked, remains durable, and requires operator review plus the exact fingerprint to requeue.

At startup, the gateway fingerprints the complete mounted secret-file inventory before opening protocol sessions and checks it again after session initialization; any missing file or credential change during startup aborts and cleans up the partial startup. Mounted HTTPS, MQTT and OPC UA certificate/key/trust files are fingerprinted every 30 seconds. A valid certificate/key change updates the HTTPS secure context and recreates protocol sessions with the replacement credentials. FactoryOS API and gateway bearer tokens are read on use so token replacement takes effect without writing secrets to config. If certificate pairing, trust validation, or a rotated secret file fails, the gateway stops its protocol drivers and keeps readiness false until the currently mounted secret set can be validated and the drivers can restart; it never silently switches to anonymous or plaintext transport.

## Local test and simulator

    cd edge/ot-gateway
    npm install --no-audit --no-fund
    npm run check
    npm test

The automated fault suite exercises encrypted spool restart, wrong-key rejection, source sequence-gap preservation, MQTT durable-ack ordering and duplicate delivery after simulated PUBACK loss, API commit/acknowledgement loss, blocked-record review/requeue, secret fingerprint changes, actual Modbus TCP reads against a local socket simulator, dropped responses, wrong unit IDs and refusal of write functions.

The CI job also builds the container. It is suitable for simulator/fault-injection acceptance, but is not evidence of a commissioned PLC site by itself.

## Signed container release and admission

The signed release workflow runs only when trusted `main` receives a change under `edge/ot-gateway/` (or the release workflow itself). It reruns the gateway syntax and fault suite, pushes an image tagged with the source commit SHA to `ghcr.io/rakibulhasanutsho07/factoryos/ot-edge-gateway`, publishes SLSA build provenance for the pushed OCI digest, keylessly signs that exact digest through GitHub OIDC/Sigstore, verifies the certificate identity/issuer, and uploads a release receipt containing the immutable `image@sha256:digest`. Do not deploy the mutable/default tag or guess a digest: use the image reference from that successful release receipt.

### Admission enforcement

`deploy/verify-image-signature.policy.yaml` is a Kyverno `ImageValidatingPolicy`. It denies matching pods unless both the Cosign signature and SLSA provenance verify, and it fails closed if the policy engine cannot complete verification. Its trust identity is deliberately restricted to `https://github.com/RakibulhasanUtsho07/factoryos/.github/workflows/ot-gateway-release.yml@refs/heads/main` with issuer `https://token.actions.githubusercontent.com`; it does not trust a signature from an arbitrary branch or workflow.

The policy must be installed first by a cluster administrator on a Kyverno version which supports `ImageValidatingPolicy`; then apply `kubectl apply -f edge/ot-gateway/deploy/verify-image-signature.policy.yaml`. Create the namespace's `factoryos-ghcr-pull` image-pull secret through the approved secret manager with read-only access to the GHCR package; no registry credential belongs in this repository. Render `deploy/deployment.yaml` with the exact `image@sha256:digest` recorded by the successful release job before applying it. If admission policy/CRDs or registry credentials are absent, production deployment is not accepted.

This is an image supply-chain gate for the OT gateway binary and a deployment prerequisite aligned with staged release control (SRS FR-SAAS2-05). It does not by itself close AI model/tool-specific FR-MSO-03/FR-MSO-05, establish that every application resolves effective releases, or prove a rollout actually happened in a customer cluster. The existing physical SaaS provisioner owns runtime deploy/health-check/HALT-or-ROLLBACK receipts. Actual cluster enforcement and hardware-in-the-loop (HIL) commissioning remain environment/site acceptance gates; this repository does not claim those external gates have passed.

## Secure deployment sequence

1. Provision a dedicated OT subnet/VLAN and firewall rules first. Permit only the reviewed broker, OPC UA server, Modbus meter, DNS and FactoryOS API target. Keep all PLC write-capable ports outside this gateway's contract.
2. Create least-privilege MQTT broker credentials/ACLs bound to the configured client ID and exact topic list. Reject wildcard subscriptions and limit publish/subscribe rights at the broker.
3. Issue and install the gateway server certificate, MQTT client identity and OPC UA client identity through the site-approved PKI. Confirm certificate fingerprints and trust roots with the OT operator before rollout.
4. Apply the ConfigMap and Secret names/paths referenced by deploy/deployment.yaml; replace the sample CIDRs in deploy/network-policy.yaml with the exact approved address/port set. Never widen the policy to 0.0.0.0/0.
5. Start in simulator/staging mode, disconnect each upstream path, confirm the spool grows, restart the container, reconnect, and reconcile source IDs and sequence statuses against the API ledger.
6. Perform operator-approved HIL commissioning using deploy/commissioning-evidence.template.md. Record the real hardware/site/build/certificate fingerprints, fault result, restoration evidence and operator sign-off. Only then approve a production staged rollout.

## Explicit acceptance boundary

No live PLC, production broker, customer key store or site hardware was available during repository implementation. This repository therefore does not claim completed HIL commissioning evidence. The simulator tests are automated; the commissioned site test record must be completed and signed by the authorized OT operator after using the actual site hardware.

## Machine-checkable commissioning evidence

Copy `deploy/commissioning-evidence.template.json` to a separate, access-controlled evidence location and fill it with the actual deployment identity, test artifacts, event reconciliation values and authorized sign-offs. Keep the blank template unchanged in source control; never put secrets or private key material in the record.

Run the release-acceptance gate from `edge/ot-gateway`:

```sh
npm run commissioning:validate -- /path/to/commissioning-evidence.json
```

The default command exits non-zero unless the decision is `PASS` and the record includes all required simulator and hardware-in-the-loop cases, immutable image/config/API identity, approved preconditions, artifact references, reconciled event counts, zero unresolved sequence gaps/backlog/alarms, and three matching sign-off records. A draft can be structurally reviewed with `npm run commissioning:validate -- --allow-incomplete /path/to/record.json`; draft validation explicitly does **not** mean release acceptance.

The validator checks record structure and evidence completeness only. It does not cryptographically authenticate artifact references or signatures and cannot prove that a physical PLC, broker, network or operator test actually occurred. Those references and the site commissioning outcome still require independent review by the authorized OT, release and security owners.
