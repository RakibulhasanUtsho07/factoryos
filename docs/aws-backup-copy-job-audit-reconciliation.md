# AWS Backup copy-job audit read-back and reconciliation

**Status:** repository implementation and regression contract only. No AWS stack has been deployed, no replay has been started and no CloudTrail digest/object has been read from a live account in this change.

## Purpose and evidence boundary

The prior event-retention slice supplies an EventBridge archive and an ongoing multi-Region CloudTrail trail. This slice adds an operator-driven read-back path. It does not claim that either provider source is complete: AWS Backup EventBridge delivery and CloudTrail delivery are best effort. Missing events, missing copyJobId, an empty queue, or a source disagreement are not proof that no copy job ran.

EventBridge does not expose a ListEvents API for an archive. The supported read-back path is an archive replay. A replay sends events to the source event bus and supports destination FilterArns; the runner selects only the exact dedicated capture rule. That rule matches only aws.backup / Copy Job State Change events carrying the EventBridge replay-name field and has exactly one SQS target. The rule has a dedicated SQS dead-letter queue and bounded delivery retries. The replay runner never configures other event-bus rules as destinations.

CloudTrail validate-logs --verbose validates the digest chain and the log files referenced by those digest files. It must be run while objects remain in their original S3 location. The exporter reads returned object versions back from S3, verifies KMS encryption, active Object Lock COMPLIANCE retention and legal-hold state, and hashes exact compressed object bytes. It does not move, rewrite, copy, or delete any CloudTrail object. CloudTrail trail home Region is explicitly separate from the AWS Backup EventBridge account/Region being inventoried.

## Files added

- deploy/aws/aws-backup-copy-job-replay-capture.template.json — creates a dedicated encrypted SQS replay-capture queue, an encrypted DLQ, exact EventBridge source-account/SourceArn resource policies, 14-day SQS retention, five-receive SQS redrive and EventBridge delivery retry/DLQ settings.
- scripts/security/preflight-aws-backup-copy-job-replay.mjs — verifies caller account, active indefinite archive, archive source/pattern, enabled replay-only rule, single SQS target, retry/DLQ config, exact queue policies and empty capture/DLQ queues.
- scripts/security/start-aws-backup-copy-job-replay.mjs — rechecks the preflighted rule and queue policies, then starts an EventBridge replay whose Destination contains exactly one FilterArns rule ARN.
- scripts/security/capture-aws-backup-copy-job-replay.mjs — waits for the exact replay to reach COMPLETED, revalidates rule/queue/DLQ, captures matching replay envelopes, hashes each raw envelope, fsyncs and atomically renames the NDJSON file, and only then acknowledges SQS messages.
- scripts/security/export-aws-backup-copy-job-audit-evidence.mjs — requires and binds the original preflight, replay-start and capture receipts; invokes CloudTrail validation twice; pins S3 object versions; checks Object Lock/legal hold; reads exact versions; and builds a source-separated reconciliation artifact.
- scripts/security/sign-aws-backup-copy-job-audit-evidence.mjs — signs the exact evidence-file bytes using a separate Ed25519 owner private key. The key is not loaded by the API.
- scripts/security/verify-aws-backup-copy-job-audit-attestation.mjs — independently verifies the detached signature, exact evidence digest, owner/key references and evidence structure using an out-of-band trusted public key.
- scripts/audit/aws-backup-copy-job-audit-evidence.mjs — bounded parser, digest/identity checks, source-local deduplication, cross-source correlation and Ed25519 attestation verification primitives.
- scripts/audit/aws-backup-copy-job-audit-evidence.test.mjs — regression tests for standard/backfill digest parsing, duplicate conflicts, source scope, SQS isolation, policy drift and signature tampering.

## Operator procedure

Use a dedicated AWS account/Region in which the existing EventBridge archive is active. Deploy the replay-capture stack in the same account and Region as the archive. The CloudFormation template does not create or change the archive or CloudTrail trail. Use a new capture queue or verify that both queues are empty; ensure no unrelated consumer has access to the capture queue.

Deploy the dedicated capture infrastructure from the reviewed branch. Choose names of 64 characters or fewer, and keep the EventBridge capture rule name separate from both SQS queue names.

    aws cloudformation deploy \
      --template-file deploy/aws/aws-backup-copy-job-replay-capture.template.json \
      --stack-name factoryos-backup-copy-replay-capture \
      --parameter-overrides \
        CaptureQueueName=factoryos-backup-copy-replay-capture \
        DeadLetterQueueName=factoryos-backup-copy-replay-capture-dlq \
        CaptureRuleName=factoryos-backup-copy-replay-rule

Read stack outputs with CloudFormation DescribeStacks and copy the exact queue ARNs/URLs, capture rule ARN/name and default event-bus ARN into the owner-controlled manifest/preflight records. The template deploy is an explicit prerequisite; the scripts do not deploy infrastructure automatically.

### 1. Prepare the replay manifest

Save an owner-reviewed JSON file with these fields. Replace every illustrative value; do not commit operational IDs or evidence to the repository.

    {
      "schema": "factoryos.aws-backup-copy-job-replay-capture/v1",
      "accountId": "123456789012",
      "region": "us-east-1",
      "archiveName": "factoryos-backup-copy-job-history",
      "archiveArn": "arn:aws:events:us-east-1:123456789012:archive/factoryos-backup-copy-job-history",
      "replayName": "backup-copy-audit-20261102-01",
      "eventStartTime": "2026-10-20T00:00:00Z",
      "eventEndTime": "2026-11-01T23:59:59Z",
      "captureRuleName": "factoryos-backup-copy-replay-capture",
      "captureQueueArn": "arn:aws:sqs:us-east-1:123456789012:factoryos-backup-copy-replay-capture",
      "captureQueueUrl": "https://sqs.us-east-1.amazonaws.com/123456789012/factoryos-backup-copy-replay-capture",
      "captureDeadLetterQueueArn": "arn:aws:sqs:us-east-1:123456789012:factoryos-backup-copy-replay-capture-dlq",
      "captureDeadLetterQueueUrl": "https://sqs.us-east-1.amazonaws.com/123456789012/factoryos-backup-copy-replay-capture-dlq",
      "maxIdlePolls": 15,
      "maxMessages": 500000
    }

The replay end time must be at least ten minutes old before preflight. Capture defaults to at least 15 consecutive empty long-poll intervals (five minutes) after the replay completes, then checks that the capture queue and DLQ approximate message counts are all zero after acknowledgements. Replay names are limited to 64 characters and must be unique. Split large periods into bounded, non-overlapping UTC windows and use a fresh SQS queue (recommended) or fully drained queue for each run. The preflight checks queue depth and exact SQS resource policies so old messages cannot be mixed with a new evidence interval.

### 2. Preflight, start, and capture

Run from a reviewed checkout with AWS CLI v2 and a least-privilege role:

    node scripts/security/preflight-aws-backup-copy-job-replay.mjs \
      --manifest ./evidence/replay-manifest.json \
      --output ./evidence/replay-preflight.json

    node scripts/security/start-aws-backup-copy-job-replay.mjs \
      --manifest ./evidence/replay-manifest.json \
      --preflight ./evidence/replay-preflight.json \
      --output ./evidence/replay-start.json

    node scripts/security/capture-aws-backup-copy-job-replay.mjs \
      --manifest ./evidence/replay-manifest.json \
      --preflight ./evidence/replay-preflight.json \
      --replay-receipt ./evidence/replay-start.json \
      --output ./evidence/eventbridge-replay.ndjson \
      --summary-output ./evidence/replay-capture-summary.json

The start runner re-hashes the original manifest against the preflight receipt and rechecks the archive state, exact capture rule, queue and DLQ resource policies immediately before StartReplay. It supplies the source default event bus as the destination and a single FilterArns entry for the SQS capture rule. Other enabled event-bus rules are not selected. It creates no AWS Backup copy, restore, delete, or vault mutation.

The capture runner verifies DescribeReplay state, exact source/time range, and that the live replay destination has exactly the single preflighted FilterArn; it checks that each replayed event time falls inside the requested time window, then polls with bounded long polling, message and byte budgets. It retains replay-name and checks account, Region, source and detail type on every message. It writes and fsyncs captured bytes before issuing bounded SQS DeleteMessageBatch calls. If acknowledgement is incomplete, or maxMessages is reached before the queue drains, do not export or sign the pack. Preserve any partial capture for investigation and use a fresh output name for a retry; duplicate envelope IDs are deduplicated downstream. The capture queue's DLQ must remain empty; any delivery failure is a reconciliation gap to resolve, not a silent success.

Replay delivery may be out of order. A replay does not represent a new backup execution; preserve its replay name and original event time. The EventBridge archive remains the source. Do not treat ReplayEndTime or an empty queue as proof that AWS emitted every original state-change event.

### 3. Prepare the CloudTrail audit manifest and export

Save an owner-reviewed file containing:

    {
      "schema": "factoryos.aws-backup-copy-job-audit-input/v1",
      "accountId": "123456789012",
      "region": "us-east-1",
      "archiveArn": "arn:aws:events:us-east-1:123456789012:archive/factoryos-backup-copy-job-history",
      "replayArn": "arn:aws:events:us-east-1:123456789012:replay/backup-copy-audit-20261102-01",
      "replayName": "backup-copy-audit-20261102-01",
      "trailArn": "arn:aws:cloudtrail:us-east-2:123456789012:trail/factoryos-backup-copy-audit",
      "trailHomeRegion": "us-east-2",
      "trailBucket": "factoryos-audit-123456789012",
      "trailS3KeyPrefix": "factoryos/aws-backup-copy",
      "cloudTrailKmsKeyArn": "arn:aws:kms:us-east-2:123456789012:key/11111111-2222-3333-4444-555555555555",
      "startTime": "2026-10-20T00:00:00Z",
      "endTime": "2026-11-01T23:59:59Z"
    }

The trailHomeRegion must equal the Region embedded in trailArn; trailS3KeyPrefix must match the live CloudTrail S3KeyPrefix exactly; cloudTrailKmsKeyArn must be the account's approved customer-managed key in that Region. The exporter re-reads the trail, event selectors, trail status, bucket Region/versioning/Object Lock/KMS/public-access settings, and exact CloudTrail-only bucket-writer/TLS policy. It passes the configured S3 prefix to validate-logs and constrains returned object paths to that prefix plus AWSLogs/<account>/CloudTrail and CloudTrail-Digest trees. The event Region remains the archive's Region; CloudTrail observations are filtered to the target account and event Region, and out-of-scope observations are counted separately.

Run the exporter with all four source/receipt files:

    node scripts/security/export-aws-backup-copy-job-audit-evidence.mjs \
      --manifest ./evidence/audit-input.json \
      --preflight ./evidence/replay-preflight.json \
      --replay-receipt ./evidence/replay-start.json \
      --capture-summary ./evidence/replay-capture-summary.json \
      --event-capture ./evidence/eventbridge-replay.ndjson \
      --output ./evidence/aws-backup-copy-job-audit-evidence.json

The exporter binds the input manifest SHA, preflight receipt SHA, replay-start receipt SHA and capture summary SHA. It verifies that the replay receipt refers to the exact preflight, archive, replay name, account, Region, UTC window and sole capture-rule filter. It requires the capture file's name, bytes and SHA to match the receipt, a drained queue and complete SQS acknowledgement.

The exporter limits one run to 5,000 S3 objects and 1 GiB of decompressed CloudTrail content; split longer/high-volume periods into smaller, contiguous UTC windows rather than lifting these memory/response bounds. Each validation pass has a 15-minute command timeout.\n\nIt then:

1. Reads the live trail, trail status, bucket Region/versioning/Object Lock/KMS/public-access configuration and KMS key state; then runs aws cloudtrail validate-logs --verbose twice against the exact trail ARN, trail home Region and UTC period. Every returned standard and backfill digest file, and every referenced log file, must report valid; parsed verbose object counts must match the summary counts; the two passes must return the same object URI set, time range and counts. Partial or INVALID digest/log summaries fail closed.
2. Parses the CLI's requested and found ranges separately. When the found range does not span the requested window, the output sets requestedWindowFullyCovered=false; this is a disclosed coverage gap, not a full-period validation claim.
3. Validates each returned S3 URI is inside the approved audit bucket/prefix; checks the immutable VersionId, KMS encryption, active Object Lock COMPLIANCE retention and legal-hold state; downloads that exact version and hashes exact object bytes; and heads the object again after read-back to detect version/retention drift.
4. Decompresses within strict per-object/global byte limits (5,000 S3 objects and 1 GiB total decompressed CloudTrail content per run), parses CloudTrail records, extracts only in-window AWS Backup records for the declared account/Region, and reports other account/Region AWS Backup observations intentionally excluded.
5. Deduplicates EventBridge envelope id and CloudTrail eventID separately. Conflicting payload bytes under one source ID are rejected. Cross-source correlation uses copyJobId when present. Records without a copyJobId remain uncorrelated. EventBridge and CloudTrail records remain separate so neither source overwrites the other's provenance.

CloudTrail's digest chain proves integrity of returned, referenced CloudTrail log/digest objects; it does not prove that AWS delivered every event or that all copy classes are known. The artifact always keeps historicalLedgerComplete=false and exhaustiveCopyClassCoverage=false. It also records whether the CLI-reported found range covers the entire requested time window. Owner review must explain any interval/scope gap or source disagreement.

### 4. Owner attestation

Use an independently controlled Ed25519 private key that is not mounted into or readable by the API workload. The signing command refuses a writable/shared private-key file, missing read-back assertions, incomplete SQS capture, or an evidence document that attempts to claim exhaustive coverage.

    node scripts/security/sign-aws-backup-copy-job-audit-evidence.mjs \
      --evidence ./evidence/aws-backup-copy-job-audit-evidence.json \
      --private-key-file ./protected/backup-audit-owner-ed25519.pem \
      --key-id backup-audit-owner-key-2026 \
      --owner-reference security-owner-approval-42 \
      --signature-output ./evidence/aws-backup-copy-job-audit-attestation.json

The detached signature binds exact evidence JSON SHA-256, signing key ID, owner reference and signing timestamp. Preserve the JSON, raw EventBridge NDJSON, capture/preflight/replay receipts, audit input manifest, signature sidecar and CloudTrail object-version inventory as one evidence package. Independently verify the Ed25519 signature with the deployment's reviewed public-key allowlist before importing the pack into any release evidence registry. A valid signature authenticates the signing owner and exact claims; it does not independently authenticate a cloud-provider response or prove provider-side coverage.

Verify the detached attestation on a separate review workstation with the exact trusted public key and independently approved key/owner identifiers:

    node scripts/security/verify-aws-backup-copy-job-audit-attestation.mjs \
      --evidence ./evidence/aws-backup-copy-job-audit-evidence.json \
      --attestation ./evidence/aws-backup-copy-job-audit-attestation.json \
      --public-key-file ./trusted/backup-audit-owner-ed25519-public.pem \
      --expected-key-id backup-audit-owner-key-2026 \
      --expected-owner-reference security-owner-approval-42

Verification checks the exact evidence bytes, Ed25519 signature, key/owner references, validation counts, object-version digests and live COMPLIANCE-retention claims. Store the trusted public key and expected owner/key mapping outside the evidence package under the release authority's controlled trust process.

## Least privilege and operational boundaries

The collection identities need only the provider read operations needed for their phase:

- Preflight/start: STS caller identity, EventBridge DescribeArchive, DescribeRule, ListTargetsByRule, StartReplay, and SQS GetQueueAttributes.
- Capture: EventBridge DescribeArchive/DescribeReplay/DescribeRule/ListTargetsByRule, STS caller identity, SQS GetQueueAttributes, ReceiveMessage, and DeleteMessageBatch on the exact capture queue. SQS delete permission is only for acknowledging messages already fsynced into the local capture evidence file.
- CloudTrail export: CloudTrail log validation reads the original S3 bucket and needs bucket listing, object read and bucket-location read. Exact-version read-back additionally needs GetObjectVersion, Object Lock retention/legal-hold reads, and KMS decrypt permission on the exact audit key. Keep S3 prefix/account and KMS key restrictions narrow. The exporter does not call S3 PutObject/CopyObject/DeleteObject, AWS Backup copy/restore/delete operations, or any AWS Backup mutation API.

Do not put access keys, session tokens, private keys, raw credentials, signed URL query strings, or customer data in manifests or evidence references. Run collection with an isolated read-only role except for SQS message acknowledgement on the dedicated capture queue. The replay-start role separately needs EventBridge StartReplay permission for the exact archive and destination event bus.

## Repository and production acceptance

The CI contract verifies deterministic parser/reconciler/signature behavior, CloudFormation shape, exact SQS/EventBridge scoping and CLI command safety. It does not use a live AWS account. No AWS stack has been deployed by this change. There is no evidence yet that the archive contains the requested history, that a real trail's digest chain validates, that KMS/S3 retention policies are effective, or that the live account has no alternate replay consumers.

Before AS-137 / NFR-PROD-14 can move beyond PARTIAL, an infrastructure operator and a separate evidence reviewer must run this procedure against every approved account/Region, verify the source window and all excluded/out-of-scope events, inspect EventBridge/SQS/DLQ delivery health, validate actual Object Lock/KMS state, reconcile with the current AWS Backup ListCopyJobs API window, and complete replay/DLQ/recovery rehearsals. PostgreSQL WAL/PITR, Redis AOF/RDB, block/filesystem snapshots, backup vaults, replicas/failover, external DR and all other copy classes remain separate inventory work. This processor does not authorize tenant-scoped deletion or mark external backup coverage complete.
