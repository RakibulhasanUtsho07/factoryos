# FactoryOS Web

FactoryOS Web is the Next.js workspace frontend for manufacturing operations. A shared responsive navigation shell connects the operational workspaces and provides an accessible skip-to-content path on every route.

## Authentication boundary

The API currently exposes the authenticated identity and access bootstrap at `GET /api/auth/me`, `GET /api/iam/access` and `GET /api/iam/factories`. These routes use the API's global `/api` prefix; the response envelope carries the API version separately. The frontend must treat the verified JWT as the identity source, never send `X-User-Id` as authority, and use `X-Tenant-Id` / `X-Factory-Id` only as requested scope for the backend to verify. Production authentication is OIDC-only with MFA enforcement; the development token endpoint is disabled outside local development. A browser OIDC login flow is not complete until the approved identity-provider client ID, redirect/logout URIs and deployment configuration are supplied.

## Shared UI system

Shared, server-renderable primitives live in `src/components/ui` and are exported from `@/components/ui`:

- `Button` — primary, secondary, outline, ghost and danger actions; native `type` defaults to `button`.
- `Badge` / `StatusBadge` — neutral and semantic status presentation.
- `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`.
- `Field`, `Label`, `Input`, `Select`, `Textarea`, `FieldHint`, `FieldError`.
- `Alert`, `EmptyState`, `PageHeader` and `Skeleton`.

Example:

```tsx
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  FieldHint,
  Input,
  Label,
} from "@/components/ui";

export function SupplierSearch() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Find a supplier</CardTitle>
      </CardHeader>
      <CardContent>
        <Field>
          <Label htmlFor="supplier-code">Supplier code</Label>
          <Input
            id="supplier-code"
            name="supplierCode"
            autoComplete="off"
            aria-describedby="supplier-code-hint"
          />
          <FieldHint id="supplier-code-hint">
            Search uses the current authorized tenant scope.
          </FieldHint>
        </Field>
        <Button className="mt-4" type="submit">Search</Button>
      </CardContent>
    </Card>
  );
}
```

Use native labels and connect hints/errors with `aria-describedby`. Keep buttons explicit about their form type. Status badges are informational only and never replace API authorization. Global semantic colors and brand tones are defined in `src/app/globals.css`; prefer these shared primitives over one-off controls in new screens. The primitives are Server Component-safe; add client boundaries only around components that actually need browser state or event handlers.

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

## Authenticated workspace session

- `/session` — connect an already-issued short-lived bearer token and load the verified current-user, IAM access, tenant membership, roles, permissions and factory context.
- Session data is kept in the root React provider's memory only. Refreshing or closing the tab clears it; no access token, identity or tenant context is written to localStorage, sessionStorage, cookies or a URL.
- The session page is not a sign-in provider and never calls the development-token endpoint. Production sign-in remains the approved OIDC Authorization Code + PKCE flow when the customer IdP application values and deployment configuration are available.
- The displayed permission snapshot is for UX only. Backend JWT, tenant, factory and IAM permission guards remain authoritative for every operation.

## Session-aware application shell

The root layout mounts the in-memory workspace session provider around all routes. The shared top navigation exposes the current verified user/tenant context when connected, allows switching only among ACTIVE factories returned by IAM, and supports explicit disconnect. Without an established session it links to `/session`. Selecting a factory changes presentation context only; it does not grant permissions or replace backend factory authorization. A visible skip-to-content link and shared footer are available across the application.

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
