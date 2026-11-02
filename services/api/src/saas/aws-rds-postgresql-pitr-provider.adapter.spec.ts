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
  const fetcher = jest.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = init?.headers as Record<string, string> | undefined;
    const target = String(headers?.['x-amz-target'] ?? '');
    const isOrganizations = target === 'AWSOrganizationsV20161128.ListAccounts';
    const bodyText = String(init?.body ?? '');
    const body: MockRequestBody = isOrganizations
      ? JSON.parse(bodyText) as Record<string, unknown>
      : new URLSearchParams(bodyText);
    const action = isOrganizations ? 'ListAccounts' : (body as URLSearchParams).get('Action') ?? '';
    const authorization = String(headers?.authorization ?? '');
    requests.push({ host: url.host, action, body, authorization, target });
    if (options.failAction === action) {
      return isOrganizations
        ? json({ __type: 'com.amazonaws.organizations#AccessDeniedException' }, 400)
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
      const backupItem = action === 'DescribeDBInstanceAutomatedBackups'
        ? (options.automatedBackupXml ?? '<DBInstanceAutomatedBackup>'
          + '<DBInstanceArn>' + databaseArn + '</DBInstanceArn>'
          + '<DbiResourceId>db-ABCDEFGHIJKLMNOP</DbiResourceId>'
          + '<DBInstanceIdentifier>orders-db</DBInstanceIdentifier>'
          + '<Region>ap-southeast-1</Region><Engine>postgres</Engine>'
          + '<Status>active</Status><BackupRetentionPeriod>7</BackupRetentionPeriod>'
          + '<RestoreWindow><EarliestTime>2026-10-27T00:00:00.000Z</EarliestTime>'
          + '<LatestTime>2026-11-01T10:00:00.000Z</LatestTime></RestoreWindow>'
          + '</DBInstanceAutomatedBackup>')
        : '';
      return xml('<' + action + 'Response><' + resultTag + '><' + collectionTag + '>'
        + item + backupItem + '</' + collectionTag + '></' + resultTag + '></' + action + 'Response>');
    }
    return xml('<ErrorResponse><Error><Code>UnsupportedAction</Code></Error></ErrorResponse>');
  });
  return { fetcher, requests };
}

function createAdapter(fetcher: typeof fetch, overrides: Record<string, unknown> = {}) {
  return new AwsRdsPostgresqlPitrProviderAdapter({
    organization_account_id: organizationAccount,
    read_only_role_name: roleName,
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
      /^AWS4-HMAC-SHA256 Credential=/.test(request.authorization))).toBe(true);
    expect(mock.requests.some((request) => request.action.startsWith('Delete'))).toBe(false);
    expect(mock.requests.some((request) => request.action.startsWith('Modify'))).toBe(false);
    expect(result.total_pages_fetched).toBe(mock.requests.length);
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
      candidate_resource_arn: databaseArn,
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
    expect(plan.blockers.join(' ')).toMatch(/WAL, database writer and AWS Backup/i);
    expect(plan.operation).toBe('DRY_RUN_ONLY');
    expect(plan.provider_mutation_performed).toBe(false);
    expect(plan.delete_api_available).toBe(false);
    expect(plan.deletion_authorized).toBe(false);
  });

  it('does not mistake a retained backup source DB ARN for the backup resource ARN', async () => {
    const mock = makeFetch();
    const inventory = await createAdapter(mock.fetcher).captureInventory();
    const source = inventory.sources.find((entry) => entry.source_kind === 'WAL_ARCHIVE_DESTINATION_CATALOG');
    const backup = source?.items.find((item) => item.resource_type === 'RDS_AUTOMATED_BACKUP');
    expect(backup?.resource_arn).toBeNull();
    expect(backup?.identity_kind).toBe('SOURCE_DB_COMPOSITE');
    expect(backup?.provider_identity_reference).toMatch(/^aws-rds-resource\./);
    expect(backup?.attributes.DBIResourceId ?? backup?.attributes.DbiResourceId).toBe('db-ABCDEFGHIJKLMNOP');
    expect(backup?.source_database_reference).toBe('orders-db');
    expect(backup?.attributes.DBInstanceArn).toBe(databaseArn);

    const plan = createAwsRdsPitrRetentionDryRunPlan({
      inventory,
      candidate_resource_arn: replicatedArn,
      expected_account_id: organizationAccount,
      expected_region: 'ap-southeast-1',
      minimum_recovery_horizon_end_at: '2026-10-30T00:00:00.000Z',
      retention_expires_at: '2026-10-31T00:00:00.000Z',
      legal_hold_status: 'NONE',
      dependency_status: 'NO_DEPENDENCY',
    });
    expect(plan.status).toBe('BLOCKED');
    expect(plan.blockers).toContain('Candidate resource was not observed in the supplied inventory.');
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
    expect(backup?.attributes.DBInstanceArn).toBe(databaseArn);
  });

  it('blocks a candidate ARN whose account or region does not match the selected scope', async () => {
    const mock = makeFetch();
    const inventory = await createAdapter(mock.fetcher).captureInventory();
    const plan = createAwsRdsPitrRetentionDryRunPlan({
      inventory,
      candidate_resource_arn: databaseArn,
      expected_account_id: organizationAccount,
      expected_region: 'us-east-1',
      minimum_recovery_horizon_end_at: '2026-10-30T00:00:00.000Z',
      retention_expires_at: '2026-10-31T00:00:00.000Z',
      legal_hold_status: 'NONE',
      dependency_status: 'NO_DEPENDENCY',
    });
    expect(plan.status).toBe('BLOCKED');
    expect(plan.blockers.join(' ')).toMatch(/expected AWS account and region/i);
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
