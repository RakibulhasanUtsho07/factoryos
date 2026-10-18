import type { FinanceSftpConfiguration } from './finance-contract';

export const FINANCE_SFTP_TRANSPORT = Symbol('FINANCE_SFTP_TRANSPORT');

export interface FinanceSftpDownload {
  /** POSIX remote path returned by the verified transport adapter. */
  remote_path: string;
  /** Untrusted remote basename; the service validates it before ingest. */
  file_name: string;
  format: 'CSV' | 'JSON';
  content: Buffer;
  /** Must be the fingerprint observed from the SSH host key, not a configured echo. */
  verified_host_key_sha256: string;
}

export interface FinanceSftpUploadResult {
  remote_path: string;
  verified_host_key_sha256: string;
  bytes_written: number;
}

export interface FinanceSftpTransport {
  /**
   * Implementations must make upload idempotent: the caller uses a content-
   * digest-derived basename. If that name already exists, verify the remote
   * bytes have the same SHA-256 rather than silently replacing different bytes.
   * Upload via a temporary file followed by an atomic rename where supported.
   */
  /**
   * Deployment adapter contract. The implementation must resolve auth material
   * via secret_reference, pin/verify host keys, constrain egress and protect
   * temporary files. Credential bytes must never be returned to callers/logs.
   */
  downloadNext(input: {
    tenant_id: string;
    factory_id: string;
    connector_id: string;
    secret_reference: string;
    configuration: FinanceSftpConfiguration;
  }): Promise<FinanceSftpDownload | null>;

  archiveRemoteFile(input: {
    tenant_id: string;
    factory_id: string;
    connector_id: string;
    secret_reference: string;
    configuration: FinanceSftpConfiguration;
    remote_path: string;
    disposition: 'PROCESSED' | 'QUARANTINED';
  }): Promise<void>;

  upload(input: {
    tenant_id: string;
    factory_id: string;
    connector_id: string;
    secret_reference: string;
    configuration: FinanceSftpConfiguration;
    remote_file_name: string;
    format: 'CSV' | 'JSON';
    content: Buffer;
    sha256: string;
  }): Promise<FinanceSftpUploadResult>;
}

export function matchesFinanceSftpFilePattern(configuration: FinanceSftpConfiguration, fileName: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(fileName) || fileName === '.' || fileName === '..') {
    return false;
  }
  if (!configuration.file_pattern) return true;
  const escaped = configuration.file_pattern
    .split('*')
    .map((part) => part.replace(/\./g, '\\.'))
    .join('.*');
  return new RegExp('^' + escaped + '
export function assertFinanceSftpRemoteFilePath(configuration: FinanceSftpConfiguration, remotePath: string, fileName: string): void {
  const directory = configuration.remote_directory.replace(/\/+$/, '') || '/';
  const expectedPrefix = directory === '/' ? '/' : directory + '/';
  if (typeof remotePath !== 'string' || !remotePath.startsWith(expectedPrefix) ||
      remotePath.length > 768 || remotePath.slice(expectedPrefix.length).includes('/') ||
      remotePath.slice(expectedPrefix.length).includes('\\') ||
      remotePath.slice(expectedPrefix.length) !== fileName ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(fileName) ||
      fileName === '.' || fileName === '..') {
    throw new Error('FINANCE_SFTP_REMOTE_PATH_OUTSIDE_CONFIGURED_DIRECTORY');
  }
}
).test(fileName);
}

/** Fail closed if the adapter returns a path outside the configured folder or a non-basename. */
export function assertFinanceSftpRemoteFilePath(configuration: FinanceSftpConfiguration, remotePath: string, fileName: string): void {
  const directory = configuration.remote_directory.replace(/\/+$/, '') || '/';
  const expectedPrefix = directory === '/' ? '/' : directory + '/';
  if (typeof remotePath !== 'string' || !remotePath.startsWith(expectedPrefix) ||
      remotePath.length > 768 || remotePath.slice(expectedPrefix.length).includes('/') ||
      remotePath.slice(expectedPrefix.length).includes('\\') ||
      remotePath.slice(expectedPrefix.length) !== fileName ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(fileName) ||
      fileName === '.' || fileName === '..') {
    throw new Error('FINANCE_SFTP_REMOTE_PATH_OUTSIDE_CONFIGURED_DIRECTORY');
  }
}
