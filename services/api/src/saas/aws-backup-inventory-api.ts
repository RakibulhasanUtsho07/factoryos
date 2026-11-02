import { createHash, createHmac } from 'node:crypto';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_ITEMS = 100000;

export interface AwsBackupInventoryCredentials {
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
}

export interface AwsBackupInventoryScope {
  account_reference: string;
  region_reference: string;
}

export interface AwsBackupRequestBudget {
  total: number;
  maximum: number;
}

export interface AwsBackupVaultRecord {
  account_id: string;
  region: string;
  backup_vault_arn: string;
  backup_vault_name: string;
  vault_type: string | null;
  vault_state: string | null;
  locked: boolean | null;
  lock_date: string | null;
  min_retention_days: number | null;
  max_retention_days: number | null;
  number_of_recovery_points: number | null;
  encryption_key_arn: string | null;
  creation_date: string | null;
}

export interface AwsBackupRecoveryPointRecord {
  account_id: string;
  region: string;
  recovery_point_arn: string;
  backup_vault_arn: string;
  backup_vault_name: string;
  resource_arn: string;
  resource_type: 'RDS' | 'Aurora';
  status: string | null;
  creation_date: string | null;
  completion_date: string | null;
  last_restore_time: string | null;
  lifecycle_delete_at: string | null;
  lifecycle_move_to_cold_storage_at: string | null;
  is_encrypted: boolean | null;
  encryption_key_arn: string | null;
  backup_size_bytes: number | null;
  source_backup_vault_arn: string | null;
  backup_vault_locked: boolean | null;
  backup_vault_lock_date: string | null;
  backup_vault_min_retention_days: number | null;
  backup_vault_max_retention_days: number | null;
}

function fail(message: string): never {
  throw new Error('AWS Backup inventory refused: ' + message);
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

function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    '%' + character.charCodeAt(0).toString(16).toUpperCase());
}

function timestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    const date = new Date(value * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value === 'string' && value.length <= 80) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
}

function safeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function validateAwsBackupArn(
  value: unknown,
  scope: AwsBackupInventoryScope,
  resource: 'backup-vault' | 'recovery-point',
): string {
  if (typeof value !== 'string') return fail('AWS Backup response omitted exact ' + resource + ' ARN');
  const match = /^arn:(aws|aws-us-gov|aws-cn):backup:([a-z0-9-]+):(\d{12}):([a-z0-9-]+):([A-Za-z0-9._:/-]{1,512})$/.exec(value);
  const expectedPartition = scope.region_reference.startsWith('cn-') ? 'aws-cn'
    : scope.region_reference.startsWith('us-gov-') ? 'aws-us-gov' : 'aws';
  if (!match || match[1] !== expectedPartition || match[2] !== scope.region_reference
    || match[3] !== scope.account_reference || match[4] !== resource) {
    return fail('AWS Backup returned a ' + resource + ' ARN outside the requested account/region scope');
  }
  return value;
}

async function readBoundedResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return fail('AWS Backup response body is missing');
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await reader.read();
      } catch {
        return fail('AWS Backup response stream was interrupted');
      }
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return fail('AWS Backup response exceeded its byte limit');
      }
      chunks.push(Buffer.from(part.value));
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
    } catch {
      return fail('AWS Backup response was not valid UTF-8');
    }
  } finally {
    reader.releaseLock();
  }
}

export class AwsBackupInventoryApi {
  constructor(
    private readonly timeoutMs: number,
    private readonly fetcher: typeof fetch,
    private readonly budget: AwsBackupRequestBudget,
    private readonly maxItems: number,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000
      || !Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > MAX_TOTAL_ITEMS) {
      fail('AWS Backup timeout or item budget is outside the supported bounds');
    }
  }

  private async getJson(
    scope: AwsBackupInventoryScope,
    credentials: AwsBackupInventoryCredentials,
    path: string,
    parameters: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    if (this.budget.total >= this.budget.maximum) {
      return fail('AWS provider calls exceeded the global page/request budget');
    }
    this.budget.total += 1;
    const dnsSuffix = scope.region_reference.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
    const host = 'backup.' + scope.region_reference + '.' + dnsSuffix;
    const canonicalUri = path.split('/').map((part) => part ? encode(part) : '').join('/') || '/';
    const canonicalQuery = Object.keys(parameters).sort().map((key) =>
      encode(key) + '=' + encode(parameters[key]!)).join('&');
    const endpoint = 'https://' + host + canonicalUri + (canonicalQuery ? '?' + canonicalQuery : '');
    const emptyPayloadHash = sha256('');
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const dateStamp = amzDate.slice(0, 8);
    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': emptyPayloadHash,
      'x-amz-date': amzDate,
    };
    if (credentials.session_token) headers['x-amz-security-token'] = credentials.session_token;
    const signedNames = Object.keys(headers).sort();
    const canonicalHeaders = signedNames.map((name) =>
      name + ':' + headers[name]!.trim().replace(/\s+/g, ' ') + '\n').join('');
    const signedHeaders = signedNames.join(';');
    const canonicalRequest = ['GET', canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, emptyPayloadHash].join('\n');
    const scopeText = dateStamp + '/' + scope.region_reference + '/backup/aws4_request';
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scopeText, sha256(canonicalRequest)].join('\n');
    const signingKey = hmac(
      hmac(hmac(hmac('AWS4' + credentials.secret_access_key, dateStamp), scope.region_reference), 'backup'),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
    const authorization = 'AWS4-HMAC-SHA256 Credential=' + credentials.access_key_id + '/'
      + scopeText + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;

    let response: Response;
    try {
      response = await this.fetcher(endpoint, {
        method: 'GET',
        headers: { ...headers, authorization },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return fail('AWS Backup GET request failed before a verified response');
    }
    const text = await readBoundedResponse(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return fail('AWS Backup returned malformed JSON');
    }
    if (!response.ok) {
      const error = isRecord(parsed)
        ? String(parsed.code ?? parsed.Code ?? parsed.__type ?? 'HTTP_' + response.status)
        : 'HTTP_' + response.status;
      const code = error.split('#').pop()?.split(':').pop() ?? 'UNKNOWN';
      if (!/^[A-Za-z0-9_.-]{1,100}$/.test(code)) return fail('AWS Backup returned an invalid service error code');
      return fail('AWS Backup inventory request was denied or failed (' + code + ')');
    }
    if (!isRecord(parsed)) return fail('AWS Backup returned an unexpected JSON response');
    return parsed;
  }

  async listBackupVaults(
    scope: AwsBackupInventoryScope,
    credentials: AwsBackupInventoryCredentials,
  ): Promise<{ vaults: AwsBackupVaultRecord[]; pages: number; receipts: string[] }> {
    const vaults: AwsBackupVaultRecord[] = [];
    const receipts: string[] = [];
    const seenTokens = new Set<string>();
    let nextToken: string | null = null;
    let pages = 0;
    do {
      const parameters: Record<string, string> = { maxResults: '1000' };
      if (nextToken) parameters.nextToken = nextToken;
      const response = await this.getJson(scope, credentials, '/backup-vaults/', parameters);
      const page = response.BackupVaultList;
      if (!Array.isArray(page) || page.length > 1000 || vaults.length + page.length > this.maxItems) {
        return fail('AWS Backup ListBackupVaults exceeded its per-page or total item budget');
      }
      for (const item of page) {
        if (!isRecord(item)) return fail('AWS Backup returned a malformed vault entry');
        const name = typeof item.BackupVaultName === 'string' ? item.BackupVaultName : '';
        if (!/^[A-Za-z0-9_-]{2,50}$/.test(name)) return fail('AWS Backup returned an invalid vault name');
        vaults.push({
          account_id: scope.account_reference,
          region: scope.region_reference,
          backup_vault_arn: validateAwsBackupArn(item.BackupVaultArn, scope, 'backup-vault'),
          backup_vault_name: name,
          vault_type: typeof item.VaultType === 'string' ? item.VaultType : null,
          vault_state: typeof item.VaultState === 'string' ? item.VaultState : null,
          locked: safeBoolean(item.Locked),
          lock_date: timestamp(item.LockDate),
          min_retention_days: safeNumber(item.MinRetentionDays),
          max_retention_days: safeNumber(item.MaxRetentionDays),
          number_of_recovery_points: safeNumber(item.NumberOfRecoveryPoints),
          encryption_key_arn: typeof item.EncryptionKeyArn === 'string' ? item.EncryptionKeyArn : null,
          creation_date: timestamp(item.CreationDate),
        });
      }
      pages += 1;
      receipts.push('aws-backup.list-backup-vaults.'
        + sha256(scope.account_reference + ':' + scope.region_reference + ':' + sha256(JSON.stringify(page))).slice(0, 32));
      const token = response.NextToken;
      if (token !== undefined && token !== null && token !== '') {
        if (typeof token !== 'string' || token.length > 100000 || seenTokens.has(token)) {
          return fail('AWS Backup ListBackupVaults returned an invalid or repeated continuation token');
        }
        seenTokens.add(token);
        nextToken = token;
      } else nextToken = null;
    } while (nextToken !== null);
    if (new Set(vaults.map((vault) => vault.backup_vault_arn)).size !== vaults.length) {
      return fail('AWS Backup ListBackupVaults returned a duplicate vault ARN');
    }
    return { vaults, pages, receipts };
  }

  async listRecoveryPointsByVault(
    scope: AwsBackupInventoryScope,
    credentials: AwsBackupInventoryCredentials,
    vault: AwsBackupVaultRecord,
  ): Promise<{ points: AwsBackupRecoveryPointRecord[]; pages: number; total_items_seen: number; receipts: string[] }> {
    const points: AwsBackupRecoveryPointRecord[] = [];
    let totalItemsSeen = 0;
    const receipts: string[] = [];
    const seenTokens = new Set<string>();
    let nextToken: string | null = null;
    let pages = 0;
    do {
      const parameters: Record<string, string> = { maxResults: '1000' };
      if (nextToken) parameters.nextToken = nextToken;
      const path = '/backup-vaults/' + encode(vault.backup_vault_name) + '/recovery-points/';
      const response = await this.getJson(scope, credentials, path, parameters);
      const page = response.RecoveryPoints;
      if (!Array.isArray(page) || page.length > 1000 || totalItemsSeen + page.length > this.maxItems) {
        return fail('AWS Backup ListRecoveryPointsByBackupVault exceeded its per-page or total item budget');
      }
      totalItemsSeen += page.length;
      for (const item of page) {
        if (!isRecord(item)) return fail('AWS Backup returned a malformed recovery-point entry');
        if (item.ResourceType !== 'RDS' && item.ResourceType !== 'Aurora') continue;
        const recoveryPointArn = validateAwsBackupArn(item.RecoveryPointArn, scope, 'recovery-point');
        const resourceArn = item.ResourceArn;
        const resourceMatch = typeof resourceArn === 'string'
          ? /^arn:(aws|aws-us-gov|aws-cn):rds:([a-z0-9-]+):(\d{12}):(db|cluster):[A-Za-z0-9:_-]+$/.exec(resourceArn)
          : null;
        const expectedPartition = scope.region_reference.startsWith('cn-') ? 'aws-cn'
          : scope.region_reference.startsWith('us-gov-') ? 'aws-us-gov' : 'aws';
        if (!resourceMatch || resourceMatch[1] !== expectedPartition
          || (item.ResourceType === 'RDS' && resourceMatch[4] !== 'db')
          || (item.ResourceType === 'Aurora' && resourceMatch[4] !== 'cluster')) {
          return fail('AWS Backup returned an RDS/Aurora recovery point with an invalid source resource ARN');
        }
        points.push({
          account_id: scope.account_reference,
          region: scope.region_reference,
          recovery_point_arn: recoveryPointArn,
          backup_vault_arn: vault.backup_vault_arn,
          backup_vault_name: vault.backup_vault_name,
          resource_arn: resourceArn as string,
          resource_type: item.ResourceType,
          status: typeof item.Status === 'string' ? item.Status : null,
          creation_date: timestamp(item.CreationDate),
          completion_date: timestamp(item.CompletionDate),
          last_restore_time: timestamp(item.LastRestoreTime),
          lifecycle_delete_at: isRecord(item.Lifecycle) ? timestamp(item.Lifecycle.DeleteAt) : null,
          lifecycle_move_to_cold_storage_at: isRecord(item.Lifecycle)
            ? timestamp(item.Lifecycle.MoveToColdStorageAt) : null,
          is_encrypted: safeBoolean(item.IsEncrypted),
          encryption_key_arn: typeof item.EncryptionKeyArn === 'string' ? item.EncryptionKeyArn : null,
          backup_size_bytes: safeNumber(item.BackupSizeInBytes),
          source_backup_vault_arn: typeof item.SourceBackupVaultArn === 'string' ? item.SourceBackupVaultArn : null,
          backup_vault_locked: vault.locked,
          backup_vault_lock_date: vault.lock_date,
          backup_vault_min_retention_days: vault.min_retention_days,
          backup_vault_max_retention_days: vault.max_retention_days,
        });
      }
      pages += 1;
      receipts.push('aws-backup.list-recovery-points.'
        + sha256(vault.backup_vault_arn + ':' + sha256(JSON.stringify(page))).slice(0, 32));
      const token = response.NextToken;
      if (token !== undefined && token !== null && token !== '') {
        if (typeof token !== 'string' || token.length > 100000 || seenTokens.has(token)) {
          return fail('AWS Backup ListRecoveryPointsByBackupVault returned an invalid or repeated continuation token');
        }
        seenTokens.add(token);
        nextToken = token;
      } else nextToken = null;
    } while (nextToken !== null);
    if (new Set(points.map((point) => point.recovery_point_arn)).size !== points.length) {
      return fail('AWS Backup ListRecoveryPointsByBackupVault returned a duplicate recovery-point ARN');
    }
    return { points, pages, total_items_seen: totalItemsSeen, receipts };
  }
}
