# Factory end-to-end acceptance and release evidence

**Status: PARTIAL / NOT RELEASE-ACCEPTED.** The repository is gaining a common PostgreSQL acceptance journey. A green CI run can prove the internal persistence/service contract; it cannot substitute for a real cloud-storage account, a genuine carrier sandbox callback, physical hardware evidence or authorized factory sign-off.

## Required persisted journey

The integration scenario in `services/api/src/inventory/inventory.location.postgres.integration.spec.ts` uses a fresh tenant/factory and ties together these persisted identifiers:

1. Active supplier → purchase order submission and maker/checker approval → posted GRN and accepted quantity.
2. Material lot linked to the posted GRN line → active finished-good product → effective-dated product revision, BOM and routing approval.
3. Production work order → material reservation from location/lot → operation start and finished-good output posting → material consumption and genealogy event(s).
4. Reverse trace from finished output back to the received material lot, forward trace from the material lot, and negative cross-tenant read tests.
5. Finished-good put-away into a directed BIN → explicit PICK to a staging location → carton packing → carton-in-pallet packing and sealing → order-line-bound pallet shipment → order-line-bound shipment and delivery/POD flow → recall impact/declaration, lifecycle label checks and durable recall-notification acknowledgement.

The existing WMS portion still injects a test storage verifier for POD digest confirmation. It tests the application flow, not a live storage provider. CI must run the PostgreSQL suite on the exact PR head before the code journey can be marked passing.

## Internal automated exit criteria

- [ ] Exact PR head passes API CI, PostgreSQL integration CI, production dependency security, and SRS/HLD/Blueprint traceability workflows.
- [ ] The integration output confirms GRN accepted quantity, work-order material reservations consumed exactly once, posted finished-good output, and persisted reverse/forward genealogy.
- [ ] The same finished-good traceability identity moves through `PUT_AWAY` and `PICK` movements with source/destination quantities checked and the pick persisted before carton packing.
- [ ] The carton is sealed, packed into a sealed pallet, and the pallet (not the inner carton) is bound to the customer order line and dispatched; recall impact reaches both package identities.
- [ ] Cross-tenant access to the finished lot and work order fails closed.
- [ ] Shipment matches the exact customer order line; POD digest verification is asserted; recall reaches the material lot, finished lot, carton/pallet and shipment as expected; notification acknowledgement is persisted.
- [ ] Any CI failure is fixed at source and all checks rerun against the new exact head. A skipped PostgreSQL test is not acceptance.

## SRS traceability evidence mapping

The following maps the shared journey to the authoritative requirement IDs in [the SRS v2.1 requirement/evidence matrix](./srs-v2.1-requirement-evidence-matrix.md) and the [requirement evidence register](./requirement-evidence-register.md). This table records test evidence only; it does **not** change the source matrix's existing `Partial` dispositions to `PASS`.

| Requirement / scope | Journey evidence | Remaining boundary |
| --- | --- | --- |
| `FR-MAT-01` — material requirements and receipt | Purchase order approval, posted GRN accepted quantity, GRN-linked material lot, BOM requirement, reservation and consumption | This single-item fixture does not prove every style/size consumption, wastage, shortage, supplier scorecard or material sector rule. |
| `FR-WMS-01` — location-level inventory movements | Directed `PUT_AWAY` to BIN and persisted `PICK` from BIN to STAGING, with source/destination quantity assertions | Cycle counting, quarantine/disposition, mobile/offline and RFID acceptance are separate. |
| `FR-WMS-02` — lot/carton/pallet identities and labels | Finished-good lot, sealed carton and sealed pallet identities; lifecycle-aware QR label print-contract snapshots before and after recall | A print contract is not a physical QR scan, printer calibration or scanner/device acceptance. |
| `FR-WMS-06` — carton/pallet genealogy through shipment and recall | Finished-good lot → carton → pallet → order-line-bound shipment; recall impact asserts both package identities and the shipment | Live carrier-originated events, real storage account permissions and hardware/site acceptance are not exercised by this injected-verifier PostgreSQL journey. |
| `FR-WMS-08` — forward trace | Material lot forward trace reaches the production output; recall impact carries the downstream order/shipment context | Sector-specific genealogy, every material/quality relationship and external customer confirmation still need their own evidence. |
| `FR-WMS-09` — reverse trace | Finished output reverse trace reaches the GRN-linked raw material lot; relationship and cross-tenant negative assertions are checked | Broader retention policy and production-site acceptance remain separate release gates. |
| `FR-LOG-01` — carrier/shipment delivery state | Shipment binds customer/order line, carrier and tracking reference; delivery events/POD metadata, digest-verifier contract, replay and recall context are asserted | The journey uses a mocked storage-verifier dependency and manual delivery service contract; it is not a real carrier sandbox or cloud-storage certification. |
| Manufacturing lifecycle acceptance (task 14; no normative SRS ID assigned in the evidence register) | One PostgreSQL flow joins PO/GRN, effective product revision/BOM/routing, work order, operations/output, material consumption, genealogy, put-away/pick, carton/pallet shipment, POD and recall acknowledgement | Quality inspection/hold/disposition/rework/scrap plus failure-injection rollback in this same flow, and authorized site/quality owner sign-off, remain open. |

**Traceability rule:** the automated SRS/HLD/Blueprint audit workflow must pass on this exact PR head, but its green result validates source-ID / evidence-register consistency; it does not certify external hardware, provider accounts, customer delivery, or a named factory signatory.

## Live storage and carrier exit criteria

Follow [`docs/wms-provider-certification.md`](./wms-provider-certification.md) against an approved dedicated staging/sandbox deployment and shipment only. Do not run the side-effectful harness on production. Do not place tokens or webhook secrets in chat, Git, PR comments or evidence artifacts.

Attach separate evidence for:

- [ ] A real authenticated POD upload and independent provider-side read-back, matching byte length and SHA-256 digest.
- [ ] Anonymous and read-only uploads denied; reviewed provider IAM policy demonstrating bucket/prefix scoping and least privilege, plus credential expiry/rotation/revocation ownership.
- [ ] A genuinely carrier-originated sandbox callback with provider request/event ID, the provider's native signature validation/mapping, and an observed retry/replay with no duplicate delivery record. The harness's synthetic FactoryOS-HMAC callback alone is insufficient.
- [ ] Redacted carrier sandbox request/response, callback-delivery log, storage object key/digest, FactoryOS shipment/delivery event IDs and timestamps correlated in one evidence pack.

## Remaining acceptance gates

- [ ] Same-identifier quality inspection and hold/disposition/rework/scrap path with stock and genealogy reconciliation; replay-without-duplicate-stock and injected-failure rollback in the shared journey.
- [ ] Physical barcode/QR/mobile offline and RFID hardware-in-the-loop evidence where those devices are in the release scope.
- [ ] SRS traceability matrix exported for the release commit; every exception remains explicitly marked, never silently set to PASS.
- [ ] Final merge-SHA workflow result is visible and green after promotion. PR-head success does not establish that a push-triggered post-merge workflow ran.
- [ ] Authorized site/quality owner, warehouse/WMS process owner, carrier integration owner and storage/security owner record named approvals against the exact release SHA and evidence artifact IDs.

## Evidence record template

Use a release-controlled ticket or protected evidence store for the completed record; do not fabricate signatories.

| Field | Required value |
| --- | --- |
| Repository / release SHA | Exact full commit SHA and branch/environment |
| Test run IDs | API, PostgreSQL, security, traceability workflow URLs |
| Site / factory / test shipment | Non-production identifiers; redact sensitive customer data |
| Storage provider / account / policy version | Provider-confirmed identifiers; no credentials |
| Carrier sandbox / external shipment / event IDs | Provider-originated IDs and timestamps |
| Upload / read-back evidence | Object key, byte length, expected/actual SHA-256, result |
| Retry/replay evidence | Original event ID, retry result, duplicate count, mismatch result |
| Exceptions | Open blockers and accepted limitations |
| Approvals | Name, role, organization/site, timestamp, signature/ticket ID and exact release SHA |

**Release rule:** without the live provider evidence and valid authorized sign-off, storage/carrier certification and full factory end-to-end acceptance remain OPEN, even if all repository CI checks pass.
