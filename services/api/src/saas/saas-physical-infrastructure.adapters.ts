import { SaasDeploymentProfile } from './dto/create-saas-subscription-plan.dto';

export const SAAS_PHYSICAL_INFRASTRUCTURE_ADAPTERS = Symbol('SAAS_PHYSICAL_INFRASTRUCTURE_ADAPTERS');

export interface PhysicalDeploymentProfile {
  id: string | null;
  profileType: SaasDeploymentProfile;
  deploymentReference: string | null;
  regionCode: string | null;
  residencyDomain: string | null;
  edgeSiteCode: string | null;
}

export interface PhysicalOperationContext {
  tenantId: string;
  actorUserId: string;
  runId: string;
  resourceId: string;
  resourceVersion: number;
  profile: PhysicalDeploymentProfile;
}

export interface PhysicalProvisioningReceipt {
  providerReference: string;
  topology: SaasDeploymentProfile;
  isolationVerified: boolean;
  evidenceDigest: string;
}

export interface PhysicalSandboxReceipt extends PhysicalProvisioningReceipt {
  storageProvisioned: boolean;
  datasetMaterialized: boolean;
  datasetMode: 'SYNTHETIC' | 'MASKED';
  datasetManifestDigest: string;
  maskingPolicyVersion?: string | null;
}

export interface PhysicalSandboxInput {
  environmentCode: string;
  purpose: string;
  dataMode: 'SYNTHETIC' | 'MASKED';
  datasetManifest: Record<string, unknown>;
  privacyAssessment: Record<string, unknown>;
}

export interface PhysicalDeploymentProfileInput {
  scopeType: 'TENANT' | 'FACTORY';
  scopeKey: string;
  factoryId: string | null;
  status: string;
  version: number;
}

export interface PhysicalReleaseInput {
  rolloutKey: string;
  scopeType: 'ORGANIZATION' | 'FACTORY' | 'MODULE' | 'AGENT';
  factoryId: string | null;
  moduleKey: string | null;
  agentKey: string | null;
  releaseChannel: string;
  stage: 'CANARY' | 'PRODUCTION';
  rolloutPercentage: number;
  artifactVersion: string;
  artifactDigest: string;
}

export interface PhysicalReleaseDeploymentReceipt extends PhysicalProvisioningReceipt {
  deploymentReference: string;
  artifactDigest: string;
}

export interface PhysicalHealthCheckReceipt {
  healthy: boolean;
  evidenceDigest: string;
  checkedAt: string;
  reasonCode?: string | null;
}

export interface PhysicalHaltReceipt {
  halted: boolean;
  evidenceDigest: string;
}

export interface PhysicalRollbackReceipt {
  rolledBack: boolean;
  healthy: boolean;
  deploymentReference: string;
  artifactDigest: string;
  topology: SaasDeploymentProfile;
  evidenceDigest: string;
}

export interface PhysicalInfrastructureAdapter {
  readonly providerCode: string;
  supports(profile: PhysicalDeploymentProfile): boolean;

  provisionSandbox(
    context: PhysicalOperationContext,
    input: PhysicalSandboxInput,
    idempotencyKey: string,
  ): Promise<PhysicalSandboxReceipt>;

  provisionDeploymentProfile(
    context: PhysicalOperationContext,
    input: PhysicalDeploymentProfileInput,
    idempotencyKey: string,
  ): Promise<PhysicalProvisioningReceipt>;

  deployRelease(
    context: PhysicalOperationContext,
    release: PhysicalReleaseInput,
    idempotencyKey: string,
  ): Promise<PhysicalReleaseDeploymentReceipt>;

  checkReleaseHealth(
    context: PhysicalOperationContext,
    deploymentReference: string,
    timeoutSeconds: number,
    expectedArtifactDigest?: string,
  ): Promise<PhysicalHealthCheckReceipt>;

  haltRelease(
    context: PhysicalOperationContext,
    deploymentReference: string,
    reasonCode: string,
    idempotencyKey: string,
  ): Promise<PhysicalHaltReceipt>;

  rollbackRelease(
    context: PhysicalOperationContext,
    deploymentReference: string,
    target: PhysicalReleaseInput,
    timeoutSeconds: number,
    idempotencyKey: string,
  ): Promise<PhysicalRollbackReceipt>;
}
