export interface AuthRuntimeConfiguration {
  nodeEnv?: string;
  authMode?: string;
  devAuthEnabled?: string;
  jwtSecret?: string;
  oidcIssuer?: string;
  oidcAudience?: string;
  oidcJwksUri?: string;
  oidcRequireMfa?: string;
  oidcMfaAmrValues?: string;
  oidcMfaAcrValues?: string;
}

export interface AuthRuntimePolicy {
  authMode: 'dev' | 'oidc';
  requireMfa: boolean;
  mfaAmrValues: ReadonlySet<string>;
  mfaAcrValues: ReadonlySet<string>;
}

function csvSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

function requireHttpsUrl(value: string | undefined, key: string): void {
  if (!value) throw new Error(key + ' is required when AUTH_MODE=oidc');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(key + ' must be an absolute HTTPS URL in production');
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
    throw new Error(key + ' must be an absolute HTTPS URL without embedded credentials in production');
  }
}

/**
 * Validate authentication mode at startup. Production may never silently fall back
 * to the development HS256 identity path; local/test defaults remain backwards compatible.
 */
export function resolveAuthRuntimePolicy(config: AuthRuntimeConfiguration): AuthRuntimePolicy {
  const nodeEnv = config.nodeEnv ?? 'development';
  const production = nodeEnv === 'production';
  const configuredMode = config.authMode?.trim().toLowerCase();
  const authMode = (configuredMode || (production ? '' : 'dev')) as string;

  if (authMode !== 'dev' && authMode !== 'oidc') {
    throw new Error(production
      ? 'AUTH_MODE=oidc is required in production'
      : 'AUTH_MODE must be either dev or oidc');
  }

  if (production && authMode !== 'oidc') {
    throw new Error('Development authentication is forbidden in production');
  }

  if (production && config.devAuthEnabled?.trim().toLowerCase() !== 'false') {
    throw new Error('DEV_AUTH_ENABLED=false must be explicitly configured in production');
  }

  if (authMode === 'dev') {
    if (!config.jwtSecret) throw new Error('JWT_SECRET is required when AUTH_MODE=dev');
    if (production) throw new Error('Development authentication is forbidden in production');
    return {
      authMode,
      requireMfa: false,
      mfaAmrValues: new Set(),
      mfaAcrValues: new Set(),
    };
  }

  if (!config.oidcAudience?.trim()) throw new Error('OIDC_AUDIENCE is required when AUTH_MODE=oidc');
  if (!config.oidcIssuer?.trim()) throw new Error('OIDC_ISSUER is required when AUTH_MODE=oidc');
  if (!config.oidcJwksUri?.trim()) throw new Error('OIDC_JWKS_URI is required when AUTH_MODE=oidc');

  if (production) {
    requireHttpsUrl(config.oidcIssuer, 'OIDC_ISSUER');
    requireHttpsUrl(config.oidcJwksUri, 'OIDC_JWKS_URI');
    if (config.oidcRequireMfa?.trim().toLowerCase() !== 'true') {
      throw new Error('OIDC_REQUIRE_MFA=true is required in production unless a reviewed release exception is approved');
    }
  }

  const requireMfa = config.oidcRequireMfa?.trim().toLowerCase() === 'true';
  const mfaAmrValues = csvSet(config.oidcMfaAmrValues);
  const mfaAcrValues = csvSet(config.oidcMfaAcrValues);

  if (requireMfa && mfaAmrValues.size === 0 && mfaAcrValues.size === 0) {
    throw new Error('Configure OIDC_MFA_AMR_VALUES or OIDC_MFA_ACR_VALUES when OIDC_REQUIRE_MFA=true');
  }

  return {
    authMode,
    requireMfa,
    mfaAmrValues,
    mfaAcrValues,
  };
}

export function oidcClaimsMeetMfaPolicy(
  claims: { amr?: unknown; acr?: unknown },
  policy: Pick<AuthRuntimePolicy, 'requireMfa' | 'mfaAmrValues' | 'mfaAcrValues'>,
): boolean {
  if (!policy.requireMfa) return true;

  const amrClaims = Array.isArray(claims.amr)
    ? claims.amr.filter((value): value is string => typeof value === 'string')
    : [];
  const acrClaim = typeof claims.acr === 'string' ? claims.acr : null;

  return amrClaims.some((value) => policy.mfaAmrValues.has(value))
    || (acrClaim !== null && policy.mfaAcrValues.has(acrClaim));
}
