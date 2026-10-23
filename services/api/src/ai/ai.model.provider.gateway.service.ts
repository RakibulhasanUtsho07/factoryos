import { BadRequestException, Injectable } from '@nestjs/common';

import { AiArtifactProvenanceService } from './artifacts/ai.artifact.provenance.service';

export interface AiModelArtifactReference {
  artifactKey: string;
  version: string;
  sha256: string | null;
}

export interface InvokeAiModelProviderInput<T> {
  tenantId: string;
  factoryId: string;
  actorUserId: string;
  requestRef: string | null;
  artifact: AiModelArtifactReference;
  /**
   * The provider adapter must send its inference request only from this
   * callback and use the exact artifact reference passed to it.
   */
  invoke: (admittedArtifact: Readonly<AiModelArtifactReference>) => Promise<T>;
}

/**
 * Shared pre-inference boundary for model-provider adapters.
 *
 * Production-like environments re-check the current signed MODEL artifact
 * registry on every call. The provider callback is never invoked when the
 * artifact is missing, expired, revoked, has an unapproved signer, or fails
 * digest/signature verification. Only explicit development/test modes bypass
 * admission, matching the existing Tool Gateway policy.
 */
@Injectable()
export class AiModelProviderGatewayService {
  constructor(
    private readonly artifactProvenance: AiArtifactProvenanceService,
  ) {}

  async invoke<T>(input: InvokeAiModelProviderInput<T>): Promise<T> {
    if (!input || typeof input !== 'object' || typeof input.invoke !== 'function') {
      throw new BadRequestException('A model provider invocation callback is required');
    }
    if (
      !input.artifact ||
      typeof input.artifact.artifactKey !== 'string' ||
      typeof input.artifact.version !== 'string'
    ) {
      throw new BadRequestException('A resolved immutable model artifact identity is required');
    }

    // Snapshot all identity fields before awaiting the registry check. This
    // prevents a caller from changing the admitted key/version/digest while
    // the database/signature check is in flight.
    const tenantId = input.tenantId;
    const factoryId = input.factoryId;
    const actorUserId = input.actorUserId;
    const requestRef = input.requestRef;
    const providerCall = input.invoke;
    const artifact: Readonly<AiModelArtifactReference> = Object.freeze({
      artifactKey: input.artifact.artifactKey,
      version: input.artifact.version,
      sha256: typeof input.artifact.sha256 === 'string'
        ? input.artifact.sha256.toLowerCase()
        : null,
    });

    if (this.productionAdmissionRequired()) {
      await this.artifactProvenance.assertAdmissible({
        tenantId,
        factoryId,
        actorUserId,
        artifactType: 'MODEL',
        artifactKey: artifact.artifactKey,
        version: artifact.version,
        expectedSha256: artifact.sha256,
        requestRef,
      });
    }

    // Deliberately invoke only after successful admission. A failed database
    // check also fails closed because the provider callback has not run yet.
    return providerCall(artifact);
  }

  private productionAdmissionRequired(): boolean {
    const nodeEnv = process.env.NODE_ENV ?? 'production';
    return nodeEnv !== 'development' && nodeEnv !== 'test';
  }
}
