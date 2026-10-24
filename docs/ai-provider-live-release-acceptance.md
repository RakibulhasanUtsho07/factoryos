# AI Model Provider Live Release Acceptance

Status: **RUNBOOK / NOT EXECUTED**. This document defines the release gate for SRS FR-MSO-03 and FR-MSO-05. It does not itself prove deployment, external-provider approval, or acceptance. Keep both requirements OPEN / NOT_ACCEPTED until the required evidence is captured and independently reviewed.

## Scope and implementation boundary

The authenticated prompt-only route is POST /api/v2/ai/inference/chat-completions. It is routed through the model-provider admission gateway and checks the signed route-manifest digest before outbound inference. It does not retrieve tenant records, execute tools, or authorize business-system writes.

The route-manifest digest binds the adapter identity, endpoint URL, pinned provider model ID, route artifact version, and built-in system-prompt hash. It is **not** a measurement of the provider's private model weights. Provider-side immutable deployment identity, region/data residency, contract approval, and the actual deployed endpoint must be verified separately.

## Release preconditions

Do not send a request to an external provider until all of the following are true:

- The environment is explicitly approved for provider traffic. Provider contract/subprocessor terms, data residency, retention, and outbound-network review have named approvers and a review/change ticket.
- Test data is synthetic and approved for the provider. Do not use real tenant, employee, customer, credential, production order, or other confidential data during acceptance.
- The exact candidate commit SHA, built artifact/deployment image digest, environment name, and database migration head are recorded. Verify migration 195 is present and applied in the target database.
- Deployment configuration is provided through the approved secret/configuration manager: AI_MODEL_PROVIDER_CHAT_COMPLETIONS_URL, AI_MODEL_PROVIDER_API_KEY, AI_MODEL_PROVIDER_MODEL_ID, AI_MODEL_PROVIDER_ARTIFACT_VERSION, and AI_MODEL_PROVIDER_EGRESS_APPROVED=true. Outside explicit development/test modes, the endpoint must be HTTPS and the egress approval must be present.
- The model ID and route artifact version are immutable/pinned for this release. Compute the expected digest using the repository's canonicalizeAiModelProviderRouteManifest implementation and register/sign that exact digest through the approved artifact workflow. The signing private key remains in the trusted signing system and must never be copied to the API deployment.
- A different authorized reviewer approves the pending artifact source; the source and artifact are active, unexpired, and scoped to the tenant/factory that will run the test. Record the source ID, artifact ID/version, public-key fingerprint, manifest digest, and expiry.
- The service account used for the probe is factory-scoped and has ai.decisions.write. Its credentials come from the approved secret store; do not paste a bearer token into tickets, logs, CI output, or this evidence record.

If any precondition is missing, stop. Do not bypass admission or set a requirement to PASS to make the deployment proceed.

## Positive end-to-end probe

Run this only against the approved staging/acceptance environment, after the preconditions above are complete. The script emits a small sanitized result containing the request reference and pinned model/version only. It intentionally does not print the token or provider response beyond checking the synthetic marker.

    $uri = ($env:FACTORYOS_STAGING_BASE_URL).TrimEnd('/') + '/api/v2/ai/inference/chat-completions'
    $headers = @{ Authorization = "Bearer $env:FACTORYOS_STAGING_JWT" }
    $body = @{
      prompt = 'Return exactly FACTORYOS_PROVIDER_ACCEPTANCE_OK'
      temperature = 0
      max_tokens = 32
    } | ConvertTo-Json -Compress

    try {
      $result = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 20
      if ($result.content -ne 'FACTORYOS_PROVIDER_ACCEPTANCE_OK') { throw 'unexpected completion content' }
      if ($result.model -ne $env:AI_MODEL_PROVIDER_MODEL_ID) { throw 'provider model mismatch' }
      if ($result.artifactVersion -ne $env:AI_MODEL_PROVIDER_ARTIFACT_VERSION) { throw 'artifact version mismatch' }
      if ([string]::IsNullOrWhiteSpace($result.requestId)) { throw 'request reference missing' }
      [pscustomobject]@{
        outcome = 'PASS'
        model = $result.model
        artifactVersion = $result.artifactVersion
        requestId = $result.requestId
      } | ConvertTo-Json -Compress
    } catch {
      Write-Error 'Provider acceptance probe failed; record only a sanitized error classification.'
      exit 1
    }

A successful HTTP response is not enough by itself. Correlate the returned requestId to the persisted allow/admission receipt for the same tenant and factory, confirm that the AI call meter was written before provider I/O, and confirm provider-reported token meters when valid token usage was returned. Use an approved read-only audit/reporting path; do not bypass row-level security or expose raw prompts/responses in evidence. Record the sanitized identifiers and outcome, not the content.

## Required negative and recovery checks

The table distinguishes CI/stub checks from tests that must be exercised in the approved target environment. Do not attempt to make a real provider return a deliberately oversized body; exercise oversized and malformed-body cases with the repository test double/stub.

| Case | Expected result | Evidence required |
|---|---|---|
| Correct active signed artifact, approved egress, pinned endpoint/model/version | Request reaches provider only after admission; response model/version match; request and meter references correlate | Sanitized probe result, admission receipt reference, usage-event references, deployment SHA |
| Egress approval absent/false in a production-like environment | Fail closed before external network I/O | Deployment configuration review and a no-egress test result |
| Missing, mismatched, expired, revoked, or invalidly signed model artifact | Denied before usage metering and outbound provider call; denial receipt where admission was reached | Negative-test result and denial receipt reference |
| Artifact manifest changes because endpoint/model/version/system prompt changes | Previous signature/digest is no longer admissible; a newly approved immutable version is required | Before/after digest and registry references; no secret values |
| Provider timeout, transport failure, or non-2xx response | Bounded generic error; upstream diagnostics/body are not returned to caller | Sanitized error classification and correlation/request reference |
| Provider reports a model ID different from the admitted ID | Reject response; do not return its content as an accepted completion | Negative-test result and provider model identity metadata |
| Oversized stream or invalid response body | Stop reading/cancel oversized body; reject safely | CI/stub test run URL and case result |
| Pre-call usage-ledger write fails | Do not make provider network request | CI/stub test run URL and assertion result |
| Revoke the source/artifact or remove the egress approval after acceptance | Subsequent calls are denied; rollback/disablement is auditable | Change record, revocation/disablement evidence, repeat negative probe |

The latest provider response-hardening change has pre-merge API CI and PostgreSQL CI links in the associated promotion PR. For each release, capture fresh CI URLs for the exact candidate/deployment SHA; do not copy an older release's evidence. A green CI run is necessary but does not replace the live positive probe, negative controls, or owner/reviewer decision.

## Evidence record template

Create one immutable evidence record per environment and candidate. Replace placeholders only with verified values. Keep secrets and raw request/response content out of this file and store larger approved logs in the organization's protected evidence store, referenced by immutable IDs/URLs.

    {
      "requirementIds": ["FR-MSO-03", "FR-MSO-05"],
      "candidateSha": "",
      "deploymentImageDigest": "",
      "environment": "",
      "testedAtUtc": "",
      "providerName": "",
      "providerEndpointOrigin": "",
      "providerRegionAndResidency": "",
      "providerApprovalTicket": "",
      "egressChangeTicket": "",
      "tenantId": "",
      "factoryId": "",
      "modelId": "",
      "routeArtifactVersion": "",
      "routeManifestSha256": "",
      "artifactRegistryId": "",
      "artifactSourceId": "",
      "signerPublicKeyFingerprintSha256": "",
      "artifactExpiresAtUtc": "",
      "migrationHead": "",
      "apiCiRunUrl": "",
      "postgresCiRunUrl": "",
      "traceOrRequestRef": "",
      "admissionReceiptRef": "",
      "usageEventRefs": [],
      "positiveProbeResult": "NOT_RUN",
      "negativeCaseResults": [],
      "rollbackVerified": false,
      "evidenceStoreRefs": [],
      "requirementOwner": "",
      "independentReviewer": "",
      "releaseDecision": "OPEN"
    }

The evidence store must enforce access control and retention. Do not include API keys, JWTs, private signing keys, passwords, raw prompts, raw model responses, full headers, or unredacted provider diagnostics. Redact tenant identifiers in artifacts shared outside the authorized review group.

## Release review and rollback

The release reviewer must verify: (1) the run's candidate SHA equals the deployed candidate; (2) API and PostgreSQL CI evidence relates to that candidate; (3) the signed route manifest and registered artifact match the deployed endpoint/model/version/prompt; (4) provider/legal/security review approves the egress and data location; (5) the positive probe and all required negative controls pass; (6) admission and usage evidence correlate; and (7) the owner and an independent reviewer approve the evidence record.

Rollback immediately if the provider identity/region changes unexpectedly, the route digest does not match, any unapproved egress occurs, an admission-denied request reaches the provider, secrets appear in logs/responses, or usage/admission evidence cannot be reconciled. Disable provider egress through the deployment control, revoke the affected artifact/source when appropriate, verify that subsequent calls fail closed, and record the change/audit references. Do not treat an emergency rollback as requirement acceptance.

**Current evidence limitation:** this runbook was added as preparation for the live acceptance step; no approved provider environment, provider credentials, deployment identity, positive live probe, or release-review sign-off was available to this repository task. FR-MSO-03 and FR-MSO-05 therefore remain OPEN / NOT_ACCEPTED until the template is populated with independently reviewed operational evidence.
