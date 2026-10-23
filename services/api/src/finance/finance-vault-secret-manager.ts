import { Inject, Injectable, Optional } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  FINANCE_BUSINESS_CENTRAL_HTTP_CLIENT,
  PinnedFinanceJsonHttpClient,
  type FinanceJsonHttpClient,
  type FinanceSecretManager,
} from './finance-business-central.adapter';

type FinanceSecretContext = { tenant_id: string; factory_id: string; connector_id: string };

function commaSeparatedSet(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean));
}

function validateVaultPath(reference: string): string {
  if (!reference.startsWith('vault://')) throw new Error('FINANCE_SECRET_REFERENCE_PROVIDER_UNSUPPORTED');
  const path = reference.slice('vault://'.length).replace(/^\/+|\/+$/g, '');
  const segments = path.split('/');
  if (!path || path.length > 512 || segments.some((segment) =>
    !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]{1,128}$/.test(segment))) {
    throw new Error('FINANCE_VAULT_SECRET_PATH_INVALID');
  }
  const prefixes = (process.env.FINANCE_VAULT_ALLOWED_SECRET_PREFIXES ?? '')
    .split(',').map((entry) => entry.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean);
  if (prefixes.length === 0 || !prefixes.some((prefix) =>
    path === prefix || path.startsWith(prefix + '/'))) {
    throw new Error('FINANCE_VAULT_SECRET_PATH_NOT_ALLOWLISTED');
  }
  return path;
}

function validateSingleLineSecret(value: unknown, errorCode: string): string {
  if (typeof value !== 'string' || value.trim().length < 8 || value.length > 8192 ||
      /[\r\n\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(errorCode);
  }
  return value.trim();
}

/**
 * HashiCorp Vault KV-v2 resolver. A short-lived Vault Agent token is mounted
 * through workload identity. Only specifically named provider credentials are
 * returned to the appropriate adapter; raw secret documents are never returned.
 */
@Injectable()
export class VaultFinanceSecretManager implements FinanceSecretManager {
  constructor(
    @Optional() @Inject(FINANCE_BUSINESS_CENTRAL_HTTP_CLIENT)
    private readonly http?: FinanceJsonHttpClient,
  ) {}

  async resolveBearerToken(
    secretReference: string,
    _context: FinanceSecretContext,
  ): Promise<string> {
    const data = await this.readVaultData(secretReference);
    return validateSingleLineSecret(data.access_token, 'FINANCE_VAULT_PROVIDER_ACCESS_TOKEN_MISSING');
  }

  async resolveSftpPrivateKey(
    secretReference: string,
    _context: FinanceSecretContext,
  ): Promise<string> {
    const data = await this.readVaultData(secretReference);
    const key = data.sftp_private_key_pem;
    if (typeof key !== 'string' || key.length < 80 || key.length > 64 * 1024 ||
        key.includes('\u0000') ||
        !/^-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----\r?\n[\s\S]{32,63000}\r?\n-----END (?:OPENSSH |RSA |EC )?PRIVATE KEY-----\r?\n?$/.test(key)) {
      throw new Error('FINANCE_VAULT_SFTP_PRIVATE_KEY_MISSING_OR_INVALID');
    }
    return key.endsWith('\n') ? key : key + '\n';
  }

  private async readVaultData(secretReference: string): Promise<Record<string, unknown>> {
    const secretPath = validateVaultPath(secretReference);
    const addressValue = process.env.FINANCE_VAULT_ADDR ?? '';
    const tokenFile = process.env.FINANCE_VAULT_TOKEN_FILE ?? '';
    const mount = process.env.FINANCE_VAULT_KV_MOUNT ?? 'secret';
    if (!addressValue || !tokenFile || !isAbsolute(tokenFile) ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(mount)) {
      throw new Error('FINANCE_VAULT_RUNTIME_CONFIGURATION_MISSING');
    }
    let address: URL;
    try {
      address = new URL(addressValue);
    } catch {
      throw new Error('FINANCE_VAULT_ADDRESS_INVALID');
    }
    if (address.protocol !== 'https:' || address.username || address.password ||
        address.pathname !== '/' || address.search || address.hash) {
      throw new Error('FINANCE_VAULT_ADDRESS_INVALID');
    }

    let vaultToken: string;
    try {
      vaultToken = (await readFile(tokenFile, 'utf8')).trim();
    } catch {
      throw new Error('FINANCE_VAULT_AGENT_TOKEN_UNAVAILABLE');
    }
    validateSingleLineSecret(vaultToken, 'FINANCE_VAULT_AGENT_TOKEN_INVALID');

    const path = secretPath.split('/').map(encodeURIComponent).join('/');
    const url = new URL('/v1/' + mount + '/data/' + path, address.origin).toString();
    const client = this.http ?? new PinnedFinanceJsonHttpClient(
      commaSeparatedSet(process.env.FINANCE_VAULT_ALLOWED_HOSTS),
      commaSeparatedSet(process.env.FINANCE_VAULT_ALLOWED_IPS),
    );
    const response = await client.request<{
      data?: { data?: Record<string, unknown> };
    }>({
      url,
      method: 'GET',
      authHeader: { name: 'X-Vault-Token', value: vaultToken },
    });
    const data = response?.data?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('FINANCE_VAULT_SECRET_DOCUMENT_INVALID');
    }
    return data;
  }
}
