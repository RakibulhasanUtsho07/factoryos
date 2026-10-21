import {
  oidcClaimsMeetMfaPolicy,
  resolveAuthRuntimePolicy,
} from './auth-runtime-policy';

describe('production authentication runtime policy', () => {
  const productionOidc = {
    nodeEnv: 'production',
    authMode: 'oidc',
    devAuthEnabled: 'false',
    oidcIssuer: 'https://idp.example.test/tenant',
    oidcAudience: 'factoryos-api',
    oidcJwksUri: 'https://idp.example.test/tenant/.well-known/jwks.json',
    oidcRequireMfa: 'true',
    oidcMfaAmrValues: 'mfa,otp,hwk',
    oidcMfaAcrValues: 'urn:example:loa:2',
  };

  it('refuses a production default or explicit development authentication mode', () => {
    expect(() => resolveAuthRuntimePolicy({
      nodeEnv: 'production',
      jwtSecret: 'a-production-looking-but-not-accepted-secret',
    })).toThrow('AUTH_MODE=oidc is required in production');

    expect(() => resolveAuthRuntimePolicy({
      ...productionOidc,
      authMode: 'dev',
      jwtSecret: 'local-secret',
    })).toThrow('Development authentication is forbidden in production');
  });

  it('requires DEV_AUTH_ENABLED to be explicitly false in production', () => {
    expect(() => resolveAuthRuntimePolicy({
      ...productionOidc,
      devAuthEnabled: undefined,
    })).toThrow('DEV_AUTH_ENABLED=false must be explicitly configured in production');
    expect(() => resolveAuthRuntimePolicy({
      ...productionOidc,
      devAuthEnabled: 'true',
    })).toThrow('DEV_AUTH_ENABLED=false must be explicitly configured in production');
  });

  it('requires OIDC endpoints over HTTPS and rejects credential-bearing URLs', () => {
    expect(() => resolveAuthRuntimePolicy({
      ...productionOidc,
      oidcIssuer: 'http://idp.example.test',
    })).toThrow('OIDC_ISSUER must be an absolute HTTPS URL');

    expect(() => resolveAuthRuntimePolicy({
      ...productionOidc,
      oidcJwksUri: 'https://user:password@idp.example.test/jwks',
    })).toThrow('OIDC_JWKS_URI must be an absolute HTTPS URL');
  });

  it('requires owner-configured MFA claim values in production', () => {
    expect(() => resolveAuthRuntimePolicy({
      ...productionOidc,
      oidcRequireMfa: 'false',
    })).toThrow('OIDC_REQUIRE_MFA=true is required in production');

    expect(() => resolveAuthRuntimePolicy({
      ...productionOidc,
      oidcMfaAmrValues: '',
      oidcMfaAcrValues: '',
    })).toThrow('Configure OIDC_MFA_AMR_VALUES or OIDC_MFA_ACR_VALUES');
  });

  it('accepts a production OIDC policy with explicit HTTPS, audience and MFA claim allowlists', () => {
    const policy = resolveAuthRuntimePolicy(productionOidc);
    expect(policy.authMode).toBe('oidc');
    expect(policy.requireMfa).toBe(true);
    expect(oidcClaimsMeetMfaPolicy({ amr: ['pwd', 'otp'] }, policy)).toBe(true);
    expect(oidcClaimsMeetMfaPolicy({ acr: 'urn:example:loa:2' }, policy)).toBe(true);
    expect(oidcClaimsMeetMfaPolicy({ amr: ['pwd'], acr: 'urn:example:loa:1' }, policy)).toBe(false);
    expect(oidcClaimsMeetMfaPolicy({ amr: 'otp', acr: null }, policy)).toBe(false);
  });

  it('requires MFA only when explicitly configured outside production', () => {
    expect(resolveAuthRuntimePolicy({
      nodeEnv: 'test',
      authMode: 'dev',
      jwtSecret: 'test-secret',
    }).authMode).toBe('dev');

    const policy = resolveAuthRuntimePolicy({
      nodeEnv: 'test',
      authMode: 'oidc',
      oidcIssuer: 'https://idp.example.test/tenant',
      oidcAudience: 'factoryos-api',
      oidcJwksUri: 'https://idp.example.test/tenant/jwks',
      oidcRequireMfa: 'true',
      oidcMfaAmrValues: 'otp',
    });
    expect(oidcClaimsMeetMfaPolicy({ amr: ['pwd'] }, policy)).toBe(false);
    expect(oidcClaimsMeetMfaPolicy({ amr: ['otp'] }, policy)).toBe(true);
  });

  it('rejects unsupported auth mode values instead of falling back to development auth', () => {
    expect(() => resolveAuthRuntimePolicy({
      nodeEnv: 'test',
      authMode: 'disabled',
      jwtSecret: 'test-secret',
    })).toThrow('AUTH_MODE must be either dev or oidc');
  });
});
