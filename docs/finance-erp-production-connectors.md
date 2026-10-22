# Finance ERP production connectors and acceptance evidence

**Status (2026-10-22):** named Business Central REST adapter + Vault KV-v2 secret resolution and OpenSSH SFTP transport + pinned host-key checks are registered in FinanceModule; provider, Vault and SFTP contract tests are present. **Staging acceptance remains OPEN.** No production/staging provider credentials, allowlist values, or approved staging execution evidence were available for this change.

**Traceability:** docs/finance-integration-contract.md; FR-FIN-03/04/08/09; FR-PROD-12/13/15/27; HLD/Blueprint WP03 and WP12.

## 1. Supported provider profile

This implementation supports **Microsoft Dynamics 365 Business Central through a reviewed FactoryOS Finance Exchange v1 AL extension**. It is not a claim that the standard Business Central API exposes these custom exchange endpoints out of the box. The BC administrator must install/review the extension and expose only the three scoped finance-exchange resources below. The adapter cannot post journals, create payments, change bank transactions, submit tax returns, or mutate the provider's underlying accounting records.

Connector configuration must contain:

    {
      "provider": "MICROSOFT_DYNAMICS_365_BUSINESS_CENTRAL_FINANCE_EXCHANGE_V1",
      "company_id": "11111111-2222-4333-8444-555555555555"
    }

company_id is the GUID of the intended Business Central company. The connector's approved endpoint_url is the HTTPS origin/base path for the approved tenant/environment. Do not include credentials, bearer tokens, query strings, or fragments. Host and resolved IP permissions come from deployment configuration, not tenant-controlled connector JSON.

## 2. Provider exchange API contract

The AL extension must scope every operation to the configured BC company, authorize the application for read/exchange access only, enforce per-record access, and make the acknowledgement and upload operations idempotent.

### Import

GET /api/factoryos/finance/v1.0/companies({company_id})/financeBatches/next

Return JSON with zero or one ready batch:

    {
      "value": [
        {
          "id": "bc-batch-record-123",
          "externalBatchRef": "finance-batch-20261022-001",
          "fileName": "ap-20261022.csv",
          "format": "CSV",
          "contentBase64": "ZXh0ZXJuYWxfZmFjdF9pZCxhbW91bnQK...",
          "sourceOccurredAt": "2026-10-22T12:00:00Z"
        }
      ]
    }

An empty value means NO_BATCH. More than one row, missing opaque IDs, non-canonical base64, malformed file contents, invalid dates, path-like names, unsupported formats, or payloads above 2 MiB are rejected. The adapter ignores provider-supplied tenant/factory identifiers; FactoryOS uses the authenticated connector scope.

### Durable external acknowledgement

POST /api/factoryos/finance/v1.0/companies({company_id})/financeBatches({provider_batch_id})/acknowledge

The request body includes externalBatchRef, payloadSha256, disposition (PROCESSED or QUARANTINED) and a deterministic idempotencyKey. The same key with the same canonical request must return the same successful acknowledgement; a key collision with different contents must return a conflict. A successful response must be JSON (for example {"accepted":true}) and 2xx. Redirects and non-JSON responses are rejected.

The adapter issues this acknowledgement only after FactoryOS's file-import pipeline reports a durable receipt, or after it creates an explicit invalid-batch/quarantine validation report. If acknowledgement fails after import, the API returns ACKNOWLEDGEMENT_PENDING; replay reuses the prior receipt and retries acknowledgement without re-applying the financial facts.

### Export

POST /api/factoryos/finance/v1.0/companies({company_id})/financeExports

The request contains fileName, format, payloadSha256, bytesWritten, contentBase64 and the deterministic idempotencyKey. The extension must atomically insert-or-return by idempotency key, verify an existing record's payload digest and length before replay, and refuse a conflicting payload. Successful JSON must echo the opaque provider id, payloadSha256 and bytesWritten. FactoryOS writes its immutable export receipt only when the echo matches the bytes sent.

This exchange endpoint stages an artifact/receipt; it is not a journal post or an instruction to change accounting records.

## 3. Secret-manager and egress controls

### Vault KV v2

The Finance module wires VaultFinanceSecretManager. Connector references use the vault:// scheme and must be below a deployment-controlled FINANCE_VAULT_ALLOWED_SECRET_PREFIXES path. The adapter resolves only the access_token field from the KV-v2 secret document.

The Vault API token is read from a mounted, short-lived Vault Agent token file populated by deployment workload identity. Do not set a static Vault token in .env, connector configuration or source control. Vault and the ERP have **separate** allowlists. To use another cloud secret manager, replace the FINANCE_SECRET_MANAGER provider with an approved implementation of the same port; do not persist credentials in finance_connectors.

Required production configuration:

- FINANCE_VAULT_ADDR — HTTPS Vault origin.
- FINANCE_VAULT_TOKEN_FILE — absolute read-only mounted Vault Agent token file.
- FINANCE_VAULT_KV_MOUNT — KV-v2 mount, default secret.
- FINANCE_VAULT_ALLOWED_SECRET_PREFIXES — approved path prefixes only.
- FINANCE_VAULT_ALLOWED_HOSTS and FINANCE_VAULT_ALLOWED_IPS — exact Vault DNS names and every expected public resolved IP.
- FINANCE_ERP_ALLOWED_HOSTS and FINANCE_ERP_ALLOWED_IPS — exact Business Central DNS names and every expected public resolved IP.

The outbound client rejects absent allowlists, non-HTTPS URLs, embedded credentials, DNS answers containing private/link-local/metadata/reserved IPs, any answer outside the IP allowlist, and redirects. It resolves the host once per request and pins the selected address through the TLS request while retaining normal certificate/hostname verification. Every current DNS answer must be both public and explicitly allowlisted; update the lists through an approved configuration change when the provider's network changes. No wildcards or suffix matching are accepted.

## 4. Finance data ownership and mapping

The provider extension exports only records that the Business Central owner has approved for this exchange; the shared FactoryOS CSV/JSON parser then validates each row and binds it to immutable finance facts. The existing Finance Integration Contract remains authoritative for allowed domain-to-fact mappings:

| Connector domain | Allowed FactoryOS finance facts |
|---|---|
| GL | GL balances, inventory value, actual/forecast cost and contribution-cost inputs |
| AP | Open payables, open purchase commitments, letter-of-credit exposure |
| AR | Open receivables, shipment milestones, actual/forecast revenue |
| Bank reconciliation | Bank balance positions |
| Tax / e-invoice | Tax liabilities |
| Custom | Enrichment only; not a reporting authority |

The API and database enforce domain/source-of-record rules. The external ERP remains authoritative for its ledger/AP/AR/bank/tax records; FactoryOS keeps attributed immutable snapshots for reporting and reconciliation only. Monetary amounts remain decimal strings and PostgreSQL numeric; currency totals are not implicitly combined. Quantity/rate/UOM evidence must reconcile against an approved operational source before the affected reporting result is considered ready. A mismatch is visible and can only be resolved/waived by an authorized reviewer distinct from the ingester. There is no silent correction of source facts.

## 5. Durable receipts, retries, and reconciliation

- Import validation and commit are bound to connector scope, batch reference, file name, format, payload SHA-256, and idempotency key. Successful import receipts share a transaction with inserted facts, reconciliation evidence, audit, and outbox events.
- Repeated batch content returns its durable receipt. Provider acknowledgement is retried after receipt existence; duplicate business facts are not re-inserted.
- Invalid file/batch content is recorded as a validation report and can be acknowledged as quarantined only after the report exists.
- Export filenames derive from the payload hash; the provider idempotency key is tied to tenant/factory/connector, file, format and hash. Receipt hashes and provider echo must agree.
- The existing API exposes import/export receipt queries and reconciliation review routes. Every deployment should alert on ACKNOWLEDGEMENT_PENDING, repeated provider 4xx/5xx failures, validation rejection spikes, stale connector freshness, and open finance mismatches.

## 6. SFTP status

The repository registers OpenSshFinanceSftpTransport as FINANCE_SFTP_TRANSPORT. It uses the OpenSSH client tools (ssh-keyscan and sftp), requires FINANCE_SFTP_ALLOWED_HOSTS plus FINANCE_SFTP_ALLOWED_IPS, resolves the connector host against the exact allowlists and pins a vetted address for the transfer. It compares the observed SSH public-key fingerprint to the connector’s canonical SHA256 pin before opening an SFTP session, then uses StrictHostKeyChecking=yes, a temporary known_hosts file containing only the pinned key, public-key authentication, and a Vault-resolved sftp_private_key_pem. Temporary key material is written under a mode-0700 temporary directory with a mode-0600 key file and removed after the operation. Export uses a content-derived temporary remote file, rename, and read-back digest verification; replay of an existing final file is accepted only if its exact digest matches. Import archives to configured-root child folders named processed or quarantine and binds archive replay to the source payload SHA-256; provision these folders before enabling polling. Install openssh-client in the API runtime image. Automated tests mock the process runner and prove adapter contract behavior, but they do not verify a real SSH handshake or remote server. A staging host, actual public-key fingerprint, secret-manager key reference, egress rules and provider permissions still require deployment approval and staged fault-injection evidence.

## 7. Automated evidence and staging release gate

New automated tests live in:

- services/api/src/finance/finance-business-central.adapter.spec.ts — provider mapping, malformed payload/ID rejection, deterministic acknowledgement replay, export receipt echo and public-IP/allowlist guard.
- services/api/src/finance/finance-vault-secret-manager.spec.ts — KV path scope, mounted workload token, and missing-token fail-closed paths.
- services/api/src/finance/finance-file-transfer.adapters.spec.ts — SFTP path/pattern checks.
- services/api/src/finance/finance-contract.spec.ts — finance domain, TLS endpoint, secret-reference and exact-decimal rules.

These tests prove the repository contract and unit-level security rules, not a real Business Central tenant connection. Attach the following before setting the staging gate to PASS:

1. Approved BC test tenant/company, extension version/hash, read/exchange-only permission set, OAuth app registration, Vault policy/Agent role, and non-production provider secret references (never secret values).
2. Exact SHA tested by API CI and PostgreSQL CI; adapter contract results; migration/receipt/replay evidence; sanitized provider operation IDs, response status codes and payload-hash equality.
3. A duplicate batch test, changed-payload/same-key rejection, lost-ack recovery test, provider outage/recovery test, malformed row quarantine, operational quantity/rate mismatch review, and export replay/remote hash verification on the real staging extension.
4. TLS/DNS/IP allowlist review, token expiry/rotation, redirect rejection, restricted egress verification, and alerts observed during a staged failure.
5. For SFTP deployments, a separate approved host fingerprint, key-auth/secret rotation, host-key mismatch negative test, safe archive/quarantine evidence, and atomic upload/replay evidence.
6. Named finance/security owners' sign-off that the connector is a read-side reporting input / artifact exchange and does not post accounting transactions.

**Release decision:** named provider adapter, Vault key/token resolution, SFTP transport implementation and automated contract testing are present; actual Business Central extension rollout, SFTP host-key confirmation, staging credentials/configuration, external outage/replay fault-injection and finance/security sign-off remain release gates.
