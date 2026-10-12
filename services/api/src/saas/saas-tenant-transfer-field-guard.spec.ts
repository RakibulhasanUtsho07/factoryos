import { BadRequestException } from '@nestjs/common';
import { assertSaasTenantTransferFieldSafe } from './saas-tenant-transfer-field-guard';

describe('SaaS tenant transfer field guard', () => {
  it.each([
    'action_token_hash',
    'actionTokenHash',
    'session_token_hash',
    'refresh_token_hash',
    'bearer_token',
    'idToken',
    'oauth_token',
    'credential_hash',
    'metadata.action-token-hash',
  ])('rejects sensitive field name %s at both transfer boundaries', (field) => {
    expect(() => assertSaasTenantTransferFieldSafe(field, 'source')).toThrow(BadRequestException);
    expect(() => assertSaasTenantTransferFieldSafe(field, 'target')).toThrow(BadRequestException);
  });

  it.each([
    'token_expires_at',
    'token_count',
    'action_token_status',
    'public_key_id',
    'credential_rotation_version',
  ])('does not reject non-secret metadata field %s', (field) => {
    expect(() => assertSaasTenantTransferFieldSafe(field, 'source')).not.toThrow();
    expect(() => assertSaasTenantTransferFieldSafe(field, 'target')).not.toThrow();
  });
});
