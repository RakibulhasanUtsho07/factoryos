# Production Security Configuration and Independent Review

**Priority:** P1 — production hardening  
**Status:** Repository controls and review pack prepared; live production configuration is **not verified** and an independent penetration test is **not performed by this change**.  
**Scope:** OIDC/MFA/SCIM applicability, least-privilege service and database identities, secret storage and rotation, network/egress boundaries, tenant-negative testing, independent security assessment, remediation proof, and release/rollback approval.

This is a gate and evidence template, not a security certification. A completed repository test cannot prove which settings are currently active in a cloud account, identity provider, cluster, firewall, database, secret manager, or customer tenant.

## 1. Applicability decision for the actual hosting topology

Before release, Architecture and Security must record the deployment topology and select the applicable controls. Use one record per environment (production, staging, disaster-recovery) and per materially different tenant boundary.

| Topology / condition | Required decision and evidence |
|---|---|
| Public or private production API | The API must start only with **NODE_ENV=production** and explicit **AUTH_MODE=oidc**. Record the OIDC issuer, audience, HTTPS JWKS endpoint, token/session lifetime and revocation behavior. Do not place tokens or client secrets in the record. |
| Multi-tenant SaaS | MFA policy is enforced at the configured IdP for privileged, support and tenant-administrator identities (and according to the approved risk policy for other users). Prove that authentication alone does not grant another tenant: active identity link plus active membership and server-derived tenant scope are required. |
| Enterprise customer with managed directory lifecycle | Decide whether SCIM provisioning/deprovisioning is contractually required and supported by the selected IdP/connector. If enabled, test create, attribute update, suspend/deprovision, retries, replay and sibling-tenant non-interference. If SCIM is not applicable or not implemented for that topology, record the decision, owner and audited manual lifecycle process; do not claim SCIM acceptance without connector evidence. |
| Single-tenant/private deployment | OIDC, MFA policy, least privilege, service identity, secret storage, egress controls and deprovisioning still apply. Private networking is not a substitute for authentication or authorization. Record any topology-specific exception and its compensating control. |
| OT/industrial integration enabled | Keep the OT gateway and controller/broker networks in their approved trust zone. Use a separate workload identity and secret scope per gateway/worker, explicit controller/register/topic allowlists and deny-by-default routing. The public API must not expose controller or broker endpoints directly. |
| Telemetry, backup, object storage, ERP/SFTP or other external integration enabled | Inventory the actual endpoint, workload identity, data class and permitted direction for each integration. Enable only required endpoints; configure a dedicated outbound policy. Unused integrations must remain unconfigured or disabled. |

**Required record fields:** environment name; hosting provider/account/project; region/data residency; ingress/egress topology; API and worker deployment model; database topology; identity provider; tenant isolation model; enabled integrations; MFA policy owner; SCIM applicability and decision rationale; Security reviewer; evidence references; date and candidate/deployed SHA.

## 2. Production authentication and browser configuration

The runtime configuration guard added with this document enforces the following startup contract:

- **NODE_ENV** must be explicitly set to **development**, **test** or **production**; an absent or unsupported value fails closed.
- Production must explicitly set **AUTH_MODE=oidc**. Missing mode, **AUTH_MODE=dev**, or any unknown mode is rejected.
- **DEV_AUTH_ENABLED=true** is rejected in production. The development-token endpoint is available only when **NODE_ENV=development**, **AUTH_MODE=dev** and **DEV_AUTH_ENABLED=true**.
- In production, **OIDC_ISSUER**, **OIDC_AUDIENCE** and **OIDC_JWKS_URI** are required. Issuer and JWKS endpoints must be credential-free HTTPS URLs; the issuer cannot contain a query or fragment.
- Production browser origins must be exact HTTPS origins in **CORS_ORIGINS**; wildcard and path-bearing origins are rejected. Set **SWAGGER_ENABLED=false** explicitly in production rather than relying on defaults.
- In OIDC mode the local HS256 signing key is not required solely to initialize **JwtModule**; do not configure or retain an unused development signing key in production unless a separate reviewed use case requires it. If any other service signs application JWTs, that use case needs its own reviewed key-management design.

For every production deployment, attach sanitized configuration evidence proving the above values are active on every replica. Redact secret values, tokens, private keys, database URLs and customer identifiers. Record configuration key names, secret-manager version IDs, issuer/audience identifiers and timestamps, not secret contents.

Identity acceptance is broader than configuring OIDC. Verify issuer and audience rejection, signature algorithm/key validation, expiry behavior, unknown/unlinked identity denial, inactive user or membership denial, multi-tenant membership selection and deprovision/session behavior against the selected real IdP in staging. Test MFA enforcement at the IdP for the roles and workflows specified by the approved risk policy. If the IdP cannot enforce the required policy for a privileged role, keep the release blocked or obtain a documented risk-owner exception.

## 3. Least-privilege service and database identities

Create a workload-identity inventory. Credentials and permissions must not be shared across the API runtime, migration runner, backup/restore operator, monitoring agent, OT gateway/worker, integration worker and human operator.

| Identity | Minimum expected boundary | Evidence to retain |
|---|---|---|
| API runtime | Non-superuser login; only required schema/table/sequence/function privileges; no database ownership or **BYPASSRLS**; tenant-scoped operations use transaction-local tenant/user context. | Role attributes and grants from the deployed database; connection target; sample denied privileged operation; owner/reviewer and timestamp. |
| Migration runner | Separate, time-bounded identity with approved DDL rights only for the migration window; not injected into API replicas. | Grant review, deployment identity, migration log and revocation/expiry evidence. |
| Backup/restore | Backup read scope and restricted encrypted-artifact write access; restore privileges only on the explicitly approved isolated recovery target. | Storage ACL, encryption/key reference, source/target identity confirmation, checksum, restore smoke output and operator approval. |
| Monitoring/telemetry | Read-only scrape/collector permissions and narrow network access; cannot read business tables or administer workloads. | Monitoring identity, scope and negative-access evidence. |
| OT/integration worker | Own identity and narrowly scoped secret, broker/topic, controller/register, SFTP/ERP or provider permissions for only the endpoints it uses. | Endpoint allowlist, identity permission review, credential/key version reference and rejected out-of-scope request. |
| Human administrator/support | Named, MFA-protected individual identities; time-bound elevated access; no shared admin credentials. | Access review, MFA enforcement result, approval and audit log for privileged sessions/actions. |

Run the existing PostgreSQL CI setup/contract for least-privilege role setup and the schema-wide tenant inventory/RLS tests. In the deployed database, inspect role membership, table ownership, grants, default privileges, **rolsuper**, **rolbypassrls** and inherited role grants. RLS tests must run with the actual runtime role, not only a table owner or superuser. Verify TLS certificate validation and that the database is reachable only from approved service/operations networks. A passing CI role check is not evidence for the live role.

## 4. Secret-manager controls and credential rotation

Use the hosting platform's managed secret store or approved workload identity. Do not commit production .env files, secret values, bearer tokens, signing keys, database URLs with passwords, recovery private keys or unredacted provider configuration. Prefer short-lived workload identity over static credentials where supported.

At minimum, inventory and assign owners for database credentials; IdP client/configuration secrets if the selected protocol uses them; outbound integration credentials; OT gateway and broker credentials; telemetry scrape/collector tokens; webhook signing secrets; backup encryption keys; and any remaining JWT signing secret with a documented production use. Include secret identifier, scope, owner, current version identifier, rotation procedure, latest/next rotation date, maximum lifetime policy, revocation procedure and dependent services. Never include the value itself.

Rotation acceptance is a controlled change, not just changing a value in a console:

1. Approve the maintenance window and identify dependencies, overlap support and rollback constraints.
2. Issue a new secret/key version through the approved manager. Do not copy it into a ticket, shell history or CI log.
3. Update the workload through the supported secret-injection mechanism; restart/reload only the affected replicas or workers and verify readiness plus an authenticated synthetic transaction.
4. Verify all replicas use the new version, the old credential no longer works where immediate revocation is supported, and audit/monitoring show no authentication errors.
5. Revoke the old value, remove temporary overlap, verify no old version is referenced, and attach redacted evidence.
6. For suspected compromise, follow the incident procedure, rotate immediately, revoke sessions/tokens as applicable, inspect usage logs and preserve a sanitized incident timeline.

Security and service owners must set the actual cadence and maximum lifetimes based on the chosen provider and regulatory requirements. This document does not invent a universal rotation interval.

## 5. Network boundaries and outbound access

Require deny-by-default ingress and egress rules with owner-reviewed exceptions.

- Public inbound traffic should terminate at the approved edge/load balancer; only the required API port reaches the API workload. Administration endpoints must be private or identity-protected.
- The application database must not have public ingress. Permit only the API runtime, migration identity during approved windows, and recovery/monitoring paths explicitly required by the topology.
- Allow outbound DNS, time synchronization and certificate validation as required, plus the exact OIDC/JWKS, OTLP, object-store, ERP/SFTP, broker/gateway and provider destinations actually enabled. Do not create a broad unrestricted outbound rule simply because a connector exists in the codebase.
- Where possible, constrain egress by destination FQDN/IP, port, protocol, service identity and environment; review DNS changes and the risk of mutable endpoints. Keep production and staging credentials/network policies separate.
- Do not expose PostgreSQL, Redis, metrics, traces, broker administration or industrial control ports to untrusted networks. Restrict monitoring collection to the monitoring identity/network.
- Test that denied egress is observable and that a failed optional integration leaves the core API in its documented degraded/recoverable state. Verify firewall, security-group, network-policy and route-table exports against the approved inventory.

Evidence must include redacted rule export, source/destination scope, owner, approval, effective date, denied-flow test and the exact environment/deployment SHA. A written intended policy without the effective infrastructure export is not proof that the rule is active.

## 6. Tenant-boundary negative tests

Run negative authorization tests against the exact candidate SHA. A 401/403 or explicit not-found response is acceptable when the contract intentionally hides resource existence; the key assertion is no unauthorized disclosure, mutation, side effect or cross-tenant audit pollution.

| Adversarial case | Expected result | Repository / environment evidence |
|---|---|---|
| Missing, malformed, expired, wrong-issuer, wrong-audience or unsupported-algorithm token | Deny authentication before business action. | JWT strategy and auth guard tests; add selected real-IdP staging evidence for issuer/audience/key rotation/expiry. |
| X-Tenant-Id, X-User-Id or body tenant values conflict with the verified principal | Ignore untrusted identity headers; derive identity and tenant from validated claims plus active membership. | IAM controller tests and request-context middleware checks. |
| User has no linked active OIDC identity, inactive user/tenant/membership, or ambiguous multi-tenant membership without selected scope | Deny; do not fall back to a caller-supplied tenant. | JWT strategy and membership query tests; IdP deprovision staging exercise. |
| Tenant A reads, updates, deletes, exports or erases Tenant B's resource by guessing its UUID | Deny before reading/mutating B's data; no cross-tenant output or side effect. | **services/api/src/database/database-tenant-isolation.integration.spec.ts**, **services/api/test/saas-tenant-isolation-matrix.sql**, tenant data governance inventory and PostgreSQL CI. |
| Missing tenant context, cross-tenant foreign key, or RLS tenant context changes inside a pooled connection | Transaction fails closed; no data leaks to the next pooled request. | Tenant isolation integration suite, migration 156 governance/RLS checks and deployed runtime-role test. |
| Cross-tenant export/deletion request, unreviewed relation, legal hold or incomplete manifest | Reject or enter the explicit governed state; never report successful erasure without complete approved receipts. | SaaS tenant data transfer/retention tests and **docs/tenant-data-governance-and-isolation.md**; add any required external-adapter acceptance evidence. |
| IdP deprovisions an identity while tokens/sessions remain active | Subsequent requests follow the documented revocation/session policy and are denied within the approved window; unrelated tenants/users remain unaffected. | Not proven by a unit test alone: run the real configured IdP deprovision test in staging and preserve sanitized request IDs, timestamps and audit receipts. |

Run the targeted test contract in API CI and the PostgreSQL-backed API suite for the same commit. The **services/api/.env.example** and CI-only credentials are examples/fixtures, not evidence of the live database grants or deployed identity policy. Do not run cross-tenant or penetration tests against production without written authorization, agreed targets, traffic limits, data-safety rules, stop conditions and an incident contact.

## 7. Independent, scope-bounded security assessment

The assessment must be performed by a reviewer who did not implement the change and whose independence is recorded. Define written rules of engagement before testing.

Required scope should cover the public API/web boundary, authentication and tenant authorization, object-level access control, session/deprovision behavior, tenant isolation/RLS, file and integration boundaries, secrets/configuration exposure, dependency/supply-chain posture, rate/resource exhaustion controls, network exposure, audit/log redaction, and the actual production-like deployment topology. Include only authorized hostnames, IP/CIDR ranges, tenant fixtures, test windows and excluded systems. Any OT equipment, live customer data, external identity provider, payment/ERP endpoint or production target requires explicit owner authorization and a safety plan; otherwise use isolated synthetic staging fixtures.

The reviewer report must record assessment company/reviewer, independence declaration, standards/method and tool versions, candidate/deployed SHA, environment/topology, dates, exact scope/exclusions, test accounts/roles (no passwords), executed cases, findings with reproducible sanitized evidence, severity rationale, affected assets, exploitability/impact, remediation owner/due date, retest result and residual-risk decision. Keep detailed exploit artifacts in the approved restricted evidence store; commit only a sanitized summary and opaque evidence reference.

**Current evidence state for this repository change:** independent assessment **NOT RUN**; actual production topology/configuration **NOT VERIFIED**; findings from an external test **NOT AVAILABLE**. Do not mark the assessment accepted from API/PostgreSQL CI or from this checklist.

## 8. Finding remediation and closure evidence

For each finding, create a unique identifier and record:

| Field | Required value |
|---|---|
| Finding ID / severity | Stable ID; Critical/High/Medium/Low/Informational using the approved assessment rubric. |
| Asset and scope | Environment, component and authorized tenant/identity context; no customer PII or secret values. |
| Reproduction | Minimal sanitized steps, expected vs actual behavior, request/correlation IDs and timestamps. |
| Risk and owner | Impact/exploitability, accountable remediation owner, due date and status. |
| Remediation commit | Exact commit SHA, changed paths and related PR. |
| Verification | Automated test name/result plus independent retest or reviewer evidence; exact SHA and environment. |
| Closure decision | Closed / accepted residual risk / deferred; Security approver and rationale. |

Release gate: no unresolved Critical or High findings. Medium findings require an explicit Security/risk-owner disposition with compensating controls and due date; the release manager cannot waive another owner's approval. Reopen a finding if the retest uses a different build/environment or fails to exercise the original reproduction. Attach before/after evidence with sensitive values redacted.

## 9. Release, rollback and branch controls

Before rollout, pin the artifact digest and code SHA; verify API CI, API PostgreSQL CI, Web CI when applicable, Production Dependency Security and SRS/HLD/Blueprint traceability validation for the same candidate; check migration manifest/order; review backups and isolated restore if schema/data changes are involved; document the change owner and monitoring/stop conditions. Production security acceptance also requires the infrastructure, identity, network, secret rotation and independent-review evidence described above.

Rollback record must name the previously approved artifact/configuration version, traffic/feature-flag rollback steps, health metrics and stop thresholds, database compatibility/forward-fix decision, backup/restore reference, owner on call, and explicit rollback authorization. Do not claim that a database migration is reversible unless that exact rollback has been reviewed and tested. If an unsafe identity, key, firewall or authorization change is discovered, stop rollout and restore the last known-good configuration; revoke compromised credentials and preserve audit evidence.

The GitHub branch metadata read on **2026-10-21** reported **protected=false** and no required status checks for both **main** and **rakibul-hasan**. This is a release-control gap, not an application-code defect. Repository administrators must enable branch protection/rulesets for both branches: require pull requests and independent review, block force pushes/deletion, require status checks appropriate to the changed files, dismiss stale approvals after new commits, and require resolved review conversations. Recheck the effective settings after saving them; this code change does not configure GitHub repository rules.

## 10. Evidence checklist and review record

Do not mark a line complete unless the cited evidence exists for the exact target environment and deployed SHA.

- [ ] Hosting topology and OIDC/MFA/SCIM applicability signed by Architecture, Security and Identity owners.
- [ ] Production NODE_ENV, AUTH_MODE, issuer/audience/JWKS, exact HTTPS CORS origins, Swagger posture and development-token disablement verified on every replica.
- [ ] Actual DB/service/worker identities, grants, RLS attributes, network reachability and certificate validation reviewed.
- [ ] Secret-manager references, access policies, rotation/revocation evidence and owners recorded without values.
- [ ] Effective firewall/security-group/network-policy and egress allowlist exports reviewed; denied-flow test retained.
- [ ] Tenant-boundary negative tests, auth/deprovision tests and audit/no-side-effect assertions passed on the candidate SHA.
- [ ] Independent reviewer report attached in the restricted evidence store; Critical/High findings closed and independently retested.
- [ ] Sanitized remediation register, release approval, monitoring thresholds and rollback/forward-fix plan approved.
- [ ] main and rakibul-hasan branch/ruleset enforcement rechecked, with the required CI checks active.

### Review record template

| Field | Record |
|---|---|
| Review ID / target environment | SEC-REVIEW-<id> / <staging-or-production-environment> |
| Candidate/deployed SHA and artifact digest | <exact-sha> / <digest> |
| Topology decision record | <restricted evidence reference> |
| Identity provider / MFA policy / SCIM decision | <issuer identifier; MFA owner/result; applicable/not applicable plus reason> |
| Service/DB identity and network review | <redacted evidence references> |
| Secret-manager and rotation evidence | <version IDs, timestamps, owners; never secret values> |
| Automated negative test results | <workflow URL, job, run result, tested SHA> |
| Independent assessor / dates / scope | <name or firm; independence; dates; scope/exclusions; report reference> |
| Open findings | <IDs/severity/status; no secret payloads> |
| Release decision / rollback owner | BLOCKED until every required gate above is evidenced / <owner> |
| Security / Platform / DB / Release approvals | <name/role, decision, timestamp> |

**Acceptance interpretation:** source code and automated contracts are only one part of the P1 task. Until the environment-specific fields, actual deployment proof, independent assessor report, finding closure evidence, branch controls and release/rollback approvals are filled and approved, this P1 remains **partially complete / not production-accepted**.
