const LOCAL_DEVELOPMENT_ORIGINS = ['http://localhost:3000'];

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
      throw new Error(`Invalid CORS origin: ${origin}`);
    }
    if (
      parsed.origin !== origin ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error(`CORS entry must be an exact origin: ${origin}`);
    }
    if (isProduction && parsed.protocol !== 'https:') {
      throw new Error(`Production CORS origins must use HTTPS: ${origin}`);
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
