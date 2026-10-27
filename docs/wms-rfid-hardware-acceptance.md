# WMS RFID reader integration and hardware acceptance

**SRS alignment:** WMS material/lot traceability, stock location reconciliation and device acceptance  
**Implementation route:** /wms/rfid  
**API:** POST /api/v1/wms/mobile/rfid/read-batches  
**Status:** reader adapter and software regression coverage added; physical HIL remains OPEN until a target reader/tag/warehouse run is recorded.

## Delivered client integration

apps/web/src/lib/rfid-serial-reader.mjs implements a browser Web Serial adapter for compatible USB-serial readers that emit a hexadecimal EPC per line, optionally as EPC:<hex>, TAG=<hex>, or JSON with an epc/EPC property. The adapter opens a real serial port after an explicit user gesture, reads the byte stream incrementally, handles partial/multiple lines, ignores malformed/status frames, canonicalizes EPC hex to uppercase and closes the port on stop, stream completion or disconnect.

The adapter intentionally does not guess vendor protocols. A reader that requires a proprietary SDK, TCP session, LLRP, a custom binary packet decoder or vendor authentication must use a separately approved model-specific driver/gateway. A serial reader must actually emit one of the documented EPC frame forms. Browser Web Serial requires a supported Chromium browser and a secure context (normally HTTPS), plus OS permission to the serial device.

The /wms/rfid page captures an immutable batch before submit. It includes raw reads, unique-EPC preview, duplicate-read preview, ignored status/noise counts, reader/session/item/location identifiers and selectable baud rate. It submits the original raw read list—including repeats—to preserve duplicate evidence. It never posts stock movements from a reader scan.

The API adapter calls the existing factory-scoped endpoint with cookies or an optional in-memory bearer token and an Idempotency-Key. Network failure leaves the captured EPC set in the page; a retry reuses the same key for that captured payload. The server returns a durable batch, individual EPC observations and expected/observed/variance quantities.

## EPC and reconciliation rules

1. A valid EPC read is normalized to uppercase hexadecimal. This serial adapter accepts 16–128 hex characters with even length, with spaces/colon/hyphen separators permitted by some serial readers. Arbitrary status/RSSI text does not become a tag.
2. The backend canonicalizes EPC case, suppresses repeated EPCs within a batch, and persists one observation per distinct EPC. duplicate_read_count records the number of repeated occurrences; duplicate_reads_suppressed records how many raw reads were collapsed.
3. The backend resolves EPCs within the authenticated tenant/factory. It records UNKNOWN_TAG for no unit, WRONG_ITEM when the EPC belongs to another item, INELIGIBLE for held/expired/quarantined/disposed/recalled states or disqualifying attributes, NOT_PRESENT when the identity has no positive quantity at the requested location, and MATCHED only when it is eligible for the selected item and has positive quantity at the selected location.
4. expected_quantity comes from the current item/bin stock balance. observed_quantity is the sum of the eligible, location-present traceability-unit quantities represented by distinct EPCs. variance_quantity = observed - expected; zero variance yields MATCHED, otherwise VARIANCE. One tag is not blindly counted as one piece: its location quantity is used.
5. RFID ingestion is audit/outbox-backed and append-only. Reconciliation does not post an inventory movement or adjust bin stock. An operator must investigate variances and use the existing approved stock/count process to post corrections.
6. An exact retry with the same idempotency key and same request is replayed from the saved batch and observations. Reusing the key for different input conflicts. A reader session also cannot be reused for a new batch.

### Automated software acceptance

Run from the repository root:

    npm --workspace apps/web run test
    npm --workspace apps/web run lint
    npm --workspace apps/web run build

The client unit tests cover EPC normalization, malformed/status frame rejection, duplicate aggregation, Web Serial stream parsing/lifecycle, missing browser support and invalid baud rates. The API PostgreSQL RFID regression verifies case-normalized repeated EPC suppression, persisted MATCHED observations, idempotent replay, UNKNOWN_TAG exclusion/variance, WRONG_ITEM exclusion/variance, and unchanged stock during reconciliation. These tests use a simulated serial stream and PostgreSQL fixtures; they are not a physical HIL run.

## HIL evidence workflow

From a managed Chromium browser at the test site, open /wms/rfid. Use an authenticated FactoryOS session with traceability.write, HTTPS, the deployed API origin, a reader UUID that is stable for the physical reader, target item/location UUIDs, and the reader's documented baud rate. Set the site/operator/manufacturer/model/serial/firmware fields before recording evidence. Connect the reader using the browser's explicit serial chooser.

Use approved, known labels/EPCs in a segregated test bin before any production scan. Do not select a production stock bin for destructive tests; reads are non-mutating, but they can still write audit and reconciliation records.

The page's HIL checklist defaults every scenario to NOT_RUN. Only the site operator may select PASS/FAIL after physically executing that scenario. Export the JSON artifact after the test, attach photos/raw reader logs or serial console output and API batch ID, and store the artifact in the site acceptance pack. The export explicitly marks the scenarios as operator-reported and not independently attested.

## Required physical evidence matrix

| Scenario | Required physical/API evidence | Exit condition |
| --- | --- | --- |
| Reader port / reconnect | Manufacturer/model, hardware serial, firmware, interface, OS/browser, baud rate, timestamp; connect, unplug/replug, stop and restart outcomes | Known EPCs resume after reconnect; no incomplete/garbled frame becomes an EPC |
| Known tag | Photograph or approved tag fixture ID, EPC, mapped unit ID, item/bin and API batch response | Disposition MATCHED; observed quantity agrees with registered unit quantity at the selected bin |
| EPC repetition | Present one physical tag repeatedly; capture raw count and distinct EPC count | API has one observation for the EPC, duplicate counts match raw-read evidence |
| Unknown tag | Approved unregistered EPC fixture; API response and no cross-scope disclosure evidence | UNKNOWN_TAG, zero observed quantity |
| Wrong item | Known tag mapped to a different item than the chosen reconciliation item | WRONG_ITEM, zero observed quantity |
| Tag not in selected bin | Known eligible identity with zero quantity at the target location | NOT_PRESENT, zero observed quantity |
| Ineligible tag | Quarantined/held/expired/recalled test identity | INELIGIBLE, zero observed quantity |
| Quantity reconciliation | Snapshot expected item/bin quantity, all mapped EPCs, unique EPC list and exact API batch result | Variance equation matches; zero variance only when all eligible location-present quantities match expected stock |
| Burst / RF conditions | Read count, time window, tag density/orientation/distance, RF power/antenna and missed/extra reads | Approved site-specific read-rate and accuracy threshold is met |
| Auth / scope | Expired/revoked token, unauthorized permission and a test identity outside the caller's factory | Request rejected and no foreign identity data is disclosed |
| Retry after lost response | Preserve request payload/key, simulate client timeout, replay same request, inspect database batch/observation counts | Same batch ID returns; no duplicate batch/observation evidence |
| Stock non-mutation | Before/after bin balance and movement-ledger query around each reconciliation | RFID reads alone produce no movement and do not change stock |

The HIL evidence must name the test site, operator, date/time/timezone, hardware model and serial, firmware, interface/protocol, antenna and RF settings (when applicable), tag/fixture IDs, test setup, expected/actual result, API batch/session/correlation IDs, database reconciliation evidence, attachments, defects and an authorized acceptance signature. Record actual measurements; do not replace missing values with estimates.

## Release boundary and known gap

No physical RFID reader or RF test fixture was connected during this code change. Consequently there is no real reader model/firmware, read-distance/rate/accuracy, antenna behavior, warehouse RF environment or hardware evidence artifact here; the HIL checklist remains open until the target site executes it. The tests under CI validate a simulated Web Serial stream and API/PostgreSQL contract only.

The existing read-batch API stores a caller-supplied reader_id UUID with the tenant/factory-scoped read evidence, but this change does not add a device certificate, reader enrollment registry, cryptographic device attestation or a server-side commissioning approval gate. The workbench therefore requires managed authenticated user access and a stable reader UUID; production must not treat that UUID or an operator-exported evidence JSON as cryptographic proof of the physical reader. A reader registry/device identity and site-sign-off gate remain additional production-hardening work if required by the deployment's threat model.
