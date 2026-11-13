# FactoryOS Web — shared design system

**Date:** 2026-11-13  
**Workspace:** `apps/web`  
**Status:** Initial reusable foundation; product-wide adoption is incremental.

## Scope

The first design-system slice standardizes common presentation and interaction patterns without adding a component framework or changing backend contracts.

### Tokens

`src/app/globals.css` defines the light surface/background, foreground, muted text, border, focus ring, semantic feedback colors and a blue brand scale. Reduced-motion preferences are respected globally.

### Primitives

| Primitive | Purpose |
| --- | --- |
| Button | Explicit action hierarchy, sizes, disabled state and safe default `type="button"` |
| Badge / StatusBadge | Consistent neutral and semantic status display |
| Card family | Reusable semantic content surfaces and sections |
| Field / Label / Input / Select / Textarea | Native, typed form controls with invalid-state styling |
| FieldHint / FieldError | Descriptive help text and announced validation errors |
| Alert | Status/alert feedback semantics |
| EmptyState | Honest no-data / no-results presentation |
| PageHeader | Consistent page title, context and actions |
| Skeleton | Loading placeholder hidden from assistive technology |

All components are exported through `@/components/ui`. The components remain Server Component-compatible unless the consuming screen itself requires interactivity. No third-party UI dependency is introduced.

## Usage requirements

- Use a real `label` association via `htmlFor` and control `id`.
- Connect hints and errors with `aria-describedby`; set `invalid` when validation fails.
- Use `Button type="submit"` only for form submission; otherwise its safe default is `button`.
- Use error alerts for actionable failure messages; do not make success or warning messages visually indistinguishable.
- Status badges are display-only. Backend IAM remains the authorization source of truth.
- Never encode access tokens, credentials, tenant/user identity or sensitive operational data in status labels.
- Keep empty, loading, error and success states distinct.
- Respect reduced-motion preference and visible keyboard focus.

## Verification

The Web CI workflow runs the frontend unit contracts, independent barcode pixel decoding, ESLint and the Next.js production build. UI primitives are statically checked by the TypeScript/Next.js build; browser-level accessibility, visual regression and real identity-provider flows remain separate acceptance tasks.

## Next phase-1 work

1. Adopt the primitives in the workspace shell and the next dashboard screens.
2. Build a typed FactoryOS API/session boundary based on `GET /api/auth/me` and `GET /api/iam/access`.
3. Complete the OIDC browser redirect/callback integration only after the approved issuer, client ID, redirect URI, logout URI and deployment configuration are supplied and verified. The development-token endpoint is not a production login method.
