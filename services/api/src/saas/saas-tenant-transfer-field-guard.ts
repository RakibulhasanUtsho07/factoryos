import { BadRequestException } from '@nestjs/common';

export type SaasTenantTransferFieldBoundary = 'source' | 'target';

const EXACT_SENSITIVE_FIELD = /^(password|password_hash|token|access_token|refresh_token|client_secret|client_token|secret|api_key|private_key|authorization|connection_string|database_url|jwt_secret|encryption_key|signing_key)$/;

// Include token fingerprints/hashes and common alternate token names. Field
// matching is intentionally recursive at both export and import boundaries:
// action_token_hash is not a bearer token, but it is still a reusable secret
// verifier and must never be copied into a tenant transfer bundle.
const SENSITIVE_FIELD_SEGMENT = /(?:^|_)(?:password|secret|access_token|refresh_token|api_key|private_key|connection_string|token_hash|action_token_hash|session_token_hash|refresh_token_hash|bearer_token|id_token|oauth_token|session_token|token_signature|credential_hash)(?:_|$)/;

export function assertSaasTenantTransferFieldSafe(
  field: string,
  boundary: SaasTenantTransferFieldBoundary,
): void {
  const normalized = field
    .replace(/([a-z0-9])([A-Z])/g, (_match, left: string, right: string) => left + '_' + right)
    .replace(/[.-]/g, '_')
    .toLowerCase();

  if (EXACT_SENSITIVE_FIELD.test(normalized) || SENSITIVE_FIELD_SEGMENT.test(normalized)) {
    const message = boundary === 'source'
      ? 'Dataset source attempted to export a credential/secret field'
      : 'Target importer rejected a credential/secret field';
    throw new BadRequestException(message);
  }
}
