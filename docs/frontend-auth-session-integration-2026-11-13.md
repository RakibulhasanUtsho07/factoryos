# FactoryOS Frontend — Authentication and Session Bootstrap

**Date:** 2026-11-13  
**Scope:** Frontend session bootstrap foundation; not a complete OIDC login flow.

## Verified API contract

The API has the global `/api` prefix. The auth and IAM controllers expose these read endpoints:

- `GET /api/auth/me` — returns the authenticated identity attached by the JWT guard.
- `GET /api/iam/access` — resolves the verified user's active tenant membership, factories, roles and permissions.
- `GET /api/iam/factories` — lists factories available to the verified tenant user.

The API response interceptor wraps successful responses in an envelope containing `api_version`, `data`, request/trace IDs and tenant metadata. The client unwraps `data`.

## Implemented

`apps/web/src/lib/factoryos-session.mjs` provides a small read-only bootstrap client:

- HTTPS is mandatory except for localhost development; credentials, paths, queries and fragments are rejected from the API-origin input.
- A short-lived bearer token and valid tenant UUID are required.
- The client calls only the three known read endpoints and sends request/trace IDs.
- The selected tenant is a requested scope only; the backend JWT guard and IAM still resolve/verify membership.
- It never sends `X-User-Id`, `X-Factory-Id`, browser cookies or any client-supplied user identity as authority.
- Requests use `cache: no-store`, `credentials: omit` and `redirect: error`.
- `clear()` discards the client-held token and prevents further requests.
- HTTP 401 and 403 are distinguishable to the UI.

This is a transport/session bootstrap contract, not an authentication bypass or an authorization cache. Every business endpoint must continue to authorize on the server.

## Not implemented / external prerequisite

There is no verified browser Authorization Code + PKCE login/callback configuration in this repository. The API runtime enforces OIDC in production, including HTTPS issuer/JWKS configuration and MFA claim policy; the development-token endpoint is intentionally unavailable outside local development.

A real sign-in/sign-out experience requires the approved IdP application details: client ID, issuer/authorization endpoint, redirect URI, logout URI, allowed origins, token audience, PKCE/client policy and deployment-owned secret/configuration handling. Do not enable a fake local-token form as a production login.

## Test coverage

The session-client tests cover API-origin validation, tenant/token validation, the exact endpoint paths, tenant/request headers, absence of user/factory authority headers, cookie omission, no-store cache, redirect rejection, response-envelope handling, 401/403 handling and in-memory token clearing.
