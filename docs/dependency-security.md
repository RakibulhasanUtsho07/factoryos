# Dependency security posture

Last reviewed: 2026-10-10

## Production dependency gate

The repository's npm workspace lockfile is shared across the web app and API. CI runs `npm audit --omit=dev` after `npm ci` to fail changes that introduce known vulnerabilities into production dependencies. This is a narrow production gate; it does not claim that all development-tool dependencies are vulnerability-free.

## Reviewed development-tool advisories

The latest full audit on the previously merged lockfile reported 25 findings (20 moderate and 5 high), while `npm audit --omit=dev` reported zero. The remaining tracked upstream advisory is in development/build tooling:

- **`braces` / GHSA-vfj7-8cjw-p6xm**: the current upstream advisory reports affected versions through 3.0.3 and no patched version. In this workspace it is pulled by Next's ESLint plugin through `fast-glob` and `micromatch`.

This branch additionally overrides `argparse` to 2.0.1 to remove the obsolete `sprintf-js` dependency from the old `js-yaml` 3 tooling chain. That major-version override must stay only if CI confirms that npm installation, lint/build, API unit tests, and PostgreSQL integration tests remain compatible. The current branch's CI is the compatibility gate; the earlier 25-finding audit should not be treated as the result of this proposed change.

Development-tool findings remain relevant to CI/developer tooling, so they are tracked rather than declared fixed or globally ignored. Revisit the full audit when upstream fixes or a compatible dependency-chain update becomes available.

References:
- https://github.com/advisories/GHSA-vfj7-8cjw-p6xm
- https://github.com/advisories/GHSA-hp3w-g68c-fv3c

## Safe remediation policy

- Do not use `npm audit fix --force` as an automated fix; npm previously proposed downgrades to `eslint-config-next`, `ts-jest`, and `@nestjs/mau` that would be incompatible with the repository's current toolchain.
- Keep root `overrides` and `package-lock.json` synchronized. The previously verified overrides patch `handlebars` to 4.7.10, `tmp` to 0.2.7, and the `undici` 6.x line to 6.29.0. This proposed change additionally overrides `argparse` to 2.0.1 to remove the obsolete `sprintf-js` chain; do not retain the added override unless the full test suite proves compatibility.
- Re-run full `npm audit`, production `npm audit --omit=dev`, all lint/build jobs, and the PostgreSQL-backed API suite after every dependency update.
