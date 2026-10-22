import { Inject, Injectable, Optional } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  FINANCE_BUSINESS_CENTRAL_HTTP_CLIENT,
  PinnedFinanceJsonHttpClient,
  type FinanceJsonHttpClient,
  type FinanceSecretManager,
} from './finance-business-central.adapter';

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

/**
 * HashiCorp Vault KV-v2 resolver. The Vault Agent/workload identity integration
 * writes a short-lived Vault API token to a mounted file; no static Vault token
 * is kept in application configuration. Only the provider access_token value is
 * returned to the ERP adapter. Vault networking uses its own DNS/IP allowlists.
 */
@Injectable()
export class VaultFinanceSecretManager implements FinanceSecretManager {
  constructor(
    @Optional() @Inject(FINANCE_BUSINESS_CENTRAL_HTTP_CLIENT)
    private readonly http?: FinanceJsonHttpClient,
  ) {}

  async resolveBearerToken(
    secretReference: string,
    _context: { tenant_id: string; factory_id: string; connector_id: string },
  ): Promise<string> {
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
    if (vaultToken.length < 8 || vaultToken.length > 8192 ||
        /[\r\n\u0000-\u001f\u007f]/.test(vaultToken)) {
      throw new Error('FINANCE_VAULT_AGENT_TOKEN_INVALID');
    }

    const path = secretPath.split('/').map(encodeURIComponent).join('/');
    const url = new URL('/v1/' + mount + '/data/' + path, address.origin).toString();
    const client = this.http ?? new PinnedFinanceJsonHttpClient(
      commaSeparatedSet(process.env.FINANCE_VAULT_ALLOWED_HOSTS),
      commaSeparatedSet(process.env.FINANCE_VAULT_ALLOWED_IPS),
    );
    const response = await client.request<{
      data?: { data?: { access_token?: unknown } };
    }>({
      url,
      method: 'GET',
      authHeader: { name: 'X-Vault-Token', value: vaultToken },
    });
    const accessToken = response?.data?.data?.access_token;
    if (typeof accessToken !== 'string' || accessToken.trim().length < 8 ||
        accessToken.length > 8192 || /[\r\n\u0000-\u001f\u007f]/.test(accessToken)) {
      throw new Error('FINANCE_VAULT_PROVIDER_ACCESS_TOKEN_MISSING');
    }
    return accessToken.trim();
  }
}
