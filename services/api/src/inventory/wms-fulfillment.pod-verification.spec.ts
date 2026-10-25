import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import { jest } from '@jest/globals';

import { DatabaseService } from '../database/database.service';
import { WmsFulfillmentService } from './wms-fulfillment.service';

const USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT_ID = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY_ID = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const SHIPMENT_ID = '69ef2a43-8157-4d91-aa59-7b4260ef1778';

function deliveredPayload(proofReference: string) {
  return {
    event_type: 'DELIVERED' as const,
    event_at: new Date().toISOString(),
    recipient_name: 'Acceptance Recipient',
    proof_type: 'SIGNATURE' as const,
    proof_reference: proofReference,
    proof_sha256: 'a'.repeat(64),
    signed_at: new Date(Date.now() - 60_000).toISOString(),
  };
}

describe('WmsFulfillmentService POD storage verification gate', () => {
  const database = {
    query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
    transaction: jest.fn(async () => {
      throw new Error('Delivery transaction must not start before POD verification');
    }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    database.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('fails closed when the stored object digest does not match the delivery claim', async () => {
    const objectKey = `pod/${TENANT_ID}/${FACTORY_ID}/${SHIPMENT_ID}/evidence.png`;
    const verifier = {
      verifyObjectDigest: jest.fn(async () => {
        throw new UnprocessableEntityException('Stored POD SHA-256 mismatch');
      }),
    };
    const service = new WmsFulfillmentService(
      database as unknown as DatabaseService,
      verifier as never,
    );

    await expect(service.recordDeliveryEvent(
      USER_ID, TENANT_ID, FACTORY_ID, SHIPMENT_ID,
      deliveredPayload(objectKey), 'pod-digest-mismatch-key', null, null,
    )).rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(verifier.verifyObjectDigest).toHaveBeenCalledWith(objectKey, 'a'.repeat(64));
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects an object key belonging to another shipment before reading storage', async () => {
    const foreignShipmentId = '7fb5cf7d-c1d3-4b15-9df6-bec7b66f4136';
    const verifier = {
      verifyObjectDigest: jest.fn(async () => ({ sha256: 'a'.repeat(64), byteLength: 14 })),
    };
    const service = new WmsFulfillmentService(
      database as unknown as DatabaseService,
      verifier as never,
    );

    await expect(service.recordDeliveryEvent(
      USER_ID, TENANT_ID, FACTORY_ID, SHIPMENT_ID,
      deliveredPayload(`pod/${TENANT_ID}/${FACTORY_ID}/${foreignShipmentId}/evidence.png`),
      'pod-wrong-shipment-key', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(verifier.verifyObjectDigest).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('fails closed when POD storage verification is not wired in', async () => {
    const service = new WmsFulfillmentService(database as unknown as DatabaseService);
    const objectKey = `pod/${TENANT_ID}/${FACTORY_ID}/${SHIPMENT_ID}/evidence.png`;

    await expect(service.recordDeliveryEvent(
      USER_ID, TENANT_ID, FACTORY_ID, SHIPMENT_ID,
      deliveredPayload(objectKey), 'pod-verifier-missing-key', null, null,
    )).rejects.toMatchObject({ status: 503 });

    expect(database.transaction).not.toHaveBeenCalled();
  });
});
