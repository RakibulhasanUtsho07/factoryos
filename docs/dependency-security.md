# Dependency security posture

Last reviewed: 2026-10-10

## Production dependency gate

The repository's npm workspace lockfile is shared across the web app and API. CI runs `npm audit --omit=dev` after `npm ci` to fail changes that introduce known vulnerabilities into production dependencies. This is a narrow production gate; it does not claim that all development-tool dependencies are vulnerability-free.

## Reviewed development-tool advisories

The latest full local audit (after the transitive security overrides were installed) reported 25 findings, while `npm audit --omit=dev` reported zero. The unresolved findings traced to development/build tooling, including:

- **`braces` / GHSA-vfj7-8cjw-p6xm**: the current upstream advisory reports affected versions through 3.0.3 and no patched version. In this workspace it is pulled by Next's ESLint plugin through `fast-glob` and `micromatch`.
- **`sprintf-js` / GHSA-hp3w-g68c-fv3c**: the current upstream advisory reports affected versions through 1.1.3 and no patched version. In this workspace it is pulled by the Jest/coverage tooling's transitive chain through `@istanbuljs/load-nyc-config`, `js-yaml` 3, and `argparse`.

These packages remain part of the development dependency tree and are not reported by the production-only audit. They still matter to CI/developer tooling, so they are tracked as unresolved—not declared fixed or globally ignored. Revisit the full audit when upstream fixes or a compatible dependency-chain update becomes available.

References:
- https://github.com/advisories/GHSA-vfj7-8cjw-p6xm
- https://github.com/advisories/GHSA-hp3w-g68c-fv3c

## Safe remediation policy

- Do not use `npm audit fix --force` as an automated fix; npm previously proposed downgrades to `eslint-config-next`, `ts-jest`, and `@nestjs/mau` that would be incompatible with the repository's current toolchain.
- Keep root `overrides` and `package-lock.json` synchronized. The reviewed overrides currently patch `handlebars` to 4.7.10, `tmp` to 0.2.7, and the `undici` 6.x line to 6.29.0.
- Re-run full `npm audit`, production `npm audit --omit=dev`, all lint/build jobs, and the PostgreSQL-backed API suite after every dependency update.
