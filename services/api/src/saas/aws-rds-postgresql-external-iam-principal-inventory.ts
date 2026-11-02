import { createHash, createHmac } from 'node:crypto';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_POLICY_DOCUMENT_BYTES = 256 * 1024;
const MAX_HARD_PAGES = 50000;
const MAX_HARD_ITEMS = 100000;
const ACCOUNT_ID = /^\d{12}$/;

export type AwsIamPartition = 'aws' | 'aws-us-gov' | 'aws-cn';

export interface AwsRdsExternalIamCredentials {
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
}

export interface AwsRdsExternalIamInventoryInput {
  account_id: string;
  partition: AwsIamPartition;
  credentials: AwsRdsExternalIamCredentials;
  fetcher?: typeof fetch;
  max_pages?: number;
  max_items?: number;
  request_timeout_ms?: number;
  consume_request?: () => void;
}

export interface AwsRdsExternalIamPotentialStatement {
  policy_reference: string;
  policy_document_sha256: string;
  statement_reference: string;
  effect: 'Allow' | 'Deny';
  action_match: 'ACTION_MATCH' | 'NOT_ACTION_DOES_NOT_EXCLUDE_CONNECT';
  action_patterns: string[];
  resource_patterns: string[];
  not_resource: boolean;
  condition_present: boolean;
}

export interface AwsRdsExternalIamPotentialPrincipal {
  principal_arn: string;
  principal_type: 'ROLE' | 'USER';
  identity: string;
  permissions_boundary_present: boolean;
  role_trust_policy_present: boolean;
  role_trust_policy_sha256: string | null;
  potential_statements: AwsRdsExternalIamPotentialStatement[];
}

export interface AwsRdsExternalIamPrincipalInventory {
  account_id: string;
  status: 'COMPLETE' | 'PARTIAL';
  pages_fetched: number;
  roles_scanned: number;
  users_scanned: number;
  groups_scanned: number;
  managed_policies_scanned: number;
  potential_principal_count: number;
  potential_allow_statement_count: number;
  potential_deny_statement_count: number;
  catalog_sha256: string;
  receipt_references: string[];
  blockers: string[];
  principals: AwsRdsExternalIamPotentialPrincipal[];
  effective_authorization_verified: false;
  actual_database_connections_enumerated: false;
}

interface Page {
  xml: string;
  receipt: string;
}

interface PolicyDocument {
  reference: string;
  document: Record<string, unknown>;
  sha256: string;
}

function fail(message: string): never {
  throw new Error('AWS RDS external IAM principal inventory refused: ' + message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    '%' + character.charCodeAt(0).toString(16).toUpperCase());
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal: string) => String.fromCodePoint(Number(decimal)));
}

/** Extracts complete, balanced elements; nested <member> collections remain intact. */
function xmlElementBlocks(xml: string, tag: string): string[] {
  const escaped = tag.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
  const token = new RegExp(
    '<(?:(?:[A-Za-z0-9_]+):)?' + escaped + '(?:\\s[^>]*)?(\\/?)>|<\\/(?:(?:[A-Za-z0-9_]+):)?' + escaped + '\\s*>',
    'gi',
  );
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;
  for (const match of xml.matchAll(token)) {
    const text = match[0];
    const index = match.index ?? 0;
    if (text.startsWith('</')) {
      depth -= 1;
      if (depth < 0) return fail('IAM returned malformed XML element nesting');
      if (depth === 0 && start >= 0) {
        blocks.push(xml.slice(start, index + text.length));
        start = -1;
      }
    } else if (text.endsWith('/>')) {
      if (depth === 0) blocks.push(text);
    } else {
      if (depth === 0) start = index;
      depth += 1;
    }
  }
  if (depth !== 0 || start >= 0) return fail('IAM returned an unterminated XML element');
  return blocks;
}

function xmlText(xml: string, tag: string): string | null {
  const block = xmlElementBlocks(xml, tag)[0];
  if (!block || block.endsWith('/>')) return null;
  const openingEnd = block.indexOf('>');
  const closingStart = block.lastIndexOf('</');
  if (openingEnd < 0 || closingStart < openingEnd) return null;
  return decodeXmlEntities(block.slice(openingEnd + 1, closingStart).trim());
}

function childList(xml: string, containerName: string): string[] {
  const container = xmlElementBlocks(xml, containerName)[0];
  return container ? xmlElementBlocks(container, 'member') : [];
}

function elementText(value: string): string | null {
  return decodeXmlEntities(value.replace(/<[^>]+>/g, '').trim());
}

function boundedConfig(input: AwsRdsExternalIamInventoryInput): {
  max_pages: number;
  max_items: number;
  request_timeout_ms: number;
} {
  const maxPages = input.max_pages ?? 10000;
  const maxItems = input.max_items ?? 20000;
  const timeout = input.request_timeout_ms ?? 10000;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_HARD_PAGES
    || !Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > MAX_HARD_ITEMS
    || !Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 30000) {
    return fail('IAM pagination, item, or timeout budget is outside supported bounds');
  }
  return { max_pages: maxPages, max_items: maxItems, request_timeout_ms: timeout };
}

function endpointForPartition(partition: AwsIamPartition): { host: string; region: string } {
  if (partition === 'aws-us-gov') return { host: 'iam.us-gov.amazonaws.com', region: 'us-gov-west-1' };
  if (partition === 'aws-cn') return { host: 'iam.cn-north-1.amazonaws.com.cn', region: 'cn-north-1' };
  return { host: 'iam.amazonaws.com', region: 'us-east-1' };
}

function validateCredentials(value: AwsRdsExternalIamCredentials): AwsRdsExternalIamCredentials {
  if (!isRecord(value) || typeof value.access_key_id !== 'string'
    || !/^[A-Z0-9]{16,128}$/.test(value.access_key_id)
    || typeof value.secret_access_key !== 'string' || value.secret_access_key.length < 20
    || /[\r\n]/.test(value.secret_access_key)
    || (value.session_token !== undefined
      && (typeof value.session_token !== 'string' || value.session_token.length < 16 || /[\r\n]/.test(value.session_token)))) {
    return fail('IAM reader role returned incomplete or malformed temporary credentials');
  }
  return value;
}

async function readBoundedResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return fail('IAM response body is missing');
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return fail('IAM response exceeded its byte limit');
      }
      chunks.push(Buffer.from(part.value));
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
    } catch {
      return fail('IAM response was not valid UTF-8');
    }
  } catch {
    return fail('IAM response stream was interrupted');
  } finally {
    reader.releaseLock();
  }
}

function makeIamRequestBody(marker: string | null): string {
  const parameters: Record<string, string> = {
    Action: 'GetAccountAuthorizationDetails',
    Version: '2010-05-08',
    MaxItems: '1000',
    'Filter.member.1': 'User',
    'Filter.member.2': 'Role',
    'Filter.member.3': 'Group',
    'Filter.member.4': 'LocalManagedPolicy',
    'Filter.member.5': 'AWSManagedPolicy',
  };
  if (marker !== null) parameters.Marker = marker;
  return Object.keys(parameters).sort()
    .map((key) => rfc3986(key) + '=' + rfc3986(parameters[key]!)).join('&');
}

async function fetchPage(
  input: AwsRdsExternalIamInventoryInput,
  config: ReturnType<typeof boundedConfig>,
  marker: string | null,
): Promise<Page> {
  const credentials = validateCredentials(input.credentials);
  const endpoint = endpointForPartition(input.partition);
  input.consume_request?.();
  const body = makeIamRequestBody(marker);
  const payloadHash = sha256(body);
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
    host: endpoint.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (credentials.session_token) headers['x-amz-security-token'] = credentials.session_token;
  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map((name) =>
    name + ':' + headers[name]!.trim().replace(/\s+/g, ' ') + '\n').join('');
  const signedHeaders = signedNames.join(';');
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = dateStamp + '/' + endpoint.region + '/iam/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac('AWS4' + credentials.secret_access_key, dateStamp), endpoint.region), 'iam'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  const authorization = 'AWS4-HMAC-SHA256 Credential=' + credentials.access_key_id + '/'
    + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
  let response: Response;
  try {
    response = await (input.fetcher ?? globalThis.fetch)('https://' + endpoint.host + '/', {
      method: 'POST',
      headers: { ...headers, authorization },
      body,
      signal: AbortSignal.timeout(config.request_timeout_ms),
    });
  } catch {
    return fail('IAM GetAccountAuthorizationDetails request failed before a verified response');
  }
  const xml = await readBoundedResponse(response);
  if (!response.ok) {
    const code = xmlText(xml, 'Code') ?? 'HTTP_' + response.status;
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(code)) return fail('IAM returned an invalid service error code');
    return fail('IAM GetAccountAuthorizationDetails was denied or failed (' + code + ')');
  }
  if (!xml.includes('GetAccountAuthorizationDetailsResult')) {
    return fail('IAM GetAccountAuthorizationDetails returned an unexpected response shape');
  }
  return {
    xml,
    receipt: 'iam-authorization-page.' + input.account_id + '.' + sha256(xml).slice(0, 32),
  };
}

function decodePolicyJson(value: string | null, field: string): Record<string, unknown> {
  if (!value || Buffer.byteLength(value, 'utf8') > MAX_POLICY_DOCUMENT_BYTES) {
    return fail(field + ' is missing or exceeds the policy document limit');
  }
  let decoded = value;
  try {
    if (/%[0-9a-f]{2}/i.test(value)) decoded = decodeURIComponent(value);
  } catch {
    return fail(field + ' is not valid RFC 3986 URL-encoded JSON');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    return fail(field + ' is not valid JSON');
  }
  if (!isRecord(parsed) || !('Statement' in parsed)) return fail(field + ' has no policy Statement');
  return parsed;
}

function asStringArray(value: unknown, field: string): string[] {
  const values = typeof value === 'string' ? [value] : Array.isArray(value) ? value : null;
  if (!values || values.length < 1 || values.some((entry) => typeof entry !== 'string' || entry.length < 1 || entry.length > 2048)) {
    return fail(field + ' must be a string or non-empty string array');
  }
  return values as string[];
}

function wildcardMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^$()|[\]\\{}]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 'i').test(value);
}

function documentFromPolicy(policyXml: string, reference: string, tag: 'PolicyDocument' | 'Document'): PolicyDocument {
  const document = decodePolicyJson(xmlText(policyXml, tag), reference);
  return { reference, document, sha256: sha256(JSON.stringify(document)) };
}

function inlinePolicies(principalXml: string, container: string, referencePrefix: string): PolicyDocument[] {
  return childList(principalXml, container).map((item) => documentFromPolicy(
    item,
    referencePrefix + ':' + (xmlText(item, 'PolicyName') ?? 'unnamed-policy'),
    'PolicyDocument',
  ));
}

function attachedPolicyArns(principalXml: string): string[] {
  return childList(principalXml, 'AttachedManagedPolicies')
    .map((item) => xmlText(item, 'PolicyArn'))
    .filter((value): value is string => value !== null && value.length > 0);
}

function attachedGroupNames(userXml: string): string[] {
  const groupList = xmlElementBlocks(userXml, 'GroupList')[0];
  if (!groupList) return [];
  return xmlElementBlocks(groupList, 'member')
    .map((item) => elementText(item.slice(item.indexOf('>') + 1, item.lastIndexOf('</'))))
    .filter((value): value is string => value !== null && value.length > 0);
}

function policyStatements(policy: PolicyDocument): AwsRdsExternalIamPotentialStatement[] {
  const raw = policy.document.Statement;
  const statements = Array.isArray(raw) ? raw : [raw];
  if (statements.length < 1 || statements.length > 10000) return fail(policy.reference + ' has an invalid statement count');
  const matches: AwsRdsExternalIamPotentialStatement[] = [];
  statements.forEach((entry, index) => {
    if (!isRecord(entry)) return fail(policy.reference + ' contains a malformed policy statement');
    const effect = entry.Effect;
    if (effect !== 'Allow' && effect !== 'Deny') return fail(policy.reference + ' contains an unsupported statement Effect');
    const hasAction = entry.Action !== undefined;
    const hasNotAction = entry.NotAction !== undefined;
    if (hasAction === hasNotAction) return fail(policy.reference + ' statement must contain exactly one of Action or NotAction');
    const actions = asStringArray(hasAction ? entry.Action : entry.NotAction, policy.reference + ' statement Action');
    const actionMatches = actions.some((action) => wildcardMatch(action, 'rds-db:connect'));
    const includeConnect = hasAction ? actionMatches : !actionMatches;
    if (!includeConnect) return;
    const hasResource = entry.Resource !== undefined;
    const hasNotResource = entry.NotResource !== undefined;
    if (hasResource === hasNotResource) return fail(policy.reference + ' statement must contain exactly one of Resource or NotResource');
    const resources = asStringArray(hasResource ? entry.Resource : entry.NotResource, policy.reference + ' statement Resource');
    const sid = typeof entry.Sid === 'string' && /^[A-Za-z0-9+=,.@_-]{0,128}$/.test(entry.Sid)
      ? entry.Sid : 'statement-' + index;
    matches.push({
      policy_reference: policy.reference,
      policy_document_sha256: policy.sha256,
      statement_reference: sid,
      effect,
      action_match: hasAction ? 'ACTION_MATCH' : 'NOT_ACTION_DOES_NOT_EXCLUDE_CONNECT',
      action_patterns: actions,
      resource_patterns: resources,
      not_resource: hasNotResource,
      condition_present: entry.Condition !== undefined,
    });
  });
  return matches;
}

function managedPolicyCatalog(policyBlocks: string[]): Map<string, PolicyDocument> {
  const result = new Map<string, PolicyDocument>();
  for (const block of policyBlocks) {
    const arn = xmlText(block, 'Arn');
    const name = xmlText(block, 'PolicyName');
    const defaultVersion = xmlText(block, 'DefaultVersionId');
    if (!arn || !name || !defaultVersion) return fail('IAM managed-policy catalog omitted its ARN, name or default version');
    const versions = childList(block, 'PolicyVersionList');
    const version = versions.find((item) => xmlText(item, 'VersionId') === defaultVersion)
      ?? versions.find((item) => xmlText(item, 'IsDefaultVersion')?.toLowerCase() === 'true');
    if (!version) return fail('IAM managed policy omitted its default version document');
    const policy = documentFromPolicy(version, 'managed:' + arn + ':' + defaultVersion, 'Document');
    if (result.has(arn)) return fail('IAM managed-policy catalog returned a duplicate policy ARN');
    result.set(arn, policy);
  }
  return result;
}

function collectAttachedPolicies(
  principalXml: string,
  inlineContainer: 'RolePolicyList' | 'UserPolicyList' | 'GroupPolicyList',
  prefix: string,
  managed: Map<string, PolicyDocument>,
  blockers: Set<string>,
): PolicyDocument[] {
  const documents = inlinePolicies(principalXml, inlineContainer, prefix);
  for (const arn of attachedPolicyArns(principalXml)) {
    const policy = managed.get(arn);
    if (!policy) {
      blockers.add('ATTACHED_MANAGED_POLICY_DOCUMENT_UNAVAILABLE');
      continue;
    }
    documents.push(policy);
  }
  return documents;
}

export async function captureAwsRdsExternalIamPrincipalInventory(
  input: AwsRdsExternalIamInventoryInput,
): Promise<AwsRdsExternalIamPrincipalInventory> {
  if (!isRecord(input) || !ACCOUNT_ID.test(input.account_id)
    || !['aws', 'aws-us-gov', 'aws-cn'].includes(input.partition)) {
    return fail('IAM inventory account ID or AWS partition is invalid');
  }
  const config = boundedConfig(input);
  validateCredentials(input.credentials);
  const roleBlocks: string[] = [];
  const userBlocks: string[] = [];
  const groupBlocks: string[] = [];
  const policyBlocks: string[] = [];
  const receipts: string[] = [];
  const blockers = new Set<string>();
  const seenMarkers = new Set<string>();
  let marker: string | null = null;
  let pagesFetched = 0;
  let totalItems = 0;
  do {
    if (pagesFetched >= config.max_pages) return fail('IAM authorization pagination exhausted its page budget');
    const page = await fetchPage(input, config, marker);
    pagesFetched += 1;
    receipts.push(page.receipt);
    const resultBlock = xmlElementBlocks(page.xml, 'GetAccountAuthorizationDetailsResult')[0];
    if (!resultBlock) return fail('IAM authorization response omitted its result container');
    const roleContainer = xmlElementBlocks(resultBlock, 'RoleDetailList')[0];
    const userContainer = xmlElementBlocks(resultBlock, 'UserDetailList')[0];
    const groupContainer = xmlElementBlocks(resultBlock, 'GroupDetailList')[0];
    const policyContainer = xmlElementBlocks(resultBlock, 'Policies')[0];
    const pageRoles = roleContainer ? xmlElementBlocks(roleContainer, 'member') : [];
    const pageUsers = userContainer ? xmlElementBlocks(userContainer, 'member') : [];
    const pageGroups = groupContainer ? xmlElementBlocks(groupContainer, 'member') : [];
    const pagePolicies = policyContainer ? xmlElementBlocks(policyContainer, 'member') : [];
    roleBlocks.push(...pageRoles);
    userBlocks.push(...pageUsers);
    groupBlocks.push(...pageGroups);
    policyBlocks.push(...pagePolicies);
    totalItems += pageRoles.length + pageUsers.length + pageGroups.length + pagePolicies.length;
    if (totalItems > config.max_items) return fail('IAM authorization inventory exceeded its bounded item budget');
    const truncated = xmlText(resultBlock, 'IsTruncated')?.toLowerCase();
    if (truncated !== 'true' && truncated !== 'false') return fail('IAM authorization pagination omitted IsTruncated');
    if (truncated === 'true') {
      const nextMarker = xmlText(resultBlock, 'Marker');
      if (!nextMarker || nextMarker.length > 4096 || seenMarkers.has(nextMarker)) {
        return fail('IAM authorization pagination returned a missing or repeated Marker');
      }
      seenMarkers.add(nextMarker);
      marker = nextMarker;
    } else {
      marker = null;
    }
  } while (marker !== null);

  const managed = managedPolicyCatalog(policyBlocks);
  const groupsByName = new Map<string, string>();
  for (const group of groupBlocks) {
    const groupName = xmlText(group, 'GroupName');
    if (!groupName || groupsByName.has(groupName)) return fail('IAM group catalog returned a missing or duplicate group name');
    groupsByName.set(groupName, group);
  }
  const principals: AwsRdsExternalIamPotentialPrincipal[] = [];
  const allPrincipalBlocks = [
    ...roleBlocks.map((xml) => ({ xml, type: 'ROLE' as const, inline: 'RolePolicyList' as const })),
    ...userBlocks.map((xml) => ({ xml, type: 'USER' as const, inline: 'UserPolicyList' as const })),
  ];
  for (const entry of allPrincipalBlocks) {
    const arn = xmlText(entry.xml, 'Arn');
    const name = entry.type === 'ROLE' ? xmlText(entry.xml, 'RoleName') : xmlText(entry.xml, 'UserName');
    if (!arn || !name || !arn.startsWith('arn:' + input.partition + ':iam::' + input.account_id + ':')) {
      blockers.add('IAM_PRINCIPAL_IDENTITY_MISSING_OR_OUT_OF_ACCOUNT');
      continue;
    }
    const documents = collectAttachedPolicies(entry.xml, entry.inline,
      entry.type.toLowerCase() + ':' + name, managed, blockers);
    if (entry.type === 'USER') {
      for (const groupName of attachedGroupNames(entry.xml)) {
        const group = groupsByName.get(groupName);
        if (!group) {
          blockers.add('IAM_USER_GROUP_POLICY_DOCUMENT_UNAVAILABLE');
          continue;
        }
        documents.push(...collectAttachedPolicies(group, 'GroupPolicyList',
          'group:' + groupName, managed, blockers));
      }
    }
    const potentialStatements = documents.flatMap(policyStatements);
    const trustPolicy = entry.type === 'ROLE' ? xmlText(entry.xml, 'AssumeRolePolicyDocument') : null;
    const trustDigest = trustPolicy ? sha256(trustPolicy) : null;
    if (entry.type === 'ROLE' && !trustPolicy) blockers.add('IAM_ROLE_TRUST_POLICY_NOT_RETURNED');
    const boundary = xmlElementBlocks(entry.xml, 'PermissionsBoundary')[0];
    if (potentialStatements.length > 0) {
      principals.push({
        principal_arn: arn,
        principal_type: entry.type,
        identity: name,
        permissions_boundary_present: Boolean(boundary),
        role_trust_policy_present: entry.type === 'ROLE' && Boolean(trustPolicy),
        role_trust_policy_sha256: trustDigest,
        potential_statements: potentialStatements,
      });
    }
  }
  const uniquePrincipals = new Set(principals.map((principal) => principal.principal_arn));
  if (uniquePrincipals.size !== principals.length) return fail('IAM authorization catalog returned duplicate principal ARNs');
  const sortedPrincipals = principals.sort((a, b) => a.principal_arn.localeCompare(b.principal_arn));
  const candidateAllowCount = sortedPrincipals.reduce((count, principal) =>
    count + principal.potential_statements.filter((statement) => statement.effect === 'Allow').length, 0);
  const candidateDenyCount = sortedPrincipals.reduce((count, principal) =>
    count + principal.potential_statements.filter((statement) => statement.effect === 'Deny').length, 0);
  blockers.add('IAM_EFFECTIVE_AUTHORIZATION_NOT_EVALUATED');
  blockers.add('RDS_IAM_DB_AUTH_CONNECTIONS_NOT_LOGGED_BY_CLOUDTRAIL');
  blockers.add('ROLE_TRUST_AND_EXTERNAL_ROLE_CHAINS_NOT_RESOLVED');
  blockers.add('SCP_SESSION_POLICY_RESOURCE_POLICY_AND_BOUNDARY_INTERACTIONS_NOT_EVALUATED');
  blockers.add('NON_IAM_DB_AUTH_AND_CUSTOM_ARCHIVE_WRITERS_OUT_OF_SCOPE');
  const catalogDigest = sha256(JSON.stringify(sortedPrincipals));
  return {
    account_id: input.account_id,
    status: blockers.size === 5 ? 'COMPLETE' : 'PARTIAL',
    pages_fetched: pagesFetched,
    roles_scanned: roleBlocks.length,
    users_scanned: userBlocks.length,
    groups_scanned: groupBlocks.length,
    managed_policies_scanned: managed.size,
    potential_principal_count: sortedPrincipals.length,
    potential_allow_statement_count: candidateAllowCount,
    potential_deny_statement_count: candidateDenyCount,
    catalog_sha256: catalogDigest,
    receipt_references: [...new Set(receipts)].sort(),
    blockers: [...blockers].sort(),
    principals: sortedPrincipals,
    effective_authorization_verified: false,
    actual_database_connections_enumerated: false,
  };
}
