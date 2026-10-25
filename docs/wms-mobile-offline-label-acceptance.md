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

### Automated verification

Run from the repository root:

    npm --workspace web test
    npm --workspace web run lint
    npm --workspace web run build

The Node test contract covers queue persistence across instances, duplicate prevention, malformed/mismatched/ambiguous receipts, receipt-gated deletion, conflict parking and resolution with a new ID, network retry/backoff, QR and Code 128 SVG generation, print-copy/layout contract, invalid/stale label rejection, and unknown/ambiguous scan lookup. The existing API PostgreSQL suite covers concurrent duplicate retries, different-payload races, stale-version conflicts, terminal receipts, and one-stock-movement conservation.

## Label creation and scan lookup

The API already issues durable label records with a template/layout snapshot, symbology, encoded value, copy count, and identity payload. apps/web/src/lib/wms-label-renderer.mjs consumes that persisted print contract and now creates a local QR SVG or Code 128 B SVG without needing a remote rendering service. It builds a self-contained browser HTML print payload with the template page dimensions, identity fields, copy count, and conspicuous current-at-issue lifecycle status. Values are escaped before they enter the HTML. When a caller supplies a freshly read identity, status/code/identity mismatch rejects printing as stale.

The scan workbench accepts keyboard-wedge scanner input or text delivered by a camera-decoder adapter and calls GET /api/v1/traceability/labels/resolve?code=... against the authenticated API. Blank/control input is rejected client-side; unknown labels return a controlled not-found error; ambiguous codes are rejected by the API rather than guessed. This is a resolver, not a claim that this commit implements browser camera decoding.

**Supported generated images:** QR and Code 128 B only. The API's template schema also accepts Data Matrix and GS1-128, but this renderer intentionally fails closed for those values until conformant encoders and independent test vectors are added. No label is silently printed with a different symbology than the stored template.

## Physical acceptance checklist — do not mark PASS without a device run

| Test | Target evidence | Current result |
| --- | --- | --- |
| Airplane mode: queue 10 distinct movements, reload browser, confirm all persist | Screen recording plus exact transaction IDs | Not run here |
| Duplicate taps, reconnect during a batch, lost response then retry | API receipts, movement count and final stock reconciliation | Automated API/PostgreSQL contracts exist; target-handheld run not done |
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
