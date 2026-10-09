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

The repository has three automated verification workflows:

- **API CI** runs API lint, build, and the unit tests that do not require PostgreSQL integration fixtures.
- **API PostgreSQL CI** provisions a disposable PostgreSQL 16 service, applies migrations 001–028 in dependency order, seeds CI-only fixtures, then runs the full API Jest suite serially. Migration 028 is applied only to this disposable CI database.
- **Web CI** installs the npm workspace dependencies, runs the frontend lint command, and builds the Next.js application.

A green GitHub Actions run verifies only the commit and environment shown in that run. It does not mean the application was deployed, that production configuration was entered in a hosting platform, or that any production migration was applied.

## Release completion criteria

- Confirm the API CI, API PostgreSQL CI, and Web CI runs succeeded for the exact commit being released.
- Confirm the production API environment has exact HTTPS values for `CORS_ORIGINS`, `NODE_ENV=production`, `SWAGGER_ENABLED=false`, and validated OIDC settings.
- Confirm the actual production database target, migration history, backup and proven restore before scheduling any production migration.
- Apply production migrations with an operator present and run post-migration API and frontend smoke tests.
- Record the deployed commit, migration results, verification evidence, and rollback/forward-fix decision.
