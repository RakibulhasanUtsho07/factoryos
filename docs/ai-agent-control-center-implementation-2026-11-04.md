# AI Agent Control Center — implementation and acceptance boundary

**Date:** 2026-11-04  
**Delivery:** PR #359  
**Status:** first operator UI slice and bounded task-list API implemented; WP05/WP06 remain PARTIAL  
**Issue:** #336

## Implemented repository scope

### API

- `GET /api/v1/ai/tasks?limit=1..100` lists recent task summaries only within the verified tenant and authorized factory.
- The controller uses `PermissionGuard`, `ai.business.read` and `RequireFactoryScope`; the service repeats IAM authorization.
- The SQL is parameterized, tenant/factory constrained, bounded to 1–100 and ordered by update time.
- The task-list SQL projection excludes planner attestation and internal request hash; the existing task detail route remains the source for persisted step evidence.
- API controller/runtime tests cover scope, IAM denial, list bounds and the least-data projection.

### Frontend

Route: `/ai/agents`

The console loads real API-backed:
- Agent catalogue and a selected immutable agent definition.
- Operational-control state, with explicit ENABLED / PAUSED / RESTRICTED change and required operator reason.
- Per-agent evaluation report.
- Latest 50 task records and selected task's persisted steps.
- Execution status, retry eligibility, approval ID, error and stored execution evidence.
- Workflow drafts and available templates.

Explicit operator actions:
- Change agent operational control.
- Cancel a non-terminal task after confirmation.
- Execute only a PENDING step whose persisted retry time is due.
- Resume an AWAITING_APPROVAL step; the API must re-check approval and policy.
- Final-verify only when every persisted step is SUCCEEDED.

The console does not create tasks or produce plans. It does not trigger a side-effect when the page loads.

## Frontend security model

- Bearer token is kept in memory only; no localStorage, cookies, URL parameters, logs or public environment variable.
- User identity is taken from the verified JWT. The client sends no `X-User-Id`.
- Tenant and factory scope are sent as request headers and are rechecked by the API's JWT, IAM and factory-scope guards.
- Non-local API origins require HTTPS; the client uses `credentials: omit` and `cache: no-store`.
- Write operations are explicit user actions; server-side permissions and runtime policy remain authoritative.

## Verification

The PR exact-head CI contains:
- API CI: type/build and API contract/unit coverage.
- API PostgreSQL CI: PostgreSQL integration and runtime/list-service coverage.
- Web CI: web Node test suite, ESLint and Next.js build.
- Independent WMS barcode pixel-decode tests remain part of Web CI.

The Node client tests cover JWT/scope headers, absence of caller-supplied user ID, HTTPS/origin validation, envelope parsing, write-action HTTP method, task list bounds and due-retry eligibility. The API tests cover tenant/factory filtering, authorization denial and safe SQL projection. The web route is not yet backed by dedicated browser automation.

## Explicitly NOT closed

This delivery is an operator UI slice, not an AI system release. Issue #336 remains OPEN. Still required:

1. Trusted live planner and permission-filtered context resolver; exact context hash/version and Ed25519 attestation from the external trusted planner.
2. Durable task worker/orchestrator covering DAG progress, approvals, bounded retries, leases, restarts, duplicate delivery, shutdown and cancellation.
3. Domain-owner-approved side-effectful manufacturing executors, tested for committed / definitely-not-committed / ambiguous outcomes, stable idempotency and exact compensation.
4. Real observed business outcomes bound to execution evidence, followed by learning signal, evaluation, owner review, released artifact and rollback reference.
5. Expanded Control Center surfaces for context/plan/verification lineage, compensation/reconciliation, learning/release history and canary/rollback.
6. Browser tests for administrator/operator/approver/read-only roles, tenant/factory isolation, keyboard and screen-reader accessibility, plus empty/error/ambiguous states.
7. Provider/model/executor staging receipts and owner sign-off on the exact release SHA.

The only documented production domain executor remains read-only `INVENTORY.STOCK.SUMMARY@1.0.0`. No production write or live provider operation was performed by this change. Do not mark WP05/WP06 or the AI Quality Gate PASS from CI alone.
