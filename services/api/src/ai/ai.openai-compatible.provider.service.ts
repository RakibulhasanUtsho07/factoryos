import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';

import { SaasSubscriptionService } from '../saas/saas-subscription.service';
import { SaasUsageService } from '../saas/saas-usage.service';
import { SaasMeterMetric } from '../saas/dto/create-saas-meter-rate.dto';
import {
  RecordSaasUsageEventDto,
  SaasUsageSourceSystem,
  SaasWorkloadClass,
} from '../saas/dto/record-saas-usage-event.dto';
import { AiModelProviderGatewayService } from './ai.model.provider.gateway.service';
import type { AiModelArtifactReference } from './ai.model.provider.gateway.service';

const ROUTE_MANIFEST_SCHEMA = 'factoryos.ai-model-provider-route-manifest/v1';
const PROVIDER_CODE = 'openai-compatible-chat-completions';
export const AI_MODEL_PROVIDER_SYSTEM_PROMPT =
  'You are an informational assistant. Your output is untrusted text: do not claim you executed tools, changed production systems, or performed external actions. Do not request passwords, API keys, or other secrets.';
const DEFAULT_MAX_TOKENS = 512;
const MAX_ALLOWED_COMPLETION_TOKENS = 2048;
const MAX_RESPONSE_BYTES_AS_TEXT = 1_048_576;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface AiModelProviderRouteManifest {
  endpointUrl: string;
  modelId: string;
  artifactVersion: string;
  systemPromptSha256: string;
}

/**
 * The signed MODEL artifact digest for this remote-provider adapter is the
 * SHA-256 of this canonical route manifest, not a claim that the API has
 * downloaded or measured a vendor's private model weights. Signing binds the
 * configured HTTPS endpoint, exact provider model ID and route version.
 */
export function sha256AiModelProviderSystemPrompt(): string {
  return createHash('sha256')
    .update(AI_MODEL_PROVIDER_SYSTEM_PROMPT, 'utf8')
    .digest('hex');
}

export function canonicalizeAiModelProviderRouteManifest(
  manifest: AiModelProviderRouteManifest,
): string {
  if (!/^[a-f0-9]{64}$/.test(manifest.systemPromptSha256)) {
    throw new BadRequestException('Provider route manifest system prompt hash must be a SHA-256 digest');
  }
  return JSON.stringify({
    schema_version: ROUTE_MANIFEST_SCHEMA,
    provider_code: PROVIDER_CODE,
    endpoint_url: new URL(manifest.endpointUrl).href,
    model_id: manifest.modelId,
    artifact_version: manifest.artifactVersion,
    system_prompt_sha256: manifest.systemPromptSha256,
  });
}

export function sha256AiModelProviderRouteManifest(
  manifest: AiModelProviderRouteManifest,
): string {
  return createHash('sha256')
    .update(canonicalizeAiModelProviderRouteManifest(manifest), 'utf8')
    .digest('hex');
}

export interface AiModelCompletionInput {
  tenantId: string;
  factoryId: string;
  actorUserId: string;
  requestRef: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}

export interface AiModelCompletionResult {
  requestId: string;
  model: string;
  artifactVersion: string;
  content: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null;
}

interface ProviderUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
}

interface ProviderChatCompletion {
  model?: unknown;
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  usage?: ProviderUsage;
}

interface ProviderConfig {
  endpointUrl: string;
  apiKey: string;
  modelId: string;
  artifactVersion: string;
  artifact: AiModelArtifactReference;
  timeoutMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

@Injectable()
export class AiOpenAiCompatibleProviderService {
  constructor(
    private readonly modelGateway: AiModelProviderGatewayService,
    private readonly subscriptions: SaasSubscriptionService,
    private readonly usageService: SaasUsageService,
  ) {}

  async chatCompletion(input: AiModelCompletionInput): Promise<AiModelCompletionResult> {
    if (!input || typeof input !== 'object') {
      throw new BadRequestException('A model inference request is required');
    }
    if (
      typeof input.prompt !== 'string' ||
      input.prompt.trim().length === 0 ||
      input.prompt.length > 10_000
    ) {
      throw new BadRequestException('prompt must contain between 1 and 10000 characters');
    }
    if (
      input.temperature !== undefined &&
      (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2)
    ) {
      throw new BadRequestException('temperature must be between 0 and 2');
    }
    if (
      input.maxTokens !== undefined &&
      (!Number.isSafeInteger(input.maxTokens) ||
        input.maxTokens < 1 ||
        input.maxTokens > MAX_ALLOWED_COMPLETION_TOKENS)
    ) {
      throw new BadRequestException(
        `maxTokens must be between 1 and ${MAX_ALLOWED_COMPLETION_TOKENS}`,
      );
    }
    if (
      !input.tenantId ||
      !input.factoryId ||
      !input.actorUserId ||
      !input.requestRef
    ) {
      throw new BadRequestException('Authenticated tenant/factory/user/request context is required');
    }

    const config = this.resolveConfig();
    const invocationId = randomUUID();

    return this.modelGateway.invoke({
      tenantId: input.tenantId,
      factoryId: input.factoryId,
      actorUserId: input.actorUserId,
      requestRef: input.requestRef,
      artifact: config.artifact,
      invoke: async (admittedArtifact) => {
        // Re-check the live subscription at the provider boundary, then write
        // the call meter before network I/O so usage-write failures fail closed.
        await this.subscriptions.assertAiCapabilityAvailable(input.tenantId);
        await this.recordUsage(
          input,
          invocationId,
          SaasMeterMetric.AI_TOOL_CALL,
          1,
          'call',
        );

        const providerResponse = await this.callProvider(
          config,
          admittedArtifact,
          input.prompt,
          input.temperature ?? 0.2,
          input.maxTokens ?? DEFAULT_MAX_TOKENS,
        );

        const usage = this.readUsage(providerResponse.usage);
        if (usage) {
          if (usage.inputTokens > 0) {
            await this.recordUsage(
              input,
              invocationId,
              SaasMeterMetric.AI_INPUT_TOKEN,
              usage.inputTokens,
              'input-tokens',
            );
          }
          if (usage.outputTokens > 0) {
            await this.recordUsage(
              input,
              invocationId,
              SaasMeterMetric.AI_OUTPUT_TOKEN,
              usage.outputTokens,
              'output-tokens',
            );
          }
        }

        // Never silently accept a provider-side alias/fallback to a model
        // different from the artifact which was admitted above.
        if (providerResponse.model !== admittedArtifact.artifactKey) {
          throw new BadGatewayException(
            'AI provider reported a model identifier different from the admitted model',
          );
        }

        const content = providerResponse.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
          throw new BadGatewayException('AI provider response did not contain a text completion');
        }

        return {
          requestId: input.requestRef,
          model: admittedArtifact.artifactKey,
          artifactVersion: admittedArtifact.version,
          content,
          usage,
        };
      },
    });
  }

  private resolveConfig(): ProviderConfig {
    const nodeEnv = process.env.NODE_ENV ?? 'production';
    const productionLike = !['development', 'test'].includes(nodeEnv);

    if (productionLike && process.env.AI_MODEL_PROVIDER_EGRESS_APPROVED !== 'true') {
      throw new ServiceUnavailableException(
        'External AI model-provider egress is not enabled for this deployment',
      );
    }

    const endpointRaw = process.env.AI_MODEL_PROVIDER_CHAT_COMPLETIONS_URL?.trim();
    const apiKey = process.env.AI_MODEL_PROVIDER_API_KEY?.trim();
    const modelId = process.env.AI_MODEL_PROVIDER_MODEL_ID?.trim();
    const artifactVersion = process.env.AI_MODEL_PROVIDER_ARTIFACT_VERSION?.trim();

    if (!endpointRaw || !apiKey || !modelId || !artifactVersion) {
      throw new ServiceUnavailableException('AI model provider configuration is incomplete');
    }
    if (modelId.length > 200 || /[\r\n\s]/.test(modelId)) {
      throw new ServiceUnavailableException('Configured AI model identifier is invalid');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/.test(artifactVersion)) {
      throw new ServiceUnavailableException('Configured AI model artifact version is invalid');
    }

    let endpoint: URL;
    try {
      endpoint = new URL(endpointRaw);
    } catch {
      throw new ServiceUnavailableException('Configured AI model provider URL is invalid');
    }

    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !endpoint.pathname.endsWith('/chat/completions')
    ) {
      throw new ServiceUnavailableException(
        'AI model provider URL must be a clean Chat Completions endpoint without credentials, query, or fragment',
      );
    }

    const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
    if (
      endpoint.protocol !== 'https:' &&
      !(localHost && endpoint.protocol === 'http:' && !productionLike)
    ) {
      throw new ServiceUnavailableException(
        'AI model provider endpoint must use HTTPS outside local development/test',
      );
    }

    const endpointUrl = endpoint.href;
    const manifest: AiModelProviderRouteManifest = {
      endpointUrl,
      modelId,
      artifactVersion,
      systemPromptSha256: sha256AiModelProviderSystemPrompt(),
    };
    const artifact: AiModelArtifactReference = Object.freeze({
      artifactKey: modelId,
      version: artifactVersion,
      sha256: sha256AiModelProviderRouteManifest(manifest),
    });

    const parsedTimeout = Number(process.env.AI_MODEL_PROVIDER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    const timeoutMs =
      Number.isSafeInteger(parsedTimeout) && parsedTimeout >= 1 && parsedTimeout <= 60_000
        ? parsedTimeout
        : DEFAULT_TIMEOUT_MS;

    return {
      endpointUrl,
      apiKey,
      modelId,
      artifactVersion,
      artifact,
      timeoutMs,
    };
  }

  private async callProvider(
    config: ProviderConfig,
    admittedArtifact: Readonly<AiModelArtifactReference>,
    prompt: string,
    temperature: number,
    maxTokens: number,
  ): Promise<ProviderChatCompletion> {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), config.timeoutMs);

    let bodyText = '';
    let responseStatus = 0;
    try {
      const response = await fetch(config.endpointUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          model: admittedArtifact.artifactKey,
          messages: [
            {
              role: 'system',
              content: AI_MODEL_PROVIDER_SYSTEM_PROMPT,
            },
            { role: 'user', content: prompt },
          ],
          temperature,
          max_tokens: maxTokens,
          stream: false,
        }),
        signal: abort.signal,
      });
      responseStatus = response.status;
      bodyText = await response.text();
    } catch {
      throw new ServiceUnavailableException('AI model provider request failed or timed out');
    } finally {
      clearTimeout(timeout);
    }

    if (bodyText.length > MAX_RESPONSE_BYTES_AS_TEXT) {
      throw new BadGatewayException('AI model provider response exceeded the allowed size');
    }
    if (responseStatus < 200 || responseStatus >= 300) {
      throw new BadGatewayException('AI model provider returned a non-success status');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new BadGatewayException('AI model provider returned invalid JSON');
    }
    if (!isRecord(parsed)) {
      throw new BadGatewayException('AI model provider response has an invalid shape');
    }
    return parsed as ProviderChatCompletion;
  }

  private readUsage(
    providerUsage: ProviderUsage | undefined,
  ): AiModelCompletionResult['usage'] {
    if (!providerUsage) return null;
    const inputTokens = providerUsage.prompt_tokens;
    const outputTokens = providerUsage.completion_tokens;
    if (!isNonNegativeInteger(inputTokens) || !isNonNegativeInteger(outputTokens)) {
      return null;
    }
    const totalTokens = providerUsage.total_tokens;
    return {
      inputTokens,
      outputTokens,
      totalTokens: isNonNegativeInteger(totalTokens)
        ? totalTokens
        : inputTokens + outputTokens,
    };
  }

  private async recordUsage(
    input: AiModelCompletionInput,
    invocationId: string,
    metricCode: SaasMeterMetric,
    quantity: number,
    suffix: 'call' | 'input-tokens' | 'output-tokens',
  ): Promise<void> {
    const key = `ai-model-inference:${invocationId}:${suffix}`;
    const payload: RecordSaasUsageEventDto = {
      metric_code: metricCode,
      capability_code:
        suffix === 'call'
          ? 'ai.model.inference'
          : suffix === 'input-tokens'
            ? 'ai.model.input-tokens'
            : 'ai.model.output-tokens',
      workload_class: SaasWorkloadClass.PRODUCTION,
      quantity,
      occurred_at: new Date().toISOString(),
      source_system: SaasUsageSourceSystem.AI_GATEWAY,
      source_event_ref: key,
      idempotency_key: key,
    };
    await this.usageService.recordUsageEvent(
      input.tenantId,
      input.factoryId,
      input.actorUserId,
      payload,
    );
  }
}
