# AWS RDS PostgreSQL / Aurora PostgreSQL PITR inventory adapter

**Status:** provider-specific read-only inventory implementation and dry-run retention preflight. This is not an AWS deployment attestation, a live staging rehearsal, or permission to delete a backup.

## Scope and deliberate separation

Implementation: **services/api/src/saas/aws-rds-postgresql-pitr-provider.adapter.ts**

The adapter covers AWS Organizations account discovery, EC2 region discovery, cross-account STS role assumption, RDS Query API catalogs, and AWS Backup REST/JSON inventory for every discovered account/region scope:

- RDS PostgreSQL DB instances;
- Aurora PostgreSQL DB clusters and global-cluster relationships;
- retained RDS automated backups;
- RDS DB snapshots and DB cluster snapshots;
- AWS Backup vaults and RDS/Aurora recovery points in every vault;
- AWS Backup legal holds and the exact recovery-point ARN membership of each ACTIVE hold.

It does **not** enumerate self-managed PostgreSQL WAL objects written to S3. That is a separate S3 object-version inventory and deletion adapter.

RDS-managed PostgreSQL WAL and system-backup chains are provider-managed. The RDS Describe APIs expose backup resources and restore-window metadata, not every underlying WAL segment as an independently addressable object generation. The adapter therefore emits WAL_SEGMENT_CATALOG = OPAQUE_PROVIDER_MANAGED, never synthesizes segment IDs, and never represents that source as a complete empty list. For RDS automated backups, DBInstanceArn is retained as provider-reported metadata but is not used as the deletion selector. DeleteDBInstanceAutomatedBackup accepts DbiResourceId for the ordinary retained backup or DBInstanceAutomatedBackupsArn for a replicated backup. Accordingly, ordinary retained entries receive a SOURCE_DB_RESOURCE_ID identity and DBI_RESOURCE_ID plan selector; replicated entries retain their distinct backup ARN. The adapter preserves AWS Status (active, creating, retained or replicating) and only Status=retained is eligible for dry-run review. Active/creating/replicating backup chains are never retention candidates.

## Runtime contract

The constructor receives:
- an AWS Organizations management/delegated-discovery account ID;
- the cross-account read-only role name and mandatory ExternalId;
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
- rds:DescribeDBClusterSnapshots;
- backup:ListBackupVaults;
- backup:ListRecoveryPointsByBackupVault;
- backup:ListLegalHolds;
- backup:ListRecoveryPointsByLegalHold.

The checked-in inventory role policy explicitly denies all actions except this read-only allow-list. The Organizations discovery identity requires organizations:ListAccounts and sts:AssumeRole for the reviewed account role ARNs. sts:GetCallerIdentity is used for identity checks. Attach a narrowly scoped policy to the role and a trust policy limited to the designated management/delegated principal; supply the unique ExternalId required by this adapter and the example trust policy. Do not reuse an archive writer, application role or deletion role.

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
- AWS Backup vault, recovery-point, legal-hold and held-recovery-point endpoints use the AWS Backup REST/JSON API and their own NextToken pagination. AWS Backup response objects and recovery-point lists are byte-, page-, item- and request-bounded.
- Every AWS Backup recovery point must report the exact vault ARN/name currently being paginated, and its RDS/Aurora source ARN must match the discovered account and region. Cross-account, cross-region and foreign-vault responses fail closed.
- AWS Backup `Lifecycle.DeleteAfterDays` and `Lifecycle.MoveToColdStorageAfterDays` are preserved separately from the provider-computed `CalculatedLifecycle.DeleteAt` and `CalculatedLifecycle.MoveToColdStorageAt`; a configured delete-after period with no calculated deletion time blocks retention review.
- Vault `MinRetentionDays` and `MaxRetentionDays` are checked against the recovery-point creation date and proposed expiry; missing creation time blocks when a vault bound applies.
- Every AWS Backup page has a local opaque receipt digest, which is attached to the PITR catalog. These are not CloudTrail event IDs or provider-signed audit records.
- Legal holds in CREATING, CANCELING or CANCELLING state mark the current account/region scope as uncertain; exact held recovery-point ARNs are recorded for ACTIVE holds. A returned `LegalHoldArn` is retained only when its partition, account and region match; AWS's documented `recovery-point` ARN resource form is accepted.
- A vault's Locked state, lock date and minimum/maximum retention are preserved. A dry-run candidate from AWS Backup is blocked when vault lock is true or unknown.
- RDS automated-backup cross-region destination ARNs are reconciled against the discovered automated-backup catalog; destinations not found in the enumerated account/region scopes are recorded in `unresolved_replication_destination_arns` and block a retention plan for the source backup.
- AWS API query receipts in this output are local opaque request/response digests, **not CloudTrail event IDs or provider-signed audit evidence**.


## Database-native writer and replication principal inventory

The optional `database_principal_inventory` configuration adds a **separate database-access role**; it is never the RDS Describe/AWS Backup collector role. The adapter assumes that role per account, verifies the STS account and exact role ARN, and uses only the short-lived credentials to create an RDS IAM database authentication token for the AWS-reported DB instance or Aurora cluster writer endpoint.

The data-plane role is deliberately separate:
- Attach `deploy/aws/rds-postgresql-pitr-database-connect-role-policy.template.json` after replacing the placeholders with one exact Region, account, DbiResourceId/DBClusterResourceId and database username. Add one exact `db-user` ARN per permitted PostgreSQL target; do not use a wildcard resource ID or database username.
- Reuse the cross-account trust template only after changing the role name and verifying the external ID independently. The database-access role policy grants `rds-db:connect` only and explicitly denies every other AWS action.
- Provision the database login with `deploy/aws/rds-postgresql-pitr-database-principal-reader-bootstrap.sql`. It creates a fresh passwordless login, grants only `rds_iam` and `pg_read_all_stats`, then grants `CONNECT` on every connectable non-template database; rerunning against an existing login fails and requires manual privilege reconciliation. it grants no data-table privileges. It does not grant `pg_read_all_data`, table SELECT, `rds_superuser`, superuser, role creation, database creation, or replication.
- The collector requires a configured RDS CA bundle and exact SHA-256 pin. TLS certificate verification is always enabled; only the AWS RDS endpoint in the discovered region is accepted. A custom DNS CNAME or plaintext/password fallback is not allowed.
- Every inspection starts with `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, verifies `transaction_read_only=on`, the exact IAM database username and the `pg_read_all_stats`/`rds_iam` role memberships, applies statement and lock timeouts, and closes the one-connection pool after the snapshot.
- Catalogs include PostgreSQL roles and login/replication flags, role memberships, database owners and structured database CREATE ACLs, schema/table/sequence/foreign-table/large-object ACLs, and future default privileges, aggregated active sessions, WAL senders, replication slots, WAL receivers, logical subscriptions and publications.
- The logical-subscription query intentionally omits `pg_subscription.subconninfo`; role and settings queries never select password hashes; activity queries never persist SQL text; sender application names are hashed before storage.
- Row limits are per catalog and global. Any permission denial, timeout, truncation, missing endpoint, wrong role identity or disabled/unknown IAM DB authentication marks that DB target PARTIAL/UNAVAILABLE. The writer-principal source becomes COMPLETE only when every discovered PostgreSQL instance/cluster has a complete database-native snapshot.
- IAM DB authentication is used for the metadata login only. It is not used to create PostgreSQL physical/logical replication connections. IAM DB authentication events are not an independent CloudTrail audit trail; separate Config/CloudTrail/network and owner verification remain open.

Without this optional configuration, `WAL_WRITER_PRINCIPAL_CATALOG` remains `NOT_ENUMERATED` and `database_writer_principals_fully_enumerated=false`. A configured but inaccessible or IAM-auth-disabled DB remains an explicit unavailable catalog; PostgreSQL versions below 14 are explicitly unsupported by the `pg_read_all_stats` reader role; the adapter does not infer that it has no writer users.

### Production prerequisites and acceptance still required

The feature is code- and mock-tested only. Before setting the database-principal requirement PASS, an approved staging owner must enable IAM DB authentication where policy allows, deploy the distinct exact-resource role and dedicated non-privileged PostgreSQL login, pin the current RDS CA bundle, confirm pg_read_all_stats/catalog visibility on RDS PostgreSQL and Aurora PostgreSQL versions in use, exercise failover/reader endpoints and validate every DB target. This adapter performs no production provisioning, role grant, parameter-group modification or database mutation.

## Catalog disposition

| Source | Current disposition | Meaning |
|---|---|---|
| PostgreSQL cluster catalog | COMPLETE only when all discovered active account/region scopes were queried | DB instances, clusters and global clusters |
| WAL archive destination catalog | COMPLETE only for the RDS automated backup and snapshot API surfaces | Not individual WAL object generations |
| WAL segment catalog | OPAQUE_PROVIDER_MANAGED | RDS control plane does not expose individual segment identities |
| WAL writer principal catalog | NOT_ENUMERATED | Requires IAM producer identity and database-native login/replication role discovery |
| WAL replication path catalog | COMPLETE for discovered RDS read-replica/global-cluster relationships | Does not cover external queues, custom archive jobs or every DB-side replication actor |
| PITR restore path catalog | PARTIAL | RDS restore-window/snapshot sources and AWS Backup RDS/Aurora recovery points are inventoried; controlled live restore rehearsal is still missing |

Non-ACTIVE Organizations accounts are preserved in excluded_accounts and make account discovery incomplete. Regions not opted in are preserved separately. If an enabled account/region cannot be assumed or queried, the adapter throws rather than treating access denial as an empty catalog.

The top-level status is ENUMERATED_WITH_EXPLICIT_GAPS only when account and region enumeration completed; otherwise it is INCOMPLETE. AWS Backup vault/recovery-point/legal-hold catalogs are complete only after all relevant account/region scopes and every continuation token were exhausted. A legal hold in CREATING, CANCELING or CANCELLING state keeps the scope uncertain. Neither inventory status is a signable provider acceptance. source_receipts_signable, manifest_eligible and deletion_authorized always remain false.

## Retention behavior

createAwsRdsPitrRetentionDryRunPlan requires:
- exact AWS RDS resource ARN and the expected account/region;
- the resource to exist in the supplied inventory;
- an expired retention period that still satisfies the approved minimum recovery horizon;
- legal-hold state NONE;
- dependency state NO_DEPENDENCY;
- policy, data-owner and infrastructure-owner references.

Even with those inputs, the plan remains blocked while provider-managed WAL segments or database writer principals are unresolved. AWS Backup candidates additionally require COMPLETED recovery-point state, an unlocked vault, complete legal-hold inventory and no matching ACTIVE legal hold. Standard retained RDS automated backups bind to DbiResourceId; replicated RDS backup copies bind to DBInstanceAutomatedBackupsArn; RDS DB/cluster snapshots are bound by immutable snapshot ARN but their provider delete selector is DBSnapshotIdentifier or DBClusterSnapshotIdentifier; AWS Backup copies bind to RecoveryPointArn. The plan also honours the provider-reported lifecycle DeleteAt and vault minimum retention horizon. The result is always DRY_RUN_ONLY. There is no Delete API method in this adapter. Do not add destructive calls here.

A future deletion implementation must be a separate adapter and release gate. It must bind a reviewed exact ARN and current inventory digest, recheck preservation/legal hold and recovery dependencies immediately before mutation, use a distinct deletion principal, reconcile crashes/idempotent retries, and use an independently assumed read-only verifier to re-list the exact identity. A provider scan or dry-run result is never deletion authorization. For RDS snapshots, the immutable ARN binds the resource while the separate delete selector is the AWS API identifier (`DBSnapshotIdentifier` or `DBClusterSnapshotIdentifier`), not the ARN.

## Tests

Focused regression suite: **services/api/src/saas/aws-rds-postgresql-pitr-provider.adapter.spec.ts**

It covers an empty Organizations continuation page, exhausted JSON token pagination, enabled/opted-out regions, SigV4 authorization presence, mandatory ExternalId validation, exact account/role identity checks, separate IAM DB role verification, repeated token rejection, access-denied failure, global request-budget exhaustion, OIDC token exchange, response streaming caps, cross-account ARN rejection including exact AWS Backup source account/region and vault binding, RDS backup DbiResourceId/replicated ARN identity, snapshot ARN-to-identifier binding, AWS Backup vault/recovery-point/legal-hold cataloging, IAM DB-authenticated PostgreSQL role/grant/replication inventory, page receipts, calculated lifecycle timestamps, minimum/maximum vault-retention bounds, missing linked-recovery-point blocking, locked-vault retention blocking and unresolved replication-destination reporting.

The tests use mocked AWS Organizations JSON, STS/RDS/EC2 Query/XML and AWS Backup REST/JSON responses only. They do not connect to AWS or validate live IAM/SCP policy behavior.

## Production acceptance still required

1. Wire the adapter to a deployment-owned workload identity or secret-backed credential provider; do not commit credentials or rely on a developer key.
2. Independently review role trust, policy, permissions boundary, SCP/session policy and all alternate writer principals.
3. Add AWS Config/CloudTrail event linkage and independent network/owner attestation; database-native principals are now optionally inventoried through a separate IAM DB role, but live account staging and independent verification are not yet accepted.
4. Resolve account closure/suspension and opt-in-region coverage with the cloud owner.
5. Run a synthetic RDS PostgreSQL and Aurora PostgreSQL staging inventory and controlled PITR restore in an approved isolated account.
6. Keep deletion disabled until the provider owners approve retention/legal-hold policy, dependencies, exact-resource plan and independent residual-read acceptance. The adapter intentionally exposes no Delete API call.

AS-137 / NFR-PROD-14 remain **PARTIAL**. This implementation is repository code and mocked contract coverage only; it is not production provider acceptance.
