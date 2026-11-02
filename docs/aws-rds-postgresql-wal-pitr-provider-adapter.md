# AWS RDS PostgreSQL / Aurora PostgreSQL PITR inventory adapter

**Status:** provider-specific read-only inventory implementation and dry-run retention preflight. This is not an AWS deployment attestation, a live staging rehearsal, or permission to delete a backup.

## Scope and deliberate separation

Implementation: **services/api/src/saas/aws-rds-postgresql-pitr-provider.adapter.ts**

The adapter covers AWS Organizations account discovery, EC2 region discovery, cross-account STS role assumption, and the RDS Query API catalogs for:

- RDS PostgreSQL DB instances;
- Aurora PostgreSQL DB clusters and global-cluster relationships;
- retained RDS automated backups;
- RDS DB snapshots and DB cluster snapshots.

It does **not** enumerate self-managed PostgreSQL WAL objects written to S3. That is a separate S3 object-version inventory and deletion adapter.

RDS-managed PostgreSQL WAL and system-backup chains are provider-managed. The RDS Describe APIs expose backup resources and restore-window metadata, not every underlying WAL segment as an independently addressable object generation. The adapter therefore emits WAL_SEGMENT_CATALOG = OPAQUE_PROVIDER_MANAGED, never synthesizes segment IDs, and never represents that source as a complete empty list. For automated backups, DBInstanceArn identifies the source DB, not the backup object. When DBInstanceAutomatedBackupsArn is absent, the item is recorded only with a SOURCE_DB_COMPOSITE identity (DbiResourceId + account + region); it has no candidate resource ARN and cannot be selected by the exact-ARN dry-run plan. When AWS supplies DBInstanceAutomatedBackupsArn for a replicated backup, that distinct ARN is retained separately.

## Runtime contract

The constructor receives:
- an AWS Organizations management/delegated-discovery account ID;
- the cross-account read-only role name and optional ExternalId;
- source credentials from an approved secret/workload-identity provider;
- optional bounded page/item/request limits;
- optional read-only role policy digest and independent policy-review reference.

The source credential object is held only in memory. The helper exchangeAwsRdsPitrWebIdentityToken can exchange a deployment-owned OIDC token for a 15-minute STS session; the caller must obtain the token from its approved workload-identity source and must not place it in logs or configuration files. The adapter never returns access keys, secret keys or session tokens. It uses AWS SigV4 signed HTTPS POST requests. Organizations ListAccounts uses the AWS Organizations JSON 1.1 protocol and x-amz-target; STS, EC2 and RDS use their Query/XML protocols. The Organizations pager follows NextToken even when Accounts is empty. The source identity must resolve to the configured Organizations account. Every account role assumption is followed by STS GetCallerIdentity; the returned account and assumed-role ARN must match the expected account and role name.

Deployment policy templates are checked in under deploy/aws/: rds-postgresql-pitr-source-role-policy.json, rds-postgresql-pitr-readonly-role-trust.template.json and rds-postgresql-pitr-readonly-role-policy.json. Replace placeholders in the trust template in the controlled account and independently verify the trust and policy before use. The assumed role is expected to permit only:
- ec2:DescribeRegions;
- rds:DescribeDBInstances;
- rds:DescribeDBClusters;
- rds:DescribeGlobalClusters;
- rds:DescribeDBInstanceAutomatedBackups;
- rds:DescribeDBSnapshots;
- rds:DescribeDBClusterSnapshots.

The Organizations discovery identity requires organizations:ListAccounts and sts:AssumeRole for the reviewed account role ARNs. sts:GetCallerIdentity is used for identity checks. Attach a narrowly scoped policy to the role and a trust policy limited to the designated management/delegated principal; use a unique ExternalId where applicable. Do not reuse an archive writer, application role or deletion role.

**Important:** role identity verification is not effective-permission proof. The adapter records collector_policy_independently_verified = false even when a policy digest/reference is configured. Security must independently retrieve and review attached/inline policies, permissions boundaries, trust policy, SCPs and session policies. A configured digest is only an input claim.

## Pagination and response safety

- Organizations ListAccounts uses JSON protocol with x-amz-target AWSOrganizationsV20161128.ListAccounts and follows NextToken, including after an empty account page.
- EC2 DescribeRegions and every RDS Describe* operation use Query/XML and follow the provider continuation marker until exhausted.
- A repeated/oversized token, malformed account/region, unexpected identity, HTTP/provider error, invalid XML, duplicate resource ARN or budget exhaustion fails closed.
- Global request/page budget defaults to 10,000 (hard maximum 50,000).
- Global item budget defaults to 20,000 (hard maximum 100,000).
- RDS MaxRecords defaults to 100 and is bounded to 20–100.
- Each response body is capped at 4 MiB; each request has a bounded timeout.
- Empty continuation pages still consume the global request/page budget.
- AWS API query receipts in this output are local opaque request/response digests, **not CloudTrail event IDs or provider-signed audit evidence**.

## Catalog disposition

| Source | Current disposition | Meaning |
|---|---|---|
| PostgreSQL cluster catalog | COMPLETE only when all discovered active account/region scopes were queried | DB instances, clusters and global clusters |
| WAL archive destination catalog | COMPLETE only for the RDS automated backup and snapshot API surfaces | Not individual WAL object generations |
| WAL segment catalog | OPAQUE_PROVIDER_MANAGED | RDS control plane does not expose individual segment identities |
| WAL writer principal catalog | NOT_ENUMERATED | Requires IAM producer identity and database-native login/replication role discovery |
| WAL replication path catalog | COMPLETE for discovered RDS read-replica/global-cluster relationships | Does not cover external queues, custom archive jobs or every DB-side replication actor |
| PITR restore path catalog | PARTIAL | RDS restore-window/snapshot sources are observed; AWS Backup vault/recovery points and live restore rehearsal are not included |

Non-ACTIVE Organizations accounts are preserved in excluded_accounts and make account discovery incomplete. Regions not opted in are preserved separately. If an enabled account/region cannot be assumed or queried, the adapter throws rather than treating access denial as an empty catalog.

The top-level status is ENUMERATED_WITH_EXPLICIT_GAPS only when account and region enumeration completed; otherwise it is INCOMPLETE. Neither status is a signable provider acceptance. source_receipts_signable, manifest_eligible and deletion_authorized always remain false.

## Retention behavior

createAwsRdsPitrRetentionDryRunPlan requires:
- exact AWS RDS resource ARN and the expected account/region;
- the resource to exist in the supplied inventory;
- an expired retention period that still satisfies the approved minimum recovery horizon;
- legal-hold state NONE;
- dependency state NO_DEPENDENCY;
- policy, data-owner and infrastructure-owner references.

Even with those inputs, the plan remains blocked while provider-managed WAL segments, database writer principals or AWS Backup recovery points are unresolved. The result is always DRY_RUN_ONLY. There is no Delete API method in this adapter. Do not add destructive calls here.

A future deletion implementation must be a separate adapter and release gate. It must bind a reviewed exact ARN and current inventory digest, recheck preservation/legal hold and recovery dependencies immediately before mutation, use a distinct deletion principal, reconcile crashes/idempotent retries, and use an independently assumed read-only verifier to re-list the exact identity. A provider scan or dry-run result is never deletion authorization.

## Tests

Focused regression suite: **services/api/src/saas/aws-rds-postgresql-pitr-provider.adapter.spec.ts**

It covers an empty Organizations continuation page, exhausted JSON token pagination, enabled/opted-out regions, SigV4 authorization presence, exact account/role identity checks, repeated token rejection, access-denied failure, global request-budget exhaustion, separate OIDC token exchange, response streaming caps, cross-account ARN rejection, source DB versus automated-backup ARN identity, explicit WAL/writer/AWS Backup gaps and blocked dry-run behavior.

The tests use mocked AWS Query API responses only. They do not connect to AWS or validate live IAM/SCP policy behavior.

## Production acceptance still required

1. Wire the adapter to a deployment-owned workload identity or secret-backed credential provider; do not commit credentials or rely on a developer key.
2. Independently review role trust, policy, permissions boundary, SCP/session policy and all alternate writer principals.
3. Add AWS Backup vault/recovery-point discovery, AWS Config/CloudTrail evidence linkage and DB-native user/role inventory.
4. Resolve account closure/suspension and opt-in-region coverage with the cloud owner.
5. Run a synthetic RDS PostgreSQL and Aurora PostgreSQL staging inventory and controlled PITR restore in an approved isolated account.
6. Keep deletion disabled until the provider owners approve retention/legal-hold policy, dependencies, exact-resource plan and independent residual-read acceptance.

AS-137 / NFR-PROD-14 remain **PARTIAL**. This implementation is repository code and mocked contract coverage only; it is not production provider acceptance.
