# ERP / SFTP / File Exchange — Finance Integration Slice

**SRS traceability:** FR-PROD-12 (P0), FR-PROD-13 (P0), FR-PROD-15 (P0), FR-PROD-27 (P0); FR-FIN-08 (P1), FR-FIN-09 (P0); Blueprint §27.2 (versioned import schema, strict validation, idempotency, checksum, dry run, reconciliation, quarantine and audit).

The canonical implementation contract is [`finance-integration-contract.md`](finance-integration-contract.md). It complements rather than replaces the tenant-wide encrypted export/migration job in [`saas-productization.md`](saas-productization.md).

## Supported payloads and connector modes

ERP records must be mapped to the canonical finance fact vocabulary before they enter the financial-fact ledger. The registry supports `REST_API`, `WEBHOOK`, `FILE_IMPORT`, `FILE_EXPORT`, `SFTP_IMPORT`, and `SFTP_EXPORT` along with the existing manual mode. The supported file formats are UTF-8 CSV and JSON; files submitted to the HTTP API are base64 encoded and capped at 2 MiB / 500 facts. There is no implicit GL posting, journal mutation, payment, tax submission or cross-currency conversion.

## Import workflow

1. Register a tenant/factory-scoped connector using an opaque `vault://` or `secret://` reference where credentials are needed. A separate actor must approve it; the connector must be active before ingestion.
2. Submit `POST /api/finance/connectors/:connectorId/file-import/validate` with an `Idempotency-Key`, `external_batch_ref`, `format`, `file_name`, and `content_base64`.
3. Inspect the immutable report via the report list/detail routes. `INVALID` reports include row/field errors and cannot be committed; `VALID` means the payload passed parser/DTO normalization, connector-domain, duplicate-prevention and applicable operational reconciliation checks.
4. Submit the same file to `POST /api/finance/connectors/:connectorId/file-import/commit` with `validation_report_id` and an idempotency key. The transaction rechecks exact SHA-256/file name/format/batch/connector scope before inserting the fact run, facts, reconciliation rows, audit and outbox records.
5. Read `GET /api/finance/connectors/:connectorId/file-imports/receipts` or the receipt detail endpoint. Receipts record checksum, format, filename, source batch, counts, status and request/trace linkage. Replaying an identical request returns the original receipt; altered content conflicts.

The legacy `POST /file-import` path also requires `validation_report_id`; it cannot bypass dry-run approval. Invalid reports remain available for investigation. Error listings are bounded at 200 and mark truncation.

## Export workflow

Create and independently approve a non-reporting `FILE_EXPORT` or `SFTP_EXPORT` connector for the required finance domain. `POST /api/finance/connectors/:connectorId/file-export` selects records only from the active reporting source and emits a deterministic CSV/JSON artifact with filename and SHA-256 receipt. The response includes base64 for a direct file export; SFTP export exposes a remote reference. GET receipt endpoints list/return the immutable metadata and allow authorized re-download for direct file export. Idempotency keys return the same receipt for the same request and conflict on a changed request. Synchronous output is limited to 500 rows / 2 MiB; use the tenant-wide export job for larger datasets.

## SFTP deployment adapter boundary

SFTP configuration requires a hostname, port, username, absolute remote directory, CSV/JSON format, host-key SHA-256 pin, optional restricted filename glob, and an opaque secret-manager reference. The adapter token `FINANCE_SFTP_TRANSPORT` provides download, archive/quarantine and upload operations. The API verifies reported host-key fingerprints, remote paths and file patterns before accepting a download; upload output must match the pinned key, deterministic basename and expected byte count.

The deployment adapter must resolve the secret reference without exposing key material, apply an explicit egress host/IP allowlist and DNS-rebinding controls, verify the SSH host key on every new connection, bound connection/read/write timeouts and bytes, atomically upload via temporary file/rename, refuse differing content at an existing digest-derived name, and make archive/quarantine operations idempotent. It must never trust caller-supplied tenant identity, log credential bytes, follow arbitrary remote paths or acknowledge a file before its receipt is durable. If no adapter is registered, SFTP processing returns service unavailable instead of simulating a successful transfer.

## Operational guarantees and limitations

Validation and transfer evidence is tenant/factory scoped, force-RLS protected and immutable. Receipts and validation reports include correlation fields and create transactional audit/outbox events. SFTP import recognizes already-ingested payload hashes and retries remote archiving separately; `ARCHIVE_PENDING` / `QUARANTINE_PENDING` makes incomplete acknowledgement visible. Finance imports are read-side evidence only, subject to the domain-owned fact mapping and finance source-of-record rules.

This slice supplies the ERP mapping contract, API-level CSV/JSON workflow, checksum/receipt persistence, safe file-export generation, and an injectable SFTP transport contract. Vendor-specific ERP REST polling/mappings and a deployment's concrete SFTP/secret-manager implementation must be configured separately; this repository change does not claim those external systems are connected without the adapter and credentials.