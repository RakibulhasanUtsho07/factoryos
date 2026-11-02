import { jest } from '@jest/globals';
import {
  AwsRdsPostgresqlPitrProviderAdapter,
  createAwsRdsPitrRetentionDryRunPlan,
  exchangeAwsRdsPitrWebIdentityToken,
  AWS_RDS_POSTGRESQL_PITR_INVENTORY_SCHEMA,
  AWS_RDS_POSTGRESQL_PITR_RETENTION_PLAN_SCHEMA,
} from './aws-rds-postgresql-pitr-provider.adapter';

const organizationAccount = '111111111111';
const databaseArn = 'arn:aws:rds:ap-southeast-1:111111111111:db:orders-db';
const roleName = 'FactoryOSRdsPitrReadOnly';
const sourceCredentials = {
  access_key_id: 'AKIAABCDEFGHIJKLMNOP',
  secret_access_key: 'source-secret-key-material-0123456789',
};

function xml(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/xml' } });
}

function instanceXml(): string {
  return '<DBInstance>'
    + '<DBInstanceArn>' + databaseArn + '</DBInstanceArn>'
    + '<DBInstanceIdentifier>orders-db</DBInstanceIdentifier>'
    + '<DbiResourceId>db-ABCDEFGHIJKLMNOP</DbiResourceId>'
    + '<Engine>postgres</Engine><DBInstanceStatus>available</DBInstanceStatus>'
    + '<BackupRetentionPeriod>7</BackupRetentionPeriod>'
    + '<LatestRestorableTime>2026-11-01T10:00:00.000Z</LatestRestorableTime>'
    + '<StorageEncrypted>true</StorageEncrypted><MultiAZ>true</MultiAZ>'
    + '</DBInstance>';
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/x-amz-json-1.1' } });
}

type MockRequestBody = URLSearchParams | Record<string, unknown>;

function makeFetch(options: {
  accountPages?: string[];
  roleAccount?: string;
  regionXml?: string;
  instanceXml?: string;
  automatedBackupXml?: string;
  dbSnapshotXml?: string;
  dbClusterSnapshotXml?: string;
  backupStatus?: string;
  backupVaultPages?: string[];
  backupRecoveryPointPages?: string[];
  legalHoldPages?: string[];
  legalHoldRecoveryPointPages?: Record<string, string[]>;
  failAction?: string;
} = {}) {
  const requests: Array<{
    host: string;
    action: string;
    body: MockRequestBody;
    authorization: string;
    target: string;
  }> = [];
  const accountPages = options.accountPages ?? [
    JSON.stringify({ Accounts: [], NextToken: 'empty-first-page-cursor' }),
    JSON.stringify({ Accounts: [{ Id: organizationAccount, State: 'ACTIVE' }] }),
  ];
  let accountPage = 0;
  let backupVaultPage = 0;
  let backupRecoveryPointPage = 0;
  let legalHoldPage = 0;
  const legalHoldRecoveryPointPage: Record<string, number> = {};
  const fetcher = jest.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = init?.headers as Record<string, string> | undefined;
    const target = String(headers?.['x-amz-target'] ?? '');
    const isOrganizations = target === 'AWSOrganizationsV20161128.ListAccounts';
    const isBackup = url.host.startsWith('backup.');
    const isLegalHoldRecoveryPoints = isBackup && url.pathname.includes('/legal-holds/')
      && url.pathname.endsWith('/recovery-points');
    const bodyText = String(init?.body ?? '');
    const body: MockRequestBody = isOrganizations
      ? JSON.parse(bodyText) as Record<string, unknown>
      : isBackup ? Object.fromEntries(url.searchParams.entries()) : new URLSearchParams(bodyText);
    const action = isOrganizations ? 'ListAccounts' : isBackup
      ? (isLegalHoldRecoveryPoints ? 'ListRecoveryPointsByLegalHold'
        : url.pathname === '/legal-holds/' ? 'ListLegalHolds'
          : url.pathname.endsWith('/recovery-points/') ? 'ListRecoveryPointsByBackupVault' : 'ListBackupVaults')
      : (body as URLSearchParams).get('Action') ?? '';
    const authorization = String(headers?.authorization ?? '');
    requests.push({ host: url.host, action, body, authorization, target });
    if (options.failAction === action) {
      return isOrganizations || isBackup
        ? json({ __type: 'com.amazonaws.backup#AccessDeniedException' }, 403)
        : xml('<ErrorResponse><Error><Code>AccessDenied</Code></Error></ErrorResponse>', 403);
    }
    if (action === 'GetCallerIdentity') {
      const temporary = authorization.includes('ASIAABCDEFGHIJKLMNOP');
      const account = temporary ? (options.roleAccount ?? organizationAccount) : organizationAccount;
      const arn = temporary
        ? 'arn:aws:sts::' + account + ':assumed-role/' + roleName + '/FactoryOSPitrInventory'
        : 'arn:aws:sts::' + organizationAccount + ':assumed-role/OrganizationReadOnly/source-session';
      return xml('<GetCallerIdentityResponse><GetCallerIdentityResult><Account>'
        + account + '</Account><Arn>' + arn + '</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>');
    }
    if (action === 'AssumeRole') {
      const queryBody = body as URLSearchParams;
      if (queryBody.get('RoleArn') !== 'arn:aws:iam::' + organizationAccount + ':role/' + roleName) {
        return xml('<ErrorResponse><Error><Code>AccessDenied</Code></Error></ErrorResponse>');
      }
      return xml('<AssumeRoleResponse><AssumeRoleResult><Credentials>'
        + '<AccessKeyId>ASIAABCDEFGHIJKLMNOP</AccessKeyId>'
        + '<SecretAccessKey>temporary-secret-key-material-0123456789</SecretAccessKey>'
        + '<SessionToken>temporary-session-token-material-0123456789</SessionToken>'
        + '</Credentials></AssumeRoleResult></AssumeRoleResponse>');
    }
    if (action === 'ListBackupVaults') {
      const pages = options.backupVaultPages ?? [JSON.stringify({
        BackupVaultList: [{
          BackupVaultName: 'default',
          BackupVaultArn: 'arn:aws:backup:ap-southeast-1:111111111111:backup-vault:default',
          VaultType: 'BACKUP_VAULT',
          VaultState: 'AVAILABLE',
          Locked: false,
          NumberOfRecoveryPoints: 1,
          EncryptionKeyArn: 'arn:aws:kms:ap-southeast-1:111111111111:key/abcd1234',
          CreationDate: '2026-10-01T00:00:00.000Z'
        }]
      })];
      return new Response(pages[backupVaultPage++] ?? pages[pages.length - 1]!, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (action === 'ListLegalHolds') {
      const pages = options.legalHoldPages ?? [JSON.stringify({ LegalHolds: [] })];
      return new Response(pages[legalHoldPage++] ?? pages[pages.length - 1]!, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (action === 'ListRecoveryPointsByLegalHold') {
      const legalHoldId = url.pathname.split('/').filter(Boolean)[1] ?? '';
      const pages = options.legalHoldRecoveryPointPages?.[legalHoldId] ?? [JSON.stringify({ RecoveryPoints: [] })];
      const pageKey = 'legal:' + legalHoldId;
      const pageIndex = legalHoldRecoveryPointPage[pageKey] ?? 0;
      legalHoldRecoveryPointPage[pageKey] = pageIndex + 1;
      return new Response(pages[pageIndex] ?? pages[pages.length - 1]!, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (action === 'ListRecoveryPointsByBackupVault') {
      const pages = options.backupRecoveryPointPages ?? [JSON.stringify({
        RecoveryPoints: [{
          RecoveryPointArn: 'arn:aws:backup:ap-southeast-1:111111111111:recovery-point:12345678-1234-1234-1234-123456789012',
          BackupVaultArn: 'arn:aws:backup:ap-southeast-1:111111111111:backup-vault:default',
          BackupVaultName: 'default',
          ResourceArn: 'arn:aws:rds:ap-southeast-1:111111111111:db:orders-db',
          ResourceType: 'RDS',
          Status: 'COMPLETED',
          CreationDate: '2026-11-01T00:00:00.000Z',
          CompletionDate: '2026-11-01T00:05:00.000Z',
          LastRestoreTime: null,
          Lifecycle: { DeleteAfterDays: 365, MoveToColdStorageAfterDays: null },
          CalculatedLifecycle: { DeleteAt: 1796102400, MoveToColdStorageAt: null },
          IsEncrypted: true,
          EncryptionKeyArn: 'arn:aws:kms:ap-southeast-1:111111111111:key/abcd1234',
          BackupSizeInBytes: 987654321
        }]
      })];
      return new Response(pages[backupRecoveryPointPage++] ?? pages[pages.length - 1]!, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (action === 'ListAccounts') {
      return new Response(accountPages[accountPage++] ?? accountPages[accountPages.length - 1]!, {
        status: 200,
        headers: { 'content-type': 'application/x-amz-json-1.1' },
      });
    }
    if (action === 'DescribeRegions') {
      return xml(options.regionXml ?? '<DescribeRegionsResponse><DescribeRegionsResult><regionInfo>'
        + '<item><regionName>ap-southeast-1</regionName><optInStatus>opted-in</optInStatus></item>'
        + '<item><regionName>me-central-1</regionName><optInStatus>not-opted-in</optInStatus></item>'
        + '</regionInfo></DescribeRegionsResult></DescribeRegionsResponse>');
    }
    const rdsActions = new Set([
      'DescribeDBInstances', 'DescribeDBClusters', 'DescribeGlobalClusters',
      'DescribeDBInstanceAutomatedBackups', 'DescribeDBSnapshots', 'DescribeDBClusterSnapshots',
    ]);
    if (rdsActions.has(action)) {
      const resultTag = action + 'Result';
      const collectionTag = action === 'DescribeDBInstances' ? 'DBInstances'
        : action === 'DescribeDBClusters' ? 'DBClusters'
          : action === 'DescribeGlobalClusters' ? 'GlobalClusters'
            : action === 'DescribeDBInstanceAutomatedBackups' ? 'DBInstanceAutomatedBackups'
              : action === 'DescribeDBSnapshots' ? 'DBSnapshots' : 'DBClusterSnapshots';
      const item = action === 'DescribeDBInstances' ? (options.instanceXml ?? instanceXml()) : '';
      const snapshotItem = action === 'DescribeDBSnapshots' ? (options.dbSnapshotXml ?? '') : '';
      const clusterSnapshotItem = action === 'DescribeDBClusterSnapshots' ? (options.dbClusterSnapshotXml ?? '') : '';
      const backupItem = action === 'DescribeDBInstanceAutomatedBackups'
        ? (options.automatedBackupXml ?? '<DBInstanceAutomatedBackup>'
          + '<DBInstanceArn>' + databaseArn + '</DBInstanceArn>'
          + '<DbiResourceId>db-ABCDEFGHIJKLMNOP</DbiResourceId>'
          + '<DBInstanceIdentifier>orders-db</DBInstanceIdentifier>'
          + '<Region>ap-southeast-1</Region><Engine>postgres</Engine>'
          + '<Status>' + (options.backupStatus ?? 'active') + '</Status><BackupRetentionPeriod>7</BackupRetentionPeriod>'
          + '<RestoreWindow><EarliestTime>2026-10-27T00:00:00.000Z</EarliestTime>'
          + '<LatestTime>2026-11-01T10:00:00.000Z</LatestTime></RestoreWindow>'
          + '</DBInstanceAutomatedBackup>')
        : '';
      return xml('<' + action + 'Response><' + resultTag + '><' + collectionTag + '>'
        + item + backupItem + snapshotItem + clusterSnapshotItem + '</' + collectionTag + '></' + resultTag + '></' + action + 'Response>');
    }
    return xml('<ErrorResponse><Error><Code>UnsupportedAction</Code></Error></ErrorResponse>');
  });
  return { fetcher, requests };
}

function createAdapter(fetcher: typeof fetch, overrides: Record<string, unknown> = {}) {
  return new AwsRdsPostgresqlPitrProviderAdapter({
    organization_account_id: organizationAccount,
    read_only_role_name: roleName,
    external_id: 'factoryos-wp10-aws-pitr-test-external-id',
    organization_region: 'us-east-1',
    read_only_policy_sha256: 'a'.repeat(64),
    policy_review_reference: 'review.aws.read-only-role.v1',
    ...overrides,
  }, sourceCredentials, fetcher, () => new Date('2026-11-02T04:00:00.000Z'));
}

describe('AwsRdsPostgresqlPitrProviderAdapter', () => {
  it('exhausts an empty Organizations continuation page and inventories RDS catalogs in every enabled region', async () => {
    const mock = makeFetch();
    const adapter = createAdapter(mock.fetcher);
    const result = await adapter.captureInventory();

    expect(result.schema).toBe(AWS_RDS_POSTGRESQL_PITR_INVENTORY_SCHEMA);
    expect(result.status).toBe('ENUMERATED_WITH_EXPLICIT_GAPS');
    expect(result.account_discovery_complete).toBe(true);
    expect(result.region_discovery_complete).toBe(true);
    expect(result.pagination_exhausted).toBe(true);
    expect(result.accounts_discovered).toBe(1);
    expect(result.scopes_discovered).toBe(1);
    expect(result.excluded_regions).toEqual([
      { account_id: organizationAccount, region: 'me-central-1', opt_in_status: 'not-opted-in' },
    ]);
    expect(result.sources.find((source) => source.source_kind === 'POSTGRESQL_CLUSTER_CATALOG')?.items[0]?.resource_arn)
      .toBe(databaseArn);
    expect(result.sources.find((source) => source.source_kind === 'WAL_SEGMENT_CATALOG')?.status)
      .toBe('OPAQUE_PROVIDER_MANAGED');
    expect(result.sources.find((source) => source.source_kind === 'WAL_WRITER_PRINCIPAL_CATALOG')?.status)
      .toBe('NOT_ENUMERATED');
    expect(result.sources.find((source) => source.source_kind === 'PITR_RESTORE_PATH_CATALOG')?.status)
      .toBe('PARTIAL');
    expect(result.collector_policy_independently_verified).toBe(false);
    expect(result.source_receipts_signable).toBe(false);
    expect(result.manifest_eligible).toBe(false);
    expect(result.deletion_authorized).toBe(false);

    const accountRequests = mock.requests.filter((request) => request.action === 'ListAccounts');
    expect(accountRequests).toHaveLength(2);
    expect(accountRequests[0]!.target).toBe('AWSOrganizationsV20161128.ListAccounts');
    expect((accountRequests[0]!.body as Record<string, unknown>).NextToken).toBeUndefined();
    expect((accountRequests[1]!.body as Record<string, unknown>).NextToken).toBe('empty-first-page-cursor');
    expect(mock.requests.every((request) =>
      request.authorization.startsWith('AWS4-HMAC-SHA256 Credential='))).toBe(true);
    expect(mock.requests.some((request) => request.action.startsWith('Delete'))).toBe(false);
    expect(mock.requests.some((request) => request.action.startsWith('Modify'))).toBe(false);
    expect(result.total_provider_requests).toBe(mock.requests.length);
    expect(result.backup_vault_catalog_complete).toBe(true);
    expect(result.aws_backup_recovery_points_enumerated).toBe(true);
    expect(result.aws_backup_legal_holds_enumerated).toBe(true);
    expect(result.aws_backup_legal_holds).toEqual([]);
    expect(result.backup_vaults).toHaveLength(1);
    expect(result.aws_backup_recovery_points).toHaveLength(1);
    expect(result.aws_backup_receipt_references.length).toBeGreaterThan(0);
    expect(result.sources.find((source) => source.source_kind === 'PITR_RESTORE_PATH_CATALOG')?.query_receipt_references)
      .toEqual(expect.arrayContaining(result.aws_backup_receipt_references));
    expect(result.aws_backup_recovery_points[0]?.recovery_point_arn)
      .toBe('arn:aws:backup:ap-southeast-1:111111111111:recovery-point:12345678-1234-1234-1234-123456789012');
  });

  it('marks non-active organization accounts as excluded and never claims complete account coverage', async () => {
    const inactiveAccounts = [
      JSON.stringify({ Accounts: [{ Id: organizationAccount, State: 'SUSPENDED' }] }),
    ];
    const mock = makeFetch({ accountPages: inactiveAccounts });
    const result = await createAdapter(mock.fetcher).captureInventory();
    expect(result.status).toBe('INCOMPLETE');
    expect(result.account_discovery_complete).toBe(false);
    expect(result.excluded_accounts[0]?.state).toBe('SUSPENDED');
    expect(mock.requests.some((request) => request.action === 'AssumeRole')).toBe(false);
  });

  it('fails closed on a repeated Organizations continuation token', async () => {
    const repeated = [
      JSON.stringify({ Accounts: [], NextToken: 'same-token' }),
      JSON.stringify({ Accounts: [{ Id: organizationAccount, State: 'ACTIVE' }], NextToken: 'same-token' }),
    ];
    const mock = makeFetch({ accountPages: repeated });
    await expect(createAdapter(mock.fetcher).captureInventory()).rejects.toThrow(/repeated continuation token/i);
  });

  it('fails closed when an assumed role resolves to a different account identity', async () => {
    const mock = makeFetch({ roleAccount: '999999999999' });
    await expect(createAdapter(mock.fetcher).captureInventory()).rejects.toThrow(/expected account/i);
  });

  it('fails closed when an AWS read API is denied instead of recording an empty catalog', async () => {
    const mock = makeFetch({ failAction: 'DescribeDBInstances' });
    await expect(createAdapter(mock.fetcher).captureInventory()).rejects.toThrow(/AccessDenied/);
  });

  it('fails closed when the global request/page budget is exhausted', async () => {
    const mock = makeFetch();
    const adapter = createAdapter(mock.fetcher, { max_total_pages: 5 });
    await expect(adapter.captureInventory()).rejects.toThrow(/global page\/request budget/i);
  });

  it('builds only a dry-run plan and blocks while WAL, writer and AWS Backup coverage remain unresolved', async () => {
    const mock = makeFetch();
    const inventory = await createAdapter(mock.fetcher).captureInventory();
    const plan = createAwsRdsPitrRetentionDryRunPlan({
      inventory,
      candidate_provider_identity_reference: inventory.sources.find((source) => source.source_kind === 'WAL_ARCHIVE_DESTINATION_CATALOG')!.items.find((item) => item.resource_type === 'RDS_AUTOMATED_BACKUP')!.provider_identity_reference,
      expected_account_id: organizationAccount,
      expected_region: 'ap-southeast-1',
      minimum_recovery_horizon_end_at: '2026-10-30T00:00:00.000Z',
      retention_expires_at: '2026-10-31T00:00:00.000Z',
      legal_hold_status: 'NONE',
      dependency_status: 'NO_DEPENDENCY',
      policy_reference: 'retention-policy.v1',
      data_owner_approval_reference: 'data-owner-review.v1',
      infrastructure_owner_approval_reference: 'infra-owner-review.v1',
    });
    expect(plan.schema).toBe(AWS_RDS_POSTGRESQL_PITR_RETENTION_PLAN_SCHEMA);
    expect(plan.status).toBe('BLOCKED');
    expect(plan.blockers).toContain('Provider-managed WAL segments remain opaque and are not individually enumerated.');
    expect(plan.blockers).toContain('Database-native writer and replication principal coverage is incomplete or unavailable.');
    expect(plan.operation).toBe('DRY_RUN_ONLY');
    expect(plan.provider_mutation_performed).toBe(false);
    expect(plan.delete_api_available).toBe(false);
    expect(plan.deletion_authorized).toBe(false);
  });

  it('binds a retained backup to its stable DbiResourceId, not its DBInstanceArn field', async () => {
    const mock = makeFetch({ backupStatus: 'retained' });
    const inventory = await createAdapter(mock.fetcher).captureInventory();
    const source = inventory.sources.find((entry) => entry.source_kind === 'WAL_ARCHIVE_DESTINATION_CATALOG');
    const backup = source?.items.find((item) => item.resource_type === 'RDS_AUTOMATED_BACKUP');
    expect(backup?.resource_arn).toBeNull();
    expect(backup?.identity_kind).toBe('SOURCE_DB_RESOURCE_ID');
    expect(backup?.provider_delete_identity_reference).toBe('db-ABCDEFGHIJKLMNOP');
    expect(backup?.provider_delete_identity_kind).toBe('DBI_RESOURCE_ID');
    expect(backup?.provider_identity_reference).toMatch(/^aws-rds-resource\./);
    expect(backup?.attributes.DBIResourceId ?? backup?.attributes.DbiResourceId).toBe('db-ABCDEFGHIJKLMNOP');
    expect(backup?.source_database_reference).toBe('orders-db');
    expect(backup?.attributes.DBInstanceArn).toBe(databaseArn);

    const plan = createAwsRdsPitrRetentionDryRunPlan({
      inventory,
      candidate_provider_identity_reference: backup!.provider_identity_reference,
      expected_account_id: organizationAccount,
      expected_region: 'ap-southeast-1',
      minimum_recovery_horizon_end_at: '2026-10-30T00:00:00.000Z',
      retention_expires_at: '2026-10-31T00:00:00.000Z',
      legal_hold_status: 'NONE',
      dependency_status: 'NO_DEPENDENCY',
    });
    expect(plan.status).toBe('BLOCKED');
    expect(plan.candidate_resource_arn).toBeNull();
    expect(plan.provider_delete_identity_reference).toBe('db-ABCDEFGHIJKLMNOP');
    expect(plan.provider_delete_identity_kind).toBe('DBI_RESOURCE_ID');
    expect(plan.blockers).toContain('Provider-managed WAL segments remain opaque and are not individually enumerated.');
    expect(plan.blockers).toContain('Database-native writer and replication principal coverage is incomplete or unavailable.');
  });

  it('uses the separate replicated automated-backup ARN when AWS supplies one', async () => {
    const replicatedArn = 'arn:aws:rds:ap-southeast-1:111111111111:auto-backup:ab-0123456789ABCDEF';
    const automatedBackupXml = '<DBInstanceAutomatedBackup>'
      + '<DBInstanceArn>' + databaseArn + '</DBInstanceArn>'
      + '<DBInstanceAutomatedBackupsArn>' + replicatedArn + '</DBInstanceAutomatedBackupsArn>'
      + '<DbiResourceId>db-ABCDEFGHIJKLMNOP</DbiResourceId>'
      + '<DBInstanceIdentifier>orders-db</DBInstanceIdentifier>'
      + '<Region>ap-southeast-1</Region><Engine>postgres</Engine><Status>replicating</Status>'
      + '</DBInstanceAutomatedBackup>';
    const mock = makeFetch({ automatedBackupXml });
    const inventory = await createAdapter(mock.fetcher).captureInventory();
    const backup = inventory.sources.find((entry) => entry.source_kind === 'WAL_ARCHIVE_DESTINATION_CATALOG')
      ?.items.find((item) => item.resource_type === 'RDS_AUTOMATED_BACKUP');
    expect(backup?.resource_arn).toBe(replicatedArn);
    expect(backup?.identity_kind).toBe('IMMUTABLE_RESOURCE_ARN');
    expect(backup?.provider_delete_identity_reference).toBe(replicatedArn);
    expect(backup?.provider_delete_identity_kind).toBe('REPLICATED_BACKUP_ARN');
    expect(backup?.attributes.DBInstanceArn).toBe(databaseArn);
  });

  it('blocks a candidate ARN whose account or region does not match the selected scope', async () => {
    const mock = makeFetch();
    const inventory = await createAdapter(mock.fetcher).captureInventory();
    const plan = createAwsRdsPitrRetentionDryRunPlan({
      inventory,
      candidate_provider_identity_reference: inventory.sources.find((source) => source.source_kind === 'WAL_ARCHIVE_DESTINATION_CATALOG')!.items.find((item) => item.resource_type === 'RDS_AUTOMATED_BACKUP')!.provider_identity_reference,
      expected_account_id: organizationAccount,
      expected_region: 'us-east-1',
      minimum_recovery_horizon_end_at: '2026-10-30T00:00:00.000Z',
      retention_expires_at: '2026-10-31T00:00:00.000Z',
      legal_hold_status: 'NONE',
      dependency_status: 'NO_DEPENDENCY',
    });
    expect(plan.status).toBe('BLOCKED');
    expect(plan.blockers.join(' ')).toMatch(/expected inventory account\/region scope|Expected account\/region is not present/i);
  });


  it('rejects unknown AWS region opt-in states instead of silently dropping the region', async () => {
    const regionXml = '<DescribeRegionsResponse><DescribeRegionsResult><regionInfo>'
      + '<item><regionName>ap-southeast-1</regionName><optInStatus>future-state</optInStatus></item>'
      + '</regionInfo></DescribeRegionsResult></DescribeRegionsResponse>';
    const mock = makeFetch({ regionXml });
    await expect(createAdapter(mock.fetcher).captureInventory()).rejects.toThrow(/unknown opt-in status/i);
  });

  it('rejects an AWS RDS response page larger than the requested MaxRecords', async () => {
    const oversized = Array.from({ length: 101 }, () => instanceXml()).join('');
    const mock = makeFetch({ instanceXml: oversized });
    await expect(createAdapter(mock.fetcher).captureInventory()).rejects.toThrow(/more items than its requested page size/i);
  });

  it('rejects an Organizations JSON page larger than its MaxResults limit', async () => {
    const manyAccounts = Array.from({ length: 21 }, (_, index) => ({
      Id: String(200000000000 + index),
      State: 'ACTIVE',
    }));
    const mock = makeFetch({ accountPages: [JSON.stringify({ Accounts: manyAccounts })] });
    await expect(createAdapter(mock.fetcher).captureInventory()).rejects.toThrow(/per-page or total account item budget/i);
  });



  it('rejects an AWS Backup recovery point whose source DB ARN belongs to another account or region', async () => {
    const mock = makeFetch({
      backupRecoveryPointPages: [JSON.stringify({ RecoveryPoints: [{
        RecoveryPointArn: 'arn:aws:backup:ap-southeast-1:111111111111:recovery-point:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        BackupVaultArn: 'arn:aws:backup:ap-southeast-1:111111111111:backup-vault:default',
        BackupVaultName: 'default',
        ResourceArn: 'arn:aws:rds:us-east-1:999999999999:db:foreign-db',
        ResourceType: 'RDS',
        Status: 'COMPLETED',
        CreationDate: '2026-11-01T00:00:00.000Z',
      }] })],
    });
    await expect(createAdapter(mock.fetcher).captureInventory())
      .rejects.toThrow(/outside the exact requested source account\/region/i);
  });

  it('rejects an AWS Backup recovery point returned under a different vault identity', async () => {
    const mock = makeFetch({
      backupRecoveryPointPages: [JSON.stringify({ RecoveryPoints: [{
        RecoveryPointArn: 'arn:aws:backup:ap-southeast-1:111111111111:recovery-point:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        BackupVaultArn: 'arn:aws:backup:ap-southeast-1:111111111111:backup-vault:foreign-vault',
        BackupVaultName: 'foreign-vault',
        ResourceArn: databaseArn,
        ResourceType: 'RDS',
        Status: 'COMPLETED',
        CreationDate: '2026-11-01T00:00:00.000Z',
      }] })],
    });
    await expect(createAdapter(mock.fetcher).captureInventory())
      .rejects.toThrow(/exact requested vault identity/i);
  });

  it('enumerates active AWS Backup legal-hold recovery points and blocks a matching retention candidate', async () => {
    const recoveryPointArn = 'arn:aws:backup:ap-southeast-1:111111111111:recovery-point:12345678-1234-1234-1234-123456789012';
    const mock = makeFetch({
      legalHoldPages: [JSON.stringify({ LegalHolds: [{
        LegalHoldId: 'hold-2026-001',
        LegalHoldArn: 'arn:aws:backup:ap-southeast-1:111111111111:recovery-point:hold-2026-001',
        Status: 'ACTIVE',
        CreationDate: '2026-10-31T00:00:00.000Z',
      }] })],
      legalHoldRecoveryPointPages: {
        'hold-2026-001': [
          JSON.stringify({ RecoveryPoints: [], NextToken: 'empty-hold-page' }),
          JSON.stringify({ RecoveryPoints: [{ RecoveryPointArn: recoveryPointArn }] }),
        ],
      },
    });
    const inventory = await createAdapter(mock.fetcher).captureInventory();
    expect(inventory.aws_backup_legal_holds_enumerated).toBe(true);
    expect(inventory.aws_backup_legal_holds).toHaveLength(1);
    expect(inventory.aws_backup_legal_holds[0]?.status).toBe('ACTIVE');
    expect(inventory.aws_backup_legal_hold_recovery_point_arns).toEqual([recoveryPointArn]);

    const recoveryPoint = inventory.sources.find((source) => source.source_kind === 'PITR_RESTORE_PATH_CATALOG')
      ?.items.find((item) => item.resource_type === 'AWS_BACKUP_RECOVERY_POINT');
    expect(recoveryPoint?.resource_arn).toBe(recoveryPointArn);
    const plan = createAwsRdsPitrRetentionDryRunPlan({
      inventory,
      candidate_provider_identity_reference: recoveryPoint!.provider_identity_reference,
      candidate_resource_arn: recoveryPointArn,
      expected_account_id: organizationAccount,
      expected_region: 'ap-southeast-1',
      minimum_recovery_horizon_end_at: '2026-10-30T00:00:00.000Z',
      retention_expires_at: '2026-10-31T00:00:00.000Z',
      legal_hold_status: 'NONE',
      dependency_status: 'NO_DEPENDENCY',
    });
    expect(plan.status).toBe('BLOCKED');
    expect(plan.provider_delete_identity_kind).toBe('AWS_BACKUP_RECOVERY_POINT_ARN');
    expect(plan.blockers).toContain('Candidate recovery point is covered by an active AWS Backup legal hold.');
  });


  it('accepts the documented AWS Backup legal-hold ARN resource form while retaining exact account/region binding', async () => {
    const mock = makeFetch({
      legalHoldPages: [JSON.stringify({ LegalHolds: [{
        LegalHoldId: 'hold-documented-arn',
        LegalHoldArn: 'arn:aws:backup:ap-southeast-1:111111111111:recovery-point:hold-documented-arn',
        Status: 'ACTIVE',
      }] })],
    });
    const inventory = await createAdapter(mock.fetcher).captureInventory();
    expect(inventory.aws_backup_legal_holds[0]?.legal_hold_arn)
      .toBe('arn:aws:backup:ap-southeast-1:111111111111:recovery-point:hold-documented-arn');
  });

  it('blocks retention planning while an AWS Backup legal hold is creating or canceling', async () => {
    const mock = makeFetch({
      legalHoldPages: [JSON.stringify({ LegalHolds: [
        { LegalHoldId: 'hold-2026-creating', Status: 'CREATING' },
        { LegalHoldId: 'hold-2026-cancelling', Status: 'CANCELLING' },
      ] })],
    });
    const inventory = await createAdapter(mock.fetcher).captureInventory();
    expect(inventory.aws_backup_legal_hold_scope_status_uncertain).toBe(true);
    expect(inventory.aws_backup_legal_holds.map((hold) => hold.status)).toEqual(['CREATING', 'CANCELLING']);
    const recoveryPoint = inventory.sources.find((source) => source.source_kind === 'PITR_RESTORE_PATH_CATALOG')
      ?.items.find((item) => item.resource_type === 'AWS_BACKUP_RECOVERY_POINT');
    const plan = createAwsRdsPitrRetentionDryRunPlan({
      inventory,
      candidate_provider_identity_reference: recoveryPoint!.provider_identity_reference,
      candidate_resource_arn: recoveryPoint!.resource_arn ?? undefined,
      expected_account_id: organizationAccount,
      expected_region: 'ap-southeast-1',
      minimum_recovery_horizon_end_at: '2026-10-30T00:00:00.000Z',
      retention_expires_at: '2026-10-31T00:00:00.000Z',
      legal_hold_status: 'NONE',
      dependency_status: 'NO_DEPENDENCY',
    });
    expect(plan.status).toBe('BLOCKED');
    expect(plan.blockers).toContain('An AWS Backup legal hold is being created/canceled; legal-hold scope is not stable.');
  });



  it('reconciles an RDS automated backup AwsBackupRecoveryPointArn with AWS Backup legal-hold membership', async () => {
    const recoveryPointArn = 'arn:aws:backup:ap-southeast-1:111111111111:recovery-point:12345678-1234-1234-1234-123456789012';
    const automatedBackupXml = '<DBInstanceAutomatedBackup>'
      + '<DBInstanceArn>' + databaseArn + '</DBInstanceArn>'
      + '<DbiResourceId>db-ABCDEFGHIJKLMNOP</DbiResourceId>'
      + '<AwsBackupRecoveryPointArn>' + recoveryPointArn + '</AwsBackupRecoveryPointArn>'
      + '<DBInstanceIdentifier>orders-db</DBInstanceIdentifier>'
      + '<Region>ap-southeast-1</Region><Engine>postgres</Engine>'
      + '<Status>retained</Status><BackupRetentionPeriod>7</BackupRetentionPeriod>'
      + '</DBInstanceAutomatedBackup>';
    const mock = makeFetch({
      automatedBackupXml,
      backupVaultPages: [JSON.stringify({ BackupVaultList: [{
        BackupVaultName: 'default',
        BackupVaultArn: 'arn:aws:backup:ap-southeast-1:111111111111:backup-vault:default',
        VaultType: 'BACKUP_VAULT',
        VaultState: 'AVAILABLE',
        Locked: false,
        NumberOfRecoveryPoints: 1,
      }] })],
      legalHoldPages: [JSON.stringify({ LegalHolds: [{
        LegalHoldId: 'hold-rds-link-01',
        LegalHoldArn: 'arn:aws:backup:ap-southeast-1:111111111111:recovery-point:hold-rds-link-01',
        Status: 'ACTIVE',
      }] })],
      legalHoldRecoveryPointPages: {
        'hold-rds-link-01': [JSON.stringify({ RecoveryPoints: [{ RecoveryPointArn: recoveryPointArn }] })],
      },
    });
    const inventory = await createAdapter(mock.fetcher).captureInventory();
    const backup = inventory.sources.find((source) => source.source_kind === 'WAL_ARCHIVE_DESTINATION_CATALOG')
      ?.items.find((item) => item.resource_type === 'RDS_AUTOMATED_BACKUP');
    expect(backup?.attributes.AwsBackupRecoveryPointArn).toBe(recoveryPointArn);
    const plan = createAwsRdsPitrRetentionDryRunPlan({
      inventory,
      candidate_provider_identity_reference: backup!.provider_identity_reference,
      expected_account_id: organizationAccount,
      expected_region: 'ap-southeast-1',
      minimum_recovery_horizon_end_at: '2026-10-30T00:00:00.000Z',
      retention_expires_at: '2026-10-31T00:00:00.000Z',
      legal_hold_status: 'NONE',
      dependency_status: 'NO_DEPENDENCY',
    });
    expect(plan.status).toBe('BLOCKED');
    expect(plan.provider_delete_identity_reference).toBe('db-ABCDEFGHIJKLMNOP');
    expect(plan.blockers).toContain('Candidate recovery point is covered by an active AWS Backup legal hold.');
  });

  it('captures RDS automated-backup cross-region replication ARN links exactly', async () => {
    const destinationArn = 'arn:aws:rds:us-east-1:111111111111:auto-backup:ab-0123456789ABCDEF';
    const automatedBackupXml = '<DBInstanceAutomatedBackup>'
      + '<DBInstanceArn>' + databaseArn + '</DBInstanceArn>'
      + '<DbiResourceId>db-ABCDEFGHIJKLMNOP</DbiResourceId>'
      + '<DBInstanceIdentifier>orders-db</DBInstanceIdentifier>'
      + '<Engine>postgres</Engine><Status>active</Status>'
      + '<DBInstanceAutomatedBackupsReplications><DBInstanceAutomatedBackupsReplication>'
      + '<DBInstanceAutomatedBackupsArn>' + destinationArn + '</DBInstanceAutomatedBackupsArn>'
      + '</DBInstanceAutomatedBackupsReplication></DBInstanceAutomatedBackupsReplications>'
      + '</DBInstanceAutomatedBackup>';
    const mock = makeFetch({ automatedBackupXml });
    const inventory = await createAdapter(mock.fetcher).captureInventory();
    const backup = inventory.sources.find((source) => source.source_kind === 'WAL_ARCHIVE_DESTINATION_CATALOG')
      ?.items.find((item) => item.resource_type === 'RDS_AUTOMATED_BACKUP');
    expect(backup?.resource_arn).toBeNull();
    expect(backup?.identity_kind).toBe('SOURCE_DB_RESOURCE_ID');
    expect(backup?.provider_delete_identity_kind).toBe('DBI_RESOURCE_ID');
    expect(backup?.replication_destination_arns).toEqual([destinationArn]);
    expect(inventory.unresolved_replication_destination_arns).toEqual([destinationArn]);
    expect(inventory.sources.find((source) => source.source_kind === 'WAL_REPLICATION_PATH_CATALOG')
      ?.items.some((item) => item.provider_identity_reference === backup?.provider_identity_reference)).toBe(true);
  });

  it('excludes non-PostgreSQL RDS engines from the PostgreSQL PITR cluster catalog', async () => {
    const mysqlArn = 'arn:aws:rds:ap-southeast-1:111111111111:db:legacy-mysql';
    const mysql = '<DBInstance><DBInstanceArn>' + mysqlArn + '</DBInstanceArn>'
      + '<DBInstanceIdentifier>legacy-mysql</DBInstanceIdentifier>'
      + '<DbiResourceId>db-MYSQL123456</DbiResourceId>'
      + '<Engine>mysql</Engine><DBInstanceStatus>available</DBInstanceStatus>'
      + '</DBInstance>';
    const mock = makeFetch({ instanceXml: instanceXml() + mysql });
    const inventory = await createAdapter(mock.fetcher).captureInventory();
    const items = inventory.sources.find((source) => source.source_kind === 'POSTGRESQL_CLUSTER_CATALOG')?.items ?? [];
    expect(items.map((item) => item.resource_arn)).toContain(databaseArn);
    expect(items.map((item) => item.resource_arn)).not.toContain(mysqlArn);
  });


  it('binds RDS snapshot deletion to the provider identifier while preserving the immutable ARN', async () => {
    const snapshotArn = 'arn:aws:rds:ap-southeast-1:111111111111:snapshot:orders-manual-20261031';
    const dbSnapshotXml = '<DBSnapshot>'
      + '<DBSnapshotArn>' + snapshotArn + '</DBSnapshotArn>'
      + '<DBSnapshotIdentifier>orders-manual-20261031</DBSnapshotIdentifier>'
      + '<DBInstanceIdentifier>orders-db</DBInstanceIdentifier>'
      + '<Engine>postgres</Engine><Status>available</Status>'
      + '<SnapshotType>manual</SnapshotType><Encrypted>true</Encrypted>'
      + '</DBSnapshot>';
    const mock = makeFetch({ dbSnapshotXml });
    const inventory = await createAdapter(mock.fetcher).captureInventory();
    const snapshot = inventory.sources.find((source) => source.source_kind === 'WAL_ARCHIVE_DESTINATION_CATALOG')
      ?.items.find((item) => item.resource_type === 'RDS_DB_SNAPSHOT');
    expect(snapshot?.resource_arn).toBe(snapshotArn);
    expect(snapshot?.provider_delete_identity_kind).toBe('SNAPSHOT_IDENTIFIER');
    expect(snapshot?.provider_delete_identity_reference).toBe('orders-manual-20261031');
    const plan = createAwsRdsPitrRetentionDryRunPlan({
      inventory,
      candidate_provider_identity_reference: snapshot!.provider_identity_reference,
      candidate_resource_arn: snapshotArn,
      expected_account_id: organizationAccount,
      expected_region: 'ap-southeast-1',
      minimum_recovery_horizon_end_at: '2026-10-30T00:00:00.000Z',
      retention_expires_at: '2026-10-31T00:00:00.000Z',
      legal_hold_status: 'NONE',
      dependency_status: 'NO_DEPENDENCY',
    });
    expect(plan.provider_delete_identity_kind).toBe('SNAPSHOT_IDENTIFIER');
    expect(plan.provider_delete_identity_reference).toBe('orders-manual-20261031');
    expect(plan.deletion_authorized).toBe(false);
  });

  it('blocks AWS Backup recovery points while the vault is locked', async () => {
    const recoveryPointArn = 'arn:aws:backup:ap-southeast-1:111111111111:recovery-point:12345678-1234-1234-1234-123456789012';
    const mock = makeFetch({
      backupVaultPages: [JSON.stringify({ BackupVaultList: [{
        BackupVaultName: 'default',
        BackupVaultArn: 'arn:aws:backup:ap-southeast-1:111111111111:backup-vault:default',
        VaultType: 'BACKUP_VAULT',
        VaultState: 'AVAILABLE',
        Locked: true,
        LockDate: '2026-10-30T00:00:00.000Z',
        MinRetentionDays: 30,
        NumberOfRecoveryPoints: 1,
      }] })],
    });
    const inventory = await createAdapter(mock.fetcher).captureInventory();
    const recoveryPoint = inventory.sources.find((source) => source.source_kind === 'PITR_RESTORE_PATH_CATALOG')
      ?.items.find((item) => item.resource_type === 'AWS_BACKUP_RECOVERY_POINT');
    const plan = createAwsRdsPitrRetentionDryRunPlan({
      inventory,
      candidate_provider_identity_reference: recoveryPoint!.provider_identity_reference,
      candidate_resource_arn: recoveryPoint!.resource_arn ?? undefined,
      expected_account_id: organizationAccount,
      expected_region: 'ap-southeast-1',
      minimum_recovery_horizon_end_at: '2026-10-30T00:00:00.000Z',
      retention_expires_at: '2026-11-30T00:00:00.000Z',
      legal_hold_status: 'NONE',
      dependency_status: 'NO_DEPENDENCY',
    });
    expect(plan.status).toBe('BLOCKED');
    expect(plan.blockers).toContain('AWS Backup vault lock is active, in grace-period configuration, or unknown.');
  });

  it('blocks an RDS automated backup if its linked AWS Backup recovery point is absent from the complete vault catalog', async () => {
    const linkedArn = 'arn:aws:backup:ap-southeast-1:111111111111:recovery-point:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const automatedBackupXml = '<DBInstanceAutomatedBackup>'
      + '<DBInstanceArn>' + databaseArn + '</DBInstanceArn>'
      + '<DbiResourceId>db-ABCDEFGHIJKLMNOP</DbiResourceId>'
      + '<AwsBackupRecoveryPointArn>' + linkedArn + '</AwsBackupRecoveryPointArn>'
      + '<DBInstanceIdentifier>orders-db</DBInstanceIdentifier>'
      + '<Engine>postgres</Engine><Status>retained</Status>'
      + '</DBInstanceAutomatedBackup>';
    const mock = makeFetch({
      automatedBackupXml,
      backupVaultPages: [JSON.stringify({ BackupVaultList: [] })],
    });
    const inventory = await createAdapter(mock.fetcher).captureInventory();
    const backup = inventory.sources.find((source) => source.source_kind === 'WAL_ARCHIVE_DESTINATION_CATALOG')
      ?.items.find((item) => item.resource_type === 'RDS_AUTOMATED_BACKUP');
    const plan = createAwsRdsPitrRetentionDryRunPlan({
      inventory,
      candidate_provider_identity_reference: backup!.provider_identity_reference,
      expected_account_id: organizationAccount,
      expected_region: 'ap-southeast-1',
      minimum_recovery_horizon_end_at: '2026-10-30T00:00:00.000Z',
      retention_expires_at: '2026-10-31T00:00:00.000Z',
      legal_hold_status: 'NONE',
      dependency_status: 'NO_DEPENDENCY',
    });
    expect(plan.status).toBe('BLOCKED');
    expect(plan.blockers).toContain('RDS automated backup references an AWS Backup recovery point absent from the complete vault inventory.');
  });


  it('uses AWS Backup CalculatedLifecycle.DeleteAt and enforces vault minimum retention days', async () => {
    const mock = makeFetch({
      backupVaultPages: [JSON.stringify({ BackupVaultList: [{
        BackupVaultName: 'default',
        BackupVaultArn: 'arn:aws:backup:ap-southeast-1:111111111111:backup-vault:default',
        Locked: false,
        MinRetentionDays: 30,
        NumberOfRecoveryPoints: 1,
      }] })],
    });
    const inventory = await createAdapter(mock.fetcher).captureInventory();
    const recoveryPoint = inventory.sources.find((source) => source.source_kind === 'PITR_RESTORE_PATH_CATALOG')
      ?.items.find((item) => item.resource_type === 'AWS_BACKUP_RECOVERY_POINT');
    expect(recoveryPoint?.attributes.LifecycleDeleteAt).toBeDefined();
    expect(recoveryPoint?.attributes.LifecycleDeleteAfterDays).toBe('365');
    const plan = createAwsRdsPitrRetentionDryRunPlan({
      inventory,
      candidate_provider_identity_reference: recoveryPoint!.provider_identity_reference,
      candidate_resource_arn: recoveryPoint!.resource_arn ?? undefined,
      expected_account_id: organizationAccount,
      expected_region: 'ap-southeast-1',
      minimum_recovery_horizon_end_at: '2026-11-03T00:00:00.000Z',
      retention_expires_at: '2026-11-20T00:00:00.000Z',
      legal_hold_status: 'NONE',
      dependency_status: 'NO_DEPENDENCY',
    });
    expect(plan.blockers).toContain('Requested retention expiry violates the AWS Backup vault minimum retention period.');
  });


  it('blocks recovery-point retention review for logically air-gapped or non-available vaults', async () => {
    const mock = makeFetch({
      backupVaultPages: [JSON.stringify({ BackupVaultList: [{
        BackupVaultName: 'default',
        BackupVaultArn: 'arn:aws:backup:ap-southeast-1:111111111111:backup-vault:default',
        VaultType: 'LOGICALLY_AIR_GAPPED_BACKUP_VAULT',
        VaultState: 'DELETING',
        Locked: false,
        NumberOfRecoveryPoints: 1,
      }] })],
    });
    const inventory = await createAdapter(mock.fetcher).captureInventory();
    const recoveryPoint = inventory.sources.find((source) => source.source_kind === 'PITR_RESTORE_PATH_CATALOG')
      ?.items.find((item) => item.resource_type === 'AWS_BACKUP_RECOVERY_POINT');
    const plan = createAwsRdsPitrRetentionDryRunPlan({
      inventory,
      candidate_provider_identity_reference: recoveryPoint!.provider_identity_reference,
      candidate_resource_arn: recoveryPoint!.resource_arn ?? undefined,
      expected_account_id: organizationAccount,
      expected_region: 'ap-southeast-1',
      minimum_recovery_horizon_end_at: '2026-11-03T00:00:00.000Z',
      retention_expires_at: '2026-11-30T00:00:00.000Z',
      legal_hold_status: 'NONE',
      dependency_status: 'NO_DEPENDENCY',
    });
    expect(plan.status).toBe('BLOCKED');
    expect(plan.blockers).toContain('AWS Backup recovery point is not in a standard BACKUP_VAULT.');
    expect(plan.blockers).toContain('AWS Backup vault is not AVAILABLE.');
  });

  it('blocks a requested retention horizon beyond the AWS Backup vault maximum retention days', async () => {
    const mock = makeFetch({
      backupVaultPages: [JSON.stringify({ BackupVaultList: [{
        BackupVaultName: 'default',
        BackupVaultArn: 'arn:aws:backup:ap-southeast-1:111111111111:backup-vault:default',
        Locked: false,
        MinRetentionDays: 1,
        MaxRetentionDays: 7,
        NumberOfRecoveryPoints: 1,
      }] })],
    });
    const inventory = await createAdapter(mock.fetcher).captureInventory();
    const restoreCatalog = inventory.sources.find((source) => source.source_kind === 'PITR_RESTORE_PATH_CATALOG');
    if (!restoreCatalog) throw new Error('PITR restore catalog was not returned');
    const recoveryPoint = restoreCatalog.items.find((item) => item.resource_type === 'AWS_BACKUP_RECOVERY_POINT');
    if (!recoveryPoint) throw new Error('AWS Backup recovery point was not returned');
    const plan = createAwsRdsPitrRetentionDryRunPlan({
      inventory,
      candidate_provider_identity_reference: recoveryPoint.provider_identity_reference,
      candidate_resource_arn: recoveryPoint.resource_arn ?? undefined,
      expected_account_id: organizationAccount,
      expected_region: 'ap-southeast-1',
      minimum_recovery_horizon_end_at: '2026-11-03T00:00:00.000Z',
      retention_expires_at: '2026-11-20T00:00:00.000Z',
      legal_hold_status: 'NONE',
      dependency_status: 'NO_DEPENDENCY',
    });
    expect(plan.blockers).toContain('Requested retention expiry exceeds the AWS Backup vault maximum retention period.');
  });

  it('rejects a missing cross-account external ID before making a provider request', async () => {
    const mock = makeFetch();
    expect(() => new AwsRdsPostgresqlPitrProviderAdapter({
      organization_account_id: organizationAccount,
      read_only_role_name: roleName,
    }, sourceCredentials, mock.fetcher)).toThrow(/external ID is required/i);
    expect(mock.fetcher).not.toHaveBeenCalled();
  });

  it('exchanges a bounded OIDC token for short-lived STS credentials without signing or logging the token', async () => {
    const token = 'oidc.' + 'a'.repeat(120) + '.signature';
    const fetcher = jest.fn<typeof fetch>().mockImplementation(async (input, init) => {
      expect(String(input)).toBe('https://sts.ap-southeast-1.amazonaws.com/');
      expect(String(init?.method)).toBe('POST');
      const body = new URLSearchParams(String(init?.body ?? ''));
      expect(body.get('Action')).toBe('AssumeRoleWithWebIdentity');
      expect(body.get('RoleArn')).toBe('arn:aws:iam::111111111111:role/FactoryOSWebIdentity');
      expect(body.get('WebIdentityToken')).toBe(token);
      expect((init?.headers as Record<string, string>).authorization).toBeUndefined();
      return xml('<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials>'
        + '<AccessKeyId>ASIAABCDEFGHIJKLMNOP</AccessKeyId>'
        + '<SecretAccessKey>web-identity-secret-key-material-0123456789</SecretAccessKey>'
        + '<SessionToken>web-identity-session-token-material-0123456789</SessionToken>'
        + '</Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>');
    });
    const credentials = await exchangeAwsRdsPitrWebIdentityToken({
      role_arn: 'arn:aws:iam::111111111111:role/FactoryOSWebIdentity',
      region: 'ap-southeast-1',
      role_session_name: 'FactoryOSPitrSource',
      web_identity_token: token,
    }, fetcher);
    expect(credentials.access_key_id).toBe('ASIAABCDEFGHIJKLMNOP');
    expect(credentials.session_token).toBeDefined();
  });

  it('rejects malformed or oversized web-identity input before making a network request', async () => {
    const fetcher = jest.fn<typeof fetch>();
    await expect(exchangeAwsRdsPitrWebIdentityToken({
      role_arn: 'arn:aws:iam::111111111111:role/FactoryOSWebIdentity',
      region: 'ap-southeast-1',
      role_session_name: 'FactoryOSPitrSource',
      web_identity_token: 'short',
    }, fetcher)).rejects.toThrow(/web-identity input/i);
    expect(fetcher).not.toHaveBeenCalled();
  });


  it('rejects an RDS resource ARN returned outside the current account and region', async () => {
    const foreignInstance = instanceXml().replace(organizationAccount, '999999999999');
    const mock = makeFetch({ instanceXml: foreignInstance });
    await expect(createAdapter(mock.fetcher).captureInventory()).rejects.toThrow(/outside the requested account\/region scope/i);
  });

  it('cancels an oversized AWS response stream before parsing or retaining it', async () => {
    const fetcher = jest.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const body = new URLSearchParams(String(init?.body ?? ''));
      if (body.get('Action') === 'GetCallerIdentity') {
        return xml('<GetCallerIdentityResponse><GetCallerIdentityResult><Account>'
          + organizationAccount + '</Account><Arn>arn:aws:sts::' + organizationAccount
          + ':assumed-role/OrganizationReadOnly/source-session</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>');
      }
      return new Response('x'.repeat(4 * 1024 * 1024 + 1), { status: 200 });
    });
    await expect(createAdapter(fetcher).captureInventory()).rejects.toThrow(/byte limit/i);
  });

});
