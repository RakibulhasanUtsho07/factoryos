import { describe, expect, it } from '@jest/globals';
import { assertFinanceSftpRemoteFilePath, matchesFinanceSftpFilePattern } from './finance-file-transfer.adapters';
import type { FinanceSftpConfiguration } from './finance-contract';

const config: FinanceSftpConfiguration = {
  host: 'erp-files.example.com',
  port: 22,
  username: 'factoryos_reader',
  remote_directory: '/incoming/finance',
  file_format: 'CSV',
  host_key_sha256: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};

describe('finance SFTP transport boundary', () => {
  it('matches configured file patterns without accepting path syntax', () => {
    expect(matchesFinanceSftpFilePattern({ ...config, file_pattern: 'finance-*.csv' }, 'finance-20261018.csv')).toBe(true);
    expect(matchesFinanceSftpFilePattern({ ...config, file_pattern: 'finance-*.csv' }, 'secrets.csv')).toBe(false);
    expect(matchesFinanceSftpFilePattern({ ...config, file_pattern: 'finance-*.csv' }, 'finance-../secrets.csv')).toBe(false);
  });

  it('accepts only simple file paths directly beneath the configured remote directory', () => {
    expect(() => assertFinanceSftpRemoteFilePath(config, '/incoming/finance/batch-01.csv', 'batch-01.csv')).not.toThrow();
    expect(() => assertFinanceSftpRemoteFilePath(config, '/incoming/finance/../secrets.csv', '../secrets.csv'))
      .toThrow('OUTSIDE_CONFIGURED_DIRECTORY');
    expect(() => assertFinanceSftpRemoteFilePath(config, '/another-folder/batch-01.csv', 'batch-01.csv'))
      .toThrow('OUTSIDE_CONFIGURED_DIRECTORY');
    expect(() => assertFinanceSftpRemoteFilePath(config, '/incoming/finance/sub/batch-01.csv', 'batch-01.csv'))
      .toThrow('OUTSIDE_CONFIGURED_DIRECTORY');
  });
});
