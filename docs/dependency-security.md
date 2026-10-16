# Dependency security posture

Last reviewed: 2026-10-10

## Production dependency gate

The repository's npm workspace lockfile is shared across the web app and API. CI runs `npm audit --omit=dev` after `npm ci` to fail changes that introduce known vulnerabilities into production dependencies. This is a narrow production gate; it does not claim that all development-tool dependencies are vulnerability-free.

## Reviewed development-tool advisories

The last full audit before the argparse override reported 25 findings (20 moderate and 5 high), while `npm audit --omit=dev` reported zero. PR #35 added an `argparse@2.0.1` root override and synchronized the lockfile to remove the obsolete `sprintf-js` 1.x package from the old `js-yaml` 3 tooling chain. The override passed Web CI, API CI, the full PostgreSQL-backed API suite, and the production dependency audit.

A fresh full `npm audit` has not yet been captured for the merged lockfile, so the current full-audit count must be rechecked after pulling this revision. The remaining known upstream advisory is:

- **`braces` / GHSA-vfj7-8cjw-p6xm**: the current upstream advisory reports affected versions through 3.0.3 and no patched version. In this workspace it is pulled by Next's ESLint plugin through `fast-glob` and `micromatch`.

Development-tool findings remain relevant to CI/developer tooling, so they are tracked rather than declared fixed or globally ignored. Revisit the full audit when upstream fixes or a compatible dependency-chain update becomes available.

References:
- https://github.com/advisories/GHSA-vfj7-8cjw-p6xm
- https://github.com/advisories/GHSA-hp3w-g68c-fv3c

## Safe remediation policy

- Do not use `npm audit fix --force` as an automated fix; npm previously proposed downgrades to `eslint-config-next`, `ts-jest`, and `@nestjs/mau` that would be incompatible with the repository's current toolchain.
- Keep root `overrides` and `package-lock.json` synchronized. The verified overrides patch `handlebars` to 4.7.10, `tmp` to 0.2.7, `undici` 6.x to 6.29.0, and `argparse` to 2.0.1. The `argparse` override passed the full CI suite and removes the obsolete `sprintf-js` chain from the lockfile.
- Re-run full `npm audit`, production `npm audit --omit=dev`, all lint/build jobs, and the PostgreSQL-backed API suite after every dependency update.


### Latest audit results — 2026-10-10

After installing the updated workspace lockfile and rerunning the dependency audits:

- `npm audit --omit=dev`: 0 vulnerabilities.
- `npm audit`: 5 high-severity findings. The reported advisory identifies the `braces` dependency chain.

The dependency path is:

`eslint-config-next@16.4.0` → `@next/eslint-plugin-next@16.4.0` → `fast-glob@3.3.1` → `micromatch@4.0.8` → `braces@3.0.3`.

`npm explain braces` confirms that this dependency is reached through the Web workspace's development tooling.

The upstream advisory currently lists affected versions through `3.0.3` and no patched version. The finding remains unresolved; it is not considered fixed merely because production dependencies have a clean audit.

Do not run `npm audit fix --force`. Reassess this finding when a compatible upstream fix or alternative dependency chain becomes available.

