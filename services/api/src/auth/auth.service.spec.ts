import { jest } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import { AuthService } from './auth.service';
import type { DatabaseService } from '../database/database.service';
import type { JwtService } from '@nestjs/jwt';

describe('AuthService development token issuance', () => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    AUTH_MODE: process.env.AUTH_MODE,
    DEV_AUTH_ENABLED: process.env.DEV_AUTH_ENABLED,
    DEV_AUTH_SECRET: process.env.DEV_AUTH_SECRET,
  };

  const databaseQuery = jest.fn();
  const signAsync = jest.fn();
  let service: AuthService;

  const userId = '4f95d1a4-13fc-4a7c-bde2-7c9c89cba111';
  const tenantId = 'ca26199a-b4b7-4fb0-b1c8-f4a2cf2a2222';

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    process.env.AUTH_MODE = 'dev';
    process.env.DEV_AUTH_ENABLED = 'true';
    process.env.DEV_AUTH_SECRET = 'unit-test-development-secret';

    databaseQuery.mockReset();
    signAsync.mockReset();

    service = new AuthService(
      { query: databaseQuery } as unknown as DatabaseService,
      { signAsync } as unknown as JwtService,
    );
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it.each([
    ['production', 'oidc', 'true'],
    ['development', 'oidc', 'true'],
    ['development', 'dev', 'false'],
    ['development', undefined, 'true'],
  ])('refuses token issuance outside explicit local dev mode (%s, %s, %s)', async (nodeEnv, authMode, enabled) => {
    process.env.NODE_ENV = nodeEnv;
    if (authMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = authMode;
    process.env.DEV_AUTH_ENABLED = enabled;

    await expect(service.issueDevToken('unit-test-development-secret', userId, tenantId))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(databaseQuery).not.toHaveBeenCalled();
    expect(signAsync).not.toHaveBeenCalled();
  });

  it('issues a short-lived development token only after active membership verification', async () => {
    databaseQuery.mockResolvedValue({
      rows: [{ user_id: userId, tenant_id: tenantId }],
    });
    signAsync.mockResolvedValue('unit-test-token');

    const result = await service.issueDevToken(
      'unit-test-development-secret',
      userId,
      tenantId,
    );

    expect(databaseQuery).toHaveBeenCalledTimes(1);
    expect(signAsync).toHaveBeenCalledWith({ sub: userId, tenant_id: tenantId });
    expect(result).toMatchObject({
      access_token: 'unit-test-token',
      token_type: 'Bearer',
      expires_in: 900,
      user_id: userId,
      tenant_id: tenantId,
    });
  });
});
