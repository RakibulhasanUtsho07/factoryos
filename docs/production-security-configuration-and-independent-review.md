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
| Vendor-hosted multi-tenant SaaS with human users | Required for production interactive authentication; issuer, audience and JWKS URI are environment-specific and HTTPS. | Required for human interactive accounts. The current production startup guard has no runtime MFA exception: any exception requires a separately reviewed code/config change. MFA assurance claim values must match the real IdP policy. | Owner must decide whether full SCIM lifecycle/group sync is in the enterprise contract. Repository now contains an opt-in Users PATCH deprovision-only receiver; it is not full SCIM provisioning/group sync. Keep disabled until real IdP integration and staging verification. | IdP policy export, linked-identity lifecycle, verified cross-tenant denial, production role/secret/network evidence. |
| Customer-managed/self-hosted private deployment | Production API uses the customer-owned/approved IdP over HTTPS; offline/local development auth is not a production fallback. | Enforce at the customer's IdP and map actual amr/acr values into the API policy. A claim is accepted only when signed by the configured issuer; the current production guard will not start without MFA validation enabled. | Customer/owner decision: required when automated provisioning is in scope; otherwise record a reason and the manual lifecycle owner. Not available in this repo revision without a separate integration. | Customer-specific IdP, JWKS rotation, DNS/TLS/firewall and credential evidence, exact deployed SHA. |
| Single-tenant/on-premises factory with directory-managed workforce | Required unless the product owner has documented an alternative production identity boundary and approved the risk. | Required for remote/admin/browser logins. A machine credential must not be presented as a human MFA session. Offline exception must have owner, expiry and recovery procedure. | Often useful when the directory owns lifecycle, but applicability depends on the directory and commercial contract. Not available in this repo revision without a separate integration. | Segregation from OT networks, local break-glass account governance, offline incident path, revocation test. |
| OT/edge, PLC/SCADA gateway or disconnected site | Human control-plane login uses the approved IdP where reachable; service-to-service/device credentials need a separate identity design and constrained scope. | MFA applies to the human control plane; it does not replace device authentication or network segmentation. Offline exception must have owner, expiry and recovery procedure. | Usually an upstream identity-control-plane concern, not a device protocol. Explicitly decide applicability; do not let SCIM membership create factory permissions without a reviewed mapping. | No direct public route to OT/ICS, protocol-specific egress allowlist, local credential expiry and signed update/recovery plan. |
| Non-interactive worker/service integration | Use a workload identity/client-credentials mechanism with distinct identity, audience and permissions; never share a human operator session token. | Human MFA is not the control for machine-only identity. Document how the workload credential is constrained, rotated and revoked. | Usually not applicable to the workload credential itself; employee/group SCIM may still provision its human owners. | Dedicated service account, minimal endpoints/verbs, rotation evidence, audit actor binding and kill-switch test. |

### MFA claim configuration

The API validates the OIDC signature through the issuer's JWKS, token expiry, issuer, audience and RS256 algorithm before applying this policy. For production, the new startup guard requires AUTH_MODE=oidc, secure issuer/JWKS URLs, OIDC_REQUIRE_MFA=true, and a non-empty owner-reviewed OIDC_MFA_AMR_VALUES and/or OIDC_MFA_ACR_VALUES allowlist. The claim values are provider-specific: obtain real signed example tokens and the IdP policy from the owner and verify exact values before rollout. Never guess that mfa, otp, hwk or any sample value is emitted by a given IdP.

When MFA is required, a token is accepted only when one configured allowlisted amr value is present or the acr value exactly matches the configured allowlist. An absent/invalid claim fails closed. The API cannot make a non-MFA IdP enforce MFA; the IdP policy and emitted signed claims must be independently verified. Any machine identity that does not satisfy human MFA must use a separately reviewed authentication contract rather than a broad exception to the user path.

### SCIM applicability and implementation state

The repository now contains a narrow, opt-in SCIM 2.0 Users PATCH deprovision receiver. It accepts only one replace active=false operation for a pre-linked auth_identities.id, authenticated by a tenant-bound high-entropy bearer credential whose SHA-256 digest alone is stored. The configured credential issuer must exactly match the linked identity issuer. The handler sets only the selected tenant_memberships row to REMOVED and commits the SCIM_DEPROVISION audit event in the same database transaction. The global user, external identity row and sibling-tenant memberships are not disabled or deleted. Replays are idempotent. The API checks active user/identity/membership state on each authenticated request, so the same still-unexpired OIDC access token is denied on the next API request for the deprovisioned tenant; this is API authorization revocation, not IdP session revocation or proof the upstream event was delivered.

This adapter is not full SCIM: it does not implement POST/PUT/GET/List/DELETE, group resources, group-to-role mapping, initial user provisioning, mover/attribute sync, IdP user-session logout, or identity-wide/global account disable. It is disabled unless SCIM_ENABLED=true; owner decision remains OWNER_DECISION_REQUIRED. If enterprise requirements include joiner/mover/group sync or global IdP deactivation semantics, those remain an explicit gap requiring separate reviewed scope. The production baseline flag repository_implementation_present: true describes only this limited adapter's presence; it does not imply full SCIM acceptance.

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
| PS-005 | No SCIM lifecycle integration existed; enterprise applicability was not decided. | Added optional tenant-bound SCIM Users PATCH deprovision-only adapter, hashed credential provisioning/rotation, idempotent membership removal and transactional audit. It does not provide full SCIM provisioning, group sync or global IdP logout. | Partially remedied in code; applicability, real IdP interoperability, live propagation, secret-manager binding and owner acceptance remain OPEN. |
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


## AWS ElastiCache Redis OSS / Valkey backup inventory reader

The ElastiCache inventory uses a separate `FactoryOSElasticacheBackupReader` identity. The checked-in policy template `deploy/aws/elasticache-redis-backup-inventory-reader-role-policy.template.json` allows only `elasticache:DescribeCacheClusters`, `elasticache:DescribeReplicationGroups`, `elasticache:DescribeGlobalReplicationGroups`, `elasticache:DescribeSnapshots`, `elasticache:DescribeServerlessCaches` and `elasticache:DescribeServerlessCacheSnapshots`, and explicitly denies other actions. The matching trust template requires the designated source role and a unique ExternalId. The source-role policy template allows assumption of only that dedicated role across the AWS partitions represented in the file.

The API requires already-assumed temporary credentials and verifies STS `GetCallerIdentity` against the exact account and reader-role name before ElastiCache requests. It captures no endpoints, cache content, security-group details, parameter values, credentials or raw descriptions. Node-based Marker and Serverless NextToken pagination use a bounded shared request/page/item budget; repeated or malformed continuation values fail closed. Review the actual provisioned role trust, permissions boundary, SCP and session policy independently; the checked-in templates are not deployment evidence.

This slice covers node-based Redis OSS/Valkey and ElastiCache Serverless cache/snapshot API catalogs (including Serverless Memcached metadata). Snapshot name/create-time or provider-ARN references are correlation identities only, not delete selectors or deletion authority. Self-managed Redis/Valkey AOF/RDB files, EBS/filesystem/volume backup chains, copied/exported snapshots, AWS Backup recovery points and external DR copies remain outside this adapter. The output permanently leaves `whole_cache_backup_coverage_complete` and all deletion flags false.

**Independent review and production staging remain pending.** A successful mocked test suite is not evidence that AWS roles were provisioned, all enabled accounts/regions were scanned, cache snapshots were restored, Global Datastore replicas were restored/failover-tested, or external copies were discovered.


## AWS Backup inventory reader identity (read-only)

The policy allows only `ListBackupVaults`, `DescribeBackupVault`, `ListRecoveryPointsByBackupVault`, `ListLegalHolds`, `GetLegalHold`, `ListRecoveryPointsByLegalHold`, `ListRestoreAccessBackupVaults`, `ListCopyJobs`, `DescribeCopyJob` and STS `GetCallerIdentity`, and explicitly denies all other actions.

The adapter requires temporary credentials from the already-assumed role and validates the exact account and assumed-role name through STS before AWS Backup API calls. It captures vault type/state, Vault Lock/encryption settings, recovery-point lifecycle/encryption/source-vault metadata and legal-hold associations without retaining free-form legal-hold descriptions. No backup job start/copy/restore/delete, vault mutation, legal-hold create/cancel, tag or KMS operation is implemented.

The reader policy scopes vault-read actions to approved backup-vault ARNs and legal-hold reads to approved legal-hold ARNs. Copy-job list/detail operations use Resource: "*" because AWS publishes no resource type for `ListCopyJobs` / `DescribeCopyJob`; the explicit `NotAction` deny allowlist remains. The source-role policy uses explicit target-account role ARNs rather than wildcard account matching.

## AWS Backup copy-job reader permissions

The `FactoryOSAwsBackupInventoryReader` policy also includes `backup:ListCopyJobs` and `backup:DescribeCopyJob` to inventory managed backup-copy attempts and their source/destination vault and recovery-point references. AWS does not define a resource-level ARN type for either action, so both read-only permissions necessarily use `Resource: "*"`; they are explicitly listed in the `NotAction` deny allowlist. This does not broaden the policy to copy creation, restore, deletion, vault mutation, or legal-hold mutation. Independently verify the deployed policy after interpolation and the effective SCP, permissions boundary, session policy and trust-chain result.

AWS Backup removes terminal copy-job records 30 days after they finish; `copy_job_terminal_record_retention_days: 30` is exposed in the result and must not be interpreted as lifetime history. A separate retained audit/event pipeline is required for longer-term historical evidence. Every source and destination account/Region still requires its own STS-verified inventory scope and approved reader role. For AWS Backup cross-account monitoring, verify the opt-in state and activation time; the aggregate API view does not retroactively guarantee jobs created before monitoring was enabled. Reconcile destination recovery points under the destination account's role, including their independent encryption, retention, legal-hold and restore controls. A `COMPLETED` copy job does not prove a successful restore or that all copies were inventoried.

## AWS Backup copy-job history retention infrastructure

The companion templates are `deploy/aws/aws-backup-copy-job-eventbridge-archive.template.json` (per account/Region) and `deploy/aws/aws-backup-copy-job-cloudtrail-audit.template.json` (one multi-Region trail per account). The former retains direct Copy Job State Change events with EventBridge RetentionDays 0; the latter records read/write management events, enables CloudTrail log-file validation, and writes to an S3 bucket with versioning, customer-managed KMS encryption, and default Object Lock Compliance retention.

The CloudTrail archive duration is a mandatory parameter with no default. An authorized data/security/legal owner must approve the retention schedule before deployment because Compliance mode blocks deletion or shortening of protected object versions until their retention expires. The KMS key is separately provisioned; review its key policy, CloudTrail GenerateDataKey/DescribeKey access, S3 use, key deletion/disablement controls, and home-Region binding. The bucket and trail templates retain the bucket when the stack is deleted/replaced, but infrastructure administrators, KMS administrators, CloudTrail stop/delete permissions and EventBridge archive delete/retention permissions remain explicit independent trust boundaries. Guard and monitor those privileged paths.

EventBridge and CloudTrail service event delivery are best effort. CloudTrail digest validation uses its per-Region signed digest chain; enabling log-file validation only makes digest files available and does not execute validation. CloudTrail logs are unordered, EventBridge archive replay can be out of order, and a regional archive only covers events received after archive creation. Capture a deployment baseline before the API's 30-day ListCopyJobs view expires and export the available 90-day CloudTrail Event history where eligible; record archive creation, trail start and first successful log/digest delivery timestamps. No archive or trail in these templates retroactively populates earlier time ranges. Perform the cold-start ListCopyJobs and available 90-day CloudTrail Event history baseline, record the exact activation and first verified delivery times, validate digest chains continuously, and retain gaps/reconciliation results. A green template-contract workflow is not evidence of live delivery, valid digests, or immutable provider storage.

**Acceptance boundary:** current tests use mocked AWS responses. Live role provisioning, cross-account monitoring configuration, effective IAM review, organization/Region scope enumeration and provider-backed copy/restore rehearsals remain pending. No production-copy or deletion permission is granted.

## Audit retention SCP guardrail

The companion `deploy/aws/aws-backup-copy-job-audit-retention-guardrail-scp.template.json` contains exact-resource deny fences for archive deletion/retention changes, CloudTrail stop/delete/configuration changes, S3 audit-bucket lifecycle/Object Lock/policy/versioning/encryption changes and KMS key disablement/deletion/policy/grant revocation. The only exception is an exact same-account break-glass role ARN; account IDs and role names are never wildcards. The policy denies these changes; it grants no permissions.

A cloud Organization administrator must interpolate the deployed archive/trail/bucket/key identities, review the exception role, enable SCP policy type, and attach the policy to every relevant member account or OU. Repository CI does not attach it. SCPs do not restrict the Organizations management account or service-linked roles; authorized Organizations management administrators can detach or edit SCPs. Management-account governance, SCP attachment rights, break-glass trust/MFA/approval and use alerts require separate review. The exception identity is an emergency pathway; its use invalidates the affected evidence period until the retention controls are revalidated.


## AWS Backup retained-history read-back

docs/aws-backup-copy-job-audit-reconciliation.md documents the isolated EventBridge FilterArns replay path, encrypted SQS capture/DLQ, CloudTrail standard/backfill digest validation, exact S3 version read-back, live trail/bucket/KMS/retention checks, source-ID deduplication and detached Ed25519 owner attestation. The scripts are operator-run and do not mutate backup or CloudTrail objects. No live AWS stack deployment, digest verification, replay, or independent owner acceptance has occurred; those remain explicit external release gates.


## AWS ElastiCache Serverless cache and snapshot inventory

The dedicated ElastiCache reader policy now includes only the six node-based and Serverless Describe actions: `DescribeCacheClusters`, `DescribeReplicationGroups`, `DescribeGlobalReplicationGroups`, `DescribeSnapshots`, `DescribeServerlessCaches`, and `DescribeServerlessCacheSnapshots`. The adapter exhausts node-based Marker and Serverless NextToken pagination under a shared bounded request/page/item budget, with STS identity checks and fail-closed repeated-token handling.

The inventory records Serverless cache metadata and provider snapshot ARNs, but the ARN digest is only a correlation reference. It is not a provider delete selector. Self-managed AOF/RDB/volume backups, exported/copied snapshots, AWS Backup recovery points and external DR copies remain separate uncovered surfaces. The feature is mocked repository evidence only; live role provisioning, effective-policy review, complete account/region proof and restore/failover acceptance remain pending.


## AWS Backup inventory reader identity (read-only)

The WP10 AWS Backup inventory uses a separate `FactoryOSAwsBackupInventoryReader` assumed role. Its policy template is `deploy/aws/aws-backup-vault-recovery-point-inventory-reader-role-policy.template.json`; the trust and source-role templates are adjacent. The policy allows only `ListBackupVaults`, `DescribeBackupVault`, `ListRecoveryPointsByBackupVault`, `ListLegalHolds`, `GetLegalHold`, `ListRecoveryPointsByLegalHold`, `ListRestoreAccessBackupVaults` and STS `GetCallerIdentity`, and explicitly denies all other actions.

The adapter requires temporary credentials from the already-assumed role and validates the exact account and assumed-role name through STS before AWS Backup API calls. It captures vault type/state, Vault Lock/encryption settings, recovery-point lifecycle/encryption/source-vault metadata and legal-hold associations without retaining free-form legal-hold descriptions. No backup job start/copy/restore/delete, vault mutation, legal-hold create/cancel, tag or KMS operation is implemented.

The reader policy scopes vault-read actions to approved backup-vault ARNs and legal-hold reads to approved legal-hold ARNs; only account/Region-wide list discovery and STS caller-identity verification use Resource: "*". The source-role policy uses explicit target-account role ARNs rather than wildcard account matching. The checked-in IAM policy and trust files are examples, not proof of effective production permissions. Before enablement, the cloud owner must provision and independently review the actual trust, ExternalId, permission boundaries, SCP/session-policy interactions, organization controls and every enabled account/Region. Repository CI and mocked responses do not constitute live restore, copy or deletion acceptance.


## AWS Backup copy-job reader permissions

The `FactoryOSAwsBackupInventoryReader` policy also includes `backup:ListCopyJobs` and `backup:DescribeCopyJob` to inventory managed backup-copy attempts and their source/destination vault and recovery-point references. AWS does not define a resource-level ARN type for either action, so both read-only permissions necessarily use `Resource: "*"`; they are explicitly listed in the `NotAction` deny allowlist. This does not broaden the policy to copy creation, restore, deletion, vault mutation, or legal-hold mutation. Independently verify the deployed policy after interpolation and the effective SCP, permissions boundary, session policy and trust-chain result.

AWS Backup removes terminal copy-job records 30 days after they finish; `copy_job_terminal_record_retention_days: 30` is exposed in the result and must not be interpreted as lifetime history. A separate retained audit/event pipeline is required for longer-term historical evidence. Every source and destination account/Region still requires its own STS-verified inventory scope and approved reader role. For AWS Backup cross-account monitoring, verify the opt-in state and activation time; the aggregate API view does not retroactively guarantee jobs created before monitoring was enabled. Reconcile destination recovery points under the destination account's role, including their independent encryption, retention, legal-hold and restore controls. A `COMPLETED` copy job does not prove a successful restore or that all copies were inventoried.

**Acceptance boundary:** current tests use mocked AWS responses. Live role provisioning, cross-account monitoring configuration, effective IAM review, organization/Region scope enumeration and provider-backed copy/restore rehearsals remain pending. No production-copy or deletion permission is granted.


## AWS Backup copy-job history retention infrastructure

The companion templates are `deploy/aws/aws-backup-copy-job-eventbridge-archive.template.json` (per account/Region) and `deploy/aws/aws-backup-copy-job-cloudtrail-audit.template.json` (one multi-Region trail per account). The former retains direct Copy Job State Change events with EventBridge RetentionDays 0; the latter records read/write management events, enables CloudTrail log-file validation, and writes to an S3 bucket with versioning, customer-managed KMS encryption, and default Object Lock Compliance retention.

The CloudTrail archive duration is a mandatory parameter with no default. An authorized data/security/legal owner must approve the retention schedule before deployment because Compliance mode blocks deletion or shortening of protected object versions until their retention expires. The KMS key is separately provisioned; review its key policy, CloudTrail GenerateDataKey/DescribeKey access, S3 use, key deletion/disablement controls, and home-Region binding. The bucket and trail templates retain the bucket when the stack is deleted/replaced, but infrastructure administrators, KMS administrators, CloudTrail stop/delete permissions and EventBridge archive delete/retention permissions remain explicit independent trust boundaries. Guard and monitor those privileged paths.

EventBridge and CloudTrail service event delivery are best effort. CloudTrail digest validation uses its per-Region signed digest chain; enabling log-file validation only makes digest files available and does not execute validation. CloudTrail logs are unordered, EventBridge archive replay can be out of order, and a regional archive only covers events received after archive creation. Capture a deployment baseline before the API's 30-day ListCopyJobs view expires and export the available 90-day CloudTrail Event history where eligible; record archive creation, trail start and first successful log/digest delivery timestamps. No archive or trail in these templates retroactively populates earlier time ranges. Perform the cold-start ListCopyJobs and available 90-day CloudTrail Event history baseline, record the exact activation and first verified delivery times, validate digest chains continuously, and retain gaps/reconciliation results. A green template-contract workflow is not evidence of live delivery, valid digests, or immutable provider storage.

**Acceptance boundary:** current templates and tests are mocked repository contracts. The retention archive, CloudTrail trail, KMS key and SCP are not deployed or independently validated in a real AWS account. No production-copy or deletion permission is granted.

## Audit retention SCP guardrail

The companion `deploy/aws/aws-backup-copy-job-audit-retention-guardrail-scp.template.json` contains exact-resource deny fences for archive deletion/retention changes, CloudTrail stop/delete/configuration changes, S3 audit-bucket lifecycle/Object Lock/policy/versioning/encryption changes and KMS key disablement/deletion/policy/grant revocation. The only exception is an exact same-account break-glass role ARN; account IDs and role names are never wildcards. The policy denies these changes; it grants no permissions.

A cloud Organization administrator must interpolate the deployed archive/trail/bucket/key identities, review the exception role, enable SCP policy type, and attach the policy to every relevant member account or OU. Repository CI does not attach it. SCPs do not restrict the Organizations management account or service-linked roles; authorized Organizations management administrators can detach or edit SCPs. Management-account governance, SCP attachment rights, break-glass trust/MFA/approval and use alerts require separate review. The exception identity is an emergency pathway; its use invalidates the affected evidence period until the retention controls are revalidated.


## AWS Backup retained-history read-back

`docs/aws-backup-copy-job-audit-reconciliation.md` documents the isolated EventBridge `FilterArns` replay path, encrypted SQS capture/DLQ, CloudTrail standard/backfill digest validation, exact S3 version read-back, live trail/bucket/KMS/retention checks, source-ID deduplication and detached Ed25519 owner attestation. The scripts are operator-run and do not mutate backup or CloudTrail objects. No live AWS stack deployment, digest verification, replay, or independent owner acceptance has occurred; those remain explicit external release gates.

## 10. Backup-copy evidence volume deployment gate

Signed backup-copy-class evidence is accepted only when the API can read exact evidence bytes from a deployment-owned Linux read-only mount. POSIX mode checks and the runtime `/proc/self/mountinfo` per-mount `ro` check are necessary runtime controls, but production provisioning must also prevent the API identity from writing to or remounting that volume. The evidence publisher must be a separate identity and the volume reference must identify the exact immutable evidence source.

For Kubernetes v1.30+, install the `ValidatingAdmissionPolicy` and `ValidatingAdmissionPolicyBinding` in `deploy/security/backup-copy-evidence-readonly-policy.yaml` and `deploy/security/backup-copy-evidence-readonly-binding.yaml`. Label the intended production API namespace `factoryos.io/backup-evidence-enforcement=required` only after the policy has been accepted and the binding is installed; restart all API Pods so they are re-admitted under the policy. The policy enforces one direct absolute evidence-root environment path backed by the dedicated `factoryos-backup-evidence` PVC, requires source-level and container-mount read-only flags, forbids subPath, and checks that no regular/init/ephemeral container in the selected production namespace reuses the PVC read-write. It also requires non-root execution, a read-only container root filesystem, no privilege escalation/privileged mode, and dropped capabilities. The publisher must stage evidence outside the API namespace/workload. The manifest requires Kubernetes v1.30+; a different platform needs an equivalent enforced workload control.

The release validator requires both the application evidence record and a separate `backup_copy_evidence.deployment_provisioning` record. The deployment record is exact-candidate-SHA-bound and requires accepted policies, active Deny bindings, namespace enrollment, a fully observed/updated/available Deployment, a bound read-only PVC, every container security context, tokenless ServiceAccount, API-identity RBAC absence across namespaces, an immutable sha256-pinned API image with matching per-Pod runtime imageID, per-replica write-denial and remount-capability evidence, negative admission probes, and a distinct infrastructure reviewer. The checked-in template keeps these fields empty/false/NOT_RUN. Do not turn them into passing values without operator-run evidence and independent review. CI validates policy/configuration contracts; it does not apply the policy to a live cluster or attest an actual production mount.

## Admission policy lock and deployment provisioning

The evidence namespace uses four fail-closed Kubernetes v1.30+ ValidatingAdmissionPolicies: read-only Pod/PVC enforcement, dedicated tokenless ServiceAccount protection, denial of legacy ServiceAccount-token Secrets, and namespace enrollment lock. Four Deny bindings activate the controls; the API's dedicated ServiceAccount has `automountServiceAccountToken: false`. All Pod containers (regular, init and ephemeral) must be non-root, no-escalation, read-only-rootfs, drop all capabilities, add none, avoid unmasked proc and use RuntimeDefault seccomp. Evidence PVC aliases must remain read-only with no subPath or mount propagation.

Use the single operator provisioning entry point rather than the earlier two-policy manual sequence:

```sh
EXPECTED_KUBE_CONTEXT=prod-eu-1 \
API_NAMESPACE=factoryos-api \
API_DEPLOYMENT=factoryos-api \
API_CONTAINER=api \
CANDIDATE_SHA="$(git rev-parse HEAD)" \
PROVISIONING_EVIDENCE_OUTPUT=./backup-evidence-provisioning.json \
./deploy/security/provision-backup-copy-evidence-enforcement.sh
```

See [Backup evidence volume deployment provisioning](backup-copy-evidence-deployment-provisioning.md) for the required Deployment annotation/PVC shape, preflight, rollout and per-replica runtime probes, the expected negative admission results, and the evidence-handling procedure. It checks every Ready API Pod carries the exact candidate SHA and probes each replica's real mount namespace.

The provisioner output is operator-run evidence, not independent infrastructure approval. A separate reviewer must inspect policy/binding protection, CSI/storage configuration, node and privileged host/storage-administrator boundaries, IAM roles and audit logs. A cluster administrator who can change the admission policies/bindings or underlying storage remains outside the API-process guarantee. Real-provider staging and full backup/copy class and writer-principal enumeration remain separate release blockers.


## SCIM deprovision-only integration and staging acceptance

### Runtime scope

The opt-in route is PATCH /api/scim/v2/Users/{auth_identity_id}. It accepts the SCIM PatchOp schema with exactly one replace active=false operation. Other operations fail closed. A credential is scoped to exactly one tenant and one issuer; its bearer format is fos_scim_<tenant-uuid>.<256-bit-random-secret>. The database stores only SHA-256, applies forced row-level security to credential rows, and rejects expired/revoked credentials. The SCIM controller bypasses the FactoryOS response envelope and returns application/scim+json.

Before use, apply migration 230_scim_tenant_deprovision_credentials.sql. The runtime API database role needs only the following column privileges on the new table; run as an approved DBA, substituting the actual API role:

    GRANT SELECT (tenant_id, issuer, token_sha256, scopes, status, expires_at)
      ON public.scim_provisioning_credentials TO factoryos_app;
    GRANT UPDATE (last_used_at)
      ON public.scim_provisioning_credentials TO factoryos_app;

Do not grant INSERT, DELETE, TRUNCATE or ownership of this table to the API runtime identity. The separately controlled provisioning identity needs only its approved INSERT/SELECT/UPDATE privileges and must not be reused as the application runtime role.

### Provision and rotate the SCIM bearer

Set SCIM_ENABLED=true only after the owner approves the topology and IdP integration. Run scripts/security/create-scim-provisioning-credential.mjs from a trusted operator host with SCIM_PROVISIONING_TENANT_ID (active tenant UUID), SCIM_PROVISIONING_ISSUER (exact credential-free HTTPS issuer), SCIM_PROVISIONING_DATABASE_URL (restricted provisioning-role DSN with sslmode=verify-full), and SCIM_PROVISIONING_TOKEN_OUTPUT_FILE (absolute path under a private runner-owned mode-0700 tmpfs directory). Optional SCIM_PROVISIONING_EXPIRES_AT_UTC is limited to 90 days. To rotate, also supply SCIM_PROVISIONING_PREVIOUS_TOKEN; old-credential revocation and new digest insertion are one transaction.

The utility writes the raw token only once to a create-only mode-0600 file; stdout includes only credential ID and token digest. Transfer it directly into the tenant's approved secret manager/IdP SCIM credential field, verify it, then securely remove the transient file. Never place the raw token in command-line arguments, CI logs, GitHub issues, artifacts or source control.

### Real IdP signed-token and propagation test

Use a non-production IdP and two synthetic FactoryOS tenants to which the same pre-linked FactoryOS user belongs. Configure the IdP to issue a real RS256-signed access token for the exact issuer/audience with an owner-approved MFA AMR/ACR value. Keep it valid for the entire propagation window plus 30 seconds and store it only in the restricted runner's secret manager/environment as OIDC_STAGING_BEARER_TOKEN.

1. Run scripts/security/verify-oidc-deprovisioning.mjs with PHASE=before, exact candidate SHA, staging API origin, issuer/audience/JWKS URL, approved MFA allowlist, target tenant and sibling tenant. Save create-only EVIDENCE_OUTPUT and BASELINE_EVIDENCE_PATH. The helper fetches HTTPS JWKS with redirects rejected, verifies RS256 signature/kid/issuer/audience/time claims and MFA, then requires the same token to authenticate /api/auth/me in both tenants.
2. In the actual IdP administration plane, remove/deactivate the test user from the target tenant assignment and let its SCIM connector issue PATCH to /api/scim/v2/Users/{prelinked-auth-identity-id} with active=false. Record the actual IdP audit-event reference and UTC event time. The test event must be tenant-specific; a global user deactivation has different cross-tenant semantics and requires separate approved testing.
3. Run the helper again using the same still-valid signed access token and baseline with PHASE=after, SCIM_DEPROVISION_EVENT_REFERENCE, SCIM_DEPROVISIONED_AT_UTC and owner-approved SCIM_MAX_PROPAGATION_SECONDS (1–3600). It polls target /api/auth/me until the original token returns 401, then verifies sibling returns 200 for the same FactoryOS user. Evidence binds token/subject hashes, issuer/audience/kid, MFA verification, candidate SHA, IdP event reference/time and observed propagation latency. The bearer token and raw subject are never stored.
4. Independently query staging as a read-only DBA to confirm target membership REMOVED, sibling membership ACTIVE, global user and linked identity preserved, and exactly one AUTH_IDENTITY / SCIM_DEPROVISION audit record exists for the target membership. Retain sanitized output and the IdP event record with signed evidence. Also test expired/wrong-issuer/wrong-audience/missing-MFA OIDC tokens, expired/revoked/wrong-tenant SCIM credentials, wrong-tenant identity IDs, duplicate events and unsupported PATCH operations; all negative cases must fail closed.

DEPROVISION_VERIFIED is a technical result for this bounded tenant-scoped contract only. It does not establish IdP-wide session logout, token revocation in other tenants, group lifecycle or provider event-delivery SLA. If the IdP performs a global user disable, the owner must separately define and test whether every tenant membership and downstream workload identity is disabled.

## 12. Protected staging OIDC and deprovision acceptance workflow

The manual workflow `.github/workflows/production-identity-deprovisioning.yml` provides a two-run staging procedure for the real signed-token and tenant-scoped API authorization check. It is gated by the protected GitHub Environment `production-security-staging`, uses read-only GitHub Actions permissions, checks out the exact candidate SHA, and refuses to run unless the environment variable `AS133_STAGING_DEPLOYED_SHA` matches the candidate SHA recorded for the staging deployment.

Configure the following non-secret environment variables only after the staging deployment and IdP policy have been independently checked:

- `AS133_STAGING_API_ORIGIN`: HTTPS origin of the staging API.
- `AS133_STAGING_DEPLOYED_SHA`: exact commit deployed to that staging API.
- `AS133_OIDC_ISSUER`, `AS133_OIDC_AUDIENCE`, `AS133_OIDC_JWKS_URI`: exact IdP issuer, API audience and HTTPS JWKS endpoint.
- `AS133_OIDC_MFA_AMR_VALUES` and/or `AS133_OIDC_MFA_ACR_VALUES`: exact values confirmed from the IdP administrator's MFA policy and signed real tokens; at least one allowlist must be configured.

Store one dedicated synthetic-user staging access token in the protected environment secret `AS133_STAGING_BEARER_TOKEN`. Use the same still-unexpired token across both phases; do not paste it into workflow inputs, logs, issue comments or artifacts. The verifier stores only token/subject SHA-256 digests, issuer/audience/key identifiers, MFA outcome and tenant/user digests. Its after-phase requires enough token lifetime to cover the owner-approved propagation interval.

Run the `before` phase first with the exact candidate SHA, a target synthetic tenant and a sibling synthetic tenant for the same user. It proves that the signed token is accepted by the real HTTPS JWKS verifier and that the API accepts the user in both tenants. Record the workflow run ID. Then perform the actual IdP deprovision event and allow the configured SCIM IdP integration to send the Users PATCH `replace active=false` for the linked FactoryOS identity. Run the `after` phase immediately within the approved propagation window, supplying the before-run ID, sanitized IdP event reference, exact UTC event timestamp and owner-approved maximum propagation seconds. The workflow verifies the prior run was successful for the same candidate, downloads its evidence artifact, and requires the original token hash/subject/issuer/key/tenant/candidate to match. The expected result is HTTP 401 in the removed tenant and HTTP 200 with the same FactoryOS user in the sibling tenant.

The credential is supplied from the protected environment in both runs; rotating it between phases intentionally causes the verifier to reject the comparison. The baseline artifact is a workflow-run transport artifact, not a signed production security attestation. Retain its GitHub run provenance and artifact digest with the sanitized IdP event reference. The workflow does not generate a deprovision event or modify the IdP: a real IdP lifecycle action must occur between the two runs. It also does not prove global IdP logout or revocation from unrelated relying parties.

The SCIM API uses the registered `application/scim+json` media type; the Express JSON parser is explicitly configured to parse it. The SCIM credential handoff writes a create-only mode-0600 token file in a runner-owned private directory before the credential-hash transaction commits. A pre-commit output failure rolls back the DB transaction and removes a partial file; an indeterminate commit result retains the protected token file for reconciliation rather than discarding a possibly committed credential.

**Acceptance boundary:** repository CI uses synthetic RSA keys, synthetic tenants and mocked API responses. The protected staging workflow has not been run against a real IdP or staging deployment in this change. It does not attest actual production PostgreSQL privileges, the deployed secret-manager provider/version and revocation, the active firewall/CNI egress rules, or an independent penetration test. Those remain separate evidence and independent-review gates. SCIM is still owner-decision-required and this adapter remains deprovision-only; it is not full user/group provisioning or upstream IdP session logout.

