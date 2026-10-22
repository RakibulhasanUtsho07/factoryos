import { afterEach, describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  OpenSshFinanceSftpTransport,
  sftpFingerprintForPublicKeyBlob,
  type FinanceSftpCommandRunner,
} from './finance-openssh-sftp.transport';
import type { FinanceSftpConfiguration } from './finance-contract';
import type { FinanceSecretManager } from './finance-business-central.adapter';

const KEY_BLOB = Buffer.from('a representative ssh public key blob for deterministic host-key tests').toString('base64');
const HOST_KEY_FINGERPRINT = sftpFingerprintForPublicKeyBlob(KEY_BLOB);
const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\n' + 'k'.repeat(120) + '\n-----END OPENSSH PRIVATE KEY-----\n';
const context = { tenant_id: 'tenant-01', factory_id: 'factory-01', connector_id: 'connector-01' };
const config: FinanceSftpConfiguration = {
  host: 'erp-files.example.com',
  port: 22,
  username: 'factoryos_reader',
  remote_directory: '/incoming/finance',
  file_format: 'CSV',
  host_key_sha256: HOST_KEY_FINGERPRINT,
  file_pattern: 'finance-*.csv',
};
const priorEnv = new Map<string, string | undefined>();
const ENV_KEYS = ['FINANCE_SFTP_ALLOWED_HOSTS', 'FINANCE_SFTP_ALLOWED_IPS'] as const;

class FakeSftpSecrets implements FinanceSecretManager {
  async resolveBearerToken() { return 'unused-provider-token'; }
  async resolveSftpPrivateKey(reference: string, input: typeof context) {
    if (reference !== 'vault://factoryos/prod/sftp') throw new Error('unexpected secret ref');
    expect(input).toEqual(context);
    return PRIVATE_KEY;
  }
}

class FakeSftpRunner implements FinanceSftpCommandRunner {
  readonly calls: Array<{ program: string; args: string[]; input: string }> = [];
  readonly remoteFiles = new Map<string, Buffer>();
  keyBlob = KEY_BLOB;
  failSftp = false;

  async run(
    program: 'ssh-keyscan' | 'sftp',
    args: string[],
    input: string | Buffer = '',
  ): Promise<Buffer> {
    const batch = Buffer.isBuffer(input) ? input.toString('utf8') : input;
    this.calls.push({ program, args, input: batch });
    if (program === 'ssh-keyscan') {
      return Buffer.from('8.8.8.8 ssh-ed25519 ' + this.keyBlob + '\n');
    }
    if (this.failSftp) throw new Error('simulated SFTP failure');
    for (const line of batch.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      const match = line.match(/^(ls -1|get|put|rename|rm)\s*(.*)$/);
      if (!match) throw new Error('unknown batch command');
      const operation = match[1];
      const argsText = match[2];
      if (operation === 'ls -1') {
        const dir = this.unquote(argsText);
        const names = [...this.remoteFiles.keys()]
          .filter((remotePath) => path.posix.dirname(remotePath) === dir)
          .map((remotePath) => path.posix.basename(remotePath))
          .sort();
        return Buffer.from(names.join('\n') + (names.length ? '\n' : ''));
      }
      if (operation === 'get') {
        const parts = this.parseTwoQuoted(argsText);
        const bytes = this.remoteFiles.get(parts[0]);
        if (!bytes) throw new Error('remote file missing');
        const fs = await import('node:fs/promises');
        await fs.writeFile(parts[1], bytes, { mode: 0o600 });
        continue;
      }
      if (operation === 'put') {
        const [localPath, remotePath] = this.parseTwoQuoted(argsText);
        const bytes = await readFile(localPath);
        this.remoteFiles.set(remotePath, bytes);
        continue;
      }
      if (operation === 'rename') {
        const [source, target] = this.parseTwoQuoted(argsText);
        const bytes = this.remoteFiles.get(source);
        if (!bytes) throw new Error('rename source missing');
        if (this.remoteFiles.has(target)) throw new Error('rename target exists');
        this.remoteFiles.set(target, bytes);
        this.remoteFiles.delete(source);
        continue;
      }
      if (operation === 'rm') {
        const remotePath = this.unquote(argsText);
        if (!this.remoteFiles.delete(remotePath)) throw new Error('remote file missing');
      }
    }
    return Buffer.alloc(0);
  }

  private unquote(value: string): string {
    if (!value.startsWith('"') || !value.endsWith('"')) throw new Error('expected quoted path');
    return value.slice(1, -1).replace(/\\("|\\)/g, '$1');
  }

  private parseTwoQuoted(value: string): [string, string] {
    const match = value.match(/^"([^"]+)"\s+"([^"]+)"$/);
    if (!match) throw new Error('expected two quoted paths');
    return [this.unquote(match[1].replace(/^/, '"').replace(/$/, '"')), this.unquote(match[2].replace(/^/, '"').replace(/$/, '"'))];
  }
}

function setupEnvironment() {
  priorEnv.clear();
  for (const key of ENV_KEYS) priorEnv.set(key, process.env[key]);
  process.env.FINANCE_SFTP_ALLOWED_HOSTS = 'erp-files.example.com';
  process.env.FINANCE_SFTP_ALLOWED_IPS = '8.8.8.8';
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = priorEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function makeTransport(runner = new FakeSftpRunner(), secrets: FinanceSecretManager = new FakeSftpSecrets()) {
  const dnsLookup = async (host: string) => {
    expect(host).toBe('erp-files.example.com');
    return [{ address: '8.8.8.8', family: 4 }];
  };
  return {
    transport: new OpenSshFinanceSftpTransport(secrets, runner, dnsLookup),
    runner,
  };
}

describe('OpenSSH SFTP production transport contract', () => {
  it('pins a DNS answer and verifies the observed host key before downloading a bounded file', async () => {
    setupEnvironment();
    const { transport, runner } = makeTransport();
    const bytes = Buffer.from('external_fact_id,amount\nAP-1,99.50\n');
    runner.remoteFiles.set('/incoming/finance/finance-ap-001.csv', bytes);
    const download = await transport.downloadNext({
      ...context,
      secret_reference: 'vault://factoryos/prod/sftp',
      configuration: config,
    });
    expect(download).toMatchObject({
      remote_path: '/incoming/finance/finance-ap-001.csv',
      file_name: 'finance-ap-001.csv',
      format: 'CSV',
      content: bytes,
      verified_host_key_sha256: HOST_KEY_FINGERPRINT,
    });
    const scan = runner.calls.find((call) => call.program === 'ssh-keyscan');
    expect(scan?.args).toContain('8.8.8.8');
    const sftpCall = runner.calls.find((call) => call.program === 'sftp');
    expect(sftpCall?.args).toContain('-oStrictHostKeyChecking=yes');
    expect(sftpCall?.args).toContain('-oHostName=8.8.8.8');
    expect(sftpCall?.args.some((arg) => arg.includes('vault://'))).toBe(false);
  });

  it('rejects a host-key mismatch before opening an SFTP session', async () => {
    setupEnvironment();
    const runner = new FakeSftpRunner();
    const { transport } = makeTransport(runner);
    await expect(transport.downloadNext({
      ...context,
      secret_reference: 'vault://factoryos/prod/sftp',
      configuration: { ...config, host_key_sha256: 'SHA256:' + Buffer.from('different fingerprint bytes').toString('base64').replace(/=+$/, '') },
    })).rejects.toThrow('FINANCE_SFTP_HOST_KEY_PIN_MISMATCH');
    expect(runner.calls.filter((call) => call.program === 'sftp')).toHaveLength(0);
  });

  it('archives a file by digest and makes a repeated archive request idempotent', async () => {
    setupEnvironment();
    const { transport, runner } = makeTransport();
    const bytes = Buffer.from('external_fact_id,amount\nAP-1,99.50\n');
    const digest = createHash('sha256').update(bytes).digest('hex');
    runner.remoteFiles.set('/incoming/finance/finance-ap-001.csv', bytes);
    const request = {
      ...context,
      secret_reference: 'vault://factoryos/prod/sftp',
      configuration: config,
      remote_path: '/incoming/finance/finance-ap-001.csv',
      payload_sha256: digest,
      disposition: 'PROCESSED' as const,
    };
    await transport.archiveRemoteFile(request);
    expect(runner.remoteFiles.has('/incoming/finance/processed/finance-ap-001.csv')).toBe(true);
    expect(runner.remoteFiles.has(request.remote_path)).toBe(false);
    await transport.archiveRemoteFile(request);
    expect(runner.remoteFiles.has('/incoming/finance/processed/finance-ap-001.csv')).toBe(true);
  });

  it('uploads with an atomic temp-and-rename flow and verifies the final digest on replay', async () => {
    setupEnvironment();
    const { transport, runner } = makeTransport();
    const bytes = Buffer.from('external_fact_id,amount\nAP-1,99.50\n');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const request = {
      ...context,
      secret_reference: 'vault://factoryos/prod/sftp',
      configuration: config,
      remote_file_name: 'finance-ap-' + digest.slice(0, 16) + '.csv',
      format: 'CSV' as const,
      content: bytes,
      sha256: digest,
    };
    const uploaded = await transport.upload(request);
    expect(uploaded).toEqual({
      remote_path: '/incoming/finance/' + request.remote_file_name,
      verified_host_key_sha256: HOST_KEY_FINGERPRINT,
      bytes_written: bytes.length,
    });
    const replayed = await transport.upload(request);
    expect(replayed).toEqual(uploaded);
    expect(runner.remoteFiles.get(uploaded.remote_path)).toEqual(bytes);
  });

  it('fails closed without an endpoint allowlist or a usable private-key secret manager', async () => {
    setupEnvironment();
    process.env.FINANCE_SFTP_ALLOWED_HOSTS = '';
    const { transport } = makeTransport();
    await expect(transport.downloadNext({
      ...context, secret_reference: 'vault://factoryos/prod/sftp', configuration: config,
    })).rejects.toThrow('SFTP host and IP allowlists are required');

    process.env.FINANCE_SFTP_ALLOWED_HOSTS = 'erp-files.example.com';
    const { transport: noKeyTransport } = makeTransport(new FakeSftpRunner(), {
      async resolveBearerToken() { return 'unused-provider-token'; },
    });
    await expect(noKeyTransport.downloadNext({
      ...context, secret_reference: 'vault://factoryos/prod/sftp', configuration: config,
    })).rejects.toThrow('SFTP transport requires a Vault-backed private-key resolver');
  });
});
