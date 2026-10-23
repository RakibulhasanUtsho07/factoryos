import { jest } from '@jest/globals';
import { UnauthorizedException } from '@nestjs/common';
import { SaasBillingController } from './saas-billing.controller';

describe('SaasBillingController', () => {
  it('requires the preserved raw request body for Stripe webhook signature verification', async () => {
    const service = { receiveStripeWebhook: jest.fn<(...args: unknown[]) => Promise<unknown>>() };
    const controller = new SaasBillingController(service as never);
    await expect(controller.stripeWebhook({ rawBody: undefined } as never, 't=1,v1=invalid'))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.receiveStripeWebhook).not.toHaveBeenCalled();

    const rawBody = Buffer.from('{"id":"evt_123abc"}', 'utf8');
    service.receiveStripeWebhook.mockResolvedValueOnce({ accepted: true });
    await expect(controller.stripeWebhook({ rawBody } as never, 'verified-by-provider'))
      .resolves.toEqual({ accepted: true });
    expect(service.receiveStripeWebhook).toHaveBeenCalledWith('verified-by-provider', rawBody);
  });

  it('uses verified authentication context instead of caller-supplied tenant headers', async () => {
    const service = {
      configureProviderAccount: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    };
    const controller = new SaasBillingController(service as never);
    const request = {
      headers: { 'x-tenant-id': '11111111-1111-4111-8111-111111111111' },
      factoryos: undefined,
    };
    await expect(controller.configureAccount(request as never, {} as never))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.configureProviderAccount).not.toHaveBeenCalled();
  });
});
