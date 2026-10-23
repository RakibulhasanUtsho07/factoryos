# Edge device gateway: registry, credentials and telemetry

## Scope
This backend slice adds a tenant/factory-scoped edge-device registry, hash-only device credentials, reconnect-safe telemetry ingestion, and append-only health reports. It owns edge-agent identity and durable cloud receipts; it does not replace the separate OT gateway API.

## API
Paths below are relative to the API base URL.

- `POST /api/v2/edge/devices` registers a device from a device key, display name, declared protocol and bounded capability metadata. Same-metadata replay is idempotent; conflicting metadata for the same key returns a conflict.
- `GET /api/v2/edge/devices` lists devices in the authorized factory.
- `POST /api/v2/edge/devices/:deviceId/status` supports ACTIVE, PAUSED and terminal REVOKED states.
- `POST /api/v2/edge/devices/:deviceId/credentials` issues a one-time opaque credential; the raw token is returned to the issuer and only its SHA-256 hash plus a short hint is stored.
- `POST /api/v2/edge/devices/:deviceId/credentials/:credentialId/revoke` revokes a credential.
- `POST /api/v2/edge/device-ingest/:deviceId` accepts an idempotent batch using the device token. Tenant, factory and device scope are derived from that credential, not caller-supplied headers.
- `GET /api/v2/edge/devices/:deviceId/observations` reads observations in authorized scope.
- `POST /api/v2/edge/device-health/:deviceId` records idempotent device health/drift metadata; `GET /api/v2/edge/devices/:deviceId/health` reads the authorized report history.

## Safeguards
Migrations 191–193 add registry, observation/batch receipts, credential lifecycle events and health/stream metadata. All tenant-bearing tables have forced RLS, tenant privacy classification and ownership-review records. Device credentials are hash-only, scoped to a single device, expiring and limited to one active credential per device. Ingestion rechecks credential and device status inside the transaction; repeated event/batch identifiers are deduplicated and conflicting reuse is rejected. Telemetry, credential and health history is immutable.

Device-reported health, model versions and drift are unverified telemetry—not evaluation outcomes, approvals or deployment authorization. The standalone Node.js component in services/edge-agent provides an atomic file-backed spool, bounded exponential retry, FIFO replay, payload integrity checks and receipt-validated deletion for the device-ingest endpoint. It is a library component, not a continuously running agent or scheduler; native physical-device collectors/drivers, signed package activation and host-side runtime enforcement remain separate integration slices.
