# FactoryOS release-readiness checklist

This checklist is deliberately separate from deployment. Passing CI does not mean production has been deployed or a production migration has been applied.

## API configuration

- Set `NODE_ENV=production` in the hosting environment.
- Set `CORS_ORIGINS` to a comma-separated list of exact HTTPS frontend origins, with no paths, wildcard, credentials, or trailing empty values.
- Keep `SWAGGER_ENABLED=false` unless there is an approved reason to expose API documentation.
- Use the OIDC configuration for production authentication; do not enable development token issuance.
- Store database credentials, JWT-related secrets, and OIDC configuration in the hosting platform's secret manager, not in Git or `.env.example`.
- Use a dedicated least-privileged application database role.

## Database migration 028 — manual release gate

Do not run migration 028 against production until all of the following are verified:

1. Confirm the target database identity and environment independently; never rely only on a shell prompt or a database name copied from an example.
2. Verify migrations 001–027 are applied and migration 028 is not already recorded.
3. Take a fresh backup and prove restore to an isolated database.
4. Apply migration 028 only to an isolated restore first; run the claim reconciliation SQL verification and PostgreSQL integration tests there.
5. Review locking, transaction duration, operator permissions, audit retention, and the manual recovery procedure with the database owner.
6. Agree on a rollback/forward-fix plan. Do not assume destructive schema rollback is safe after application writes begin.
7. Schedule production execution with an operator present, capture migration output, and run post-migration smoke tests.

## CI scope

The API CI workflow runs lint, build, and tests that do not require a provisioned PostgreSQL integration fixture. Database integration tests remain a separate gate until a dedicated ephemeral PostgreSQL setup and safe migration bootstrap are configured in CI. A skipped integration test is not evidence that the database path passed.
