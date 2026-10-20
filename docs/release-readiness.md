# FactoryOS release-readiness checklist

This checklist is deliberately separate from deployment. Passing CI does not mean production has been deployed or a production migration has been applied.

## API configuration

- Set `NODE_ENV=production` in the hosting environment.
- Set `CORS_ORIGINS` to a comma-separated list of exact HTTPS frontend origins, with no paths, wildcard, credentials, or trailing empty values.
- Keep `SWAGGER_ENABLED=false` unless there is an approved reason to expose API documentation.
- Use the OIDC configuration for production authentication; do not enable development token issuance.
- Store database credentials, JWT-related secrets, and OIDC configuration in the hosting platform's secret manager, not in Git or `.env.example`.
- Use a dedicated least-privileged application database role.
- For the optional OPC UA one-shot read slice, set FACTORYOS_OPCUA_GATEWAY_URL to the fixed HTTPS /api/v1/read endpoint and FACTORYOS_OPCUA_GATEWAY_TOKEN (at least 32 characters) in the deployment secret store. FACTORYOS_OPCUA_GATEWAY_TIMEOUT_MS is optional and must be 100–5000 ms. Production reads fail closed when configuration is absent or the URL is not HTTPS. Provision the OT gateway, target mapping, firewall rules and its own secret-manager access separately; never expose the gateway to an untrusted network.

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
- Confirm the actual production database target, migration history including migration 156, inventory/RLS contract output, backup and proven restore before scheduling any production migration.
- Apply production migrations with an operator present and run post-migration API and frontend smoke tests.
- Record the deployed commit, migration results, verification evidence, and rollback/forward-fix decision.

## OT / OPC UA commissioning gate

Migration 157 and the API read gateway client establish a bounded read-only API contract. Before production use, deploy and review the trusted OT gateway, map each config:// reference to an approved endpoint and secret in the gateway trust zone, restrict outbound routes to explicitly approved controllers, confirm OPC UA security mode/certificate policy at the gateway, and exercise disconnect, timeout, invalid-quality, stale-version, tenant-isolation and gateway-auth failure cases. This repository change does not contain a live OPC UA session driver or certify hardware-in-the-loop behavior; retain commissioning evidence and operator approval before connecting to production equipment.
