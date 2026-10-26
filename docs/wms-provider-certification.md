# WMS live storage and carrier certification

**SRS scope:** FR-WMS-06/07/08 — shipment POD integrity, signed carrier delivery events, retry/replay and operational connector controls.  
**Runnable harness:** \`scripts/integrations/wms-provider-certification.mjs\`  
**Status:** automated live-configuration smoke is implemented; external carrier sandbox certification remains **OPEN** until provider-originated callback evidence and the provider's actual credential/policy evidence are attached.

## What the automated harness proves

Run the harness against a dedicated **staging/sandbox** FactoryOS deployment, a dedicated already-\`DISPATCHED\` test shipment and an \`ACTIVE\` \`WMS_CARRIER\` connector. It makes real HTTPS requests to that deployment; it is not a mocked unit test.

1. Reads the connector configuration using a valid read-only token and confirms \`source_system=WMS_CARRIER\`, \`status=ACTIVE\`, matching display name/schema version and an allowed \`WMS.SHIPMENT_DELIVERY\` event.
2. Confirms an anonymous POD upload is rejected and a connector-read-capable token without \`inventory.write\` is denied.
3. Uploads a tiny PNG fixture through the authenticated POD endpoint. The API uses its deployed S3-compatible credentials to sign a real PUT, fetches the object separately, computes SHA-256 over the returned bytes and only returns \`verified=true\` if the stored bytes match.
4. Sends a deliberately invalid-signature callback and confirms rejection.
5. Sends a synthetic, correctly FactoryOS-HMAC-signed \`DELIVERED\` callback with the actual uploaded object's key and digest. Then it retries the exact event ID/payload and requires the original receipt/event ID, followed by a changed-payload reuse of that event ID which must return HTTP 409.
6. Writes a JSON evidence artifact with provider names supplied by the operator, HTTP results, object key/digest/byte count and replay outcomes. The artifact never records the bearer tokens or signing secret.

**Important:** the \`DELIVERED\` callback in this harness is synthetic and signed by the harness using the configured FactoryOS connector secret. Its success proves the configured storage path and FactoryOS receiver contract; it does **not** prove that a real carrier sandbox called the endpoint. It creates a test POD object, a delivery timeline event and a conflicting-replay reconciliation record. Do not run against production or a production shipment.

## Configuration

Set these variables in a protected shell/environment or short-lived secret-manager injection. Do not commit them into a \`.env\`, issue, PR, log or evidence artifact.

| Variable | Meaning |
| --- | --- |
| \`FACTORYOS_CERT_ENVIRONMENT\` | Must be exactly \`staging\` or \`sandbox\`; production is blocked. |
| \`FACTORYOS_CERT_ALLOW_SIDE_EFFECTS\` | Must be \`YES\` to acknowledge the test shipment will receive a POD and delivery event. |
| \`FACTORYOS_CERT_API_ORIGIN\` | Credential-free HTTPS origin only, for example \`https://factoryos-staging.example.com\`; no path/query. |
| \`FACTORYOS_CERT_CONNECTOR_ID\` | UUID of the active FactoryOS carrier connector. |
| \`FACTORYOS_CERT_SHIPMENT_UNIT_ID\` | UUID of a dedicated, dispatched sandbox shipment already bound to the carrier/tracking reference below. |
| \`FACTORYOS_CERT_SCHEMA_VERSION\` | Registered connector schema version; defaults to \`1\`. |
| \`FACTORYOS_CERT_WEBHOOK_SECRET\` | At least 32 bytes; must equal the value configured in FactoryOS under the connector's \`env://WEBHOOK_SECRET_...\` secret reference. |
| \`FACTORYOS_CERT_BEARER_TOKEN\` | Valid staging user/session token with factory-scoped \`inventory.write\`. |
| \`FACTORYOS_CERT_READONLY_BEARER_TOKEN\` | Valid token with \`integrations.connectors.read\` but without \`inventory.write\`; proves access denial on upload. |
| \`FACTORYOS_CERT_STORAGE_PROVIDER\` | Operator-declared name of the configured storage provider/account. This label is not independently discovered by the API. |
| \`FACTORYOS_CERT_CARRIER_PROVIDER\` | Operator-declared carrier/provider sandbox name. |
| \`FACTORYOS_CERT_CARRIER_NAME\` | Must match the connector display name and the carrier bound to the selected shipment. |
| \`FACTORYOS_CERT_TRACKING_REFERENCE\` | Exact carrier tracking reference already bound to the selected shipment. |
| \`FACTORYOS_CERT_SITE\`, \`FACTORYOS_CERT_OPERATOR\` | Site and operator metadata for the evidence record. |
| \`FACTORYOS_CERT_EVIDENCE_PATH\` | Optional output path; defaults to a unique \`artifacts/wms-provider-certification-*.json\` file. |

The runtime storage principal must already be provisioned by the deployment/security owner. For the POD prefix it needs the required \`PutObject\` and \`GetObject\` operations and must not receive broad bucket or account access. This harness proves the positive upload/read-back path through the deployed API. It does **not** probe bucket listing/deletion permissions or inspect provider IAM policy; attach the reviewed policy/export separately and confirm that access is prefix-scoped and unnecessary actions (such as \`ListBucket\`, \`DeleteObject\`, wildcard resources and unrelated buckets) are absent.

## Run from PowerShell

Use a secret-manager-backed session or environment injection. These are variable names only; do not paste production values into the repository.

\`\`\`powershell
$env:FACTORYOS_CERT_ENVIRONMENT = "staging"
$env:FACTORYOS_CERT_ALLOW_SIDE_EFFECTS = "YES"
$env:FACTORYOS_CERT_API_ORIGIN = "https://factoryos-staging.example.com"
$env:FACTORYOS_CERT_CONNECTOR_ID = "<active WMS_CARRIER connector UUID>"
$env:FACTORYOS_CERT_SHIPMENT_UNIT_ID = "<dedicated DISPATCHED test shipment UUID>"
$env:FACTORYOS_CERT_SCHEMA_VERSION = "1"
$env:FACTORYOS_CERT_STORAGE_PROVIDER = "<selected S3-compatible provider/account label>"
$env:FACTORYOS_CERT_CARRIER_PROVIDER = "<selected carrier sandbox name>"
$env:FACTORYOS_CERT_CARRIER_NAME = "<exact connector display name>"
$env:FACTORYOS_CERT_TRACKING_REFERENCE = "<existing test shipment tracking reference>"
$env:FACTORYOS_CERT_SITE = "<test site code>"
$env:FACTORYOS_CERT_OPERATOR = "<operator or ticket identifier>"
$env:FACTORYOS_CERT_BEARER_TOKEN = "<short-lived inventory.write token>"
$env:FACTORYOS_CERT_READONLY_BEARER_TOKEN = "<short-lived connectors.read token without inventory.write>"
$env:FACTORYOS_CERT_WEBHOOK_SECRET = "<same configured connector HMAC secret, injected securely>"
node scripts/integrations/wms-provider-certification.mjs
\`\`\`

The successful output path is printed only after the artifact has been written. Review the output JSON and retain it with the storage account/policy version, carrier sandbox transaction ID, provider callback delivery log, test-shipment identity, and review/approval record. Delete the test object only through an approved storage-cleanup workflow; the harness deliberately does not require or request delete permission.

## Actual carrier sandbox exit criteria (manual/provider-owned evidence)

The repository does not yet contain a selected vendor-specific carrier API/SDK or credentials, so there is no generic API call that can safely create a real sandbox shipment for every carrier. Use the selected carrier's documented sandbox to create/advance the dedicated test tracking reference and configure its callback target to the publicly reachable FactoryOS connector webhook path. The provider must send a genuine provider-originated event compatible with the registered connector envelope/signature contract, or an approved provider-specific adapter must normalize and authenticate the provider's own signature before forwarding it.

Capture all of the following as separate provider/site evidence; do not infer these results from the synthetic harness callback:

| Acceptance | Required evidence |
| --- | --- |
| Real sandbox origin | Carrier sandbox account/tenant, provider transaction/request ID, shipment/tracking ID and provider-console/API request/response evidence with secrets redacted. |
| Callback authentication | Raw callback bytes/headers (signature redacted or protected), timestamp, external event ID, provider's signature-verification result, and mapping from the provider's native schema to \`WMS.SHIPMENT_DELIVERY\`. |
| Delivered POD | Exact object key and SHA-256; FactoryOS storage read-back receipt; delivery event/receipt identifiers and the persisted shipment lifecycle result. |
| Provider retry | Provider configuration or delivery log proving the same event ID/payload was retried after an induced timeout/5xx; show the original receipt was returned and no duplicate WMS delivery event was inserted. |
| Provider replay/mismatch | A controlled repeat with the same event ID and different payload must be rejected/reconciled without a second delivery event. Do not forge provider signatures to claim the provider performed this test. |
| Credentials and permissions | Secret-manager reference/rotation owner, credential expiry/rotation policy, storage IAM policy scoped to the approved POD bucket/prefix, carrier sandbox credential scope and revocation owner. Do not attach raw secrets. |
| Independent sign-off | Storage/security owner, carrier integration owner and WMS process owner sign the evidence pack; record unresolved provider limitations explicitly. |

If the chosen carrier signs webhooks in a provider-specific format rather than the FactoryOS timestamp/event-ID/raw-body HMAC contract, do not disable signature checks or reuse a secret across trust domains. Implement and test a dedicated verified adapter first. Carrier certification stays **OPEN** until the real provider-originated callback and retry evidence, storage/IAM review and named approvals are present.


## Protected GitHub Actions staging/sandbox run

The repository also has a manual workflow at `.github/workflows/wms-provider-live-smoke.yml`. It is intentionally named a *smoke* workflow: it executes the same configured storage PUT/independent GET digest checks, authorization denials, invalid-signature rejection, synthetic FactoryOS-HMAC callback, idempotent replay and conflicting replay tests. It does **not** turn a synthetic callback into carrier-origin certification.

Before dispatching it, a repository administrator must:

1. Promote this workflow to the repository's default branch so GitHub exposes `workflow_dispatch`; then select the `rakibul-hasan` ref when launching it.
2. Create the GitHub Environment named `wms-certification`, require approval from the storage/security or release owner, and restrict deployments to the intended protected branch. The workflow references the environment, but required reviewers and branch restrictions are repository settings and must be configured by an administrator.
3. Set the environment variable `FACTORYOS_CERT_API_ORIGIN` to the approved non-production API origin. Its hostname must visibly contain a `staging` or `sandbox` segment; ambiguous hostnames are rejected by the harness. Confirm independently that the hostname does not route to production.
4. Add only short-lived, least-privilege environment secrets: `FACTORYOS_CERT_WEBHOOK_SECRET`, `FACTORYOS_CERT_BEARER_TOKEN`, and `FACTORYOS_CERT_READONLY_BEARER_TOKEN`. The read-only token must be allowed to read connector configuration but not upload PODs; the writer token must be factory-scoped. Use a dedicated connector and a dedicated already-dispatched sandbox shipment.
5. Launch **Actions → WMS configured storage and webhook receiver smoke** with `target_environment` set to `staging` or `sandbox`, type `YES` in `confirm_side_effects`, and supply the connector/shipment IDs, exact carrier name/tracking reference, provider labels, site and operator/ticket ID. Do not use a customer shipment or production credential.

On successful completion, the workflow re-checks that the evidence JSON does not contain the configured secrets, verifies that the result retains the external-carrier limitation, and uploads only that JSON artifact for 30 days. The upload step is skipped if the smoke or redaction check fails. A failed attempt is not a certification result.

The workflow does not have access to carrier-native sandbox credentials, does not ask the carrier platform to emit a genuine callback, does not prove provider-side retry delivery, and cannot inspect or test storage IAM list/delete permissions or credential rotation. Complete the provider-owned evidence table above independently. **Do not close the external certification gate solely because this workflow passed.**
