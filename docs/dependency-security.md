# Dependency security posture

Last reviewed: 2026-11-01

## Current audit baseline

The full workspace audit was captured from the locked install in Production Dependency Security workflow [run 41315563071](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/41315563071), against diagnostic baseline commit [8ea4174d3f2803b6fb29d755e15e59573a4450a7](https://github.com/RakibulhasanUtsho07/factoryos/commit/8ea4174d3f2803b6fb29d755e15e59573a4450a7).

- `npm audit`: **40 affected package records** — 0 critical, 2 high, 35 moderate, 3 low.
- `npm audit --omit=dev`: **0 production dependency vulnerabilities** at that baseline.
- The 40 records are affected package records, not 40 independent CVEs. npm aggregates advisories through multiple direct and transitive tooling packages.
- The full workspace is not clean. A passing production-only audit must not be represented as a clean development dependency audit.

## Patched transitive dependencies in this remediation

The root overrides and lockfile now pin these dependencies to patched versions:

| Dependency | Previous | Patched | Audit path |
|---|---:|---:|---|
| `undici` | 6.29.0 | 6.29.1 | High; nested below `@nestjs/mau` |
| `zod` | 4.6.5 | 4.6.7 | High; nested below `eslint-plugin-react-hooks` |
| `fast-uri` | 3.1.8 | 3.1.9 | Moderate; nested below Ajv |

These overrides preserve the existing major lines. The audited lockfile marks these three copies as development-only. A CI contract checks each root override against the exact locked version, registry tarball URL, SHA-512 integrity value and dev-only metadata. The full audit reporter still runs after `npm ci`, so remaining findings stay visible.

References:
- https://github.com/advisories/GHSA-4qv8-2p9j-2685
- https://github.com/advisories/GHSA-xjj6-f33q-929c
- https://github.com/advisories/GHSA-2m5v-pch6-74hx
- https://github.com/advisories/GHSA-qrxm-fqhp-jwvm
- https://github.com/advisories/GHSA-9fm3-97px-rjf6
- https://github.com/advisories/GHSA-mrhx-c7xc-m3w5
- https://github.com/advisories/GHSA-w74x-v6f9-j3xg
- https://github.com/advisories/GHSA-xhq7-xmqj-769h
- https://github.com/advisories/GHSA-wjr9-j795-jxcr
- https://github.com/advisories/GHSA-333x-w4r6-6crp

## Remaining development-tool advisories — NOT FIXED

These compatibility blockers remain open and must not be presented as remediated:

- **`glob` / GHSA-3g3m-2fjr-6pw4 (Moderate):** the audit found vulnerable locked copies `glob@13.0.6` and nested `glob@10.5.0`; the advisory's fixed version is `14.0.2`. Current Jest and `test-exclude` dependency ranges are major-version constrained and do not admit 14.0.2. A coordinated parent-toolchain update requires compatibility review.
- **`minimatch` / GHSA-g3hv-75wg-m249 (Moderate):** the fixed version is `11.0.1`, while this lockfile has 3.x, 9.x and 10.x copies required by ESLint, Nest CLI, TypeScript ESLint and glob consumers. A blanket 11.x override crosses declared major ranges and is not accepted without compatibility evidence.
- **`deepmerge` / GHSA-gcqx-w48m-w2h4 (Low):** locked `deepmerge@4.3.1` is used by Jest configuration. No patched release was listed in the audit metadata reviewed for this baseline; keep it tracked and re-check upstream before changing the test runner.

npm's aggregate suggestions include old major releases such as ESLint 4 and Jest 25.1.0. Those are not acceptable remediation because they downgrade the current toolchain. Do not run `npm audit fix --force` or use broad cross-major overrides to suppress the report.

## CI and release policy

- `npm ci` must install the committed lockfile.
- The workspace advisory reporter is diagnostic and displays the findings; it does not turn advisory presence into PASS.
- `npm audit --omit=dev` remains a blocking production dependency gate.
- Run API CI, PostgreSQL integration CI, Web CI, the full workspace advisory report and production audit on the exact PR head after every dependency update.
- Do not describe the full workspace as clean until full `npm audit` returns zero findings or the remaining risk is formally accepted through the approved security governance process.
- This work is separate from PR #297's external erasure acceptance and does not change AS-137 / NFR-PROD-14 or authorize branch promotion.
