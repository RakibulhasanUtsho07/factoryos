# Finance/ERP/SFTP connector acceptance evidence — 2026-10-22

**Current application code SHA:** `6d9dd0e40c3a9d1b38436692744a869ad25be0eb`  
**Branch:** `rakibul-hasan`  
**Automated API acceptance:** PASS  
**Automated PostgreSQL acceptance at exact SHA:** PASS  
**External staging acceptance:** OPEN

## 1. Implementation evidence

- Named vendor adapter: `services/api/src/finance/finance-business-central.adapter.ts` — Microsoft Dynamics 365 Business Central Finance Exchange v1 custom AL-extension contract.
- Secret manager: `services/api/src/finance/finance-vault-secret-manager.ts` — HashiCorp Vault KV-v2 with a short-lived Vault Agent token file and allowlisted secret paths. It returns provider tokens and SFTP private-key material only through separate adapter methods.
- SFTP transport: `services/api/src/finance/finance-openssh-sftp.transport.ts` — OpenSSH-based SFTP, exact host/IP allowlists, pinned DNS answer, observed SSH host-key SHA-256 check, strict host-key checking, bounded transfers, hash-guarded archive/quarantine replay, atomic temp-upload/rename and final digest verification.
- Wired through `services/api/src/finance/finance.module.ts`; ERP and SFTP work continue through the existing FinanceService validators, durable receipt tables and source-of-record/domain rules.
- Configuration example: `services/api/.env.example`, with ERP, Vault and SFTP allowlist variables. No credentials or private keys are committed.

## 2. Automated checks

### API CI — exact code SHA

Run: https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39799600599  
Result: **SUCCESS**, API job completed successfully for `6d9dd0e40c3a9d1b38436692744a869ad25be0eb`.  
Log summary: **130 test suites passed; 1,161 tests passed**. This includes the Business Central adapter contract tests, Vault secret-manager tests, SFTP transport contract tests, existing finance file import/export and reconciliation tests, and API lint/build steps.

### PostgreSQL CI — exact code SHA

Run: https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39799600720  
Result: **SUCCESS**, `api-postgres` job completed for `6d9dd0e40c3a9d1b38436692744a869ad25be0eb`.  
Log summary: **170 test suites passed; 1,344 tests passed**, including PostgreSQL migration/contract checks. The workflow wrapper still reports its overall run as finalizing, but its only `api-postgres` job has conclusion `success`.

### PostgreSQL CI — previous code-equivalent run

Run: https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39798886085  
Result: **SUCCESS** on `74884e6953c7b9fe34c8c8ff4e095d2f64c1e9f1`, before the final SFTP test-helper cleanup. Logs: **170 suites passed; 1,344 tests passed**. No finance schema migration was added in the final test-helper cleanup, but this older result does not substitute for the in-progress exact-SHA workflow.

### Traceability

Run: https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39799315604  
Result: **SUCCESS** on `b143093f7d11f75284e27ed64c61726c453e48e2`, validating the HLD/Blueprint evidence-matrix update. The subsequent code-SHA change includes the final SFTP test-helper cleanup; traceability documentation was not changed after that run.

## 3. Contract coverage

- Business Central: batch shape and opaque-reference validation, strict CSV/JSON/base64/filename/time validation, ignored provider tenant fields, deterministic acknowledgement idempotency key, duplicate-ack replay, export payload hash/size echo and mismatch rejection.
- Endpoint security: HTTPS-only endpoints, no embedded URL credentials or redirects, exact DNS hostname allowlist, explicit IP allowlist for every current DNS answer, rejection of private/reserved/link-local/metadata addresses, and pinned DNS through the HTTP request.
- Vault: allowed secret path prefixes, path traversal rejection, HTTPS Vault address, mounted short-lived Vault Agent token, invalid/missing token failure, provider access-token shape, and SFTP private-key field validation.
- SFTP: allowlist fail-closed behavior, observed key fingerprint mismatch rejected before SFTP session, strict host-key verification configured for the session, bounded download, exact-digest archive replay, temp-file + rename upload, read-back digest equality, remote filename conflicts rejected.
- Finance boundary: imports still go through shared dry-run validation, governed fact mapping and transactional receipts; same-payload retries reuse a prior receipt and retry only the external acknowledgement/archive action. The Business Central extension is an exchange adapter, not an instruction to post journals, pay vendors, change bank records or submit tax returns.

## 4. External staging evidence — NOT YET AVAILABLE

No approved staging tenant/company, installed Business Central AL extension build/hash, provider OAuth registration, Vault workload role, SFTP host/fingerprint, remote folder confirmation, allowlisted DNS/IP values, credentials/secret references, or maintenance window was supplied or used for this run. Automated mocks do not prove a real provider handshake.

Before closing acceptance, attach a sanitized staging receipt (never secret values) proving:
1. Actual Business Central batch receive/import and external acknowledgement; duplicate batch replay; same idempotency key with changed payload conflict; lost-ack recovery; export hash/length match.
2. Actual SFTP fingerprint matched and mismatch rejected; token/key rotation; provider/network outage and recovery; processed/quarantine archive replay; upload rename and read-back digest verification.
3. GL/AP/AR/bank/tax mapping reconciled to the external system's source-of-record totals, with at least one deliberate discrepancy held for authorized review and then resolved/waived with audit evidence.
4. Egress/TLS/allowlist review and alerts observed; finance/security owner approval that no external accounting transaction is posted by this reporting/exchange connector.
5. Exact-SHA PostgreSQL CI success and sanitized provider operation IDs, timestamps, response codes, hashes, extension/runtime versions and approval references.

**Release decision:** automated connector implementation is present; exact-SHA API and PostgreSQL jobs passed. Finance/ERP/SFTP production acceptance remains **OPEN** until real staging credentials/configuration plus fault-injection evidence and finance/security sign-off are attached.
