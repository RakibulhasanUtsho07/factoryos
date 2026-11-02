import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);

async function template(path) {
  const raw = await readFile(new URL(path, root), 'utf8');
  return JSON.parse(raw);
}

function resourcesOfType(doc, type) {
  return Object.entries(doc.Resources).filter(([, resource]) => resource.Type === type);
}

test('EventBridge archive retains every AWS Backup copy-job state change indefinitely', async () => {
  const doc = await template('deploy/aws/aws-backup-copy-job-eventbridge-archive.template.json');
  const archives = resourcesOfType(doc, 'AWS::Events::Archive');
  assert.equal(archives.length, 1);
  const archive = archives[0][1];
  assert.deepEqual(archive.Properties.EventPattern.source, ['aws.backup']);
  assert.deepEqual(archive.Properties.EventPattern['detail-type'], ['Copy Job State Change']);
  assert.equal(archive.Properties.RetentionDays, 0, 'RetentionDays=0 is the indefinite archive setting');
  assert.equal(archive.Properties.SourceArn['Fn::Sub'], 'arn:\${AWS::Partition}:events:\${AWS::Region}:\${AWS::AccountId}:event-bus/default');
  assert.equal(archive.Properties.ArchiveName.Ref, 'ArchiveName');
  assert.equal(Object.hasOwn(archive.Properties, 'State'), false);
});

test('CloudTrail is multi-Region, records read/write management events and emits integrity digests', async () => {
  const doc = await template('deploy/aws/aws-backup-copy-job-cloudtrail-audit.template.json');
  const trails = resourcesOfType(doc, 'AWS::CloudTrail::Trail');
  assert.equal(trails.length, 1);
  const trail = trails[0][1];
  assert.equal(trail.Properties.IsLogging, true);
  assert.equal(trail.Properties.IsMultiRegionTrail, true);
  assert.equal(trail.Properties.IncludeGlobalServiceEvents, true);
  assert.equal(trail.Properties.EnableLogFileValidation, true);
  assert.deepEqual(trail.Properties.EventSelectors, [{
    IncludeManagementEvents: true,
    ReadWriteType: 'All',
  }]);
  assert.equal(trail.Properties.S3BucketName.Ref, 'AuditBucket');
  assert.equal(trail.Properties.KMSKeyId.Ref, 'CloudTrailKmsKeyArn');
  assert.equal(trail.DependsOn, 'AuditBucketPolicy');
});

test('CloudTrail audit bucket has versioning, Compliance Object Lock, KMS encryption and retained stack lifecycle', async () => {
  const doc = await template('deploy/aws/aws-backup-copy-job-cloudtrail-audit.template.json');
  const buckets = resourcesOfType(doc, 'AWS::S3::Bucket');
  assert.equal(buckets.length, 1);
  const bucket = buckets[0][1];
  assert.equal(bucket.DeletionPolicy, 'Retain');
  assert.equal(bucket.UpdateReplacePolicy, 'Retain');
  assert.equal(bucket.Properties.ObjectLockEnabled, true);
  assert.deepEqual(bucket.Properties.VersioningConfiguration, { Status: 'Enabled' });
  assert.equal(bucket.Properties.ObjectLockConfiguration.ObjectLockEnabled, 'Enabled');
  assert.deepEqual(bucket.Properties.ObjectLockConfiguration.Rule.DefaultRetention, {
    Mode: 'COMPLIANCE',
    Days: { Ref: 'ApprovedRetentionDays' },
  });
  assert.equal(bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0]
    .ServerSideEncryptionByDefault.SSEAlgorithm, 'aws:kms');
  assert.equal(bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0]
    .ServerSideEncryptionByDefault.KMSMasterKeyID.Ref, 'CloudTrailKmsKeyArn');
  assert.equal(bucket.Properties.OwnershipControls.Rules[0].ObjectOwnership, 'BucketOwnerEnforced');
  assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, {
    BlockPublicAcls: true,
    IgnorePublicAcls: true,
    BlockPublicPolicy: true,
    RestrictPublicBuckets: true,
  });
});

test('owner must supply the Object Lock duration; no retention period is guessed or defaulted', async () => {
  const doc = await template('deploy/aws/aws-backup-copy-job-cloudtrail-audit.template.json');
  const retention = doc.Parameters.ApprovedRetentionDays;
  assert.equal(retention.Type, 'Number');
  assert.equal(Object.hasOwn(retention, 'Default'), false);
  assert.equal(retention.MinValue, 1);
  assert.equal(retention.MaxValue, 36500);
  assert.match(retention.Description, /owner-approved/i);
  const key = doc.Parameters.CloudTrailKmsKeyArn;
  assert.equal(key.Type, 'String');
  assert.equal(Object.hasOwn(key, 'Default'), false);
  assert.match(key.AllowedPattern, /kms/);
});

test('CloudTrail bucket policy grants writes only to the CloudTrail service for the exact trail and account prefix', async () => {
  const doc = await template('deploy/aws/aws-backup-copy-job-cloudtrail-audit.template.json');
  const policies = resourcesOfType(doc, 'AWS::S3::BucketPolicy');
  assert.equal(policies.length, 1);
  const statements = policies[0][1].Properties.PolicyDocument.Statement;
  const acl = statements.find((s) => s.Sid === 'AllowCloudTrailToReadBucketAclForThisTrail');
  const put = statements.find((s) => s.Sid === 'AllowCloudTrailToWriteOnlyThisAccountsTrailObjects');
  const tls = statements.find((s) => s.Sid === 'DenyInsecureTransport');
  assert.equal(acl.Effect, 'Allow');
  assert.deepEqual(acl.Principal, { Service: 'cloudtrail.amazonaws.com' });
  assert.equal(acl.Action, 's3:GetBucketAcl');
  assert.equal(acl.Condition.StringEquals['aws:SourceArn']['Fn::Sub'],
    'arn:\${AWS::Partition}:cloudtrail:\${AWS::Region}:\${AWS::AccountId}:trail/\${TrailName}');
  assert.equal(put.Effect, 'Allow');
  assert.deepEqual(put.Principal, { Service: 'cloudtrail.amazonaws.com' });
  assert.equal(put.Action, 's3:PutObject');
  assert.match(put.Resource['Fn::Sub'], /AWSLogs\/\$\{AWS::AccountId\}\/\*/);
  assert.equal(put.Condition.StringEquals['s3:x-amz-acl'], 'bucket-owner-full-control');
  assert.equal(put.Condition.StringEquals['aws:SourceArn']['Fn::Sub'],
    'arn:\${AWS::Partition}:cloudtrail:\${AWS::Region}:\${AWS::AccountId}:trail/\${TrailName}');
  assert.equal(tls.Effect, 'Deny');
  assert.equal(tls.Condition.Bool['aws:SecureTransport'], 'false');
});

test('templates do not deploy an event consumer or grant a copy/restore/delete privilege', async () => {
  const archive = await template('deploy/aws/aws-backup-copy-job-eventbridge-archive.template.json');
  const trail = await template('deploy/aws/aws-backup-copy-job-cloudtrail-audit.template.json');
  const types = [...Object.values(archive.Resources), ...Object.values(trail.Resources)].map((r) => r.Type);
  assert.equal(types.includes('AWS::Lambda::Function'), false);
  assert.equal(types.includes('AWS::IAM::Role'), false);
  assert.equal(types.includes('AWS::SQS::Queue'), false);
  assert.equal(types.some((type) => /BackupVault|BackupPlan/.test(type)), false);
});

test('documentation distinguishes best-effort events, event retention, CloudTrail digest validation and deployment acceptance', async () => {
  const doc = await readFile(new URL('docs/aws-backup-copy-job-event-retention.md', root), 'utf8');
  assert.match(doc, /best effort/i);
  assert.match(doc, /RetentionDays: 0/);
  assert.match(doc, /COMPLIANCE/);
  assert.match(doc, /EnableLogFileValidation/);
  assert.match(doc, /does \*\*not\*\* execute validation by itself/);
  assert.match(doc, /out of order/i);
  assert.match(doc, /No event consumer/i);
  assert.match(doc, /Issue #298 stays OPEN/);
  assert.match(doc, /SCP template/i);
  assert.match(doc, /exact same-account role ARN/i);
  assert.match(doc, /does not restrict the Organizations management account/i);
  assert.match(doc, /management account/i);
  assert.match(doc, /service-linked roles/i);
});


test('SCP protects the exact archive, trail, audit bucket and KMS key except one exact break-glass role', async () => {
  const raw = await readFile(new URL('deploy/aws/aws-backup-copy-job-audit-retention-guardrail-scp.template.json', root), 'utf8');
  const policy = JSON.parse(raw);
  assert.equal(policy.Version, '2012-10-17');
  assert.equal(policy.Statement.length, 4);
  assert.ok(policy.Statement.every((statement) => statement.Effect === 'Deny'));
  assert.ok(policy.Statement.every((statement) => Array.isArray(statement.Resource) && statement.Resource.length === 1));
  assert.ok(policy.Statement.every((statement) => !statement.Resource[0].includes('*<ACCOUNT_ID>')));
  assert.ok(policy.Statement.every((statement) =>
    statement.Condition?.ArnNotEquals?.['aws:PrincipalArn']
      === 'arn:<PARTITION>:iam::<ACCOUNT_ID>:role/<BREAK_GLASS_ROLE_NAME>'));

  const archive = policy.Statement.find((s) => s.Sid === 'DenyMutationOrDeletionOfFactoryOSBackupCopyEventArchive');
  assert.deepEqual(archive.Action, ['events:DeleteArchive', 'events:UpdateArchive']);
  assert.equal(archive.Resource[0], 'arn:<PARTITION>:events:*:<ACCOUNT_ID>:archive/<ARCHIVE_NAME>');

  const trail = policy.Statement.find((s) => s.Sid === 'DenyStopDeleteOrConfigurationChangesToFactoryOSBackupCopyCloudTrail');
  assert.deepEqual(trail.Action, [
    'cloudtrail:StopLogging',
    'cloudtrail:DeleteTrail',
    'cloudtrail:UpdateTrail',
    'cloudtrail:PutEventSelectors',
  ]);
  assert.equal(trail.Resource[0], 'arn:<PARTITION>:cloudtrail:*:<ACCOUNT_ID>:trail/<TRAIL_NAME>');

  const bucket = policy.Statement.find((s) => s.Sid === 'DenyRemovalOrWeakeningOfCloudTrailAuditBucketControls');
  assert.deepEqual(bucket.Action, [
    's3:DeleteBucket',
    's3:PutBucketPolicy',
    's3:DeleteBucketPolicy',
    's3:PutBucketObjectLockConfiguration',
    's3:PutBucketVersioning',
    's3:PutBucketEncryption',
    's3:DeleteBucketEncryption',
    's3:PutLifecycleConfiguration',
  ]);
  assert.equal(bucket.Resource[0], 'arn:<PARTITION>:s3:::<AUDIT_BUCKET_NAME>');

  const key = policy.Statement.find((s) => s.Sid === 'DenyDisablementOrKeyPolicyChangesToCloudTrailAuditKey');
  assert.deepEqual(key.Action, [
    'kms:DisableKey',
    'kms:ScheduleKeyDeletion',
    'kms:PutKeyPolicy',
    'kms:RevokeGrant',
    'kms:RetireGrant',
  ]);
  assert.equal(key.Resource[0], 'arn:<PARTITION>:kms:<TRAIL_HOME_REGION>:<ACCOUNT_ID>:key/<KMS_KEY_ID>');
  assert.equal(policy.Statement.some((s) => s.Effect === 'Allow'), false);
  assert.equal(policy.Statement.some((s) => s.Resource[0] === '*'), false);
});
