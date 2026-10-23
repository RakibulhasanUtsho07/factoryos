import { jest } from '@jest/globals';
import { ForbiddenException } from '@nestjs/common';

import { AiArtifactProvenanceService } from './artifacts/ai.artifact.provenance.service';
import {
  AiModelArtifactReference,
  AiModelProviderGatewayService,
} from './ai.model.provider.gateway.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const actorUserId = '6f1a3333-3333-4333-8333-333333333333';
const requestRef = '6f1a2222-2222-4222-8222-222222222222';
const artifact: AiModelArtifactReference = {
  artifactKey: 'factoryos.example-model',
  version: '4.2.0',
  sha256: 'ab'.repeat(32),
};

describe('AI model provider admission gateway', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const provenance = {
    assertAdmissible: jest.fn<AiArtifactProvenanceService['assertAdmissible']>(),
  };

  const service = new AiModelProviderGatewayService(
    provenance as unknown as AiArtifactProvenanceService,
  );

  const baseInput = {
    tenantId,
    factoryId,
    actorUserId,
    requestRef,
    artifact,
  };

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    provenance.assertAdmissible.mockReset();
    provenance.assertAdmissible.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    jest.restoreAllMocks();
  });

  it('checks the exact model identity before invoking the provider callback', async () => {
    const order: string[] = [];
    provenance.assertAdmissible.mockImplementation(async () => {
      order.push('admission');
    });
    const invoke = jest.fn(async (admitted: Readonly<AiModelArtifactReference>) => {
      order.push('provider');
      return admitted.version;
    });

    const result = await service.invoke({ ...baseInput, invoke });

    expect(result).toBe('4.2.0');
    expect(order).toEqual(['admission', 'provider']);
    expect(provenance.assertAdmissible).toHaveBeenCalledWith({
      tenantId,
      factoryId,
      actorUserId,
      artifactType: 'MODEL',
      artifactKey: artifact.artifactKey,
      version: artifact.version,
      expectedSha256: artifact.sha256,
      requestRef,
    });
    expect(invoke).toHaveBeenCalledWith(Object.freeze({ ...artifact }));
  });

  it('never sends inference traffic when artifact admission is denied', async () => {
    provenance.assertAdmissible.mockRejectedValueOnce(
      new ForbiddenException('AI artifact admission denied: ARTIFACT_EXPIRED'),
    );
    const invoke = jest.fn(async () => 'provider response');

    await expect(service.invoke({ ...baseInput, invoke }))
      .rejects.toThrow('AI artifact admission denied: ARTIFACT_EXPIRED');

    expect(invoke).not.toHaveBeenCalled();
  });

  it('passes a missing digest to the admission service so production records a denial', async () => {
    provenance.assertAdmissible.mockImplementation(async (input) => {
      if (!input.expectedSha256) {
        throw new ForbiddenException(
          'AI artifact admission denied: EXPECTED_DIGEST_MISSING_OR_INVALID',
        );
      }
    });
    const invoke = jest.fn(async () => 'provider response');

    await expect(service.invoke({
      ...baseInput,
      artifact: { ...artifact, sha256: null },
      invoke,
    })).rejects.toThrow('EXPECTED_DIGEST_MISSING_OR_INVALID');

    expect(provenance.assertAdmissible).toHaveBeenCalledWith(expect.objectContaining({
      artifactType: 'MODEL',
      expectedSha256: null,
    }));
    expect(invoke).not.toHaveBeenCalled();
  });

  it('enforces admission in staging and when NODE_ENV is unset', async () => {
    const invoke = async () => 'ok';

    process.env.NODE_ENV = 'staging';
    await service.invoke({ ...baseInput, invoke });
    expect(provenance.assertAdmissible).toHaveBeenCalledTimes(1);

    provenance.assertAdmissible.mockClear();
    delete process.env.NODE_ENV;
    await service.invoke({ ...baseInput, invoke });
    expect(provenance.assertAdmissible).toHaveBeenCalledTimes(1);
  });

  it('bypasses the production-only registry gate only in explicit development/test modes', async () => {
    const invoke = jest.fn(async () => 'ok');

    process.env.NODE_ENV = 'development';
    await service.invoke({ ...baseInput, invoke });
    process.env.NODE_ENV = 'test';
    await service.invoke({ ...baseInput, invoke });

    expect(provenance.assertAdmissible).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
