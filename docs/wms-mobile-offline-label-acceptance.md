# WMS mobile offline queue and label rendering acceptance

**Scope:** SRS v2.1 FR-WMS-02 / FR-WMS-06 / FR-WMS-07 / FR-WMS-08 / FR-WMS-09  
**Code branch:** feat/wms-mobile-offline-label-acceptance-20261026  
**Status:** client code and automated contract tests added; physical device/site acceptance remains OPEN.

## Offline queue contract

The web workbench is available at /wms. Its IndexedDB queue is implemented in apps/web/src/lib/wms-offline-queue.mjs and is partitioned by tenant, factory, user, and device identifiers. These values only partition local records; they do not grant server authority. Requests continue through the existing authenticated, factory-scoped API. Bearer tokens are memory-only; they are not placed into queued records.

- Queue insertion is durable before the UI reports that an operation is queued. A repeat of the same client transaction ID and canonical payload returns the stored entry; the same ID with a different payload is rejected locally.
- The reconnect handler attempts a due batch when browser connectivity returns. Batches are capped at the server-supported 100 transactions. Failed HTTP/network requests retain every operation and use bounded exponential backoff. Retry timers are scheduled only while the workbench is open; queued entries remain persisted when it closes.
- Queue cleanup requires one and only one response matching the exact client transaction ID, expected operation, APPLIED status, and a syntactically valid server receipt UUID. Missing, duplicated, malformed, or mismatched receipt responses keep the operation pending for retry.
- A server-receipted CONFLICT or REJECTED operation is parked rather than retried automatically. Resolution requires a fresh client transaction UUID and a corrected expected balance version (or other corrected payload); the original receipt/history is preserved as RESOLVED. Rejection is not silently treated as success.
- The server remains authoritative for stock mutation, transaction locking, idempotency, balance-version conflicts, durable terminal receipts, and repair of the interrupted-movement/receipt case. The client does not optimistically post stock.

### Cross-tab and concurrent reconnect protection

A due batch is claimed inside one IndexedDB read/write transaction before the network request starts. The claim has a per-attempt token and a bounded lease (default 120 seconds, maximum 10 minutes). Overlapping tabs using the same origin/database cannot both claim the same live pending entry. Only the current unexpired token owner can remove an APPLIED item, park a terminal result, or reschedule an ambiguous/network-failed item. If a tab closes or stalls, another tab can reclaim the entry after lease expiry; a late response from the expired owner cannot overwrite the replacement owner's local state.

The lease is a local coordination guard, not server authorization and not a substitute for idempotency. A request can outlive its lease or run from another physical device. The API's durable `client_transaction_id` / device-scoped idempotency contract must still guarantee that duplicate delivery causes no second stock movement. IndexedDB claims coordinate tabs sharing the same browser profile; server-side locking protects cross-device concurrency.

### Automated verification

Run from the repository root:

    npm --workspace web test
    npm --workspace web run lint
    npm --workspace web run build

The Node test contract covers queue persistence across instances, duplicate prevention, malformed/mismatched/ambiguous receipts, receipt-gated deletion, conflict parking and resolution with a new ID, network retry/backoff, atomic claims across two queue instances, expired-lease recovery, stale-owner response protection, QR and Code 128 SVG generation, print-copy/layout contract, invalid/stale label rejection, and unknown/ambiguous scan lookup. The API PostgreSQL suite covers concurrent duplicate retries, different-payload races, stale-version conflicts, terminal receipts, and one-stock-movement conservation. The concurrent-claim tests use a shared test store to exercise the state machine; a browser run is still required to validate real IndexedDB behavior across actual tabs.

## HTTP-to-PostgreSQL retry acceptance

The API PostgreSQL suite also exercises the actual `POST /api/wms/mobile/offline-sync/batches` route using a test-only authenticated request-context guard, the production controller and DTO validation pipe, and the real PostgreSQL integration adapter. This is deliberately different from a service-only integration test.

The acceptance scenario sends an `ISSUE` operation, discards the first HTTP response as a lost-response simulation, then retries the identical batch. It checks that the second response reuses the durable receipt, the authoritative stock balance changes only once, there is one inventory movement, and the receipt has exactly one audit and outbox evidence row. Reusing the transaction UUID with a changed quantity must return `IDEMPOTENCY_KEY_REUSED` without another movement. Unauthenticated requests and DTOs with unknown fields are rejected before stock mutation.

The test-only guard only supplies an identity context for this integration fixture; it does **not** test a deployed issuer/JWT, production permission assignments, staging network behavior, or physical hardware. The separate staging run still requires a non-production API, approved test item/device, and real deployment credentials. Do not mark live staging certification PASS based on this CI scenario.

## Label creation and scan lookup

The API already issues durable label records with a template/layout snapshot, symbology, encoded value, copy count, and identity payload. apps/web/src/lib/wms-label-renderer.mjs consumes that persisted print contract and now creates a local QR SVG or Code 128 B SVG without needing a remote rendering service. It builds a self-contained browser HTML print payload with the template page dimensions, identity fields, copy count, and conspicuous current-at-issue lifecycle status. Values are escaped before they enter the HTML. When a caller supplies a freshly read identity, status/code/identity mismatch rejects printing as stale.

The scan workbench accepts keyboard-wedge scanner input or text delivered by a camera-decoder adapter and calls GET /api/v1/traceability/labels/resolve?code=... against the authenticated API. Blank/control input is rejected client-side; unknown labels return a controlled not-found error; ambiguous codes are rejected by the API rather than guessed. This is a resolver, not a claim that this commit implements browser camera decoding.

**Supported generated images:** QR, Code 128 B and a bounded GS1-128 profile. GS1-128 requires parenthesized Application Identifier fields and supports fixed/variable AIs 00, 01, 02, 10, 11, 13, 15, 17, 20, 21, 30, 37, 240, 241, 400, 401, 420 and 422, plus the fixed six-digit numeric measurement families 310n (net weight kg), 320n (net weight lb) and 330n (logistic/gross weight kg), with decimal indicator n limited to 0–5. Unsupported AIs, invalid measurement-family indicators, duplicate AIs, unsupported variable-field characters, bad field lengths, invalid GTIN/SSCC check digits, invalid YYMMDD dates and payloads over 48 encoded AI/data characters fail closed. The measurement families follow the GS1 General Specifications' N4+N6 field shape; they are not a claim of broad support for every GS1 AI. Data Matrix remains fail-closed until a conformant encoder and independent test vectors are added. No label is silently printed with a different symbology than the stored template. See the [GS1 General Specifications](https://ref.gs1.org/standards/genspecs/25.0.0/) for the normative AI definitions.

## Physical acceptance checklist — do not mark PASS without a device run

| Test | Target evidence | Current result |
| --- | --- | --- |
| Airplane mode: queue 10 distinct movements, reload browser, confirm all persist | Screen recording plus exact transaction IDs | Not run here |
| Duplicate taps, reconnect during a batch, lost response then retry | API receipts, movement count and final stock reconciliation | Automated API/PostgreSQL contracts exist; target-handheld run not done |
| Two tabs or app windows reconnect at once in one browser profile | Record both sync correlation IDs, sent transaction IDs, terminal receipts and final ledger count | Two-instance unit test added; browser + target-handheld concurrency run still NOT RUN |
| Two physical devices submit the same transaction ID after a timeout / lost response | Device IDs, exact client transaction ID, server receipt/replay attempt and before/after stock ledger | API idempotency/concurrency contract exists; cross-device field acceptance NOT RUN |
| Server returns conflict/rejection/partial or malformed receipt | Queue retains/parks correct rows and no unreceipted row disappears | Automated client tests added; on-device run not done |
| Browser/app restart and browser-storage clearing | Persistence across restart; documented recovery when storage is erased | Persistence covered by client test; device restart not done |
| Print QR / Code 128 to each supported site printer and media size | Printer model/firmware/DPI, media, actual print sample and measured dimensions | Not run here |
| Scan output label on each supported handheld/camera/scanner | Device/app/firmware, successful decode, decoded canonical string and scan distance | Not run here |
| Damaged, clipped, blank, duplicate-code, stale-status or unknown label | Photos/scan logs and controlled rejection details | Software-invalid cases tested; physical defect testing not done |
| Reprint after quarantine/recall/shipment state change | Latest identity/status JSON, stale snapshot rejection and approved new print | Stale-status code test added; plant workflow not signed off |
| Network/auth expiry and tenant/factory boundary | API auth/permission evidence and no cross-scope identity disclosure | Backend factory-scope endpoint exists; site credentials not tested |
| Native printer language integration where required | Approved ZPL/EPL/ESC-POS payload profile and real device evidence | Not implemented; current output is HTML/SVG browser print |

Record each actual run with site, date/time, operator, hardware model and firmware, printer DPI/media/driver, browser version, scanner input mode, pass/fail, artifact/trace reference, defect and owner. Do not use a unit test or simulator as a substitute for physical acceptance.

## Limitations / release gate

- IndexedDB protects against network interruption and reload, but not deliberate browser-data clearing, profile loss, device theft, or storage eviction. Production needs a managed-device backup/re-enrolment procedure and retention policy.
- The /wms workbench exposes the needed queue/label operations but is not a replacement for an integrated device-management/authentication UI. A deployment must provide valid authenticated context, a same-origin or approved CORS API origin, HTTPS, and managed access tokens/cookies.
- Camera decode is supplied by a scanner wedge or an external camera-decoder adapter; this change does not claim device-camera image capture/decode, RFID HIL, native ZPL/EPL/ESC-POS generation, or certification against named printer/scanner models.
- Browser printing varies by browser, OS, driver, DPI, printer margins and stock. Printer/scanner compatibility, readable dimensions, scan distance, label media and offline plant rehearsal remain site-specific acceptance gates.
- No hardware was available for physical testing in this change. These gates remain OPEN until the checklist contains evidence and an authorized site owner signs it.

## Third-party source notices

The offline QR encoder is based on qrcode-generator by Kazuhiko Arase and retains its MIT license in apps/web/src/lib/vendor/qrcode-generator-LICENSE.txt. The Code 128 pattern table is derived from the MIT-licensed JsBarcode implementation by Johan Lindell; the license is retained in apps/web/src/lib/vendor/JsBarcode-MIT-LICENSE.txt.


## Physical hardware acceptance evidence bundle validator

The checklist above remains **OPEN** until the selected site has run the target devices and an authorized owner has reviewed the evidence. To reduce incomplete or wrongly promoted evidence packs, the repository now includes:

- \`apps/web/src/lib/wms-hardware-acceptance.mjs\`
- \`apps/web/src/lib/wms-hardware-acceptance.test.mjs\`

Run the validator from an approved, access-controlled evidence workspace:

    node apps/web/src/lib/wms-hardware-acceptance.mjs --manifest "C:\secure-evidence\wms-hil-manifest.json" --evidence-root "C:\secure-evidence\attachments" --release-sha "<exact-tested-release-sha>"

Use manifest schema \`factoryos.wms.hardware-acceptance/v1\`. Its \`release_sha\` and each owner approval must match the exact tested candidate release. \`scope.offline_mobile\` and \`scope.label_print_scan\` are mandatory for this WMS acceptance bundle. RFID can be included with the physical reader tests, or excluded only with a written reason confirming it is outside the approved release scope.

Every in-scope scenario must be marked \`PHYSICAL_HARDWARE\` and PASS. Required scenario IDs cover airplane-mode queue/reload/reconnect, lost response/duplicate tap/retry, cross-tab and cross-device sync, server conflict and receipt reconciliation, physical QR/Code 128 print-and-scan, damaged/stale-label handling, lifecycle reprint, and (when RFID is in scope) EPC repeat/dedup/unknown tags, wrong/ineligible tags, quantity reconciliation and RF burst/disconnect/reconnect.

The evidence pack needs real target asset IDs and manufacturer/model/firmware/OS/browser or printer/scanner interface settings, plus attachments tied to the test scenarios. Required attachments include screen recordings, API sync receipts, stock-ledger reconciliation, actual printed-label photos, scanner decode logs, printer settings and, if RFID is in scope, reader logs, EPC/stock reconciliation and RF-burst/reconnect logs. Every attachment's SHA-256 is recalculated from the local file; path traversal, symlinks, missing/empty/oversized files, hash mismatches and secret-bearing manifest field names fail validation.

Three distinct owners must approve the same release SHA: \`wms_process_owner\`, \`device_security_owner\`, and \`site_owner\`. When RFID is in scope, an additional distinct \`rfid_specialist\` approval is required. If the field run uses production, the manifest must also record explicit authorization for production side effects and its approval reference.

**Interpretation:** \`PASS_PHYSICAL_HARDWARE_ACCEPTANCE_BUNDLE\` confirms manifest completeness, exact-release binding, required physical scenario declarations, attachment integrity and owner-approval coverage. It does not prove that a submitted video/log is genuine. Do not change a scenario from simulator to physical merely to satisfy the schema. An authorized site/device owner must inspect the original recordings/logs and sign off independently. Automated Node tests use fixtures only and do not count as hardware-in-the-loop evidence; no actual handheld, printer, scanner or RFID reader was available to the software validation run.


## Real-browser IndexedDB multi-tab lab

The route \`/wms/browser-acceptance\` is now available for a browser-backed local-store check. Unlike the Node \`MemoryStore\` unit tests, it uses the browser's actual IndexedDB engine and two separately opened page instances, while keeping all payloads and responses local to the browser.

1. Use a dedicated test browser profile and open \`/wms/browser-acceptance\`.
2. Click **Open second tab** and keep both pages on the same \`run\` URL and run ID. Do not open two unrelated run IDs: each run ID selects a separate local database.
3. Seed one local test movement. Reload tab B and click **Refresh IndexedDB**; both tabs should show the same transaction ID as PENDING.
4. In tab A, click **Start primary claim** and wait until it reports that the transaction is CLAIMED and awaiting release.
5. While A's transport is intentionally held, click **Try competing claim** in tab B. It must report PASS with \`sent=0\` and \`transport called=false\`. Save the visible run logs from both tabs.
6. In tab A, click **Release primary as APPLIED**. Both tabs should converge to an empty queue after refresh. Save both run logs and the screen recording.

This test uses synthetic local receipts and a fixed fixture scope. It does **not** contact the API, mutate inventory, prove server idempotency, or count as a managed handheld/site acceptance. It only verifies actual browser IndexedDB cross-tab claim behavior. To prove server-side correctness, separately run the authenticated \`/wms\` workflow against a dedicated staging factory and reconcile each unique client transaction ID, returned server receipt, persisted stock movement, and before/after stock balance from PostgreSQL. The two-device retry after a real lost response still requires physical device evidence.

If the browser is closed while the primary claim is held, the lease is finite and a later tab can eventually reclaim it. Allow the claim lease to expire before restarting a held scenario; do not manually delete IndexedDB rows during the evidence run.
