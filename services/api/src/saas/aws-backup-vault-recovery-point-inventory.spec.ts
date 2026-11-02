import { jest } from '@jest/globals';
import {
  captureAwsBackupVaultRecoveryPointInventory,
  type AwsBackupVaultRecoveryPointInventoryInput,
} from './aws-backup-vault-recovery-point-inventory';

const account = '111111111111';
const roleName = 'FactoryOSAwsBackupInventoryReader';
const credentials = {
  access_key_id: 'ASIABACKUPREADER12345',
  secret_access_key: 'aws-backup-inventory-reader-secret-0123456789',
  session_token: 'aws-backup-inventory-reader-session-token-0123456789',
};
const region = 'ap-southeast-1';
const partition = 'aws';
const standardVaultArn = 'arn:aws:backup:ap-southeast-1:111111111111:backup-vault:standard';
const airgapVaultArn = 'arn:aws:backup:ap-southeast-1:111111111111:backup-vault:airgap';
const restoreVaultArn = 'arn:aws:backup:ap-southeast-1:111111111111:backup-vault:restore-access';
const sourceRecoveryPointArn = 'arn:aws:backup:ap-southeast-1:111111111111:recovery-point:source';
const airgapRecoveryPointArn = 'arn:aws:backup:ap-southeast-1:111111111111:recovery-point:airgap-copy';
const restoreRecoveryPointArn = 'arn:aws:backup:ap-southeast-1:111111111111:recovery-point:restore-copy';

function vault(name: string, arn: string, type: string): Record<string, unknown> {
  return {
    BackupVaultName: name,
    BackupVaultArn: arn,
    VaultType: type,
    VaultState: 'AVAILABLE',
    CreationDate: 1790899200,
    EncryptionKeyArn: 'arn:aws:kms:ap-southeast-1:111111111111:key/11111111-1111-4111-8111-111111111111',
    EncryptionKeyType: 'CUSTOMER_MANAGED_KMS_KEY',
    NumberOfRecoveryPoints: 1,
    Locked: true,
    MinRetentionDays: 7,
    MaxRetentionDays: 3650,
    LockDate: 1793491200,
  };
}

function recoveryPoint(
  arn: string,
  vaultArn: string,
  sourceVaultArn?: string,
  createdAt: number | null = 1790985600,
): Record<string, unknown> {
  return {
    RecoveryPointArn: arn,
    BackupVaultArn: vaultArn,
    BackupVaultName: vaultArn.split(':').pop(),
    ResourceArn: 'arn:aws:rds:ap-southeast-1:111111111111:db:factoryos-db',
    ResourceType: 'RDS',
    ResourceName: 'factoryos-db',
    Status: 'COMPLETED',
    ...(createdAt === null ? {} : { CreationDate: createdAt }),
    CompletionDate: 1790985900,
    InitiationDate: 1790985500,
    LastRestoreTime: 1790986000,
    BackupSizeInBytes: 123456789,
    IsEncrypted: true,
    EncryptionKeyArn: 'arn:aws:kms:ap-southeast-1:111111111111:key/22222222-2222-4222-8222-222222222222',
    EncryptionKeyType: 'CUSTOMER_MANAGED_KMS_KEY',
    ...(sourceVaultArn ? { SourceBackupVaultArn: sourceVaultArn } : {}),
    CreatedBy: {
      BackupPlanArn: 'arn:aws:backup:ap-southeast-1:111111111111:backup-plan:plan-1',
      BackupPlanId: 'plan-1',
      BackupPlanVersion: 'v3',
      BackupRuleId: 'rule-1',
      BackupRuleName: 'daily',
    },
    Lifecycle: {
      DeleteAfterDays: 90,
      MoveToColdStorageAfterDays: 30,
      OptInToArchiveForSupportedResources: true,
    },
    CalculatedLifecycle: {
      DeleteAt: 1798752000,
      MoveToColdStorageAt: 1793577600,
    },
    IsParent: false,
  };
}

function stsResponse(identityAccount = account, identityRole = roleName): string {
  return '<GetCallerIdentityResponse><GetCallerIdentityResult><Account>' + identityAccount + '</Account>'
    + '<Arn>arn:aws:sts::' + identityAccount + ':assumed-role/' + identityRole + '/ci-run</Arn>'
    + '</GetCallerIdentityResult></GetCallerIdentityResponse>';
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string;
}

interface FixtureOptions {
  wrongIdentity?: boolean;
  deniedAction?: string;
  repeatedVaultToken?: boolean;
  missingCreationDate?: boolean;
  unknownLegalHoldPoint?: boolean;
  sourceVaultOutsideScope?: boolean;
  maxPages?: number;
  pageOverrides?: Record<string, unknown[]>;
}

function makeInput(options: FixtureOptions = {}): {
  input: AwsBackupVaultRecoveryPointInventoryInput;
  calls: Call[];
} {
  const calls: Call[] = [];
  const vaultPage = vault('standard', standardVaultArn, 'BACKUP_VAULT');
  const airgapPage = vault('airgap', airgapVaultArn, 'LOGICALLY_AIR_GAPPED_BACKUP_VAULT');
  const restorePage = vault('restore-access', restoreVaultArn, 'RESTORE_ACCESS_BACKUP_VAULT');
  const byName: Record<string, Record<string, unknown>> = {
    standard: vaultPage,
    airgap: airgapPage,
    'restore-access': { ...restorePage, SourceBackupVaultArn: airgapVaultArn },
  };
  const pageCounts = new Map<string, number>();

  const fetcher = jest.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = String(init?.body ?? '');
    const call: Call = {
      url,
      method: String(init?.method ?? 'GET'),
      headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)])),
      body,
    };
    calls.push(call);

    if (url.host.startsWith('sts.')) {
      return new Response(stsResponse(options.wrongIdentity ? '999999999999' : account));
    }

    const path = url.pathname;
    const action =
      path === '/backup-vaults/' ? 'ListBackupVaults'
        : path === '/legal-holds/' ? 'ListLegalHolds'
          : /^\/backup-vaults\/[^/]+\/recovery-points\/$/.test(path) ? 'ListRecoveryPointsByBackupVault'
            : /^\/backup-vaults\/[^/]+$/.test(path) ? 'DescribeBackupVault'
              : /^\/logically-air-gapped-backup-vaults\/[^/]+\/restore-access-backup-vaults\/$/.test(path)
                ? 'ListRestoreAccessBackupVaults'
                : /^\/legal-holds\/[^/]+\/recovery-points$/.test(path) ? 'ListRecoveryPointsByLegalHold'
                  : /^\/legal-holds\/[^/]+\/$/.test(path) ? 'GetLegalHold'
                    : 'Unknown';

    if (options.deniedAction === action) return jsonResponse({ message: 'denied' }, 403);

    const token = url.searchParams.get('nextToken');
    const indexKey = action + ':' + path;
    const index = pageCounts.get(indexKey) ?? 0;
    pageCounts.set(indexKey, index + 1);

    if (action === 'ListBackupVaults') {
      if (token === 'vault-page-2') return jsonResponse({ BackupVaultList: [] });
      if (options.repeatedVaultToken) {
        return jsonResponse({ BackupVaultList: [vaultPage], NextToken: 'repeat-me' });
      }
      return jsonResponse({ BackupVaultList: [vaultPage, airgapPage, restorePage], NextToken: 'vault-page-2' });
    }

    if (action === 'DescribeBackupVault') {
      const name = decodeURIComponent(path.split('/')[2] ?? '');
      return jsonResponse(byName[name] ?? {});
    }

    if (action === 'ListRecoveryPointsByBackupVault') {
      const name = decodeURIComponent(path.split('/')[2] ?? '');
      if (name === 'standard') {
        return jsonResponse({
          RecoveryPoints: [recoveryPoint(
            sourceRecoveryPointArn,
            standardVaultArn,
            options.sourceVaultOutsideScope
              ? 'arn:aws:backup:ap-northeast-1:222222222222:backup-vault:foreign-source'
              : undefined,
            options.missingCreationDate ? null : 1790985600,
          )],
        });
      }
      if (name === 'airgap') {
        return jsonResponse({ RecoveryPoints: [recoveryPoint(airgapRecoveryPointArn, airgapVaultArn, standardVaultArn)] });
      }
      return jsonResponse({ RecoveryPoints: [recoveryPoint(restoreRecoveryPointArn, restoreVaultArn, airgapVaultArn)] });
    }

    if (action === 'ListRestoreAccessBackupVaults') {
      return jsonResponse({
        RestoreAccessBackupVaults: [{
          RestoreAccessBackupVaultArn: restoreVaultArn,
          VaultState: 'AVAILABLE',
          CreationDate: 1791000000,
          ApprovalDate: 1791000300,
          LatestRevokeRequest: {
            Status: 'NONE',
            InitiationDate: 1791000400,
            ExpiryDate: 1791004000,
          },
        }],
      });
    }

    if (action === 'ListLegalHolds') {
      return jsonResponse({
        LegalHolds: [
          {
            LegalHoldId: 'hold-1',
            LegalHoldArn: 'arn:aws:backup:ap-southeast-1:111111111111:legal-hold:hold-1',
            Status: 'ACTIVE',
            CreationDate: 1791000000,
          },
          {
            LegalHoldId: 'hold-2',
            LegalHoldArn: 'arn:aws:backup:ap-southeast-1:111111111111:legal-hold:hold-2',
            Status: 'ACTIVE',
            CreationDate: 1791000100,
          },
        ],
      });
    }

    if (action === 'GetLegalHold') {
      const holdId = decodeURIComponent(path.split('/')[2] ?? '');
      return jsonResponse({
        LegalHoldId: holdId,
        LegalHoldArn: 'arn:aws:backup:ap-southeast-1:111111111111:legal-hold:' + holdId,
        Status: 'ACTIVE',
        CreationDate: 1791000000,
        RetainRecordUntil: 1822536000,
        RecoveryPointSelection: {
          VaultNames: ['standard', 'airgap'],
          ResourceIdentifiers: ['arn:aws:rds:ap-southeast-1:111111111111:db:factoryos-db'],
          DateRange: { FromDate: 1790800000, ToDate: 1791100000 },
        },
      });
    }

    if (action === 'ListRecoveryPointsByLegalHold') {
      const holdId = decodeURIComponent(path.split('/')[2] ?? '');
      const firstArn = options.unknownLegalHoldPoint
        ? 'arn:aws:backup:ap-southeast-1:111111111111:recovery-point:missing'
        : sourceRecoveryPointArn;
      const points = [{
        RecoveryPointArn: firstArn,
        BackupVaultName: 'standard',
        ResourceArn: 'arn:aws:rds:ap-southeast-1:111111111111:db:factoryos-db',
        ResourceType: 'RDS',
      }];
      // The source recovery point is shared by two holds; the first hold also
      // protects a second recovery point to prove many-to-many enumeration.
      if (holdId === 'hold-1') {
        points.push({
          RecoveryPointArn: airgapRecoveryPointArn,
          BackupVaultName: 'airgap',
          ResourceArn: 'arn:aws:rds:ap-southeast-1:111111111111:db:factoryos-db',
          ResourceType: 'RDS',
        });
      }
      return jsonResponse({ RecoveryPoints: points });
    }

    return jsonResponse({ message: 'unexpected route ' + path }, 404);
  });

  const input: AwsBackupVaultRecoveryPointInventoryInput = {
    scopes: [{
      account_id: account,
      partition,
      region,
      expected_assumed_role_name: roleName,
      credentials,
    }],
    fetcher,
    now: () => new Date('2026-11-02T14:00:00.000Z'),
    ...(options.maxPages ? { max_pages: options.maxPages } : {}),
  };
  return { input, calls };
}

describe('AWS Backup vault and recovery-point inventory', () => {
  test('enumerates all vault types, recovery-point lifecycle/encryption/source metadata and legal-hold relationships', async () => {
    const { input, calls } = makeInput();
    const result = await captureAwsBackupVaultRecoveryPointInventory(input);

    expect(result.schema).toBe('factoryos.aws-backup-vault-recovery-point-inventory/v1');
    expect(result.status).toBe('COMPLETE');
    expect(result.verified_scope_count).toBe(1);
    expect(result.vaults).toHaveLength(3);
    expect(result.observed_vault_types).toEqual([
      'BACKUP_VAULT',
      'LOGICALLY_AIR_GAPPED_BACKUP_VAULT',
      'RESTORE_ACCESS_BACKUP_VAULT',
    ]);
    expect(result.vault_catalog_complete).toBe(true);
    expect(result.recovery_point_catalog_complete).toBe(true);
    expect(result.recovery_points).toHaveLength(3);
    expect(result.recovery_points[0]?.creation_date).toBe('2026-10-03T00:00:00.000Z');
    expect(result.recovery_points[0]?.lifecycle_delete_after_days).toBe(90);
    expect(result.recovery_points[0]?.calculated_delete_at).toBe('2026-12-31T21:20:00.000Z');
    expect(result.recovery_points[0]?.encryption_key_type).toBe('CUSTOMER_MANAGED_KMS_KEY');
    expect(result.recovery_points[1]?.source_backup_vault_arn).toBe(standardVaultArn);
    expect(result.legal_holds).toHaveLength(2);
    expect(result.legal_holds[0]?.status).toBe('ACTIVE');
    expect(result.legal_holds[0]?.selected_vault_names).toEqual(['airgap', 'standard']);
    expect(result.legal_holds[0]?.selected_resource_identifier_count).toBe(1);
    expect(result.legal_hold_recovery_point_relationships).toHaveLength(3);
    expect(result.legal_hold_recovery_point_relationships.filter(
      (relationship) => relationship.recovery_point_arn === sourceRecoveryPointArn,
    )).toHaveLength(2);
    expect(result.legal_hold_recovery_point_relationships.filter(
      (relationship) => relationship.legal_hold_id === 'hold-1',
    )).toHaveLength(2);
    expect(result.restore_access_vault_relationships).toHaveLength(1);
    expect(result.restore_access_vault_relationships[0]?.restore_access_backup_vault_arn).toBe(restoreVaultArn);
    expect(result.restore_access_relationships_complete).toBe(true);
    expect(result.query_receipt_references.length).toBeGreaterThan(0);
    expect(result.pages_fetched).toBeGreaterThanOrEqual(8);
    expect(result.requests_attempted).toBeGreaterThan(result.pages_fetched);
    expect(result.provider_mutation_performed).toBe(false);
    expect(result.restore_api_available).toBe(false);
    expect(result.copy_api_available).toBe(false);
    expect(result.delete_api_available).toBe(false);
    expect(result.deletion_authorized).toBe(false);
    expect(calls.every((call) => call.headers.authorization?.startsWith('AWS4-HMAC-SHA256 Credential='))).toBe(true);
    expect(calls.every((call) => call.headers['x-amz-date'])).toBe(true);
    expect(calls.filter((call) => call.url.host.startsWith('backup.')).every((call) => call.method === 'GET')).toBe(true);
    expect(calls.some((call) => /delete|restore|copy/i.test(call.url.pathname))).toBe(false);
  });

  test('follows an empty ListBackupVaults continuation page and signs both pages', async () => {
    const { input, calls } = makeInput();
    const result = await captureAwsBackupVaultRecoveryPointInventory(input);
    const vaultCalls = calls.filter((call) => call.url.pathname === '/backup-vaults/');
    expect(vaultCalls).toHaveLength(2);
    expect(vaultCalls[0]?.url.searchParams.get('maxResults')).toBe('1000');
    expect(vaultCalls[1]?.url.searchParams.get('nextToken')).toBe('vault-page-2');
    expect(result.status).toBe('COMPLETE');
  });

  test('fails closed on a repeated NextToken', async () => {
    const { input } = makeInput({ repeatedVaultToken: true });
    const result = await captureAwsBackupVaultRecoveryPointInventory(input);
    expect(result.status).toBe('PARTIAL');
    expect(result.vault_catalog_complete).toBe(false);
    expect(result.blockers.join(' ')).toContain('repeated a continuation token');
  });

  test('returns partial inventory when AWS denies legal-hold enumeration', async () => {
    const { input } = makeInput({ deniedAction: 'ListLegalHolds' });
    const result = await captureAwsBackupVaultRecoveryPointInventory(input);
    expect(result.status).toBe('PARTIAL');
    expect(result.legal_hold_catalog_complete).toBe(false);
    expect(result.blockers.join(' ')).toContain('ListLegalHolds');
    expect(result.provider_mutation_performed).toBe(false);
  });

  test('does not enumerate any vault when STS account identity does not match', async () => {
    const { input, calls } = makeInput({ wrongIdentity: true });
    const result = await captureAwsBackupVaultRecoveryPointInventory(input);
    expect(result.status).toBe('PARTIAL');
    expect(result.verified_scope_count).toBe(0);
    expect(result.vaults).toHaveLength(0);
    expect(calls.filter((call) => call.url.host.startsWith('backup.'))).toHaveLength(0);
  });

  test('marks completeness partial when a recovery point has no valid CreationDate', async () => {
    const { input } = makeInput({ missingCreationDate: true });
    const result = await captureAwsBackupVaultRecoveryPointInventory(input);
    expect(result.status).toBe('PARTIAL');
    expect(result.recovery_points[0]?.creation_date).toBeNull();
    expect(result.blockers.join(' ')).toContain('missing a valid CreationDate');
  });

  test('records an explicit gap when a recovery point source vault is outside supplied account/region scopes', async () => {
    const { input } = makeInput({ sourceVaultOutsideScope: true });
    const result = await captureAwsBackupVaultRecoveryPointInventory(input);
    expect(result.status).toBe('PARTIAL');
    expect(result.source_vault_scope_gaps).toHaveLength(1);
    expect(result.blockers.join(' ')).toContain('outside the explicitly supplied account/region scopes');
  });

  test('marks a legal-hold relationship that is absent from the recovery-point catalog as incomplete', async () => {
    const { input } = makeInput({ unknownLegalHoldPoint: true });
    const result = await captureAwsBackupVaultRecoveryPointInventory(input);
    expect(result.status).toBe('PARTIAL');
    expect(result.legal_hold_catalog_complete).toBe(false);
    expect(result.blockers.join(' ')).toContain('absent from the enumerated vault catalog');
  });

  test('enforces a shared page budget across all AWS Backup catalog calls', async () => {
    const { input } = makeInput({ maxPages: 1 });
    const result = await captureAwsBackupVaultRecoveryPointInventory(input);
    expect(result.status).toBe('PARTIAL');
    expect(result.pages_fetched).toBe(1);
    expect(result.blockers.join(' ')).toContain('page budget exhausted');
  });

  test('rejects duplicate account/region scopes before making provider calls', async () => {
    const { input } = makeInput();
    input.scopes = [input.scopes[0]!, { ...input.scopes[0]! }];
    await expect(captureAwsBackupVaultRecoveryPointInventory(input)).rejects.toThrow('duplicate account/region scope');
  });
});
