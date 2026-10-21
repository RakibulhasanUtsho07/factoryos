import { jest } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuthService } from './auth.service';

describe('AuthService development token safety', () => {
  const envKeys = ['NODE_ENV', 'DEV_AUTH_ENABLED', 'AUTH_MODE', 'DEV_AUTH_SECRET'] as const;
  let previous: Partial<Record<(typeof envKeys)[number], string>>;
  let query: jest.Mock;
  let signAsync: jest.Mock;
  let service: AuthService;

  beforeEach(() => {
    previous = {};
    for (const key of envKeys) {
      previous[key] = process.env[key];
    }
    query = jest.fn(async () => ({ rows: [] }));
    signAsync = jest.fn(async () => 'synthetic-dev-token');
    service = new AuthService(
      { query } as never,
      { signAsync } as never,
    );
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  it('does not issue a development token when OIDC mode is configured', async () => {
    process.env.NODE_ENV = 'development';
    process.env.DEV_AUTH_ENABLED = 'true';
    process.env.AUTH_MODE = 'oidc';
    process.env.DEV_AUTH_SECRET = 'development-only-secret';

    await expect(service.issueDevToken('development-only-secret', randomUUID(), randomUUID()))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(query).not.toHaveBeenCalled();
    expect(signAsync).not.toHaveBeenCalled();
  });

  it('keeps development-token issuance unavailable in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DEV_AUTH_ENABLED = 'true';
    process.env.AUTH_MODE = 'dev';
    process.env.DEV_AUTH_SECRET = 'development-only-secret';

    await expect(service.issueDevToken('development-only-secret', randomUUID(), randomUUID()))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(query).not.toHaveBeenCalled();
    expect(signAsync).not.toHaveBeenCalled();
  });

  it('issues only in explicitly enabled development mode with an active tenant membership', async () => {
    const userId = randomUUID();
    const tenantId = randomUUID();
    process.env.NODE_ENV = 'development';
    process.env.DEV_AUTH_ENABLED = 'true';
    process.env.AUTH_MODE = 'dev';
    process.env.DEV_AUTH_SECRET = 'development-only-secret';
    query.mockImplementation(async () => ({ rows: [{ user_id: userId, tenant_id: tenantId }] }));

    const result = await service.issueDevToken('development-only-secret', userId, tenantId);
    expect(result.access_token).toBe('synthetic-dev-token');
    expect(query).toHaveBeenCalledTimes(1);
    expect(signAsync).toHaveBeenCalledTimes(1);
  });
});
