# FactoryOS release-readiness checklist

This checklist is deliberately separate from deployment. Passing CI does not mean production has been deployed or a production migration has been applied.

## API configuration

- Set `NODE_ENV=production` in the hosting environment.
- Set `CORS_ORIGINS` to a comma-separated list of exact HTTPS frontend origins, with no paths, wildcard, credentials, or trailing empty values.
- Keep `SWAGGER_ENABLED=false` unless there is an approved reason to expose API documentation.
- Use the OIDC configuration for production authentication; do not enable development token issuance.
- Store database credentials, JWT-related secrets, and OIDC configuration in the hosting platform's secret manager, not in Git or `.env.example`.
- Use a dedicated least-privileged application database role.
- For distributed tracing, configure OTEL_EXPORTER_OTLP_TRACES_ENDPOINT to the private OTLP/HTTP collector URL ending in /v1/traces; remote endpoints must use HTTPS. Store OTEL_EXPORTER_OTLP_TRACES_TOKEN (if used) in secret management, set OTEL_SERVICE_NAME, and set/approve TRACE_SAMPLE_RATIO in [0, 1]. Do not send full URLs, payloads or tenant/user IDs to trace attributes.
- To enable Prometheus scraping, configure METRICS_SCRAPE_TOKEN with a high-entropy value of at least 32 characters and restrict GET /api/internal/metrics to the monitoring network/identity. Without the token the endpoint remains unavailable. Scrape each API replica; the metrics are process-local.
- Configure orchestration probes against GET /api/health/live (liveness) and GET /api/health/ready (database readiness). The legacy GET /api/health is preserved as readiness.
- For optional OT integration, configure the OPC UA gateway URL/token and separately configure FACTORYOS_OT_PROTOCOL_GATEWAY_URL to the fixed HTTPS /api/v1/modbus/read endpoint, FACTORYOS_OT_PROTOCOL_GATEWAY_TOKEN (at least 32 characters), and optional FACTORYOS_OT_PROTOCOL_GATEWAY_TIMEOUT_MS (100–5000 ms). A spool replay worker requires FACTORYOS_OT_API_URL as a fixed HTTPS origin and FACTORYOS_OT_API_TOKEN or an injected rotating workload-identity provider. Keep all tokens and the 32-byte spool encryption key in deployment secret storage; never commit them. Provision the trusted gateway, broker/topic and controller/register mapping, firewall rules and its own secret-manager access separately; never expose industrial network endpoints to an untrusted network.

## Migration and destructive-change manual release gate

Do not apply a production migration until all of the following are verified:

1. Confirm the target database identity and environment independently; never rely only on a shell prompt or a database name copied from an example.
2. Compare the complete ordered migration list in .github/workflows/api-postgres-ci.yml with applied schema_migrations entries, including same-prefix migrations whose order is dependency-sensitive. Do not use the maximum numeric filename as proof that all migrations ran.
3. Take a fresh, access-restricted backup and prove restore to an isolated database.
4. Apply the exact candidate migration sequence to the isolated restore first; run its SQL contract verification and the PostgreSQL integration tests there.
5. Review RLS, locking, transaction duration, operator permissions, audit retention, and the manual recovery procedure with the database owner.
6. Agree on a rollback/forward-fix plan. Do not assume destructive schema rollback is safe after application writes begin.
7. Schedule production execution with an operator present, capture migration output, and run post-migration smoke tests.

Migrations 149–155 add retention policy/versioning, legal holds, preservation attestations and bounded execution receipts. They do not by themselves make every copy of a tenant erasable. Migration 156 inventories every public base/partition relation: direct `tenant_id` tables receive forced RLS and a restrictive tenant-scope fence, `user_roles`/`role_permissions` are registered as derived-scope IAM relations, and all remaining no-direct-scope relations are explicitly excluded and erasure-blocked pending ownership review. The SQL CI gate fails for missing inventory rows. Only reviewed dataset adapters are exportable, and external object storage, caches/indexes, replicas, providers and backups still need separately configured adapters and verified deletion receipts. Retention periods/legal bases require policy-owner approval; do not advertise whole-tenant erasure until indirect ownership coverage and all required external adapters have passed acceptance. Migration 028's execution-claim reconciliation has additional manual recovery risk: preserve a fresh backup, confirm the isolated restore, inspect claim/execution evidence, and obtain operator review before any production reconciliation action. A CI application of migration 028 is not authorization to run it against production.

## CI scope

The repository has automated API, PostgreSQL integration, frontend and dependency-security verification workflows. Confirm the exact workflow set that applies to the candidate SHA:

- **API CI** runs API lint, build, and the unit tests that do not require PostgreSQL integration fixtures.
- **API PostgreSQL CI** provisions a disposable PostgreSQL 16 service, applies the ordered migration manifest in `.github/workflows/api-postgres-ci.yml` through `migrations/157_ot_opcua_read_gateway.sql`, verifies that no numbered migration is omitted, reapplies migrations 155, 156 and 157 for idempotency, runs retention/isolation/schema-wide privacy inventory and OT/OPC UA SQL contracts, then runs the full API Jest suite serially. Migration 028 is applied only to this disposable CI database.
- **Web CI** installs the npm workspace dependencies, runs the frontend lint command, and builds the Next.js application.

A green GitHub Actions run verifies only the commit and environment shown in that run. It does not mean the application was deployed, that production configuration was entered in a hosting platform, or that any production migration was applied.

## Backup and restore evidence

Before any production database change, follow docs/operational-reliability-runbook.md to create a restricted backup, restore it into an isolated database, apply the candidate migration sequence there, and run application/tenant-scope smoke tests. Record backup integrity, the restored database identity, candidate SHA, migration results, and operator sign-off.

## Release completion criteria

- Confirm the API CI, API PostgreSQL CI, and Web CI runs succeeded for the exact commit being released.
- Confirm the production API environment has exact HTTPS values for `CORS_ORIGINS`, `NODE_ENV=production`, `SWAGGER_ENABLED=false`, and validated OIDC settings.
- Confirm the actual production database target, migration history including migrations 156–158, inventory/RLS/OT protocol contract output, backup and proven restore before scheduling any production migration.
- Apply production migrations with an operator present and run post-migration API and frontend smoke tests.
- Record the deployed commit, migration results, verification evidence, and rollback/forward-fix decision.

## OT / OPC UA / MQTT / Modbus commissioning gate

Migrations 157–158 and the OT API adapters establish bounded API-to-gateway contracts, not a deployed industrial connector. Before production use, deploy and review the trusted OT gateway; map every config:// reference to approved endpoints and secrets in the gateway trust zone; restrict routes to explicitly approved controllers/brokers; confirm OPC UA certificate policy, MQTT TLS/ACL/topic and QoS 1 settings, and Modbus unit/register/address/data-type conventions. Provision the durable spool encryption key through secret management, protect its dedicated directory and capacity, ensure a broker delivery is not acknowledged until durably spooled, and ensure a spool item is not removed until all source IDs receive a validated telemetry API acknowledgement. Exercise network loss, reconnect storms, timeout, invalid acknowledgements, response loss after database commit, duplicate delivery, source sequence gaps, retry-ceiling quarantine, manual requeue, wrong key, corrupted spool, full disk, tenant/factory isolation and controller/broker HIL behavior. This repository change does not contain a live OPC UA/MQTT/Modbus session driver or certify hardware-in-the-loop behavior; retain commissioning evidence, rollback/recovery procedure and operator approval before connecting production equipment.
