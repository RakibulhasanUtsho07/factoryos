# Production Security Configuration and Independent Review

**Release-gate status: PENDING_EXTERNAL_REVIEW.** This document defines the production security evidence package and records preliminary repository changes. It does not claim that a production deployment was inspected, an independent penetration test was performed, or a release was approved.

## 1. Scope and standard of evidence

Target acceptance is evaluated against one immutable 40-character candidate commit SHA and one named hosting environment. Every control needs evidence from the environment where it will run; a repository template, local test, development Compose file, or green CI result alone is not production configuration evidence.

This review package covers:

- OIDC issuer/audience/JWKS validation and the MFA claim contract for interactive users.
- Applicability decision for SCIM-based user/group lifecycle and the boundary between identity provisioning and FactoryOS tenant/role authorization.
- Runtime, migration, monitoring and backup identities; PostgreSQL role attributes, inherited roles and effective object privileges.
- Secret-manager attachment, credential rotation/revocation and rollback/overlap periods.
- Ingress/egress network policy, database/private monitoring routes, OIDC/JWKS egress and feature-specific integration destinations.
- Negative tests for missing/invalid identity, MFA policy failure, spoofed user/tenant headers, cross-tenant reads/writes, RLS missing context and unauthorized metrics access.
- Scope-bounded external security review, severity-ranked findings, fix verification and explicit release/rollback approval.

### Review boundary

The repository review performed by the implementation author is preliminary and not independent. An independent reviewer must be selected by the service owner, have no implementation/approval conflict, confirm written authorization and scope, independently execute/review the agreed checks and issue their own signed report. Do not describe this record as a penetration-test certificate. A full penetration test may require a separate provider/contract and a broader authorization.

## 2. Hosting-topology applicability matrix

The owner must select the actual row(s) matching the deployed system and record exceptions with rationale, scope, expiry and approver. If topology is not known, applicability remains unresolved and the P1 release gate stays closed.

| Hosting / identity shape | OIDC | MFA | SCIM | Additional release evidence |
|---|---|---|---|---|
| Vendor-hosted multi-tenant SaaS with human users | Required for production interactive authentication; issuer, audience and JWKS URI are environment-specific and HTTPS. | Required for human interactive accounts. The current production startup guard has no runtime MFA exception: any exception requires a separately reviewed code/config change. MFA assurance claim values must match the real IdP policy. | Evaluate for enterprise customers needing automated joiner/mover/leaver and group sync. Current repository snapshot has no SCIM endpoint/adapter identified; treat as not implemented, not as implicitly enabled. | IdP policy export, linked-identity lifecycle, verified cross-tenant denial, production role/secret/network evidence. |
| Customer-managed/self-hosted private deployment | Production API uses the customer-owned/approved IdP over HTTPS; offline/local development auth is not a production fallback. | Enforce at the customer's IdP and map actual amr/acr values into the API policy. A claim is accepted only when signed by the configured issuer; the current production guard will not start without MFA validation enabled. | Customer/owner decision: required when automated provisioning is in scope; otherwise record a reason and the manual lifecycle owner. Not available in this repo revision without a separate integration. | Customer-specific IdP, JWKS rotation, DNS/TLS/firewall and credential evidence, exact deployed SHA. |
| Single-tenant/on-premises factory with directory-managed workforce | Required unless the product owner has documented an alternative production identity boundary and approved the risk. | Required for remote/admin/browser logins. A machine credential must not be presented as a human MFA session. Offline exception must have owner, expiry and recovery procedure. | Often useful when the directory owns lifecycle, but applicability depends on the directory and commercial contract. Not available in this repo revision without a separate integration. | Segregation from OT networks, local break-glass account governance, offline incident path, revocation test. |
| OT/edge, PLC/SCADA gateway or disconnected site | Human control-plane login uses the approved IdP where reachable; service-to-service/device credentials need a separate identity design and constrained scope. | MFA applies to the human control plane; it does not replace device authentication or network segmentation. Offline exception must have owner, expiry and recovery procedure. | Usually an upstream identity-control-plane concern, not a device protocol. Explicitly decide applicability; do not let SCIM membership create factory permissions without a reviewed mapping. | No direct public route to OT/ICS, protocol-specific egress allowlist, local credential expiry and signed update/recovery plan. |
| Non-interactive worker/service integration | Use a workload identity/client-credentials mechanism with distinct identity, audience and permissions; never share a human operator session token. | Human MFA is not the control for machine-only identity. Document how the workload credential is constrained, rotated and revoked. | Usually not applicable to the workload credential itself; employee/group SCIM may still provision its human owners. | Dedicated service account, minimal endpoints/verbs, rotation evidence, audit actor binding and kill-switch test. |

### MFA claim configuration

The API validates the OIDC signature through the issuer's JWKS, token expiry, issuer, audience and RS256 algorithm before applying this policy. For production, the new startup guard requires AUTH_MODE=oidc, secure issuer/JWKS URLs, OIDC_REQUIRE_MFA=true, and a non-empty owner-reviewed OIDC_MFA_AMR_VALUES and/or OIDC_MFA_ACR_VALUES allowlist. The claim values are provider-specific: obtain real signed example tokens and the IdP policy from the owner and verify exact values before rollout. Never guess that mfa, otp, hwk or any sample value is emitted by a given IdP.

When MFA is required, a token is accepted only when one configured allowlisted amr value is present or the acr value exactly matches the configured allowlist. An absent/invalid claim fails closed. The API cannot make a non-MFA IdP enforce MFA; the IdP policy and emitted signed claims must be independently verified. Any machine identity that does not satisfy human MFA must use a separately reviewed authentication contract rather than a broad exception to the user path.

### SCIM applicability and implementation state

No SCIM provisioning route or adapter was found in the repository paths inspected for this change. Therefore the production register deliberately sets repository_implementation_present: false and applicability: OWNER_DECISION_REQUIRED. If SCIM is a contracted requirement, it is an unresolved product/security gap until a separate authenticated SCIM implementation is designed and tested. That implementation must include schema/version validation, idempotency, external-ID uniqueness, deactivate/delete semantics, signed/audited changes, rate limiting, tenant-bound mapping, safe group/role reconciliation and replay protection. Receiving an IdP group must never grant ORG_ADMIN or factory access without an owner-approved mapping. If SCIM is not required for the chosen topology, the accountable owner must record the accepted alternative lifecycle process and evidence.

## 3. Production configuration baseline

The provider-neutral attestation template is deploy/security/production-security-baseline.yml. Its initial status is intentionally NOT_ATTESTED; fill it with sanitized identifiers and evidence links only. Do not paste credentials, raw tokens, private keys, full connection strings or customer data into the file or a PR.

Required API authentication settings:

- NODE_ENV=production
- AUTH_MODE=oidc
- DEV_AUTH_ENABLED=false
- OIDC_ISSUER=https://<approved-idp-issuer>
- OIDC_AUDIENCE=<exact-api-audience>
- OIDC_JWKS_URI=https://<approved-idp-jwks-endpoint>
- OIDC_REQUIRE_MFA=true
- OIDC_MFA_AMR_VALUES and/or OIDC_MFA_ACR_VALUES, based on reviewed, signed IdP tokens and the IdP administrator's policy evidence.

Issuer/JWKS URLs must not contain embedded credentials or redirects to arbitrary hosts. Network policy must allow only the approved IdP/JWKS destinations. AUTH_MODE no longer silently falls back to development authentication in production. Unit tests cover production refusal of missing/dev mode, non-HTTPS OIDC endpoints, missing MFA policy and rejected MFA claims.

The API no longer needs a locally managed HS256 signing secret to validate upstream OIDC tokens. In OIDC mode the local JWT service is not given that development signing key; the development-token endpoint remains unavailable outside NODE_ENV=development plus DEV_AUTH_ENABLED=true. Do not enable development-token issuance in a production deployment.

## 4. Service and database identities

Each workload must have a distinct identity and purpose. Record role names, owner, allowed resources, credential source, lifetime, last rotation and revocation proof:

| Identity | Required boundary | Evidence |
|---|---|---|
| FactoryOS API runtime database user | NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS; only required schema/table/sequence/function grants. Must not own tenant tables or inherit a privileged/admin role. | Sanitized output of deploy/security/postgres-role-audit.sql, grants-versus-table-inventory review, negative tenant/RLS tests. |
| Migration/DDL runner | Distinct from runtime API role; elevated permissions only during a reviewed, time-bounded migration window. Use JIT/temporary credentials and remove/revoke after success or rollback. | Migration approval, temporary grants, exact SHA/manifest, actor/time audit and revoke evidence. |
| PostgreSQL/Prometheus monitoring | Distinct role, minimum statistics/lock visibility; no superuser, no BYPASSRLS, no general business-table access. | Read-only audit output, exporter endpoint and successful scrape evidence. |
| Backup/restore operator | Separate database service identities and separately controlled backup encryption/decryption key custody. Restore access is not an API runtime privilege. | Key-access log, checksum/restore rehearsal receipt and operator sign-off. |
| Deploy/secret-manager workload identity | Restrict read access to only the specific secrets/config it needs and only the intended environment. Prefer platform workload identity to long-lived cloud access keys. | IAM policy export, audit event and a denied-access test for another service/environment. |
| Human admin/reviewer | Named accounts with MFA, tenant/factory-scoped authorization, just-in-time elevation and attributable audit entries. No shared admin login. | IdP/MFA policy, access review, elevated-session log and deprovisioning test. |

Run deploy/security/postgres-role-audit.sql as an approved DBA with the actual runtime and migration role names. It is read-only and collects role attributes, inherited-role edges, direct table grants, schema grants, sequence-related usage grants and default ACL evidence. Review effective privileges, not only direct role flags; a role that inherits a superuser or RLS-bypass role is not least-privilege. Reconcile grants to the complete, current table/sequence/function inventory. Do not copy CI's superuser fixture into production.

## 5. Secrets manager and credential rotation

Production secret values must come from an approved secrets manager or platform-native secret mechanism. Inject them only into the container/process that needs them. No secret in source control, Docker build arguments, image layers, checked-in .env, workflow output, URL, metrics label or logs. Rotate if exposure is suspected; do not wait for the calendar interval.

Use this documented rotation runbook for each credential family:

1. Inventory secret identifier/version, owner, dependent services, current expiry/rotation window, break-glass owner and rollback/overlap limit. Record evidence references, not the values.
2. Approve a rotation window and change record. Create the new version without deleting the prior one; restrict who can read or activate it.
3. Test the new version against an isolated/canary workload. For database credentials, verify TLS certificate/hostname, connection-pool recycle, readiness, read/write transactions under RLS and connection-limit headroom.
4. Deploy the new version to all target replicas and workers. Verify authentication success, denied old/cross-environment credentials, audit events and health telemetry.
5. Revoke the previous credential after the agreed overlap window. Restart/force-refresh long-lived pools where required and prove an old credential can no longer authenticate. Do not leave an indefinite overlap.
6. If the new credential fails, revert the secret version reference only if the previous credential is still valid and not suspected compromised. Otherwise follow the incident/forward-fix process; never write old secrets into Git to roll back.
7. Attach UTC times, secret version IDs, target environment, candidate SHA, operator, approver, health/test result and revocation result. Redact raw secret values.

Rotation intervals must be selected by the owner and provider policy, not guessed in this template. Cover DB runtime credentials, temporary migration credentials, monitoring/backup credentials, cloud workload identities, OAuth client credentials when present, webhook/API integration secrets, backup encryption keys and issuer signing-key rotation. OIDC signing-key rotation must verify overlapping JWKS keys and the client's JWKS cache duration; the API must not pin a single long-lived public key or accept unsigned/untrusted keys.

## 6. Network, ingress and egress controls

deploy/security/network-egress-policy.yml is a provider-neutral proposed policy, not an applied firewall. Translate it to the actual cloud security groups/firewall, Kubernetes NetworkPolicy/CNI, service mesh or on-premises rules, then capture the active policy export and a live connectivity test.

Minimum boundary:

- Default-deny ingress and egress. Public traffic terminates at the approved WAF/load balancer or edge; API replicas and database have private listeners.
- PostgreSQL accepts traffic only from approved API/private subnets and a time-bounded migration runner. Require TLS certificate/hostname verification.
- Internal metrics scrapes and OTLP receiver traffic stay on private network paths and require authentication/TLS. Do not expose metrics, Grafana/Prometheus/Alertmanager administrative endpoints or the OTLP receiver directly to the public internet.
- API egress is limited to the database, approved DNS, secrets manager/workload-identity endpoint, configured OIDC issuer/JWKS, the approved telemetry backend, and explicitly enabled integration destinations. Keep feature-specific webhook/connector/device egress in reviewed allowlists; no blanket 0.0.0.0/0 outbound exception for business traffic.
- No public internet route to database or OT/ICS/PLC/SCADA networks. Segment IT, monitoring, backup and OT/edge zones. Allow only documented protocol/destination pairs from the gateway component that owns the relevant adapter.
- An exception requires business reason, exact source/destination/protocol, owner, security review, expiry UTC and a removal ticket. Wildcards and permanent "temporary" rules fail acceptance.

Evidence includes sanitized active rules, network diagram/zone ownership, actual resolved IdP/secret/backend/database endpoints, DNS/TLS validation, allowed route test and denied route test. A repository YAML template by itself is not evidence that a firewall is enforcing it.

## 7. Tenant-boundary negative tests

The release candidate must preserve both application authorization and PostgreSQL RLS. Run these tests on the exact candidate SHA against CI and an isolated pre-production deployment with only synthetic tenant data:

| Test | Expected result | Existing or added evidence |
|---|---|---|
| Request without a token / expired or invalid issuer, audience, signature or key ID | Denied; no protected data returned | JWT strategy validation + API guard tests; attach exact test result. |
| OIDC token lacks configured MFA amr/acr or has a non-allowlisted value | Authentication denied | auth-runtime-policy.spec.ts; independent reviewer must also test against a signed token from the real IdP. |
| Production boot with absent/dev/unknown AUTH_MODE, or MFA policy omitted | Process start fails closed | auth-runtime-policy.spec.ts and config contract. |
| Client spoofs X-User-Id or X-Tenant-Id | Verified token identity wins; spoofing cannot select another tenant | iam.controller.spec.ts and authorization tests. |
| Tenant A reads Tenant B ID/resource, export, receipt or audit row | Denied or indistinguishable not-found response according to route contract; no cross-tenant data in logs/metrics | Existing tenant-data transfer/isolation tests plus live synthetic tenant negative test. |
| Tenant A attempts write using Tenant B tenant_id / cross-tenant foreign key | Database/application rejects and transaction has no partial mutation | database-tenant-isolation.integration.spec.ts, governance matrix, PostgreSQL CI. |
| Query to forced-RLS table without tenant context | No tenant rows visible and writes fail | services/api/test/tenant-data-governance-inventory.sql, tenant isolation integration and RLS matrix. |
| Invalid/missing metrics scrape token | 401/404 and no metrics are emitted | internal-metrics.controller.spec.ts; deployed test must query from an untrusted network location too. |
| Monitoring identity reads tenant business data or has BYPASSRLS/superuser through inherited role | Security gate fails | postgres-role-audit.sql report and privilege review. |
| Revoked/old credential or identity from another environment attempts access | Authentication/connection rejected | Live rotation/revocation evidence from the provider/DB. |

Capture test case ID, candidate SHA, environment, UTC time, expected versus actual result, sanitized request/correlation ID, cleanup evidence and operator. Never attach access tokens, raw database rows or tenant-specific customer identifiers. Tests in GitHub CI do not replace live staging negative testing.

## 8. Independent security review record

### Record metadata

- **Review status:** PENDING_EXTERNAL_REVIEW
- **Candidate SHA:** <fill with exact PR head SHA>
- **Hosting/provider/environment:** <owner to fill>
- **Service owner / release approver:** <owner to fill>
- **Independent reviewer and organization:** <not assigned>
- **Conflict-of-interest check:** NOT_RUN
- **Written authorization/change reference:** <required before testing>
- **Execution UTC window:** <not run>
- **Independent report/artifact reference:** <not issued>

**Independent review has NOT been performed.** The initial engineering pass identified and implemented code-level guard changes; it is not a signed independent review and must not be counted as one.

### Bounded external review scope

The reviewer should receive the exact candidate SHA, deployment topology diagram, system owner contact, environment-only synthetic accounts for at least two tenants, an allowlisted target inventory and the remediation template. Suggested scope:

1. Static review of auth-mode startup guard, OIDC JWKS/issuer/audience/expiry validation, MFA claim enforcement, dev-token path, IAM authorization and identity-link lifecycle.
2. Authentication/authorization testing for spoofed tenant/user headers, alternate tenant selection, missing/invalid MFA claims, expired/revoked identities and role escalation.
3. Tenant-boundary negative testing of approved read/write/export/audit endpoints with synthetic tenant A/B; database RLS and effective role/grant inspection.
4. Production configuration review of runtime/migration/monitoring privileges, secret storage/rotation, public/private network boundaries, egress allowlists, metrics/telemetry exposure, backup key control and release/rollback procedure.
5. Dependency/secret exposure and CI/security workflow review with the candidate's exact lockfile and workflow evidence.
6. Retest fixes independently and issue a signed severity-ranked report with reproducible evidence, affected commit/component, impact, exploit preconditions, remediation status and residual risk.

### Explicit exclusions and test safety

Do not perform destructive data changes, unrestricted fuzzing, denial-of-service testing, social engineering, phishing, testing of third-party IdPs, production customer data access, OT device control or unapproved external connector calls. Those require separate written authorization and test windows. Penetration testing must target only the named environment and allowlisted hosts. A production exploit should not be used to prove a fix when a safe staging reproduction suffices. Preserve the logs and stop conditions in the review plan.

### Preliminary repository findings — implementation author, not independent findings

| ID | Initial observation | Remediation/evidence | Current closure state |
|---|---|---|---|
| PS-001 | Missing AUTH_MODE previously defaulted the API to development/HS256 auth; a production environment could appear configured without explicit OIDC mode. | Startup policy now rejects missing/unknown mode and any production dev mode; tests in auth-runtime-policy.spec.ts. | Code remedied on candidate branch; independent retest and deployed env proof pending. |
| PS-002 | OIDC validation previously did not require or check MFA assurance claims. | Production now requires OIDC_REQUIRE_MFA=true and a configured amr/acr allowlist; claim contract rejects missing/unmatched claims; tests included. | Code remedied but IdP policy/token evidence and independent verification pending. |
| PS-003 | Local Docker Compose published the dev PostgreSQL port on all host interfaces. | Port now binds to 127.0.0.1:5432; a contract test prevents an all-interface mapping. | Repository configuration remedied; confirm effective host/firewall and no other published DB route. |
| PS-004 | The repository alone cannot prove live production DB roles, secrets-manager bindings, credential rotation, or firewall/egress rules. | Role audit SQL, network policy template and production attestation register added. | Open deployment-evidence gate; no runtime roles or secret values verified in this chat. |
| PS-005 | No SCIM endpoint/adapter was identified in the inspected repository tree. | SCIM applicability is explicit owner decision; this document does not claim SCIM is implemented. | Open until owner either approves an alternative lifecycle or funds/accepts a separate SCIM implementation. |
| PS-006 | No independent external review report or target-environment penetration evidence was supplied. | Scope and report/finding templates documented here. | Open P1 release gate; external reviewer, authorization, execution and retest are pending. |

These are preliminary observations, not severity ratings issued by an independent assessor. The external reviewer may reclassify, add or reject findings. A code-level fix is not closed until the retest passes and its exact evidence reference is attached.

### Independent finding/remediation row template

For each finding, record: finding_id, title, severity (Critical/High/Medium/Low/Informational), affected component, affected candidate SHA, attack preconditions, impact, sanitized reproduction, report reference, owner, due date, remediation commit SHA, automated test URL, staging retest URL/result, residual risk/exception, approver and closure UTC. High/Critical findings must not be accepted by a developer alone. Any accepted exception requires a named risk owner, written rationale, compensating controls and expiry; overdue/unowned high-risk findings block release.

## 9. Rollback and release approval

### Automated evidence consistency check

The checked-in `deploy/security/production-security-baseline.yml` is an **unattested template only**. CI runs:

```sh
node scripts/security/validate-production-security-baseline.mjs --check-template
```

This fails if the shared template is edited to imply production approval, successful external tests, verified credentials, or reviewed network controls without operator evidence. Do not overwrite the template with live secrets or use a CI result as runtime attestation.

For a separate, access-controlled operator evidence copy, run the exact-candidate release gate:

```sh
node scripts/security/validate-production-security-baseline.mjs --release-gate /secure/path/production-security-attestation.yml <full-40-character-candidate-sha>
```

The validator checks that the declared candidate SHA matches the supplied immutable SHA, dependency-audit evidence refers to that same SHA, required identity/database/secrets/network controls have explicit outcomes, negative tests and independent-review evidence are complete, credential-overlap windows are valid, and operator/approver are different people. Missing, ambiguous, stale or contradictory evidence fails closed. A successful validator run means the supplied evidence is internally complete; it does not independently authenticate the report or replace release authority's review of the evidence.

Each of the seven tenant-boundary negative-test records must now contain a structured evidence object with:
- `result: PASS`;
- the full candidate `candidate_sha`, exactly equal to the release-gate argument;
- `workflow_url` identifying a GitHub Actions run in this repository;
- an opaque `evidence_reference` without embedded credentials;
- a named `tested_environment`; and
- a valid, non-future UTC `executed_at_utc`.

A bare `PASS` string is not an acceptable evidence record. This validation checks the claims' shape and SHA binding only; an operator and independent reviewer must still open the linked run/artifact, verify that the named test ran and passed in the stated environment, and confirm sanitized evidence is retained. Never create a reference or timestamp just to satisfy the validator, and never add tokens, customer data, or raw production rows to the attestation.


The release remains blocked until all applicable items are supported by evidence:

- [ ] Exact candidate SHA recorded and applicable API/PostgreSQL/Web/security CI passes.
- [ ] Owner-approved topology and OIDC/MFA/SCIM applicability decisions recorded.
- [ ] Production authentication mode, issuer/audience/JWKS TLS, MFA IdP policy and signed claim evidence verified.
- [ ] Runtime, monitoring, migration and backup identities audited; effective privileges contain no unintended superuser/DB creation/role creation/RLS-bypass grants.
- [ ] Secret manager binding and rotation/revocation evidence complete for all deployed identities.
- [ ] Active ingress/egress rules and denied-route tests match the approved network diagram.
- [ ] Tenant-boundary negative tests pass in isolated pre-production and evidence is tied to the candidate SHA.
- [ ] Independent reviewer report exists; every High/Critical finding is independently retested and closed or formally excepted by the accountable risk owner.
- [ ] Rollback/forward-fix decision, target artifact, compatible database recovery path, operator, approver and rollback drill evidence recorded.
- [ ] Separate release approval is signed after reviewing the evidence; do not infer approval from CI status.

Rollback must cover application config and secret-version references, not only the container image. For schema changes, use the reviewed migration/backup restore decision tree; do not automatically reverse arbitrary business-data migrations. If an identity-provider, secret or certificate rollback credential is suspected compromised, revoke it instead of re-enabling it.

### Final approval register

- release_approved: false
- owner_approved_slo_or_security_exception_reference: <blank until approved>
- independent_review_report_reference: <pending>
- high_critical_findings_closed: false
- operator: <pending>
- approver: <pending>
- approval_utc: <pending>

The approval register must be updated only by authorized release personnel once evidence is complete. Do not mark the release approved from the implementation branch or this report draft.


## 10. Backup-copy evidence volume deployment gate

Signed backup-copy-class evidence is accepted only when the API can read exact evidence bytes from a deployment-owned Linux read-only mount. POSIX mode checks and the runtime `/proc/self/mountinfo` per-mount `ro` check are necessary runtime controls, but production provisioning must also prevent the API identity from writing to or remounting that volume. The evidence publisher must be a separate identity and the volume reference must identify the exact immutable evidence source.

For Kubernetes v1.30+, install the `ValidatingAdmissionPolicy` and `ValidatingAdmissionPolicyBinding` in `deploy/security/backup-copy-evidence-readonly-policy.yaml` and `deploy/security/backup-copy-evidence-readonly-binding.yaml`. Label the intended production API namespace `factoryos.io/backup-evidence-enforcement=required` only after the policy has been accepted and the binding is installed; restart all API Pods so they are re-admitted under the policy. The policy enforces one direct absolute evidence-root environment path backed by the dedicated `factoryos-backup-evidence` PVC, requires source-level and container-mount read-only flags, forbids subPath, and checks that no regular/init/ephemeral container in the selected production namespace reuses the PVC read-write. It also requires non-root execution, a read-only container root filesystem, no privilege escalation/privileged mode, and dropped capabilities. The publisher must stage evidence outside the API namespace/workload. The manifest requires Kubernetes v1.30+; a different platform needs an equivalent enforced workload control.

The release validator now requires a populated `backup_copy_evidence` record: deployment platform, absolute non-root evidence path, evidence-volume reference, enforcement-policy reference, read-only mount proof, denial of API write/remount privileges, separate publisher identity, and a runtime mount-verification record tied to the exact candidate SHA and a repository Actions run. The checked-in template keeps these fields empty/false/NOT_RUN. Do not turn them into passing values without independently reviewed deployment evidence. CI validates policy/configuration contracts; it does not apply the policy to a live cluster or attest an actual production mount.
