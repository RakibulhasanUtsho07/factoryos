import { Inject, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, chmod, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pathPosix from 'node:path/posix';
import {
  FINANCE_SECRET_MANAGER,
  resolveFinancePinnedAddress,
  type FinanceDnsLookup,
  type FinanceSecretManager,
} from './finance-business-central.adapter';
import type { FinanceSftpConfiguration } from './finance-contract';
import {
  assertFinanceSftpRemoteFilePath,
  matchesFinanceSftpFilePattern,
  FINANCE_SFTP_TRANSPORT,
  type FinanceSftpDownload,
  type FinanceSftpTransport,
  type FinanceSftpUploadResult,
} from './finance-file-transfer.adapters';

export const FINANCE_SFTP_COMMAND_RUNNER = Symbol('FINANCE_SFTP_COMMAND_RUNNER');
export const FINANCE_SFTP_DNS_LOOKUP = Symbol('FINANCE_SFTP_DNS_LOOKUP');

type SftpProgram = 'ssh-keyscan' | 'sftp';

export interface FinanceSftpCommandRunner {
  run(
    program: SftpProgram,
    args: string[],
    input?: string | Buffer,
    timeoutMs?: number,
    maxStdoutBytes?: number,
  ): Promise<Buffer>;
}

function commaSeparatedSet(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean));
}

/**
 * Shell-free bounded OpenSSH command runner. stderr is drained but deliberately
 * discarded because remote error strings can contain provider data or paths.
 */
@Injectable()
export class OpenSshFinanceSftpCommandRunner implements FinanceSftpCommandRunner {
  run(
    program: SftpProgram,
    args: string[],
    input: string | Buffer = '',
    timeoutMs = 15_000,
    maxStdoutBytes = 2 * 1024 * 1024,
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      let child;
      try {
        child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch {
        reject(new Error('FINANCE_SFTP_OPENSSH_CLIENT_NOT_AVAILABLE'));
        return;
      }
      const stdout: Buffer[] = [];
      let stdoutSize = 0;
      let finished = false;
      const fail = (error: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error('FINANCE_SFTP_COMMAND_TIMEOUT')), timeoutMs);
      child.stdout.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutSize += buffer.length;
        if (stdoutSize > maxStdoutBytes) {
          fail(new Error('FINANCE_SFTP_COMMAND_OUTPUT_TOO_LARGE'));
          return;
        }
        stdout.push(buffer);
      });
      // Drain stderr without capturing it: command errors must not leak paths or secrets.
      child.stderr.on('data', () => undefined);
      child.on('error', () => fail(new Error('FINANCE_SFTP_OPENSSH_CLIENT_NOT_AVAILABLE')));
      child.on('close', (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(program === 'ssh-keyscan'
            ? 'FINANCE_SFTP_HOST_KEY_SCAN_FAILED'
            : 'FINANCE_SFTP_BATCH_COMMAND_FAILED'));
          return;
        }
        resolve(Buffer.concat(stdout));
      });
      child.stdin.on('error', () => fail(new Error('FINANCE_SFTP_COMMAND_INPUT_FAILED')));
      child.stdin.end(input);
    });
  }
}

type KeyscanMatch = { fingerprint: string; knownHostsEntry: string };

function fingerprintForKeyBlob(encodedKeyBlob: string): string {
  const decoded = Buffer.from(encodedKeyBlob, 'base64');
  if (decoded.length < 16 || decoded.toString('base64').replace(/=+$/, '') !== encodedKeyBlob.replace(/=+$/, '')) {
    throw new Error('FINANCE_SFTP_HOST_KEY_SCAN_RESPONSE_INVALID');
  }
  return 'SHA256:' + createHash('sha256').update(decoded).digest('base64').replace(/=+$/, '');
}

function parsePinnedHostKey(output: Buffer, config: FinanceSftpConfiguration): KeyscanMatch {
  const lines = output.toString('utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3 || !/^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))$/.test(fields[1])) continue;
    let fingerprint: string;
    try {
      fingerprint = fingerprintForKeyBlob(fields[2]);
    } catch {
      continue;
    }
    if (fingerprint === config.host_key_sha256) {
      // HostKeyAlias is unique to host+port. Only the configured key is trusted.
      return {
        fingerprint,
        knownHostsEntry: config.host + ':' + config.port + ' ' + fields[1] + ' ' + fields[2],
      };
    }
  }
  throw new Error('FINANCE_SFTP_HOST_KEY_PIN_MISMATCH');
}

function sftpQuote(value: string): string {
  if (/[\r\n\u0000]/.test(value)) throw new Error('FINANCE_SFTP_COMMAND_VALUE_INVALID');
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function validSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function remoteChild(directory: string, fileName: string): string {
  return pathPosix.join(directory, fileName);
}

/**
 * Production SFTP transport over the OpenSSH client. The implementation pins a
 * vetted DNS answer for the TCP connection, scans and verifies the configured
 * SHA-256 host-key pin, then performs transfers with strict known-host checking.
 * It requires openssh-client (sftp + ssh-keyscan) in the runtime image and a
 * Vault secret field named sftp_private_key_pem.
 */
@Injectable()
export class OpenSshFinanceSftpTransport implements FinanceSftpTransport {
  private readonly allowedHosts = commaSeparatedSet(process.env.FINANCE_SFTP_ALLOWED_HOSTS);
  private readonly allowedIps = commaSeparatedSet(process.env.FINANCE_SFTP_ALLOWED_IPS);

  constructor(
    @Optional() @Inject(FINANCE_SECRET_MANAGER) private readonly secrets?: FinanceSecretManager,
    @Optional() @Inject(FINANCE_SFTP_COMMAND_RUNNER) private readonly commandRunner?: FinanceSftpCommandRunner,
    @Optional() @Inject(FINANCE_SFTP_DNS_LOOKUP) private readonly dnsLookup?: FinanceDnsLookup,
  ) {}

  async downloadNext(input: Parameters<FinanceSftpTransport['downloadNext']>[0]): Promise<FinanceSftpDownload | null> {
    return this.withSession(input.configuration, input.secret_reference, input, async (session) => {
      const listing = await session.runBatch('ls -1 ' + sftpQuote(input.configuration.remote_directory) + '\n');
      const candidateNames = listing.toString('utf8')
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => pathPosix.basename(entry))
        .filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(name))
        .filter((name) => name !== '.' && name !== '..')
        .filter((name) => matchesFinanceSftpFilePattern(input.configuration, name))
        .sort((a, b) => a.localeCompare(b, 'en'));
      if (candidateNames.length === 0) return null;

      const fileName = candidateNames[0];
      const remotePath = remoteChild(input.configuration.remote_directory, fileName);
      assertFinanceSftpRemoteFilePath(input.configuration, remotePath, fileName);
      const localPath = path.join(session.directory, 'download.bin');
      await session.runBatch('get ' + sftpQuote(remotePath) + ' ' + sftpQuote(localPath) + '\n');
      const content = await readFile(localPath);
      if (content.length < 1 || content.length > 2 * 1024 * 1024) {
        throw new Error('FINANCE_SFTP_PAYLOAD_SIZE_INVALID');
      }
      return {
        remote_path: remotePath,
        file_name: fileName,
        format: input.configuration.file_format,
        content,
        verified_host_key_sha256: session.verifiedHostKey,
      };
    });
  }

  async archiveRemoteFile(input: Parameters<FinanceSftpTransport['archiveRemoteFile']>[0]): Promise<void> {
    if (!validSha256(input.payload_sha256)) throw new Error('FINANCE_SFTP_ARCHIVE_HASH_INVALID');
    await this.withSession(input.configuration, input.secret_reference, input, async (session) => {
      const fileName = pathPosix.basename(input.remote_path);
      assertFinanceSftpRemoteFilePath(input.configuration, input.remote_path, fileName);
      const folder = input.disposition === 'PROCESSED' ? 'processed' : 'quarantine';
      const targetPath = remoteChild(remoteChild(input.configuration.remote_directory, folder), fileName);
      const targetLocal = path.join(session.directory, 'archive-target.bin');
      const sourceLocal = path.join(session.directory, 'archive-source.bin');

      const targetDigest = await this.tryDownloadDigest(session, targetPath, targetLocal);
      const sourceDigest = await this.tryDownloadDigest(session, input.remote_path, sourceLocal);
      if (targetDigest !== null) {
        if (targetDigest !== input.payload_sha256) {
          throw new Error('FINANCE_SFTP_ARCHIVE_TARGET_HASH_CONFLICT');
        }
        if (sourceDigest !== null) {
          if (sourceDigest !== input.payload_sha256) {
            throw new Error('FINANCE_SFTP_ARCHIVE_SOURCE_HASH_MISMATCH');
          }
          await session.runBatch('rm ' + sftpQuote(input.remote_path) + '\n');
        }
        return;
      }
      if (sourceDigest === null) throw new Error('FINANCE_SFTP_ARCHIVE_SOURCE_MISSING');
      if (sourceDigest !== input.payload_sha256) throw new Error('FINANCE_SFTP_ARCHIVE_SOURCE_HASH_MISMATCH');
      try {
        await session.runBatch('rename ' + sftpQuote(input.remote_path) + ' ' + sftpQuote(targetPath) + '\n');
      } catch {
        // A lost response after server-side rename is replay-safe only if the target hash matches.
        const replayDigest = await this.tryDownloadDigest(session, targetPath, targetLocal);
        if (replayDigest !== input.payload_sha256) throw new Error('FINANCE_SFTP_ARCHIVE_RENAME_UNCONFIRMED');
      }
      const finalDigest = await this.tryDownloadDigest(session, targetPath, targetLocal);
      if (finalDigest !== input.payload_sha256) throw new Error('FINANCE_SFTP_ARCHIVE_VERIFY_FAILED');
    });
  }

  async upload(input: Parameters<FinanceSftpTransport['upload']>[0]): Promise<FinanceSftpUploadResult> {
    if (!validSha256(input.sha256) || !Buffer.isBuffer(input.content) ||
        input.content.length < 1 || input.content.length > 2 * 1024 * 1024 ||
        createHash('sha256').update(input.content).digest('hex') !== input.sha256) {
      throw new Error('FINANCE_SFTP_UPLOAD_HASH_OR_SIZE_INVALID');
    }
    return this.withSession(input.configuration, input.secret_reference, input, async (session) => {
      const fileName = input.remote_file_name;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(fileName) || fileName === '.' || fileName === '..') {
        throw new Error('FINANCE_SFTP_UPLOAD_FILENAME_INVALID');
      }
      const remotePath = remoteChild(input.configuration.remote_directory, fileName);
      const existingLocal = path.join(session.directory, 'existing.bin');
      const existingDigest = await this.tryDownloadDigest(session, remotePath, existingLocal);
      if (existingDigest !== null) {
        if (existingDigest !== input.sha256) throw new Error('FINANCE_SFTP_REMOTE_FILE_HASH_CONFLICT');
        return {
          remote_path: remotePath,
          verified_host_key_sha256: session.verifiedHostKey,
          bytes_written: input.content.length,
        };
      }

      const localPath = path.join(session.directory, 'upload.bin');
      await writeFile(localPath, input.content, { mode: 0o600, flag: 'wx' });
      const temporaryRemotePath = remoteChild(
        input.configuration.remote_directory,
        'tmp-' + input.sha256 + '-' + fileName,
      );
      await session.runBatch(
        'put ' + sftpQuote(localPath) + ' ' + sftpQuote(temporaryRemotePath) + '\n' +
        'rename ' + sftpQuote(temporaryRemotePath) + ' ' + sftpQuote(remotePath) + '\n',
      ).catch(async () => {
        const replayDigest = await this.tryDownloadDigest(session, remotePath, existingLocal);
        if (replayDigest !== input.sha256) throw new Error('FINANCE_SFTP_UPLOAD_REPLAY_UNCONFIRMED');
      });
      const finalDigest = await this.tryDownloadDigest(session, remotePath, existingLocal);
      if (finalDigest !== input.sha256) throw new Error('FINANCE_SFTP_UPLOAD_VERIFY_FAILED');
      return {
        remote_path: remotePath,
        verified_host_key_sha256: session.verifiedHostKey,
        bytes_written: input.content.length,
      };
    });
  }

  private async tryDownloadDigest(
    session: SftpSession,
    remotePath: string,
    localPath: string,
  ): Promise<string | null> {
    try {
      await session.runBatch('get ' + sftpQuote(remotePath) + ' ' + sftpQuote(localPath) + '\n');
      const content = await readFile(localPath);
      return createHash('sha256').update(content).digest('hex');
    } catch {
      return null;
    }
  }

  private async withSession<T>(
    configurationInput: FinanceSftpConfiguration,
    secretReference: string,
    context: { tenant_id: string; factory_id: string; connector_id: string },
    work: (session: SftpSession) => Promise<T>,
  ): Promise<T> {
    const configuration = configurationInput;
    if (!this.secrets?.resolveSftpPrivateKey) {
      throw new ServiceUnavailableException('SFTP transport requires a Vault-backed private-key resolver');
    }
    if (this.allowedHosts.size === 0 || this.allowedIps.size === 0) {
      throw new ServiceUnavailableException('SFTP host and IP allowlists are required');
    }
    const pinned = await resolveFinancePinnedAddress(
      configuration.host,
      this.allowedHosts,
      this.allowedIps,
      this.dnsLookup,
    );
    const privateKey = await this.secrets.resolveSftpPrivateKey(secretReference, {
      tenant_id: context.tenant_id,
      factory_id: context.factory_id,
      connector_id: context.connector_id,
    });
    if (typeof privateKey !== 'string' || privateKey.length < 80 || privateKey.length > 64 * 1024 ||
        privateKey.includes('\u0000') ||
        !/^-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----\r?\n[\s\S]{32,63000}\r?\n-----END (?:OPENSSH |RSA |EC )?PRIVATE KEY-----\r?\n?$/.test(privateKey)) {
      throw new Error('FINANCE_SFTP_PRIVATE_KEY_INVALID');
    }
    const runner = this.commandRunner ?? new OpenSshFinanceSftpCommandRunner();
    const scan = await runner.run(
      'ssh-keyscan',
      ['-T', '5', '-p', String(configuration.port), '-t', 'ed25519,ecdsa,rsa', pinned.address],
      '',
      10_000,
      256 * 1024,
    );
    const key = parsePinnedHostKey(scan, configuration);
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factoryos-finance-sftp-'));
    let cleanup = false;
    try {
      await chmod(directory, 0o700);
      const identityFile = path.join(directory, 'sftp-identity');
      const knownHostsFile = path.join(directory, 'known_hosts');
      await writeFile(identityFile, privateKey.endsWith('\n') ? privateKey : privateKey + '\n', {
        mode: 0o600,
        flag: 'wx',
      });
      await writeFile(knownHostsFile, key.knownHostsEntry + '\n', { mode: 0o600, flag: 'wx' });
      const runBatch = async (batch: string) => runner.run(
        'sftp',
        [
          '-q', '-b', '-',
          '-oBatchMode=yes',
          '-oStrictHostKeyChecking=yes',
          '-oCheckHostIP=no',
          '-oUserKnownHostsFile=' + knownHostsFile,
          '-oGlobalKnownHostsFile=/dev/null',
          '-oIdentitiesOnly=yes',
          '-oIdentityFile=' + identityFile,
          '-oPasswordAuthentication=no',
          '-oKbdInteractiveAuthentication=no',
          '-oPreferredAuthentications=publickey',
          '-oConnectTimeout=10',
          '-oHostKeyAlias=' + configuration.host + ':' + configuration.port,
          '-oHostName=' + pinned.address,
          '-P', String(configuration.port),
          configuration.username + '@' + configuration.host,
        ],
        batch,
        20_000,
        2 * 1024 * 1024,
      );
      const session: SftpSession = {
        directory,
        verifiedHostKey: key.fingerprint,
        runBatch,
      };
      cleanup = true;
      return await work(session);
    } finally {
      if (cleanup || directory) await rm(directory, { recursive: true, force: true });
    }
  }
}

interface SftpSession {
  directory: string;
  verifiedHostKey: string;
  runBatch(batch: string): Promise<Buffer>;
}

export function sftpFingerprintForPublicKeyBlob(encodedKeyBlob: string): string {
  return fingerprintForKeyBlob(encodedKeyBlob);
}
