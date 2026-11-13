# FactoryOS Web

FactoryOS Web is the Next.js workspace frontend for manufacturing operations. A shared responsive navigation shell connects the operational workspaces and provides an accessible skip-to-content path on every route.

## Workspaces

- `/` — FactoryOS workspace landing page.
- `/ai/agents` — governed AI Agent Control Center.
- `/wms` — warehouse mobile workbench for offline stock movements, labels and scan resolution.
- `/wms/browser-acceptance` — browser-based offline queue concurrency and recovery acceptance.
- `/wms/rfid` — USB-serial RFID capture and hardware-in-the-loop acceptance.

## Requirements

- Node.js 24
- npm 11 (the repository root npm workspace and lockfile are authoritative)

Install and run from the repository root:

```bash
npm ci
npm --workspace apps/web run dev
```

The frontend runs at `http://localhost:3000`.

## AI Agent Control Center

Open `/ai/agents`. Enter the API origin (origin only), authenticated tenant UUID, factory UUID and a short-lived bearer access token. The token is held only in the page's memory and cleared when you disconnect or close the page; it is never saved to local storage, cookies, or URLs. The browser sends `Authorization: Bearer`, `X-Tenant-Id` and `X-Factory-Id`; user identity is resolved by the API from the verified JWT. Non-local APIs must use HTTPS. Browser requests omit cookies and use `cache: no-store`.

The backend must have the AI routes and `GET /api/v1/ai/tasks?limit=1..100` deployed. Use an authenticated principal with the appropriate `ai.business.read`, `ai.agents.read`, `ai.agents.control` and `ai.actions.*` permissions. A section may return 403 when the selected principal lacks the permission; the console reports the section error rather than presenting it as an empty successful result.

The UI reads agent definitions and controls, evaluation reports, recent tasks/steps, workflow drafts and templates. Explicit operator actions include operational control changes, task cancellation, executing a due pending step, resuming an approval-pending step and final task verification. Every write remains subject to API IAM, policy, approval, planner-attestation, tool-entitlement, idempotency, deadline and execution-reconciliation gates.

Optionally set `NEXT_PUBLIC_FACTORYOS_API_URL` to prefill the API origin. Do not put access tokens or other secrets in `NEXT_PUBLIC_*` variables.

## Verification

From the repository root:

```bash
npm --workspace apps/web run test
npm --workspace apps/web run lint
npm --workspace apps/web run build
```

The AI console is the first operator UI slice, not full AI Quality Gate acceptance. Live planner/context integration, durable worker, side-effectful manufacturing executors, observed-outcome→learning→release, compensation/canary/rollback workflows, browser role/isolation/accessibility acceptance and provider staging evidence remain open. See [the implementation and acceptance note](../../docs/ai-agent-control-center-implementation-2026-11-04.md) and issue #336.

## Warehouse workbench

The existing WMS workbench has its own authenticated API origin/token flow for local acceptance, offline stock queue, traceability labels and scanner resolution. Physical devices and warehouse staging acceptance remain separate from browser-only CI.
