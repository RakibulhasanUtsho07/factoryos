import { jest } from '@jest/globals';
import {
  captureAwsRdsExternalIamPrincipalInventory,
  type AwsRdsExternalIamInventoryInput,
} from './aws-rds-postgresql-external-iam-principal-inventory';

const account = '111111111111';
const roleArn = 'arn:aws:iam::111111111111:role/pitr-writer';
const userArn = 'arn:aws:iam::111111111111:user/legacy-backup';
const boundaryArn = 'arn:aws:iam::111111111111:policy/DatabaseConnectBoundary';
const managedArn = 'arn:aws:iam::111111111111:policy/LegacyWriterPolicy';
const credentials = {
  access_key_id: 'ASIAIAMINVENTORY12345',
  secret_access_key: 'iam-reader-secret-key-material-0123456789',
  session_token: 'iam-reader-session-token-material-0123456789',
};

function policyDocument(document: unknown): string {
  return encodeURIComponent(JSON.stringify(document));
}

function managedPolicy(arn: string, name: string, document: unknown): string {
  return '<member><Arn>' + arn + '</Arn><PolicyName>' + name + '</PolicyName>'
    + '<DefaultVersionId>v3</DefaultVersionId><PolicyVersionList><member>'
    + '<VersionId>v3</VersionId><IsDefaultVersion>true</IsDefaultVersion>'
    + '<Document>' + policyDocument(document) + '</Document>'
    + '</member></PolicyVersionList></member>';
}

function roleDetail(options: {
  policy?: unknown;
  boundary?: string;
  trust?: unknown;
  attached?: string[];
} = {}): string {
  const policy = options.policy ?? {
    Version: '2012-10-17',
    Statement: [{
      Sid: 'AllowRdsDbConnect',
      Effect: 'Allow',
      Action: 'rds-db:connect',
      Resource: 'arn:aws:rds-db:ap-southeast-1:111111111111:dbuser:db-ABC123/factoryos_writer',
      Condition: { StringEquals: { 'aws:PrincipalTag/workload': 'backup' } },
    }],
  };
  const trust = options.trust ?? {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::222222222222:root' }, Action: 'sts:AssumeRole' }],
  };
  const boundary = options.boundary
    ? '<PermissionsBoundary><PermissionsBoundaryType>Policy</PermissionsBoundaryType>'
      + '<PermissionsBoundaryArn>' + options.boundary + '</PermissionsBoundaryArn></PermissionsBoundary>'
    : '';
  const attached = (options.attached ?? []).length
    ? '<AttachedManagedPolicies>' + (options.attached ?? []).map((arn) =>
      '<member><PolicyName>attached</PolicyName><PolicyArn>' + arn + '</PolicyArn></member>').join('')
      + '</AttachedManagedPolicies>' : '';
  return '<member><Path>/</Path><RoleName>pitr-writer</RoleName><Arn>' + roleArn + '</Arn>'
    + '<AssumeRolePolicyDocument>' + policyDocument(trust) + '</AssumeRolePolicyDocument>'
    + boundary + attached
    + '<RolePolicyList><member><PolicyName>inline-writer</PolicyName>'
    + '<PolicyDocument>' + policyDocument(policy) + '</PolicyDocument>'
    + '</member></RolePolicyList></member>';
}

function userDetail(): string {
  return '<member><Path>/legacy/</Path><UserName>legacy-backup</UserName><Arn>' + userArn + '</Arn>'
    + '<GroupList><member>db-writers</member></GroupList>'
    + '<UserPolicyList></UserPolicyList><AttachedManagedPolicies></AttachedManagedPolicies></member>';
}

function groupDetail(): string {
  return '<member><Path>/</Path><GroupName>db-writers</GroupName>'
    + '<GroupPolicyList><member><PolicyName>legacy-db-writer</PolicyName>'
    + '<PolicyDocument>' + policyDocument({
      Version: '2012-10-17',
      Statement: [{ Sid: 'GroupConnect', Effect: 'Allow', Action: 'rds-db:connect', Resource: '*' }],
    }) + '</PolicyDocument></member></GroupPolicyList>'
    + '<AttachedManagedPolicies></AttachedManagedPolicies></member>';
}

function responseXml(options: {
  role?: string;
  user?: string;
  group?: string;
  policies?: string;
  truncated?: boolean;
  marker?: string;
} = {}): string {
  return '<GetAccountAuthorizationDetailsResponse><GetAccountAuthorizationDetailsResult>'
    + '<RoleDetailList>' + (options.role ?? '') + '</RoleDetailList>'
    + '<UserDetailList>' + (options.user ?? '') + '</UserDetailList>'
    + '<GroupDetailList>' + (options.group ?? '') + '</GroupDetailList>'
    + '<Policies>' + (options.policies ?? '') + '</Policies>'
    + '<IsTruncated>' + String(options.truncated ?? false) + '</IsTruncated>'
    + (options.marker ? '<Marker>' + options.marker + '</Marker>' : '')
    + '</GetAccountAuthorizationDetailsResult></GetAccountAuthorizationDetailsResponse>';
}

function makeInput(
  pages: string[],
  overrides: Partial<AwsRdsExternalIamInventoryInput> = {},
): { input: AwsRdsExternalIamInventoryInput; requests: Array<{ url: string; body: string; authorization: string }> } {
  const requests: Array<{ url: string; body: string; authorization: string }> = [];
  let index = 0;
  const fetcher = jest.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const headers = init?.headers as Record<string, string>;
    requests.push({
      url: String(url),
      body: String(init?.body ?? ''),
      authorization: String(headers?.authorization ?? ''),
    });
    const xml = pages[index++];
    if (!xml) throw new Error('unexpected extra IAM page request');
    return new Response(xml, { status: 200, headers: { 'content-type': 'text/xml' } });
  });
  return {
    input: {
      account_id: account,
      partition: 'aws',
      credentials,
      fetcher,
      ...overrides,
    },
    requests,
  };
}

describe('AWS RDS external IAM principal inventory', () => {
  test('collects direct role and group-inherited user rds-db:connect statements and permission-boundary evidence', async () => {
    const boundaryPolicy = {
      Version: '2012-10-17',
      Statement: [
        { Sid: 'PermitDbConnect', Effect: 'Allow', Action: 'rds-db:connect', Resource: 'arn:aws:rds-db:ap-southeast-1:111111111111:dbuser:db-ABC123/*' },
        { Sid: 'DenyConnectToOtherAccounts', Effect: 'Deny', Action: 'rds-db:connect', Resource: '*', Condition: { StringNotEquals: { 'aws:PrincipalAccount': account } } },
      ],
    };
    const pages = [responseXml({
      role: roleDetail({ boundary: boundaryArn }),
      user: userDetail(),
      group: groupDetail(),
      policies: managedPolicy(boundaryArn, 'DatabaseConnectBoundary', boundaryPolicy),
    })];
    const { input, requests } = makeInput(pages);
    const result = await captureAwsRdsExternalIamPrincipalInventory(input);

    expect(result.status).toBe('COMPLETE');
    expect(result.roles_scanned).toBe(1);
    expect(result.users_scanned).toBe(1);
    expect(result.groups_scanned).toBe(1);
    expect(result.managed_policies_scanned).toBe(1);
    expect(result.potential_principal_count).toBe(2);
    expect(result.potential_allow_statement_count).toBe(2);
    expect(result.potential_deny_statement_count).toBe(0);
    expect(result.effective_authorization_verified).toBe(false);
    expect(result.actual_database_connections_enumerated).toBe(false);
    expect(result.blockers).toContain('IAM_EFFECTIVE_AUTHORIZATION_NOT_EVALUATED');
    expect(result.blockers).toContain('RDS_IAM_DB_AUTH_CONNECTIONS_NOT_LOGGED_BY_CLOUDTRAIL');

    const role = result.principals.find((principal) => principal.principal_arn === roleArn);
    const user = result.principals.find((principal) => principal.principal_arn === userArn);
    expect(role?.potential_statements[0]?.action_patterns).toContain('rds-db:connect');
    expect(role?.potential_statements[0]?.condition_present).toBe(true);
    expect(role?.permissions_boundary_policy_reference).toContain(boundaryArn);
    expect(role?.permissions_boundary_policy_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(role?.permissions_boundary_statements).toHaveLength(2);
    expect(user?.potential_statements[0]?.policy_reference).toContain('group:db-writers');

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://iam.amazonaws.com/');
    expect(requests[0]?.body).toContain('Action=GetAccountAuthorizationDetails');
    expect(requests[0]?.body).toContain('Filter.member.4=LocalManagedPolicy');
    expect(requests[0]?.authorization).toContain('AWS4-HMAC-SHA256 Credential=' + credentials.access_key_id);
    expect(result.receipt_references[0]).toMatch(/^iam-authorization-page\./);
  });

  test('follows IAM Marker pagination, including a page with no principals', async () => {
    const pages = [
      responseXml({ truncated: true, marker: 'next-page-token' }),
      responseXml({ role: roleDetail(), truncated: false }),
    ];
    const { input, requests } = makeInput(pages);
    const result = await captureAwsRdsExternalIamPrincipalInventory(input);
    expect(result.status).toBe('COMPLETE');
    expect(result.pages_fetched).toBe(2);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body).not.toContain('Marker=');
    expect(requests[1]?.body).toContain('Marker=next-page-token');
  });

  test('fails closed when IAM repeats a continuation Marker', async () => {
    const pages = [
      responseXml({ truncated: true, marker: 'repeat-me' }),
      responseXml({ truncated: true, marker: 'repeat-me' }),
    ];
    const { input } = makeInput(pages);
    await expect(captureAwsRdsExternalIamPrincipalInventory(input))
      .rejects.toThrow('missing or repeated Marker');
  });

  test('marks missing attached managed-policy documents as partial instead of empty coverage', async () => {
    const { input } = makeInput([responseXml({
      user: userDetail(),
      group: '<member><GroupName>db-writers</GroupName><GroupPolicyList></GroupPolicyList>'
        + '<AttachedManagedPolicies><member><PolicyArn>' + managedArn + '</PolicyArn></member></AttachedManagedPolicies></member>',
    })]);
    const result = await captureAwsRdsExternalIamPrincipalInventory(input);
    expect(result.status).toBe('PARTIAL');
    expect(result.blockers).toContain('ATTACHED_MANAGED_POLICY_DOCUMENT_UNAVAILABLE');
  });

  test('fails closed on malformed pagination and bounded page exhaustion', async () => {
    const malformed = makeInput(['<GetAccountAuthorizationDetailsResponse><GetAccountAuthorizationDetailsResult>'
      + '<IsTruncated>maybe</IsTruncated></GetAccountAuthorizationDetailsResult></GetAccountAuthorizationDetailsResponse>']);
    await expect(captureAwsRdsExternalIamPrincipalInventory(malformed.input))
      .rejects.toThrow('omitted IsTruncated');

    const exhausted = makeInput([
      responseXml({ truncated: true, marker: 'next' }),
      responseXml({ truncated: false }),
    ], { max_pages: 1 });
    await expect(captureAwsRdsExternalIamPrincipalInventory(exhausted.input))
      .rejects.toThrow('exhausted its page budget');
  });

  test('rejects account/partition and credential mismatches before scanning', async () => {
    const { input } = makeInput([responseXml()]);
    await expect(captureAwsRdsExternalIamPrincipalInventory({ ...input, account_id: 'not-an-account' }))
      .rejects.toThrow('account ID or AWS partition is invalid');
    await expect(captureAwsRdsExternalIamPrincipalInventory({
      ...input,
      credentials: { access_key_id: 'bad', secret_access_key: 'bad' },
    })).rejects.toThrow('incomplete or malformed temporary credentials');
  });
});
