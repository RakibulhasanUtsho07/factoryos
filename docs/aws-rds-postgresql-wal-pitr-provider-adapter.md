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
- AWS Backup legal holds and the exact recovery-point ARN membership of each ACTIVE hold;
- database-native PostgreSQL writer grants, roles, memberships, sessions and replication identities when the separate IAM-authenticated reader is configured.

It does **not** enumerate self-managed PostgreSQL WAL objects written to S3. That is a separate S3 object-version inventory and deletion adapter.

RDS-managed PostgreSQL WAL and system-backup chains are provider-managed. The RDS Describe APIs expose backup resources and restore-window metadata, not every underlying WAL segment as an independently addressable object generation. The adapter therefore emits WAL_SEGMENT_CATALOG = OPAQUE_PROVIDER_MANAGED, never synthesizes segment IDs, and never represents that source as a complete empty list. For RDS automated backups, DBInstanceArn is retained as provider-reported metadata but is not used as the deletion selector. DeleteDBInstanceAutomatedBackup accepts DbiResourceId for the ordinary retained backup or DBInstanceAutomatedBackupsArn for a replicated backup. Accordingly, ordinary retained entries receive a SOURCE_DB_RESOURCE_ID identity and DBI_RESOURCE_ID plan selector; replicated entries retain their distinct backup ARN. The adapter preserves AWS Status (active, creating, retained or replicating) and only Status=retained is eligible for dry-run review. Active/creating/replicating backup chains are never retention candidates.

## Runtime contract

The constructor receives:
- an AWS Organizations management/delegated-discovery account ID;
- the cross-account read-only role name and mandatory ExternalId;
- source credentials from an approved secret/workload-identity provider;
- optional bounded page/item/request limits;
- optional inventory-role policy digest and independent policy-review reference;
- optional **separate** database-principal reader role name, PostgreSQL login name, pinned RDS CA PEM and SHA-256 digest, plus bounded database/query/row/timeout limits.

The source credential object is held only in memory. The helper exchangeAwsRdsPitrWebIdentityToken can exchange a deployment-owned OIDC token for a 15-minute STS session; the caller must obtain the token from its approved workload-identity source and must not place it in logs or configuration files. The adapter never returns access keys, secret keys or session tokens. It uses AWS SigV4 signed HTTPS POST requests. Organizations ListAccounts uses the AWS Organizations JSON 1.1 protocol and x-amz-target; STS, EC2 and RDS use their Query/XML protocols. The Organizations pager follows NextToken even when Accounts is empty. The source identity must resolve to the configured Organizations account. Every account role assumption is followed by STS GetCallerIdentity; the returned account and assumed-role ARN must match the expected account and role name.

Deployment templates are checked in under deploy/aws/: rds-postgresql-pitr-source-role-policy.json, rds-postgresql-pitr-readonly-role-trust.template.json, rds-postgresql-pitr-readonly-role-policy.json, rds-postgresql-db-principal-reader-role-trust.template.json, rds-postgresql-db-principal-reader-role-policy.template.json and rds-postgresql-db-principal-reader-bootstrap.sql. Replace placeholders in the trust template in the controlled account and independently verify the trust and policy before use. The assumed role is expected to permit only:
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

The checked-in inventory role policy explicitly denies all actions except this read-only allow-list. The Organizations discovery identity requires organizations:ListAccounts and sts:AssumeRole for the reviewed account role ARNs. sts:GetCallerIdentity is used for identity checks. Attach a narrowly scoped policy to the role and a trust policy limited to the designated management/delegated principal; supply the unique ExternalId required by this adapter and the example trust policy. Do not reuse an archive writer, application role or deletion role. The source-role policy permits sts:AssumeRole only for the configured inventory-reader and database-principal-reader role names; the reader trust template still requires the exact source role ARN and ExternalId.

The database-principal reader role is deliberately separate from the RDS Describe/AWS Backup inventory role. Its checked-in policy template grants only rds-db:connect and only to the exact per-database dbuser ARNs built from each DbiResourceId or DbClusterResourceId and the fixed factoryos_db_inventory_reader login. Replace the placeholders with reviewed account, region and resource IDs; do not use wildcards for resource IDs or database usernames. The bootstrap SQL creates a passwordless login, grants rds_iam and pg_monitor, grants CONNECT only to current connectable non-template databases, and refuses to overwrite an existing role. It is a manual DBA change artifact, not executed by this adapter.

**Important:** role identity verification is not effective-permission proof. The adapter records collector_policy_independently_verified = false even when a policy digest/reference is configured. Security must independently retrieve and review attached/inline policies, permissions boundaries, trust policy, SCPs and session policies. A configured digest is only an input claim.

## Database-native principal inventory

Implementation: **services/api/src/saas/aws-rds-postgresql-database-principal-inventory.ts**

This is an optional, separate read-only inspection path. Configure database_principal_reader only after the account owner has provisioned the dedicated reader role, bootstrap login and exact rds-db:connect resource allow-list. The adapter assumes that role separately in each discovered account, verifies the returned STS assumed-role identity, and creates an RDS IAM authentication token scoped to the exact RDS endpoint, region and database username. Tokens and temporary credentials are held only in memory and are never placed in inventory records or logs.

The database connection uses the supplied RDS CA bundle only when its configured SHA-256 digest matches the exact PEM bytes. TLS certificate verification and endpoint hostname verification are mandatory; there is no insecure fallback. Each connection begins with BEGIN READ ONLY, applies bounded statement and lock timeouts, verifies that the current login is the configured reader, requires pg_monitor membership and inherited role grants, rejects superuser/createdb/createrole/replication/BYPASSRLS capabilities and known elevated writer/server-execution role memberships, then rolls the transaction back and closes the connection. The reader role must not be reused for application traffic or backup deletion.

The scanner first enumerates pg_database, then inspects every non-template database with datallowconn = true. Cluster-wide roles, role memberships, replication senders, replication slots and WAL receiver state are queried once per RDS resource using the bootstrap database connection; they are not repeated or attributed to every database. Database-scoped grants and sessions are queried in each database, and logical subscriptions are filtered by their owning subdbid because pg_subscription is shared across the cluster. A denied connection, disabled database, missing database, truncated catalog or budget exhaustion remains an explicit blocker; a skipped database is never treated as an empty result. The bounded catalogs include:

- role attributes and login status from pg_roles (never rolpassword or pg_authid);
- role memberships and admin option;
- database CONNECT/CREATE/TEMP privileges;
- schema ACLs, table/view write ACLs, column-level write ACLs, sequence ACLs, and default table/sequence/function privileges;
- function EXECUTE grants as capability evidence, not proof that a function is harmless;
- active session identity/state metadata from pg_stat_activity (never SQL text); application_name is stored only as a presence flag and SHA-256 digest, never as raw text;
- replication senders, slots and WAL receivers;
- logical subscription metadata (subname, owner, enabled state, slot and publication names), never pg_subscription.subconninfo.

Each catalog query uses a parameterized LIMIT and reads at most one row over its configured cap to detect truncation. Defaults are 64 databases per target, 500 rows per query, 20,000 observed rows and 10,000 catalog/verification queries; hard limits are 256 databases, 5,000 rows per query, 100,000 rows and 50,000 queries. Statement and connection timeouts are bounded. Opaque local digest receipts are generated over returned metadata; these are not AWS-signed or CloudTrail audit events.

WAL_WRITER_PRINCIPAL_CATALOG becomes COMPLETE only when the separate reader is configured and every discovered PostgreSQL RDS instance / PostgreSQL or Aurora PostgreSQL DB cluster, IAM-auth endpoint, connectable non-template database and required catalog has been inspected without truncation or access blockers. Without the reader configuration it remains NOT_ENUMERATED; with partial access, disabled IAM DB authentication, missing endpoint/resource identity or any catalog error it is PARTIAL. database_writer_principals_fully_enumerated refers only to the PostgreSQL database-native catalog scope.

WAL_REPLICATION_PATH_CATALOG deliberately remains PARTIAL: it combines RDS read-replica/global-cluster/backup-copy metadata with database senders, slots, WAL receivers and subscriptions, but does not enumerate every external AWS IAM caller, CloudTrail/Config producer, custom archive process, queue, or other out-of-database writer. A complete database-native role catalog is therefore not a claim that all AWS-side writers have been identified. The separate policy digest/review reference is recorded as an input claim; database_principal_reader_policy_independently_verified stays false until Security independently evaluates the role trust, effective rds-db:connect resources, permissions boundaries, SCP/session policies and database grants.

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

## Catalog disposition

| Source | Current disposition | Meaning |
|---|---|---|
| PostgreSQL cluster catalog | COMPLETE only when all discovered active account/region scopes were queried | DB instances, clusters and global clusters |
| WAL archive destination catalog | COMPLETE only for the RDS automated backup and snapshot API surfaces | Not individual WAL object generations |
| WAL segment catalog | OPAQUE_PROVIDER_MANAGED | RDS control plane does not expose individual segment identities |
| WAL writer principal catalog | COMPLETE only after the optional IAM database reader covers every discovered PostgreSQL target/database/catalog; otherwise NOT_ENUMERATED or PARTIAL | Database-native roles, memberships, grants, sessions and replication identities only; not AWS-side callers |
| WAL replication path catalog | PARTIAL | Combines RDS replication relationships and database-native senders/slots/receivers/subscriptions; external IAM writers, queues and custom archive jobs remain outside scope |
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

Focused regression suites: **services/api/src/saas/aws-rds-postgresql-pitr-provider.adapter.spec.ts** and **services/api/src/saas/aws-rds-postgresql-database-principal-inventory.spec.ts**.

It covers an empty Organizations continuation page, exhausted JSON token pagination, enabled/opted-out regions, SigV4 authorization presence, mandatory ExternalId validation, exact account/role identity checks, repeated token rejection, access-denied failure, global request-budget exhaustion, OIDC token exchange, response streaming caps, cross-account ARN rejection including exact AWS Backup source account/region and vault binding, RDS backup DbiResourceId/replicated ARN identity, snapshot ARN-to-identifier binding, AWS Backup vault/recovery-point/legal-hold cataloging, page receipts, calculated lifecycle timestamps, minimum/maximum vault-retention bounds, missing linked-recovery-point blocking, locked-vault retention blocking and unresolved replication-destination reporting.

The adapter tests use mocked AWS Organizations JSON, STS/RDS/EC2 Query/XML and AWS Backup REST/JSON responses only. The new database-principal suite uses a mocked PostgreSQL client and covers SigV4 IAM token scope, CA digest pinning, verified TLS options, read-only transactions, least-privilege role checks, cluster-versus-database catalog scoping without duplicate role/replication evidence, multi-database coverage, query/row budgets, partial handling of denied catalogs, hashed application labels and omission of password/connection-info/query-text fields. These suites do not connect to AWS or a live PostgreSQL database and do not validate effective IAM/SCP policy behavior.

## Production acceptance still required

1. Wire the adapter to a deployment-owned workload identity or secret-backed credential provider; do not commit credentials or rely on a developer key.
2. Provision the separate passwordless IAM DB login through the approved DBA change path, deploy the pinned RDS CA bundle and reader configuration, then independently review its trust, exact rds-db:connect resources, permissions boundary, SCP/session policy and database grants. This scanner is repository code plus mocked contract coverage; it has not run against AWS or a live database.
3. Independently review inventory-role trust/policy and all alternate AWS-side writer principals.
4. Add AWS Config/CloudTrail event linkage and obtain independent provider audit evidence; database-native catalog completeness does not identify external IAM producers.
5. Resolve account closure/suspension and opt-in-region coverage with the cloud owner.
6. Run synthetic RDS PostgreSQL and Aurora PostgreSQL staging inventory, verify reader identity/least privilege, then perform a controlled PITR restore in an approved isolated account.
7. Keep deletion disabled until the provider owners approve retention/legal-hold policy, dependencies, exact-resource plan and independent residual-read acceptance. The adapter intentionally exposes no Delete API call.

AS-137 / NFR-PROD-14 remain **PARTIAL**. This implementation is repository code and mocked contract coverage only; it is not production provider acceptance.
