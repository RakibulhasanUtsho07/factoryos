# AWS Backup copy-job historical event retention

**Status:** infrastructure templates and repository contract tests only. No AWS stack has been deployed, no trail has been enabled, and no event archive contents have been read back.

## Problem and evidence boundary

AWS Backup removes terminal copy-job records from the copy-job API after its documented 30-day retention. The ListCopyJobs collector in this repository can therefore enumerate only records still retained by AWS; it cannot recover older terminal jobs.

This release adds two independent AWS-native history sources:

1. **EventBridge archive (one stack per account and backup-enabled Region):** archives direct aws.backup / Copy Job State Change events with RetentionDays: 0, AWS's indefinite-retention setting for an archive. The event pattern includes all job states rather than only successful copies.
2. **CloudTrail multi-Region trail (one stack per account, deployed in a chosen trail home Region):** records all AWS account management events, including AWS Backup API and AWS Backup service-generated CloudTrail events such as CopyJobStarted and CopyJobCompleted; enables CloudTrail log-file integrity validation; delivers logs and digest files into a versioned S3 bucket with a mandatory, explicitly supplied Object Lock Compliance retention period and customer-managed KMS encryption.

These sources overlap but have different semantics. AWS Backup's direct EventBridge state events are best effort and are emitted at roughly five-minute intervals. AWS services also deliver CloudTrail events on a best-effort basis. Therefore **absence of an event is not proof that a copy job did not happen**, and neither source alone is a gap-free copy-job ledger. The retained CloudTrail log files plus digest validation and independent S3 retention checks are the audit-oriented source; EventBridge archive is an independent state-change replay source, not a replacement for CloudTrail.

## Deployment templates

- deploy/aws/aws-backup-copy-job-eventbridge-archive.template.json — deploy once in every account and every Region where AWS Backup runs. It archives the default event bus's complete Copy Job State Change envelope, including CREATED, RUNNING, COMPLETED and FAILED events. The template explicitly sets RetentionDays: 0 (indefinite).
- deploy/aws/aws-backup-copy-job-cloudtrail-audit.template.json — deploy once per account in its selected trail home Region. The trail is multi-Region, includes global service events, records read/write management events, validates log-file integrity and writes to a retained S3 bucket.

For an AWS Organization, distribute the regional archive stack through a reviewed StackSet to every enabled account/Region. The CloudTrail template here is an account-level multi-Region trail; an organization trail and central log-archive account require the organization-specific trail, bucket policy, and account-prefix design to be separately reviewed. Do not deploy a second multi-Region trail with the same purpose in the same account without reconciling existing trails.

### Mandatory owner decisions

The CloudTrail template deliberately has no default for ApprovedRetentionDays. The data owner, security owner and legal/compliance owner must approve the duration before deployment. S3 Object Lock is enabled in **COMPLIANCE** mode; protected object versions cannot be deleted or have retention shortened during their lock period, including by the account root user. This is an intentionally strong, potentially irreversible storage decision, not a universal retention recommendation. Choose the period from the approved legal/security schedule; do not infer it from AWS's 30-day API retention.

The stack also requires a pre-provisioned KMS key in the trail home Region. Its key policy and grants must allow CloudTrail to describe the key and generate data keys for trail delivery, and allow the required S3 encryption path. The template does not create or weaken that key policy. Verify the final effective key policy, SCPs, permission boundaries and key deletion/rotation controls independently.

The S3 bucket is retained by CloudFormation deletion and replacement policies, has versioning, Object Lock default Compliance retention, KMS default encryption, Bucket Owner Enforced ownership, all S3 public-access blocks, and a TLS-only access condition. CloudTrail is the only writer principal allowed by the bucket policy. A generated bucket name avoids cross-account naming collisions.

## Cold-start baseline and event gaps

Neither template backfills events from before its creation. An EventBridge archive starts retaining matching events only after the archive exists and is active. A newly enabled CloudTrail trail likewise starts ongoing delivery from its activation; enabling log validation does not reconstruct older digest files.

Immediately before/after deployment, capture a bounded baseline for every supplied account/Region:
- Run the current AWS Backup ListCopyJobs inventory while the API still exposes the last 30 days of terminal jobs. Preserve the request scope, pagination completion, query receipts, result digest and the exact capture interval.
- Where the relevant records are available in CloudTrail Event history, export the maximum available 90-day regional history and mark the exact returned time window. CloudTrail Event history is a rolling, per-Region management-event view; do not claim events outside its window or visibility.
- Record the archive's creation/activation time and the CloudTrail trail's first successful log and digest delivery times. Mark the earlier interval as a known historical gap unless a separate retained source fills it.

The one-time ListCopyJobs baseline is not a perpetual source and does not extend the AWS API's retention. EventBridge archive does not ingest the CloudTrail Event history export automatically. Keep baseline records separate from ongoing events and bind both into the same reviewed evidence period only after comparing scopes and duplicate/correlation identities.

## Privileged administration guardrail

The companion SCP template `deploy/aws/aws-backup-copy-job-audit-retention-guardrail-scp.template.json` provides four explicit Deny statements for the exact retained resources:

- EventBridge archive: `events:DeleteArchive` and `events:UpdateArchive` on `arn:<PARTITION>:events:*:<ACCOUNT_ID>:archive/<ARCHIVE_NAME>`.
- CloudTrail trail: `cloudtrail:StopLogging`, `cloudtrail:DeleteTrail`, `cloudtrail:UpdateTrail` and `cloudtrail:PutEventSelectors` on `arn:<PARTITION>:cloudtrail:*:<ACCOUNT_ID>:trail/<TRAIL_NAME>`.
- S3 audit bucket: bucket deletion, bucket-policy replacement/removal, Object Lock default-retention changes, versioning/encryption changes and lifecycle changes on the exact bucket ARN.
- KMS audit key: disablement, scheduled deletion, key-policy replacement and grant revocation/retirement on the exact KMS key ARN.

Each statement exempts only the exact same-account role ARN `arn:<PARTITION>:iam::<ACCOUNT_ID>:role/<BREAK_GLASS_ROLE_NAME>` through `ArnNotEquals` on `aws:PrincipalArn`. Fill every placeholder from reviewed CloudFormation outputs/approved account inventory. The archive and trail names must match the deployed stack parameters; the audit bucket name comes from the CloudTrail stack output; the KMS key ARN must identify the pre-provisioned trail-home-Region key. Do not replace the account ID or break-glass role with wildcards. The policy has no Allow statement and grants no new permission.

Attach the SCP from AWS Organizations to every relevant **member account** or parent OU after the trail, archive, bucket and KMS key identities are confirmed. SCPs are guardrails, not grants: the operator identities still require their normal IAM permissions. SCPs do not restrict the Organizations management account or service-linked roles, and an authorized Organizations administrator can detach or change the SCP. Protect the Organizations management account, SCP attachment/change permissions, break-glass role trust/MFA and alert on any SCP detach/change in a separate administrative control plane. Validate the inherited policy using the exact account, role session and resource ARNs before calling the guardrail active.

The exception role is a controlled emergency path, not an everyday operator role. Its owner, MFA/workload authentication, session duration, approval, monitored use, post-incident review and credential revocation must be separately documented. A role assumption or policy change through this identity should trigger an alert and invalidate any affected evidence period until a new archive/trail/bucket/KMS verification is completed.

This SCP template is a policy document, not an Organizations attachment. Repository tests validate its exact action/resource/exception contract; they do not prove that SCPs are enabled in the Organization, that the policy is attached to the correct OUs/accounts, or that an AWS administrator cannot change the management-account control plane.

## Event shape, ordering and deduplication

Keep the **raw envelope bytes** as evidence. The documented EventBridge event includes the envelope id, account, region, time, detail-type, source, and a detail object. AWS copy-job detail can include copyJobId, state, source/destination vault ARNs, creation/completion time and destination recovery-point ARN. Some early-state examples omit copyJobId; a consumer must not drop such an event just because that field is absent.

CloudTrail log entries have their own eventID, eventTime, eventSource, eventName, awsRegion, identity, request and response metadata. AWS documents CopyJobStarted and CopyJobCompleted CloudTrail event names. CloudTrail log files are not an ordered stack trace. EventBridge archive replay can also deliver events out of order and marks replayed events with replay-name.

For any future event consumer or export processor:

- Preserve the raw source record, the source kind, account, Region, provider event time, ingestion time, opaque object/version identity and a SHA-256 digest of the exact retained bytes.
- Deduplicate EventBridge delivery retries by the EventBridge envelope id; deduplicate CloudTrail records by eventID. Keep cross-source observations as separate evidence records even when they correlate to the same copy job, so one source does not erase the provenance of the other.
- Correlate by account/Region, copy-job ID when present, source/destination vault ARN, state and event time. Do not manufacture a job ID for CREATED events that omit it.
- Accept duplicate and out-of-order input. Do not require monotonic arrival order or infer an event sequence solely from SQS/consumer arrival order.
- Preserve replay metadata and distinguish replayed observations from first delivery. Replaying an archive must not be counted as a new AWS copy execution.
- Keep malformed, unknown-state, out-of-scope, conflicting or uncorrelatable records in an unresolved evidence set; never silently discard them.

No event consumer, event-to-database ingestion, automatic replay, copy action or restore action is implemented by these templates. The archive and trail are provider-side retention sources awaiting deployment and independent acceptance.

## Audit and reconciliation procedure

For each account/Region scope, and for each evidence period:

1. Capture the exact trail ARN, event archive ARN/name, account and Region scope, stack/template digest, KMS key ARN and owner-approved Object Lock retention.
2. Check the CloudTrail trail status and delivery/digest delivery error fields. A successful CloudFormation deployment is not proof that log or digest delivery remains healthy.
3. Validate CloudTrail log files and digest chains for the full period using the AWS CloudTrail validate-logs procedure. Enabling EnableLogFileValidation causes digest files to be delivered; it does **not** execute validation by itself.
4. Independently enumerate the S3 log and digest object versions, inspect each object's retention mode/retain-until date/legal-hold state, and verify KMS key status and access. Preserve the results of those reads with the evidence pack.
5. Reconcile the current 30-day ListCopyJobs API window with the overlapping EventBridge/CloudTrail history. Explain every job present in one source and absent from the other; do not convert a mismatch into a silent success.
6. For periods older than the API window, report the archive's known collection window, verified CloudTrail digest range, missing account/Region scopes, delivery errors and event-source limitations. The evidence conclusion must say **historical evidence retained for the verified period**, not "all copies discovered", unless a separate exhaustive provider inventory proves that broader claim.
7. Bind the reviewed export, archive/trail metadata, digest-validation output and reconciliation report into an owner-approved evidence pack. Hash the exact pack and obtain independent owner attestation under the deployment's reviewed evidence trust process. Keep private signing keys outside the API workload.

CloudTrail Event history itself is only a rolling 90-day management-event view per Region. The multi-Region trail is the ongoing record beyond that view. The EventBridge archive is indefinite until its archive is deleted or its retention configuration is changed; protect archive administration and monitor archive state so a privileged deletion or retention change is not mistaken for retained history.

## Known gaps and release disposition

This implementation is **not** live AWS acceptance. Still required:

- Deploy the EventBridge archive in all enabled AWS Backup Regions/accounts and the CloudTrail trail in every relevant account (or separately approve an organization-trail architecture).
- Verify direct AWS Backup event and CloudTrail delivery, EventBridge archive state, and S3 Object Lock/KMS settings against actual provider APIs.
- Continuously validate CloudTrail digest chains and alert on delivery/digest gaps, trail stops, archive deletion/retention changes, KMS disablement and missing regional/account scopes.
- Build and accept a consumer/export process with duplicate handling, out-of-order reconciliation, durable evidence packing and independent owner signing.
- Compare live ListCopyJobs results with the retained event records over their overlapping 30-day period and resolve every source disagreement.
- Rehearse event replay, recovery from a delivery/DLQ or consumer outage, KMS key rotation/revocation, retention expiry, and restore of the evidence archive in an isolated provider staging account.
- Continue to enumerate self-managed WAL/AOF/RDB, volume/filesystem snapshots, S3/third-party copies, replicas and external DR classes separately.

The repository contract test verifies the CloudFormation resource shape only. It does not deploy AWS resources or prove events were delivered, digest chains validate, keys are correctly provisioned, or records are retained in a live account. Issue #298 stays OPEN; AS-137 / NFR-PROD-14 stay PARTIAL.

## AWS reference links

- [AWS Backup Copy Job State Change events](https://docs.aws.amazon.com/aws-backup/latest/devguide/eventbridge.html)
- [AWS Backup CloudTrail events and trail behavior](https://docs.aws.amazon.com/aws-backup/latest/devguide/logging-using-cloudtrail.html)
- [EventBridge archives and replay](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-archive.html)
- [CloudTrail log-file integrity validation](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-log-file-validation-intro.html)
- [CloudTrail digest file structure](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-log-file-validation-digest-file-structure.html)
- [S3 Object Lock configuration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-configure.html)
- [CloudFormation AWS::Events::Archive](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-events-archive.html)
- [CloudFormation AWS::CloudTrail::Trail](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cloudtrail-trail.html)
- [CloudFormation AWS::S3::Bucket](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-s3-bucket.html)

- [AWS EventBridge archive IAM resource ARN](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-manage-iam-access.html)
- [AWS CloudTrail IAM and trail resource ARN](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/security_iam_service-with-iam.html)
- [AWS Organizations SCPs](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html)
- [AWS global aws:PrincipalArn condition key](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-keys.html)
- [Amazon S3 PutBucketLifecycleConfiguration retention implications](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutBucketLifecycleConfiguration.html)
- [AWS KMS service authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_kms.html)


## Read-back and reconciliation companion

The operator-driven read-back path, CloudTrail digest/object-version verification, source-local duplicate-safe reconciliation and detached Ed25519 owner attestation are documented in [AWS Backup copy-job audit read-back and reconciliation](aws-backup-copy-job-audit-reconciliation.md). This repository slice does not imply live AWS deployment or provider acceptance.
