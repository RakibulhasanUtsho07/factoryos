import {
  resolveAuthMode,
  resolveCorsOrigins,
  resolveNodeEnvironment,
  resolveOidcConfiguration,
  resolveSwaggerEnabled,
} from './runtime-config';

describe('runtime configuration', () => {
  describe('resolveNodeEnvironment', () => {
    it.each(['development', 'test', 'production'])('accepts %s', (value) => {
      expect(resolveNodeEnvironment(value)).toBe(value);
    });

    it('rejects a missing runtime environment instead of defaulting silently', () => {
      expect(() => resolveNodeEnvironment(undefined)).toThrow(/NODE_ENV must be explicitly configured/);
    });

    it('rejects unknown environment labels', () => {
      expect(() => resolveNodeEnvironment('prod')).toThrow(/NODE_ENV must be one of/);
    });
  });

  describe('resolveAuthMode', () => {
    it('defaults to development auth only outside production', () => {
      expect(resolveAuthMode('development')).toBe('dev');
      expect(resolveAuthMode('test')).toBe('dev');
    });

    it('requires explicit OIDC mode in production', () => {
      expect(() => resolveAuthMode('production')).toThrow(/AUTH_MODE=oidc must be explicitly configured/);
      expect(() => resolveAuthMode('production', 'dev')).toThrow(/dev-mode JWT authentication is not permitted/);
      expect(resolveAuthMode('production', 'oidc', 'false')).toBe('oidc');
    });

    it('rejects typos and unsupported modes in every environment', () => {
      expect(() => resolveAuthMode('development', 'oidc-dev')).toThrow(/AUTH_MODE must be either/);
      expect(() => resolveAuthMode('test', '')).not.toThrow();
    });

    it('rejects enabled development token issuance in production', () => {
      expect(() => resolveAuthMode('production', 'oidc', 'true')).toThrow(/DEV_AUTH_ENABLED must not be true/);
      expect(() => resolveAuthMode('development', 'dev', 'sometimes')).toThrow(/DEV_AUTH_ENABLED must be either/);
    });
  });

  describe('resolveOidcConfiguration', () => {
    it('requires every OIDC setting', () => {
      expect(() => resolveOidcConfiguration('production', undefined, 'factoryos', 'https://id.example.com/jwks'))
        .toThrow(/OIDC_ISSUER is required/);
      expect(() => resolveOidcConfiguration('production', 'https://id.example.com', undefined, 'https://id.example.com/jwks'))
        .toThrow(/OIDC_AUDIENCE is required/);
      expect(() => resolveOidcConfiguration('production', 'https://id.example.com', 'factoryos', undefined))
        .toThrow(/OIDC_JWKS_URI is required/);
    });

    it('accepts credential-free HTTPS issuer and JWKS URL in production', () => {
      expect(resolveOidcConfiguration(
        'production',
        'https://id.example.com/tenant',
        'factoryos-api',
        'https://id.example.com/keys',
      )).toEqual({
        issuer: 'https://id.example.com/tenant',
        audience: 'factoryos-api',
        jwksUri: 'https://id.example.com/keys',
      });
    });

    it.each([
      ['http://id.example.com', 'https://id.example.com/keys'],
      ['https://user:pass@id.example.com', 'https://id.example.com/keys'],
      ['https://id.example.com?unsafe=true', 'https://id.example.com/keys'],
      ['https://id.example.com', 'http://id.example.com/keys'],
      ['https://id.example.com', 'https://user:pass@id.example.com/keys'],
    ])('rejects unsafe production OIDC URL pairs', (issuer, jwksUri) => {
      expect(() => resolveOidcConfiguration('production', issuer, 'factoryos-api', jwksUri)).toThrow();
    });

    it('allows local HTTP identity-provider fixtures outside production', () => {
      expect(resolveOidcConfiguration(
        'development',
        'http://localhost:8080/issuer',
        'factoryos-api',
        'http://localhost:8080/jwks',
      ).jwksUri).toBe('http://localhost:8080/jwks');
    });
  });

  describe('resolveCorsOrigins', () => {
    it('defaults to localhost during development', () => {
      expect(resolveCorsOrigins('development')).toEqual(['http://localhost:3000']);
    });

    it('requires explicit origins in production', () => {
      expect(() => resolveCorsOrigins('production')).toThrow(/CORS_ORIGINS must be configured/);
    });

    it('accepts exact HTTPS origins in production', () => {
      expect(resolveCorsOrigins('production', 'https://app.example.com,https://admin.example.com'))
        .toEqual(['https://app.example.com', 'https://admin.example.com']);
    });

    it.each([
      '*',
      'https://app.example.com/path',
      'http://app.example.com',
      'https://user:password@app.example.com',
      'https://app.example.com,',
    ])('rejects unsafe production origin configuration: %s', (origins) => {
      expect(() => resolveCorsOrigins('production', origins)).toThrow();
    });

    it('deduplicates origins', () => {
      expect(resolveCorsOrigins('development', 'http://localhost:3000,http://localhost:3000'))
        .toEqual(['http://localhost:3000']);
    });
  });

  describe('resolveSwaggerEnabled', () => {
    it('defaults off in production and on outside production', () => {
      expect(resolveSwaggerEnabled('production')).toBe(false);
      expect(resolveSwaggerEnabled('development')).toBe(true);
    });

    it('honors explicit true/false values', () => {
      expect(resolveSwaggerEnabled('production', 'true')).toBe(true);
      expect(resolveSwaggerEnabled('development', 'false')).toBe(false);
    });

    it('rejects invalid values', () => {
      expect(() => resolveSwaggerEnabled('production', 'sometimes')).toThrow(/SWAGGER_ENABLED/);
    });
  });
});
