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


## Protected GitHub Actions run (configured storage + receiver smoke)

A manual runner is now defined at [WMS configured-provider certification smoke](../.github/workflows/wms-provider-live-smoke.yml). It is intentionally **manual-only** and is not a real-carrier certification job. It runs the existing deployed-API storage PUT/read-back digest and FactoryOS webhook receiver checks, evaluates a supplied storage identity-policy document for strict shape, checks the evidence artifacts for credential leakage, and uploads only the redacted JSON reports after all checks succeed.

Before running it, create the GitHub environment named `wms-provider-certification`. Require an authorized reviewer/approver for this environment and scope every value below to a disposable staging/sandbox deployment. Environment protection is a repository setting and must be reviewed by an administrator.

**Environment variables** (non-secret test configuration):

- `FACTORYOS_CERT_API_ORIGIN`: credential-free HTTPS origin of the staging/sandbox API.
- `FACTORYOS_CERT_CONNECTOR_ID`, `FACTORYOS_CERT_SHIPMENT_UNIT_ID`, `FACTORYOS_CERT_SCHEMA_VERSION`: the active connector and dedicated dispatched test shipment.
- `FACTORYOS_CERT_STORAGE_PROVIDER`, `FACTORYOS_CERT_CARRIER_PROVIDER`, `FACTORYOS_CERT_CARRIER_NAME`, `FACTORYOS_CERT_TRACKING_REFERENCE`: selected provider/account labels and exact fixture binding.
- `WMS_POD_STORAGE_BUCKET`, `WMS_POD_STORAGE_PREFIX`: policy target (prefix must end in `/`, normally `pod/`).

**Environment secrets** (short-lived / restricted credentials only):

- `FACTORYOS_CERT_WEBHOOK_SECRET`: the configured FactoryOS connector secret used by its current webhook contract.
- `FACTORYOS_CERT_BEARER_TOKEN`: short-lived factory-scoped upload token.
- `FACTORYOS_CERT_READONLY_BEARER_TOKEN`: token that can read the connector but cannot upload.
- `WMS_POD_STORAGE_POLICY_JSON`: reviewed identity policy JSON for the deployed POD runtime principal; it is written to a temporary file with owner-only permissions, checked, and deleted. The policy itself is not uploaded.

From Actions, dispatch the workflow with target `staging` or `sandbox`, enter a non-sensitive site/ticket value and operator/ticket identifier, and explicitly select `YES` only after confirming the shipment is a disposable test fixture. The script refuses production targets. Do not dispatch against a production API or a production shipment. The smoke performs real side effects: POD upload, delivery event insertion and a conflicting-replay reconciliation record.

The policy-shape checker accepts only explicit `s3:GetObject` and `s3:PutObject` allow actions on the requested bucket/object prefix and rejects wildcard/bucket-wide/sibling-prefix grants plus list/delete actions. It prints a SHA-256 fingerprint and non-secret summary rather than the policy body. This is **shape-only**: it does not prove the exported policy is attached to the running identity, resolve bucket/session/organization/KMS policy interactions, or certify credential rotation/revocation.

**Provider-format limitation:** the current checker expects an AWS-IAM-style identity policy document with S3 ARN resources. If the selected S3-compatible vendor uses a different native authorization format, do not convert it into AWS-shaped JSON and treat that conversion as certification. Attach the vendor-native policy export, add/run a provider-specific checker, and have the storage owner verify effective permissions against the deployed identity.

The evidence safety guard fails if configured connector tokens/secrets appear in either artifact, if the policy shape does not pass, or if the smoke tries to upgrade the result to real-carrier certification. A successful workflow artifact therefore still explicitly records `carrier_sandbox_origin=NOT_PROVEN` and `storage_iam_least_privilege_review=NOT_VERIFIED_BY_SCRIPT`.

## Live carrier acceptance still needs provider-owned evidence

This repository does not include a selected carrier-specific API/SDK, carrier sandbox credentials, or a vendor-native signature adapter. The current webhook endpoint verifies the **FactoryOS** timestamp/event-ID/raw-body HMAC contract; the synthetic harness signs with that FactoryOS secret. Do not treat that as validation of DHL/FedEx/UPS/another carrier's native signature, nor as proof of provider retry delivery.

To close the carrier gate, the carrier integration owner must select the provider and implement or verify its native adapter, configure the provider sandbox callback to the approved staging endpoint, and attach the provider's own callback-delivery/request ID, signature-verification result, raw-payload digest, and observed retry/replay records. A same-event/same-payload replay must not create a second delivery receipt; same-event/different-payload replay must fail/reconcile. Storage/security must separately review the identity actually attached to the deployed runtime, permission scope, expiry, rotation and revocation evidence.

**Certification disposition remains OPEN** until a genuine provider-originated sandbox callback/retry, independent storage read-back, effective-credential/IAM review, and authorized carrier/WMS/storage sign-offs are tied to the exact release SHA. The manual smoke workflow is a repeatable precondition/evidence tool, not a substitute for that acceptance.
