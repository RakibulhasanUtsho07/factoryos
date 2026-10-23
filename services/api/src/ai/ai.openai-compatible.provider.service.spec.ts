import { jest } from '@jest/globals';
import {
  BadGatewayException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { AiArtifactProvenanceService } from './artifacts/ai.artifact.provenance.service';
import { AiModelProviderGatewayService } from './ai.model.provider.gateway.service';
import {
  AiOpenAiCompatibleProviderService,
  sha256AiModelProviderRouteManifest,
} from './ai.openai-compatible.provider.service';
import { SaasSubscriptionService } from '../saas/saas-subscription.service';
import { SaasUsageService } from '../saas/saas-usage.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const actorUserId = '6f1a3333-3333-4333-8333-333333333333';
const requestRef = '6f1a2222-2222-4222-8222-222222222222';
const endpointUrl = 'https://provider.example/v1/chat/completions';
const modelId = 'factoryos-pinned-model-v4';
const artifactVersion = 'route-v4';

describe('AI OpenAI-compatible provider adapter', () => {
  const originalEnv = {
    nodeEnv: process.env.NODE_ENV,
    egressApproved: process.env.AI_MODEL_PROVIDER_EGRESS_APPROVED,
    endpointUrl: process.env.AI_MODEL_PROVIDER_CHAT_COMPLETIONS_URL,
    apiKey: process.env.AI_MODEL_PROVIDER_API_KEY,
    modelId: process.env.AI_MODEL_PROVIDER_MODEL_ID,
    artifactVersion: process.env.AI_MODEL_PROVIDER_ARTIFACT_VERSION,
    timeout: process.env.AI_MODEL_PROVIDER_TIMEOUT_MS,
  };

  const provenance = {
    assertAdmissible: jest.fn<AiArtifactProvenanceService['assertAdmissible']>(),
  };
  const subscriptions = {
    assertAiCapabilityAvailable: jest.fn< S aasSubscriptionService['assertAiCapabilityAvailable'] >(),
  };
  const usage = {
    recordUsageEvent: jest.fn< S aasUsageService['recordUsageEvent'] >(),
  };

  let gateway: AiModelProviderGatewayService;
  let service: AiOpenAiCompatibleProviderService;
  let fetchMock: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.AI_MODEL_PROVIDER_EGRESS_APPROVED = 'true';
    process.env.AI_MODEL_PROVIDER_CHAT_COMPLETIONS_URL = endpointUrl;
    process.env.AI_MODEL_PROVIDER_API_KEY = 'test-provider-secret';
    process.env.AI_MODEL_PROVIDER_MODEL_ID = modelId;
    process.env.AI_MODEL_PROVIDER_ARTIFACT_VERSION = artifactVersion;
    process.env.AI_MODEL_PROVIDER_TIMEOUT_MS = '15000';

    provenance.assertAdmissible.mockReset().mockResolvedValue(undefined);
    subscriptions.assertAiCapabilityAvailable.mockReset().mockResolvedValue(undefined);
    usage.recordUsageEvent.mockReset().mockResolvedValue({} as never);

    gateway = new AiModelProviderGatewayService(provenance as never);
    service = new AiOpenAiCompatibleProviderService(
      gateway,
      subscriptions as never,
      usage as never,
    );
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('NODE_ENV', originalEnv.nodeEnv);
    restore('AI_MODEL_PROVIDER_EGRESS_APPROVED', originalEnv.egressApproved);
    restore('AI_MODEL_PROVIDER_CHAT_COMPLETIONS_URL', originalEnv.endpointUrl);
    restore('AI_MODEL_PROVIDER_API_KEY', originalEnv.apiKey);
    restore('AI_MODEL_PROVIDER_MODEL_ID', originalEnv.modelId);
    restore('AI_MODEL_PROVIDER_ARTIFACT_VERSION', originalEnv.artifactVersion);
    restore('AI_MODEL_PROVIDER_TIMEOUT_MS', originalEnv.timeout);
  });

  function response(body: Record<string, unknown>, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('admits the signed route manifest before provider I/O and meters call/input/output usage', async () => {
    const events: string[] = [];
    provenance.assertAdmissible.mockImplementation(async () => {
      events.push('admission');
    });
    subscriptions.assertAiCapabilityAvailable.mockImplementation(async () => {
      events.push('subscription');
    });
    usage.recordUsageEvent.mockImplementation(async () => {
      events.push('usage');
      return {} as never;
    });
    fetchMock.mockImplementation(async (_input, init) => {
      events.push('provider');
      expect((init?.headers as Record<string, string>).authorization).toBe(
        'Bearer test-provider-secret',
      );
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe(modelId);
      expect(body.stream).toBe(false);
      return response({
        model: modelId,
        choices: [{ message: { content: 'Approved informational response' } }],
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      });
    });

    const result = await service.chatCompletion({
      tenantId, factoryId, actorUserId, requestRef,
      prompt: 'Summarize a non-sensitive planning question',
      temperature: 0.1,
      maxTokens: 64,
    });

    expect(result).toEqual({
      requestId: requestRef,
      model: modelId,
      artifactVersion,
      content: 'Approved informational response',
      usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
    });
    expect(provenance.assertAdmissible).toHaveBeenCalledWith({
      tenantId,
      factoryId,
      actorUserId,
      artifactType: 'MODEL',
      artifactKey: modelId,
      version: artifactVersion,
      expectedSha256: sha256AiModelProviderRouteManifest({
        endpointUrl, modelId, artifactVersion,
      }),
      requestRef,
    });
    expect(events[0]).toBe('admission');
    expect(events.indexOf('provider')).toBeGreaterThan(events.indexOf('admission'));
    expect(events.indexOf('provider')).toBeGreaterThan(events.indexOf('subscription'));
    expect(events.indexOf('provider')).toBeGreaterThan(events.indexOf('usage'));
    expect(usage.recordUsageEvent).toHaveBeenCalledTimes(3);
  });

  it('never records usage or sends a provider request when artifact admission denies', async () => {
    provenance.assertAdmissible.mockRejectedValueOnce(
      new ForbiddenException('AI artifact admission denied: ARTIFACT_EXPIRED'),
    );

    await expect(service.chatCompletion({
      tenantId, factoryId, actorUserId, requestRef, prompt: 'Hello',
    })).rejects.toThrow('ARTIFACT_EXPIRED');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(usage.recordUsageEvent).not.toHaveBeenCalled();
    expect(subscriptions.assertAiCapabilityAvailable).not.toHaveBeenCalled();
  });

  it('requires explicit production provider-egress approval before any provider request', async () => {
    delete process.env.AI_MODEL_PROVIDER_EGRESS_APPROVED;

    await expect(service.chatCompletion({
      tenantId, factoryId, actorUserId, requestRef, prompt: 'Hello',
    })).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(provenance.assertAdmissible).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses insecure non-local production endpoints', async () => {
    process.env.AI_MODEL_PROVIDER_CHAT_COMPLETIONS_URL = 'http://provider.example/v1/chat/completions';

    await expect(service.chatCompletion({
      tenantId, factoryId, actorUserId, requestRef, prompt: 'Hello',
    })).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(provenance.assertAdmissible).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects provider-side model substitution after metering returned token usage', async () => {
    fetchMock.mockResolvedValueOnce(response({
      model: 'different-unpinned-model',
      choices: [{ message: { content: 'This must never be returned' } }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }));

    await expect(service.chatCompletion({
      tenantId, factoryId, actorUserId, requestRef, prompt: 'Hello',
    })).rejects.toBeInstanceOf(BadGatewayException);

    expect(usage.recordUsageEvent).toHaveBeenCalledTimes(3);
  });

  it('does not expose upstream error response bodies', async () => {
    fetchMock.mockResolvedValueOnce(response({
      error: { message: 'upstream internal details and secrets' },
    }, 500));

    await expect(service.chatCompletion({
      tenantId, factoryId, actorUserId, requestRef, prompt: 'Hello',
    })).rejects.toThrow('AI model provider returned a non-success status');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
