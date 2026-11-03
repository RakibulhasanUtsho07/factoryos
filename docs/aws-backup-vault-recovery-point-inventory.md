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
- \`sts:GetCallerIdentity\`

The policy explicitly denies every action outside that reviewed allowlist. It grants no \`StartBackupJob\`, \`StartCopyJob\`, \`StartRestoreJob\`, \`DeleteRecoveryPoint\`, legal-hold create/cancel, vault mutation, access-policy mutation, tag mutation or KMS data-key operation. The trust template limits the principal to the designated FactoryOS source role and requires a unique ExternalId. The source-role template permits assuming only the dedicated reader role in an explicit target-account allowlist. Add one exact target role ARN for each approved account/partition; do not replace the account placeholder with a wildcard. The reader policy scopes vault-read actions to the approved account/Region backup-vault ARN and legal-hold actions to the matching legal-hold ARN. Only the two account/Region-wide catalog discovery actions and STS identity verification use Resource: "*", because AWS publishes no resource type for those list/identity actions.

Replace placeholders only through the approved cloud-owner process. Independently inspect the deployed trust policy, permission boundary, SCPs, session policies, organization controls and effective permissions. A checked-in policy template is not evidence that a live role exists or is least-privileged.

## Explicit exclusions

1. AWS Backup copy-job history and in-flight job state (\`ListCopyJobs\` / \`DescribeCopyJob\`) are not enumerated by this adapter.
2. Copies that exist only in accounts/regions not supplied by the caller, external providers, third-party vaults, self-managed database WAL/AOF/RDB, filesystem/block-volume agents and offline media are not discovered.
3. S3 object-version inventories, external DR replicas, provider-specific snapshot exports and object-storage copy destinations are separate copy classes.
4. No restore rehearsal, checksum/byte-level backup validation, PITR replay, failover test, MPA approval, live role review or production deletion is performed.
5. No legal/compliance owner decision, retention-policy approval, or deletion authority is derived from these API responses.

Accordingly \`aws_backup_copy_job_catalog_enumerated\`, \`non_aws_backup_external_copy_surfaces_enumerated\`, \`whole_backup_coverage_complete\`, \`provider_mutation_performed\`, \`restore_api_available\`, \`copy_api_available\`, \`delete_api_available\` and \`deletion_authorized\` remain false.

## Tests and release boundary

Focused suite: \`services/api/src/saas/aws-backup-vault-recovery-point-inventory.spec.ts\`.

Mocked provider tests cover SigV4 headers, identity mismatch, all three vault types, per-vault describe, paginated vault listing including an empty continuation page, recovery-point lifecycle/encryption/source metadata, restore-access links, legal-hold detail and many-to-many relationship capture, repeated-token rejection, AccessDenied, missing CreationDate, out-of-scope source vaults, missing hold relationships, duplicate scopes and shared page-budget exhaustion.

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
- [AWS Backup legal holds](https://docs.aws.amazon.com/aws-backup/latest/devguide/legalhold.html)
- [AWS Backup IAM service authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_backup.html)
