const LOCAL_DEVELOPMENT_ORIGINS = ['http://localhost:3000'];

export type RuntimeEnvironment = 'development' | 'test' | 'production';
export type AuthMode = 'dev' | 'oidc';

/**
 * Require an explicit, recognized runtime environment rather than silently
 * treating a misconfigured deployment as development.
 */
export function resolveNodeEnvironment(
  configuredValue?: string,
): RuntimeEnvironment {
  const value = configuredValue?.trim().toLowerCase();

  if (!value) {
    throw new Error(
      'NODE_ENV must be explicitly configured as development, test, or production.',
    );
  }

  if (
    value !== 'development' &&
    value !== 'test' &&
    value !== 'production'
  ) {
    throw new Error(
      'NODE_ENV must be one of development, test, or production.',
    );
  }

  return value;
}

/**
 * Select authentication mode fail-closed. Dev-mode JWTs are local-only and
 * must never become the implicit production authentication mechanism.
 */
export function resolveAuthMode(
  nodeEnv: RuntimeEnvironment,
  configuredMode?: string,
  devAuthEnabled?: string,
): AuthMode {
  const mode = configuredMode?.trim().toLowerCase();

  if (!mode) {
    if (nodeEnv === 'production') {
      throw new Error(
        'AUTH_MODE=oidc must be explicitly configured in production; refusing the development-auth fallback.',
      );
    }
  } else if (mode !== 'dev' && mode !== 'oidc') {
    throw new Error('AUTH_MODE must be either dev or oidc.');
  }

  const resolvedMode: AuthMode = mode === 'oidc' ? 'oidc' : 'dev';

  if (nodeEnv === 'production' && resolvedMode !== 'oidc') {
    throw new Error(
      'AUTH_MODE=oidc is required in production; dev-mode JWT authentication is not permitted.',
    );
  }

  const devEnabled = devAuthEnabled?.trim().toLowerCase();
  if (devEnabled && devEnabled !== 'true' && devEnabled !== 'false') {
    throw new Error('DEV_AUTH_ENABLED must be either true or false.');
  }

  if (nodeEnv === 'production' && devEnabled === 'true') {
    throw new Error(
      'DEV_AUTH_ENABLED must not be true in production.',
    );
  }

  return resolvedMode;
}

function requireSecureHttpsUrl(
  value: string,
  variableName: string,
  allowQuery: boolean,
): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(variableName + ' must be a valid HTTPS URL in production.');
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    (!allowQuery && parsed.search)
  ) {
    throw new Error(
      variableName + ' must be a credential-free HTTPS URL in production.',
    );
  }
}

/** Validate OIDC inputs and apply strict HTTPS rules to production endpoints. */
export function resolveOidcConfiguration(
  nodeEnv: RuntimeEnvironment,
  configuredIssuer?: string,
  configuredAudience?: string,
  configuredJwksUri?: string,
): { issuer: string; audience: string; jwksUri: string } {
  const issuer = configuredIssuer?.trim();
  const audience = configuredAudience?.trim();
  const jwksUri = configuredJwksUri?.trim();

  if (!issuer) {
    throw new Error('OIDC_ISSUER is required when AUTH_MODE=oidc.');
  }
  if (!audience) {
    throw new Error('OIDC_AUDIENCE is required when AUTH_MODE=oidc.');
  }
  if (!jwksUri) {
    throw new Error('OIDC_JWKS_URI is required when AUTH_MODE=oidc.');
  }

  if (nodeEnv === 'production') {
    requireSecureHttpsUrl(issuer, 'OIDC_ISSUER', false);
    requireSecureHttpsUrl(jwksUri, 'OIDC_JWKS_URI', true);
  }

  return { issuer, audience, jwksUri };
}

/** Resolve exact browser origins and fail closed for unsafe production values. */
export function resolveCorsOrigins(
  nodeEnv: string,
  configuredOrigins?: string,
): string[] {
  const isProduction = nodeEnv === 'production';
  const raw = configuredOrigins?.trim();

  if (!raw) {
    if (isProduction) {
      throw new Error(
        'CORS_ORIGINS must be configured with exact HTTPS frontend origins in production.',
      );
    }
    return [...LOCAL_DEVELOPMENT_ORIGINS];
  }

  const origins = raw.split(',').map((value) => value.trim());
  if (origins.some((origin) => !origin)) {
    throw new Error('CORS_ORIGINS must not contain empty entries.');
  }

  const normalized = origins.map((origin) => {
    if (origin === '*') {
      throw new Error('Wildcard CORS origins are not allowed.');
    }
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error('Invalid CORS origin: ' + origin);
    }
    if (
      parsed.origin !== origin ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('CORS entry must be an exact origin: ' + origin);
    }
    if (isProduction && parsed.protocol !== 'https:') {
      throw new Error('Production CORS origins must use HTTPS: ' + origin);
    }
    return parsed.origin;
  });

  return [...new Set(normalized)];
}

/** Swagger is opt-in in production and on by default for local development. */
export function resolveSwaggerEnabled(
  nodeEnv: string,
  configuredValue?: string,
): boolean {
  if (configuredValue !== undefined && configuredValue.trim() !== '') {
    const value = configuredValue.trim().toLowerCase();
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error('SWAGGER_ENABLED must be either true or false.');
  }
  return nodeEnv !== 'production';
}
