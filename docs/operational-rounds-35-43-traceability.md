# FactoryOS Operational Rounds 35–43: Provisional SRS/HLD/Blueprint Traceability Audit

**Audit type:** Repository-evidence review, not a signed product acceptance report  
**Branch baseline:** The commit containing this document and the latest CI runs linked from the branch  
**Scope:** Requested Round 35–43 acceptance themes, existing design docs, source, migrations and automated tests  
**Status semantics:** Implemented = a repository-level implementation and relevant tests exist; Partial = bounded foundation exists but one or more explicit acceptance boundaries remain; Not verified = the current repository does not contain enough authoritative evidence to claim acceptance.

## 1. Audit limitation and source of truth

The current branch contains engineering documents such as docs/ai-runtime-agent-execution-traceability.md, docs/saas-productization.md, docs/research-growth-intelligence.md and docs/release-readiness.md. The authoritative signed SRS, complete HLD and implementation Blueprint requested for a formal requirement-by-requirement audit are not present as source files in the repository tree inspected for this change. Therefore this matrix traces the nine supplied round objectives and repository documents/code; it must not be represented as full SRS sign-off. Add the approved source documents and requirement IDs before release approval.

The repository already implements several of these domains. This audit does not count an existing foundation as newly implemented merely because it is mapped here. Code and CI prove only the cases exercised by those sources and tests; they do not prove a production deployment, real infrastructure adapters, customer-data erasure, OT hardware behavior or disaster-recovery objectives.

## 2. Requirement/evidence matrix

| Round / requirement theme | Repository evidence | Status | Remaining acceptance gate |
|---|---|---|---|
| **35 — Forecasting, calibration, uncertainty and deterministic numerical consistency** | services/api/src/ai/ai.operational.evaluation.service.ts; services/api/src/ai/ai.operational.evaluation.service.spec.ts; services/api/src/ai/ai.operational.evaluation.integrity.postgres.integration.spec.ts; services/api/src/growth/growth-scenario-engine.ts and its spec; migrations 055 and 057 cover observed-outcome-linked forecast accuracy and numeric consistency. | **Implemented foundation** | Sign off business-defined confidence calibration targets, uncertainty interpretation and minimum sample thresholds against the authoritative SRS; demonstrate reproducibility on the approved supported runtime/data fixtures. |
| **36 — Bounded retries, handoffs, failure recovery and approved compensation** | services/api/src/ai/agents/ai.agent.runtime.service.ts and its spec; runtime defines bounded step/retry/tool-call/time budgets, validates handoff expiry and tool entitlement, uses durable execution claims and checks registered rollback contracts before compensation. | **Implemented foundation** | Production-domain executors, end-to-end recovery from real downstream ambiguity, and approved compensators for each domain side effect remain individually gated. No implicit retry is allowed for an ambiguous external side effect. |
| **37 — SaaS entitlements, subscription lifecycle, metering, budget control and reconciliation** | docs/saas-productization.md; services/api/src/saas/saas-subscription.service.ts and specs; services/api/src/saas/saas-usage.service.ts and specs; subscription and usage PostgreSQL integration specs. | **Core control plane implemented** | External billing/invoicing remains an adapter/provider boundary; verify a real provider, accounting/tax rules, billing-period close and support process before claiming end-to-end commercial acceptance. Legacy no-subscription compatibility is still a documented policy, not proof of all plans being provisioned. |
| **38 — Retention, tenant export/deletion, audit and cross-tenant isolation** | services/api/src/saas/saas-tenant-data-transfer.service.ts, worker, dataset source and transfer tests; migrations 010 and 052–053; Audit/IAM/RLS infrastructure and existing PostgreSQL integration tests. | **Partial** | Export/migration manifests do not constitute a complete tenant-erasure workflow. No reviewed, tenant-wide retention schedule, legal-hold model, approved per-table purge plan or end-to-end deletion receipt across all tenant-owned data is evidenced in this branch. A complete all-table RLS matrix and two-tenant negative test are required before claiming this requirement accepted. |
| **39 — Device registry and bounded OPC UA slice** | migrations/148_ot_device_registry_spool.sql; services/api/src/ot/ot-device.module.ts, controller, service and DTO; services/api/test/ot-device-contract.sql. Registry enumerates OPC_UA/MQTT/MODBUS_TCP and guards scoped lifecycle transitions. | **Bounded registry slice implemented** | There is no OPC UA client/session driver, certificate lifecycle, node/tag browse, industrial network deployment or real-controller test in this slice. Protocol label registration is not OPC UA connectivity acceptance. |
| **40 — MQTT/Modbus, offline spool and reconnect/recovery** | OT service accepts bounded normalized batches with event fingerprinting, idempotent duplicate replay, source-sequence uniqueness, persistent server-side event history and ON_TIME/LATE/SEQUENCE_GAP classification. | **Partial** | The database ledger is server-side evidence, not an edge-local durable spool. MQTT broker connection/QoS/session handling, Modbus polling/timeout semantics, OPC UA session renewal, edge disk spool capacity/encryption, back-pressure and controlled reconnect have not been implemented or verified by this API slice. |
| **41 — Distributed tracing, metrics, alerting and SLO/runbook** | services/api/src/common/middleware/trace-id.middleware.ts and spec; services/api/src/observability/http-metrics.service.ts, middleware/controller and specs; docs/operational-reliability-runbook.md. | **Partial** | Trace ID propagation and process-local metrics exist, but no OpenTelemetry exporter/span topology, durable centralized telemetry backend, alert manager/notification routing or approved contractual SLO is configured by this change. Proposed thresholds in the runbook require owner sign-off. |
| **42 — Backup/restore, migration recovery, load and security verification** | .github/workflows/api-postgres-ci.yml explicitly applies the ordered migration manifest and rejects omitted SQL migrations; SQL contracts and Jest/PostgreSQL suites; docs/release-readiness.md and docs/operational-reliability-runbook.md. | **CI/rehearsal instructions implemented; production evidence pending** | No production backup was created/restored by this code change. No production-like capacity/load run, formal penetration test, recovery-time/point measurement or disaster-recovery approval is evidenced. Run the documented isolated restore and approved test protocol against the target release/environment. |
| **43 — Final authoritative SRS/HLD/Blueprint audit and backlog** | This document maps the nine supplied themes to files, tests, boundaries and residual acceptance gates; supporting traceability/release documents are linked above. | **Provisional audit only** | Insert approved SRS/HLD/Blueprint IDs and revision metadata, map every applicable normative requirement (not only Rounds 35–43), attach workflow/test/deployment evidence, and obtain engineering, security, operations and product sign-off. |

## 3. Priority gaps before production acceptance

Priorities below are provisional engineering risk classifications. Replace them with the official SRS/incident/security classification once the authoritative documents are added.

| Priority | Gap | Minimum evidence to close |
|---|---|---|
| **P0 — release sign-off blocker** | Authoritative signed SRS, HLD and Blueprint are absent from this repository snapshot, preventing a defensible requirement-by-requirement final audit. | Add immutable/versioned source documents; record document revision/hash; map every requirement ID to implementation, test, owner and accepted exception. |
| **P1 — security/privacy** | Tenant-wide retention, legal hold, approved erasure and deletion verification are not demonstrated across all tenant-owned tables and external stores. | Approved retention schedule and legal basis; deletion plan with table/store inventory; scoped approvals; dry-run manifest; idempotent execution and verification receipts; audit treatment for legally retained evidence; cross-tenant negative tests. |
| **P1 — OT safety/reliability** | Real OPC UA/MQTT/Modbus adapters and on-edge encrypted spool/reconnect behavior are outside the current bounded API slice. | Protocol-specific contract and security review; isolated simulators first; fault injection (disconnect, restart, duplicate, gap, source clock reset); replay invariants; device/network allowlist; operator-approved commissioning and hardware-in-the-loop evidence. |
| **P1 — observability** | The new metrics are process-local and there is no central exporter/alert routing or signed SLO evidence in the repository change. | Deploy collector, scrape every replica, configure retention/access, verify alert notifications, test 5xx/latency/DB/queue alerts and document on-call ownership. |
| **P1 — recovery/security** | Production backup restore, RPO/RTO measurements, production migration smoke test, load/capacity test and independent security verification have not been performed here. | Attach environment-specific backup/restore evidence, applied migration list, sanitized load results, vulnerability/penetration-test disposition and operator approval. |
| **P1 — external productization** | Billing provider, physical tenant isolation/sandbox infrastructure and migration-target adapters still have external adapter responsibilities. | Demonstrate real provider and infrastructure adapters in a controlled staging tenant; verify failure/replay/reconciliation paths and tenant-boundary enforcement. |

## 4. Proposed P2 / sector-pack backlog

These are proposed candidates for product/architecture review, not asserted SRS requirements:

- Protocol-specific OT drivers and vendor/sector packs for device identity, tags/register maps, quality codes, clock synchronization and safe read-only commissioning.
- Edge deployment packages with encrypted disk spool, bounded disk quotas, broker QoS/session recovery, signed configuration, certificate rotation, fleet upgrade and offline observability.
- Multi-region/zone failover and tested RPO/RTO targets once hosting topology is selected.
- Approved billing-provider adapters, tax/invoice reconciliation and dunning workflows.
- Data-retention policies for new data categories and external object stores after legal/product owners define retention periods and exceptions.

## 5. Acceptance checklist for the next release candidate

- [ ] Approved SRS/HLD/Blueprint revisions are stored and mapped at individual requirement-ID granularity.
- [ ] API lint/build/unit tests and PostgreSQL migrations/contracts are green on the exact release SHA.
- [ ] Forecast correctness/calibration fixtures, uncertainty thresholds and deterministic scenario fingerprints meet approved thresholds.
- [ ] Agent recovery/replay/compensation is tested against each registered production executor and side-effect ambiguity is reconciled without blind retries.
- [ ] Real subscription/billing provider and budget/invoice reconciliation flows are exercised in a non-production tenant.
- [ ] Tenant export, legal hold, retention, deletion, audit preservation and cross-tenant negative tests pass against a reviewed table/store inventory.
- [ ] Device and edge acceptance distinguishes database-ingestion tests, protocol-simulator tests and hardware-in-the-loop tests; all three are not interchangeable.
- [ ] Metrics are centrally collected, alert routing has been test-fired and SLO targets are approved by named owners.
- [ ] Fresh backup is restored into an isolated target; migration and application smoke tests pass; RPO/RTO, load and security evidence are attached.
- [ ] Unresolved P0/P1 risks have an explicit owner, approved exception or release block.

## 6. Related repository evidence

- docs/ai-runtime-agent-execution-traceability.md
- docs/saas-productization.md
- docs/research-growth-intelligence.md
- docs/release-readiness.md
- docs/operational-reliability-runbook.md
- .github/workflows/api-postgres-ci.yml
