# AWS Backup vault and recovery-point inventory

**Status:** read-only provider inventory implementation with mocked AWS API contracts. This slice inventories AWS Backup vault metadata, recovery points, the three AWS Backup vault types, restore-access relationships for logically air-gapped vaults, and legal-hold-to-recovery-point relationships for explicitly supplied, STS-verified account/region scopes. It does not authorize restore, copy, deletion, legal-hold changes, or whole-backup erasure.

## Scope

Implementation: \`services/api/src/saas/aws-backup-vault-recovery-point-inventory.ts\`

For each explicitly supplied account/region scope, the adapter:

1. Calls STS \`GetCallerIdentity\` with SigV4 and requires the exact account and dedicated assumed-role name \`FactoryOSAwsBackupInventoryReader\`.
2. Exhausts \`ListBackupVaults\` using \`NextToken\`, then calls \`DescribeBackupVault\` for each discovered vault.
3. Enumerates and preserves all documented \`VaultType\` values:
   - \`BACKUP_VAULT\`
   - \`LOGICALLY_AIR_GAPPED_BACKUP_VAULT\`
   - \`RESTORE_ACCESS_BACKUP_VAULT\`
4. Exhausts \`ListRecoveryPointsByBackupVault\` for each listed vault.
5. For each logically air-gapped source vault, exhausts \`ListRestoreAccessBackupVaults\` and captures the associated restore-access vault ARN, state and approval/revocation lifecycle timestamps.
6. Exhausts \`ListLegalHolds\`, calls \`GetLegalHold\` for each hold, and exhausts \`ListRecoveryPointsByLegalHold\` to materialize the many-to-many legal-hold/recovery-point relationship.
7. Exhausts `ListCopyJobs` for every supplied account/Region scope and fetches each job with `DescribeCopyJob`.
8. Reconciles source/destination vault and recovery-point ARNs against the explicitly supplied scopes and the corresponding vault/recovery-point catalogs.

### Vault metadata

The normalized vault record includes provider ARN/name/type/state, create time, encryption-key ARN/type, reported recovery-point count, Vault Lock state, minimum/maximum retention days, lock date and source-vault ARN when returned by AWS.

A missing/unknown vault type or an ARN that does not match the requested partition/account/region is a completeness blocker. The adapter does not treat the reported \`NumberOfRecoveryPoints\` as the authoritative count; it enumerates the recovery-point pages separately.

### Recovery-point metadata

The adapter captures the provider recovery-point ARN, owning vault, vault type, resource ARN/type/name, status, creation/completion/initiation/last-restore timestamps, reported byte size, encryption flag/key ARN/key type, source backup vault ARN, backup-plan/rule identifiers, lifecycle days/events, calculated delete/cold-storage timestamps and parent/composite metadata when supplied.

\`CreationDate\` and a correctly scoped recovery-point ARN are required for completeness. Optional fields remain null when AWS does not return them. A malformed size, source-vault ARN, or missing required timestamp is a blocker rather than evidence that the recovery point is absent.

\`SourceBackupVaultArn\` is retained as provider provenance. If its account/region is not in the explicitly supplied scopes, the output records that source-vault gap and remains PARTIAL. The adapter does not claim to discover every AWS Organizations account or enabled Region.

### Restore-access vault relationships

AWS Backup's \`ListRestoreAccessBackupVaults\` is queried for each \`LOGICALLY_AIR_GAPPED_BACKUP_VAULT\`. The output records the source vault ARN, restore-access vault ARN, current state, creation/approval timestamps and latest revoke request state/timestamps. The MPA session ARN and status message are intentionally omitted.

This relationship catalog is distinct from the three-type \`ListBackupVaults\` catalog. It is not proof that an MPA approval workflow or a restore operation was exercised.

### Legal holds

The adapter records hold ID/ARN/status, creation/cancellation/record-retention timestamps, selected vault names, the number (not contents) of selected resource identifiers and optional selection date bounds. It intentionally omits free-form title, description and cancellation text.

\`ListRecoveryPointsByLegalHold\` produces explicit association rows. This preserves the AWS Backup many-to-many model: a recovery point may be associated with more than one hold, and a hold may cover more than one recovery point. If a hold references a recovery point that is absent from the enumerated vault catalogs, the result is PARTIAL rather than silently dropping the relationship.

A legal-hold status of ACTIVE is observed provider metadata only. The inventory does not create, cancel or release holds and does not independently prove the legal sufficiency of any retention policy. AWS documents that copies made to another Region or account do not inherit the source recovery point's legal hold; therefore each copy destination must be enumerated and its hold/retention state evaluated independently. A source hold relationship is not evidence that a destination copy is protected by the same hold.

## AWS Backup copy-job history and destination reconciliation

For every STS-verified account/Region scope, the collector exhausts `ListCopyJobs` without state or date filters, then calls `DescribeCopyJob` for each unique `CopyJobId`. This includes `CREATED`, `RUNNING`, `COMPLETED`, `FAILED` and `PARTIAL` job states, so the inventory does not silently omit failed or still-running copy attempts. A malformed/missing job ID, duplicate ID, unknown state, missing creation timestamp, missing source/destination vault identity, or an incomplete completed-job result blocks copy-job completeness.

Captured, minimized metadata includes the job owner/account and source execution scope, source vault and recovery-point ARNs, destination vault and recovery-point ARNs, job state and lifecycle timestamps, byte count, resource ARN/type, destination encryption-key ARN, destination vault type/lock state, destination lifecycle settings, backup-plan/rule identifiers, and composite parent/child indicators. Free-form status messages, non-unique resource names, and the copy IAM role ARN are intentionally omitted.

Each source and destination ARN is parsed into partition/account/Region and compared with the requested scopes. Vault ARNs are cross-checked against the vault catalog; source and completed destination recovery-point ARNs are cross-checked against the recovery-point catalog. The output records separate source-scope, destination-scope, vault-catalog and recovery-point-catalog gaps. A completed job whose destination point is not in the current point catalog remains PARTIAL: the missing point could have expired, been deleted, or be outside effective visibility, and the job record alone cannot distinguish those conditions. A job that is not COMPLETED may legitimately have no destination recovery-point ARN yet.

`aws_backup_copy_job_catalog_enumerated` is true only when copy-job pagination and every per-job detail read complete for all supplied scopes without validation blockers. `copy_job_destination_reconciliation_complete` is a separate signal and requires all referenced source/destination scopes, vaults and recovery points to reconcile. Cross-account and cross-Region counts are derived only from provider source/destination vault ARNs. Neither signal proves byte readability, successful restore, future copy delivery, or whole-backup/tenant erasure coverage.

AWS Backup cross-account monitoring is an explicit opt-in. AWS documents that the aggregated view includes jobs created after cross-account monitoring is enabled; jobs created before opt-in are not retroactively guaranteed by that view. FactoryOS therefore does not infer organization-wide coverage from one management-account response. The caller must supply and independently verify every account/Region scope, including destination accounts/Regions, and must confirm effective role access in each. AWS also documents separate source- and destination-account requirements for cross-account copy permissions; this inventory grants neither permission and performs no copy.

AWS Backup removes terminal copy-job records 30 days after they finish. The output exposes `copy_job_terminal_record_retention_days: 30`; a complete `ListCopyJobs` traversal therefore means only that the records still retained by AWS for each supplied scope were exhausted. It is not a lifetime copy history and cannot reconstruct older jobs after provider expiry. For longer-lived evidence, an independently operated event/CloudTrail or provider audit retention path must be designed and accepted. A job in state `COMPLETED` is provider-reported job metadata, not an independently verified restore. Cross-account/Region destination recovery points must be enumerated under destination-account credentials and evaluated for their own encryption, retention, legal-hold and restore controls. AWS legal holds on a source point do not automatically protect its copies.


## Long-term copy-job event history

The companion archive contract is documented in [AWS Backup copy-job historical event retention](aws-backup-copy-job-event-retention.md), with two infrastructure templates:

- `deploy/aws/aws-backup-copy-job-eventbridge-archive.template.json`: one indefinite (RetentionDays 0) EventBridge archive for Copy Job State Change in every enabled AWS Backup account/Region.
- `deploy/aws/aws-backup-copy-job-cloudtrail-audit.template.json`: one account-level multi-Region CloudTrail trail with log-file integrity validation and a versioned S3/KMS/Object Lock Compliance log bucket.

AWS Backup service events and CloudTrail service events are best effort. CloudTrail log files are unordered; digest validation must be performed and its result retained. The Object Lock duration has no repository default: the cloud owner must provide an approved retention period and a pre-provisioned KMS key. Neither template has been deployed or tested against a live account in this change.

Neither archive backfills events from before activation. At deployment, capture the current ListCopyJobs 30-day baseline and, where available, the regional CloudTrail Event history (up to its rolling 90-day window); record gaps before the first confirmed archive/trail delivery. The EventBridge archive is a replay source, not a loss-free ledger or proof that every job emitted an event. Cross-check retained CloudTrail records and the overlapping API window and preserve unresolved source disagreements.

## Audit retention SCP guardrail

The companion `deploy/aws/aws-backup-copy-job-audit-retention-guardrail-scp.template.json` contains exact-resource deny fences for archive deletion/retention changes, CloudTrail stop/delete/configuration changes, S3 audit-bucket lifecycle/Object Lock/policy/versioning/encryption changes and KMS key disablement/deletion/policy/grant revocation. The only exception is an exact same-account break-glass role ARN; account IDs and role names are never wildcards. The policy denies these changes; it grants no permissions.

A cloud Organization administrator must interpolate the deployed archive/trail/bucket/key identities, review the exception role, enable SCP policy type, and attach the policy to every relevant member account or OU. Repository CI does not attach it. SCPs do not restrict the Organizations management account or service-linked roles; authorized Organizations management administrators can detach or edit SCPs. Management-account governance, SCP attachment rights, break-glass trust/MFA/approval and use alerts require separate review. The exception identity is an emergency pathway; its use invalidates the affected evidence period until the retention controls are revalidated.

## Request, pagination and evidence bounds

AWS Backup uses API version \`2018-11-15\`, its REST-JSON protocol, regional HTTPS endpoints and SigV4. STS identity verification uses the regional STS endpoint. The adapter:

- Requires already-assumed temporary credentials; it does not assume roles or obtain credentials itself.
- Signs every AWS Backup GET and STS identity request; it returns no credentials or session tokens.
- Uses \`NextToken\` pagination for every list surface, follows empty continuation pages and fails closed on repeated, malformed or oversized tokens.
- Shares global request, page and item budgets across every scope, vault, recovery-point list and legal-hold list.
- Bounds each streamed UTF-8 response to 4 MiB and every request timeout to the configured 1–30 second range.
- Creates opaque local SHA-256 receipt references for provider response pages. These receipts are not AWS-signed evidence, CloudTrail records or proof of organization-wide scope.
- Fails closed on STS identity mismatch, AccessDenied, malformed JSON/list containers, out-of-scope ARNs, exhausted budgets or inconsistent legal-hold associations.

The inventory's \`COMPLETE\` means only that the defined AWS Backup vault/recovery-point/legal-hold surfaces were exhausted for the explicitly supplied scopes without blockers. It does not prove all AWS accounts/regions, all backup providers or all copy destinations were supplied.

## IAM deployment templates

Templates:

- \`deploy/aws/aws-backup-vault-recovery-point-inventory-reader-role-policy.template.json\`
- \`deploy/aws/aws-backup-vault-recovery-point-inventory-reader-role-trust.template.json\`
- \`deploy/aws/aws-backup-vault-recovery-point-inventory-source-role-policy.template.json\`

The reader role policy allows only:

- \`backup:ListBackupVaults\`
- \`backup:DescribeBackupVault\`
- \`backup:ListRecoveryPointsByBackupVault\`
- \`backup:ListLegalHolds\`
- \`backup:GetLegalHold\`
- \`backup:ListRecoveryPointsByLegalHold\`
- \`backup:ListRestoreAccessBackupVaults\`
- `backup:ListCopyJobs`
- `backup:DescribeCopyJob`
- \`sts:GetCallerIdentity\`

The reader policy scopes vault-read actions to the approved account/Region backup-vault ARN and legal-hold actions to the matching legal-hold ARN. Copy-job list/detail operations use `Resource: "*"` because the AWS Backup service authorization reference publishes no resource type for `ListCopyJobs` or `DescribeCopyJob`; these are non-mutating read actions and the explicit `NotAction` deny fence retains the allowlist boundary. Only approved account/Region-wide catalog and job-history discovery, copy-job detail, and STS identity verification use `Resource: "*"`.

Replace placeholders only through the approved cloud-owner process. Independently inspect the deployed trust policy, permission boundary, SCPs, session policies, organization controls and effective permissions. A checked-in policy template is not evidence that a live role exists or is least-privileged.

## Explicit exclusions

1. Copy-job history is enumerated only within the explicit account/Region scopes supplied to the run. Organization-wide coverage is not inferred: cross-account monitoring must be enabled and its opt-in time boundary reviewed, and destination account/Region scopes must be supplied separately.
2. Copies that exist only in accounts/regions not supplied by the caller, external providers, third-party vaults, self-managed database WAL/AOF/RDB, filesystem/block-volume agents and offline media are not discovered.
3. S3 object-version inventories, external DR replicas, provider-specific snapshot exports and object-storage copy destinations are separate copy classes.
4. No restore rehearsal, checksum/byte-level backup validation, PITR replay, failover test, MPA approval, live role review or production deletion is performed.
5. No legal/compliance owner decision, retention-policy approval, or deletion authority is derived from these API responses.

Accordingly `aws_backup_copy_job_catalog_enumerated` is true only for a complete copy-job catalog across the explicitly supplied scopes; `copy_job_destination_reconciliation_complete` is a separate scope/catalog reconciliation gate. `non_aws_backup_external_copy_surfaces_enumerated`, `whole_backup_coverage_complete`, `provider_mutation_performed`, `restore_api_available`, `copy_api_available`, `delete_api_available` and `deletion_authorized` remain false.

## Tests and release boundary

Focused suite: \`services/api/src/saas/aws-backup-vault-recovery-point-inventory.spec.ts\`.

Mocked provider tests cover SigV4 headers, identity mismatch, all three vault types, per-vault describe, paginated vault listing including an empty continuation page, recovery-point lifecycle/encryption/source metadata, restore-access links, legal-hold detail and many-to-many relationship capture, copy-job list/detail calls, copy-job state/lifecycle/destination metadata, empty continuation pages, AccessDenied for list and detail actions, missing destination recovery-point ARNs on completed jobs, cross-account/Region destination scope gaps, repeated-token rejection, missing CreationDate, out-of-scope source vaults, missing hold relationships, duplicate scopes and shared page-budget exhaustion.

No live AWS credentials or production backup vault were used. Before production acceptance, the cloud owner must provision the roles; an independent reviewer must inspect the final effective IAM controls; operators must prove complete organization/account/Region scope, reconcile source-vault and copy-job references, and perform approved representative restore and copy/DR rehearsals with retained evidence.

**Issue #298 remains OPEN. AS-137 / NFR-PROD-14 remain PARTIAL.** This inventory is not a deletion adapter and does not establish whole-tenant erasure.

## AWS references

- [ListBackupVaults](https://docs.aws.amazon.com/aws-backup/latest/APIReference/API_ListBackupVaults.html)
- [DescribeBackupVault](https://docs.aws.amazon.com/aws-backup/latest/APIReference/API_DescribeBackupVault.html)
- [ListRecoveryPointsByBackupVault](https://docs.aws.amazon.com/aws-backup/latest/APIReference/API_ListRecoveryPointsByBackupVault.html)
- [ListLegalHolds](https://docs.aws.amazon.com/aws-backup/latest/APIReference/API_ListLegalHolds.html)
- [GetLegalHold](https://docs.aws.amazon.com/aws-backup/latest/APIReference/API_GetLegalHold.html)
- [ListRecoveryPointsByLegalHold](https://docs.aws.amazon.com/aws-backup/latest/APIReference/API_ListRecoveryPointsByLegalHold.html)
- [ListRestoreAccessBackupVaults](https://docs.aws.amazon.com/aws-backup/latest/APIReference/API_ListRestoreAccessBackupVaults.html)
- [ListCopyJobs](https://docs.aws.amazon.com/aws-backup/latest/APIReference/API_ListCopyJobs.html)
- [DescribeCopyJob](https://docs.aws.amazon.com/aws-backup/latest/APIReference/API_DescribeCopyJob.html)
- [CopyJob response model](https://docs.aws.amazon.com/aws-backup/latest/APIReference/API_CopyJob.html)
- [AWS Backup cross-account monitoring](https://docs.aws.amazon.com/aws-backup/latest/devguide/manage-cross-account.html)
- [AWS Backup cross-account copy](https://docs.aws.amazon.com/aws-backup/latest/devguide/create-cross-account-backup.html)
- [AWS Backup legal holds](https://docs.aws.amazon.com/aws-backup/latest/devguide/legalhold.html)
- [AWS Backup IAM service authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_backup.html)
- [AWS Backup copy-job historical event retention](aws-backup-copy-job-event-retention.md)
