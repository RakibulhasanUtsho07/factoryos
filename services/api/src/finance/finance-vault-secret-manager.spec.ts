import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type FinanceJsonHttpClient,
  type FinanceJsonHttpRequest,
} from './finance-business-central.adapter';
import { VaultFinanceSecretManager } from './finance-vault-secret-manager';

class FakeVaultHttp implements FinanceJsonHttpClient {
  requests: FinanceJsonHttpRequest[] = [];
  response: unknown = { data: { data: { access_token: 'bc-provider-access-token-value' } } };
  async request<T>(input: FinanceJsonHttpRequest): Promise<T> {
    this.requests.push(input);
    return this.response as T;
  }
}

const ENV_KEYS = [
  'FINANCE_VAULT_ADDR',
  'FINANCE_VAULT_TOKEN_FILE',
  'FINANCE_VAULT_KV_MOUNT',
  'FINANCE_VAULT_ALLOWED_SECRET_PREFIXES',
  'FINANCE_VAULT_ALLOWED_HOSTS',
  'FINANCE_VAULT_ALLOWED_IPS',
] as const;
const priorEnv = new Map<string, string | undefined>();
let temporaryDirectory: string | undefined;

async function configureVaultEnvironment() {
  priorEnv.clear();
  for (const key of ENV_KEYS) priorEnv.set(key, process.env[key]);
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'factoryos-finance-vault-'));
  const tokenFile = path.join(temporaryDirectory, 'agent-token');
  await writeFile(tokenFile, 'vault-agent-token-not-a-real-secret\n', { mode: 0o600 });
  process.env.FINANCE_VAULT_ADDR = 'https://vault.example.com';
  process.env.FINANCE_VAULT_TOKEN_FILE = tokenFile;
  process.env.FINANCE_VAULT_KV_MOUNT = 'secret';
  process.env.FINANCE_VAULT_ALLOWED_SECRET_PREFIXES = 'factoryos/prod';
  process.env.FINANCE_VAULT_ALLOWED_HOSTS = 'vault.example.com';
  process.env.FINANCE_VAULT_ALLOWED_IPS = '8.8.8.8';
}

async function restoreEnvironment() {
  for (const key of ENV_KEYS) {
    const value = priorEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
}

afterEach(async () => restoreEnvironment());

describe('Vault KV-v2 finance secret-manager integration', () => {
  it('resolves only the provider access token over the separately pinned Vault network', async () => {
    await configureVaultEnvironment();
    const http = new FakeVaultHttp();
    const secrets = new VaultFinanceSecretManager(http);
    const token = await secrets.resolveBearerToken(
      'vault://factoryos/prod/business-central',
      { tenant_id: 'tenant-1', factory_id: 'factory-1', connector_id: 'connector-1' },
    );
    expect(token).toBe('bc-provider-access-token-value');
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0].url).toBe(
      'https://vault.example.com/v1/secret/data/factoryos/prod/business-central',
    );
    expect(http.requests[0].authHeader).toEqual({
      name: 'X-Vault-Token',
      value: 'vault-agent-token-not-a-real-secret',
    });
    expect(http.requests[0].bearerToken).toBeUndefined();
  });

  it('rejects path traversal and connector references outside the deployment secret prefix', async () => {
    await configureVaultEnvironment();
    const http = new FakeVaultHttp();
    const secrets = new VaultFinanceSecretManager(http);
    await expect(secrets.resolveBearerToken(
      'vault://factoryos/prod/../admin/root',
      { tenant_id: 't', factory_id: 'f', connector_id: 'c' },
    )).rejects.toThrow('FINANCE_VAULT_SECRET_PATH_INVALID');
    await expect(secrets.resolveBearerToken(
      'vault://other-team/credentials',
      { tenant_id: 't', factory_id: 'f', connector_id: 'c' },
    )).rejects.toThrow('FINANCE_VAULT_SECRET_PATH_NOT_ALLOWLISTED');
    expect(http.requests).toHaveLength(0);
  });

  it('fails closed when agent identity or Vault configuration is absent', async () => {
    await configureVaultEnvironment();
    const tokenFile = process.env.FINANCE_VAULT_TOKEN_FILE as string;
    await rm(tokenFile, { force: true });
    const secrets = new VaultFinanceSecretManager(new FakeVaultHttp());
    await expect(secrets.resolveBearerToken(
      'vault://factoryos/prod/business-central',
      { tenant_id: 't', factory_id: 'f', connector_id: 'c' },
    )).rejects.toThrow('FINANCE_VAULT_AGENT_TOKEN_UNAVAILABLE');

    process.env.FINANCE_VAULT_TOKEN_FILE = '';
    await expect(secrets.resolveBearerToken(
      'vault://factoryos/prod/business-central',
      { tenant_id: 't', factory_id: 'f', connector_id: 'c' },
    )).rejects.toThrow('FINANCE_VAULT_RUNTIME_CONFIGURATION_MISSING');
  });

  it('rejects missing or unsafe access-token values from a Vault response', async () => {
    await configureVaultEnvironment();
    const http = new FakeVaultHttp();
    http.response = { data: { data: { access_token: 'bad\ntoken' } } };
    const secrets = new VaultFinanceSecretManager(http);
    await expect(secrets.resolveBearerToken(
      'vault://factoryos/prod/business-central',
      { tenant_id: 't', factory_id: 'f', connector_id: 'c' },
    )).rejects.toThrow('FINANCE_VAULT_PROVIDER_ACCESS_TOKEN_MISSING');
  });
});
