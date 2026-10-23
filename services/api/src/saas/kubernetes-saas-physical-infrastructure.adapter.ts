import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  PhysicalDeploymentProfile,
  PhysicalDeploymentProfileInput,
  PhysicalHealthCheckReceipt,
  PhysicalHaltReceipt,
  PhysicalInfrastructureAdapter,
  PhysicalOperationContext,
  PhysicalProvisioningReceipt,
  PhysicalReleaseDeploymentReceipt,
  PhysicalReleaseInput,
  PhysicalRollbackReceipt,
  PhysicalSandboxInput,
  PhysicalSandboxReceipt,
} from './saas-physical-infrastructure.adapters';
import { SaasDeploymentProfile } from './dto/create-saas-subscription-plan.dto';

type JsonRecord = Record<string, any>;

interface KubernetesTarget {
  code: string;
  apiServer: string;
  bearerToken: string;
}

interface NamespaceEvidence {
  namespace: string;
  uid: string;
  resourceQuotaUid: string;
  limitRangeUid: string;
  networkPolicyUid: string;
}

class KubernetesProviderError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly providerCode: string,
  ) {
    super('Kubernetes provider operation failed');
    this.name = 'KubernetesProviderError';
  }
}

/**
 * Real Kubernetes API adapter for tenants whose clusters are already provisioned.
 * Shared/single-tenant targets use a configured shared cluster with one namespace
 * and storage boundary per tenant. DEDICATED_VPC uses a secret-manager configured
 * cluster endpoint selected by the reviewed deployment_reference. HYBRID_EDGE_CLOUD
 * requires both a cloud target and a separately configured edge target.
 *
 * The adapter does not create a VPC/cluster itself. That requires an infrastructure
 * account/provider controller and is deliberately kept outside this Kubernetes API.
 */
@Injectable()
export class KubernetesSaasPhysicalInfrastructureAdapter implements PhysicalInfrastructureAdapter {
  readonly providerCode = 'kubernetes';

  constructor(private readonly config: ConfigService) {}

  supports(profile: PhysicalDeploymentProfile): boolean {
    try {
      this.targets(profile);
      return true;
    } catch {
      return false;
    }
  }

  async provisionDeploymentProfile(
    context: PhysicalOperationContext,
    input: PhysicalDeploymentProfileInput,
    _idempotencyKey: string,
  ): Promise<PhysicalProvisioningReceipt> {
    const namespaceEvidence: NamespaceEvidence[] = [];
    for (const target of this.targets(context.profile)) {
      namespaceEvidence.push(await this.ensureTenantNamespace(target, context));
    }
    const evidenceDigest = this.hash({
      runId: context.runId,
      operation: 'DEPLOYMENT_PROFILE_PROVISION',
      profile: context.profile.profileType,
      scopeType: input.scopeType,
      scopeKey: input.scopeKey,
      profileVersion: input.version,
      namespaceEvidence,
    });
    return {
      providerReference: 'namespace:' + namespaceEvidence[0].namespace,
      topology: context.profile.profileType,
      isolationVerified: namespaceEvidence.length === this.targets(context.profile).length
        && namespaceEvidence.every((item) => Boolean(item.uid && item.resourceQuotaUid && item.limitRangeUid && item.networkPolicyUid)),
      evidenceDigest,
    };
  }

  async provisionSandbox(
    context: PhysicalOperationContext,
    input: PhysicalSandboxInput,
    _idempotencyKey: string,
  ): Promise<PhysicalSandboxReceipt> {
    const targets = this.targets(context.profile);
    const receipts: Array<Record<string, unknown>> = [];
    const manifestDigest = this.hash(input.datasetManifest);
    const datasetImage = this.pinnedDatasetProvisionerImage();

    for (const target of targets) {
      const namespace = await this.ensureTenantNamespace(target, context);
      const pvcName = this.sandboxPvcName(context.resourceId);
      const pvcSpec: JsonRecord = {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: this.storageRequest() } },
      };
      const storageClass = this.config.get<string>('SAAS_KUBERNETES_STORAGE_CLASS')?.trim();
      if (storageClass) pvcSpec.storageClassName = storageClass;

      await this.ensureObject(
        target,
        '/api/v1/namespaces/' + namespace.namespace + '/persistentvolumeclaims',
        '/api/v1/namespaces/' + namespace.namespace + '/persistentvolumeclaims/' + pvcName,
        this.namespacedObject('PersistentVolumeClaim', pvcName, namespace.namespace, context, pvcSpec, {
          'factoryos.io/dataset-manifest-digest': manifestDigest,
          'factoryos.io/sandbox-id': context.resourceId,
        }),
        context,
      );

      const manifestConfigMapName = this.datasetConfigMapName(context.runId);
      const configMapData = {
        'dataset_manifest.json': JSON.stringify(input.datasetManifest),
        'privacy_assessment.json': JSON.stringify(input.privacyAssessment),
      };
      const configMap = await this.ensureObject(
        target,
        '/api/v1/namespaces/' + namespace.namespace + '/configmaps',
        '/api/v1/namespaces/' + namespace.namespace + '/configmaps/' + manifestConfigMapName,
        this.namespacedObject('ConfigMap', manifestConfigMapName, namespace.namespace, context, {}, {
          'factoryos.io/dataset-manifest-digest': manifestDigest,
        }, configMapData),
        context,
      );

      let maskedSecretName: string | null = null;
      if (input.dataMode === 'MASKED') {
        maskedSecretName = this.maskedSourceSecretName();
        const secret = await this.maybeGet(
          target,
          '/api/v1/namespaces/' + namespace.namespace + '/secrets/' + maskedSecretName,
        );
        if (!secret || !this.ownedByTenant(secret, context.tenantId)) {
          throw new ConflictException('Approved masked-data source secret is not installed in the tenant namespace; dataset copy is blocked');
        }
      }

      const jobName = this.datasetJobName(context.runId);
      const volumes: JsonRecord[] = [
        { name: 'dataset-input', configMap: { name: manifestConfigMapName } },
        { name: 'dataset-storage', persistentVolumeClaim: { claimName: pvcName } },
      ];
      const mounts: JsonRecord[] = [
        { name: 'dataset-input', mountPath: '/input', readOnly: true },
        { name: 'dataset-storage', mountPath: '/data', readOnly: false },
      ];
      if (maskedSecretName) {
        volumes.push({ name: 'masked-source', secret: { secretName: maskedSecretName, defaultMode: 256 } });
        mounts.push({ name: 'masked-source', mountPath: '/source', readOnly: true });
      }
      const jobSpec = {
        backoffLimit: 0,
        activeDeadlineSeconds: this.provisionTimeoutSeconds(),
        ttlSecondsAfterFinished: 86400,
        template: {
          metadata: { labels: this.resourceLabels(context, { 'factoryos.io/run-id-hash': this.sha(context.runId).slice(0, 16) }) },
          spec: {
            restartPolicy: 'Never',
            automountServiceAccountToken: false,
            securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001, seccompProfile: { type: 'RuntimeDefault' } },
            containers: [{
              name: 'dataset-materializer',
              image: datasetImage,
              imagePullPolicy: 'IfNotPresent',
              args: [
                'materialize',
                '--mode', input.dataMode,
                '--manifest', '/input/dataset_manifest.json',
                '--privacy-assessment', '/input/privacy_assessment.json',
                '--output', '/data',
              ],
              env: [
                { name: 'FACTORYOS_EXPECTED_DATASET_MANIFEST_SHA256', value: manifestDigest },
                { name: 'FACTORYOS_SANDBOX_ID', value: context.resourceId },
              ],
              volumeMounts: mounts,
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
                seccompProfile: { type: 'RuntimeDefault' },
              },
              resources: {
                requests: { cpu: '100m', memory: '128Mi' },
                limits: { cpu: '1', memory: '1Gi' },
              },
            }],
            volumes,
          },
        },
      };
      const job = await this.ensureObject(
        target,
        '/apis/batch/v1/namespaces/' + namespace.namespace + '/jobs',
        '/apis/batch/v1/namespaces/' + namespace.namespace + '/jobs/' + jobName,
        this.namespacedObject('Job', jobName, namespace.namespace, context, jobSpec, {
          'factoryos.io/dataset-manifest-digest': manifestDigest,
        }),
        context,
      );

      await this.waitFor(
        () => this.getRequired(target, '/api/v1/namespaces/' + namespace.namespace + '/persistentvolumeclaims/' + pvcName),
        (resource) => resource.status?.phase === 'Bound',
        this.provisionTimeoutSeconds(),
        'Sandbox persistent volume did not reach Bound state',
      );
      const completedJob = await this.waitFor(
        () => this.getRequired(target, '/apis/batch/v1/namespaces/' + namespace.namespace + '/jobs/' + jobName),
        (resource) => {
          if (resource.status?.failed > 0 || resource.status?.conditions?.some((condition: JsonRecord) =>
            condition.type === 'Failed' && condition.status === 'True')) {
            throw new KubernetesProviderError(409, 'DATASET_JOB_FAILED');
          }
          return resource.status?.succeeded >= 1 || resource.status?.conditions?.some((condition: JsonRecord) =>
            condition.type === 'Complete' && condition.status === 'True');
        },
        this.provisionTimeoutSeconds(),
        'Dataset materializer job did not complete before the provisioning deadline',
      );
      const boundPvc = await this.getRequired(
        target, '/api/v1/namespaces/' + namespace.namespace + '/persistentvolumeclaims/' + pvcName,
      );
      receipts.push({
        target: target.code,
        namespaceUid: namespace.uid,
        resourceQuotaUid: namespace.resourceQuotaUid,
        networkPolicyUid: namespace.networkPolicyUid,
        pvcUid: boundPvc.metadata?.uid,
        pvcPhase: boundPvc.status?.phase,
        configMapUid: configMap.metadata?.uid,
        jobUid: completedJob.metadata?.uid ?? job.metadata?.uid,
        jobSucceeded: true,
        manifestDigest,
        mode: input.dataMode,
      });
    }

    const maskingPolicyVersion = input.dataMode === 'MASKED'
      ? String(input.datasetManifest.masking_policy_version ?? '')
      : null;
    return {
      providerReference: 'pvc:' + this.tenantNamespace(context.tenantId) + '/' + this.sandboxPvcName(context.resourceId),
      topology: context.profile.profileType,
      isolationVerified: receipts.length === targets.length && receipts.every((receipt) =>
        Boolean(receipt.namespaceUid && receipt.resourceQuotaUid && receipt.networkPolicyUid)),
      storageProvisioned: receipts.length === targets.length && receipts.every((receipt) => receipt.pvcPhase === 'Bound'),
      datasetMaterialized: receipts.length === targets.length && receipts.every((receipt) => receipt.jobSucceeded === true),
      datasetMode: input.dataMode,
      datasetManifestDigest: manifestDigest,
      maskingPolicyVersion,
      evidenceDigest: this.hash({ runId: context.runId, operation: 'SANDBOX_PROVISION', receipts }),
    };
  }

  async deployRelease(
    context: PhysicalOperationContext,
    release: PhysicalReleaseInput,
    _idempotencyKey: string,
  ): Promise<PhysicalReleaseDeploymentReceipt> {
    const targets = this.targets(context.profile);
    const receipts: Array<Record<string, unknown>> = [];
    let primaryDeploymentReference = '';

    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const namespace = await this.ensureTenantNamespace(target, context);
      const name = this.releaseDeploymentName(release);
      const deployment = await this.applyReleaseDeployment(target, namespace.namespace, context, release, name);
      await this.applyReleaseService(target, namespace.namespace, context, release, name);
      if (index === 0) primaryDeploymentReference = 'deployment:' + namespace.namespace + '/' + name;
      receipts.push({
        target: target.code,
        namespaceUid: namespace.uid,
        networkPolicyUid: namespace.networkPolicyUid,
        deploymentUid: deployment.metadata?.uid,
        deploymentGeneration: deployment.metadata?.generation,
        artifactDigest: release.artifactDigest,
        deploymentName: name,
      });
    }

    if (!this.providerReferenceValid(primaryDeploymentReference)) {
      throw new ConflictException('Kubernetes did not return a safe deployment reference');
    }
    return {
      providerReference: primaryDeploymentReference,
      deploymentReference: primaryDeploymentReference,
      topology: context.profile.profileType,
      isolationVerified: receipts.length === targets.length && receipts.every((receipt) =>
        Boolean(receipt.namespaceUid && receipt.networkPolicyUid && receipt.deploymentUid)),
      artifactDigest: release.artifactDigest,
      evidenceDigest: this.hash({ runId: context.runId, operation: 'RELEASE_DEPLOY', receipts }),
    };
  }

  async checkReleaseHealth(
    context: PhysicalOperationContext,
    deploymentReference: string,
    timeoutSeconds: number,
    expectedArtifactDigest?: string,
  ): Promise<PhysicalHealthCheckReceipt> {
    const parsed = this.parseDeploymentReference(deploymentReference);
    const targets = this.targets(context.profile);
    const deadline = Date.now() + timeoutSeconds * 1000;
    let lastStates: Record<string, unknown>[] = [];
    let providerUnavailable = false;

    do {
      lastStates = [];
      providerUnavailable = false;
      let allReady = true;
      for (const target of targets) {
        try {
          const deployment = await this.getRequired(
            target,
            '/apis/apps/v1/namespaces/' + parsed.namespace + '/deployments/' + parsed.name,
          );
          const desired = Number(deployment.spec?.replicas ?? 1);
          const observed = Number(deployment.status?.observedGeneration ?? 0) >= Number(deployment.metadata?.generation ?? 0);
          const artifactDigest = deployment.metadata?.annotations?.['factoryos.io/artifact-digest'];
          const artifactMatches = !expectedArtifactDigest || artifactDigest === expectedArtifactDigest;
          const ready = observed && Number(deployment.status?.readyReplicas ?? 0) >= desired &&
            Number(deployment.status?.availableReplicas ?? 0) >= desired &&
            deployment.metadata?.labels?.['factoryos.io/tenant-id'] === context.tenantId &&
            artifactMatches;
          allReady = allReady && ready;
          lastStates.push({
            target: target.code, deploymentUid: deployment.metadata?.uid,
            generation: deployment.metadata?.generation, observedGeneration: deployment.status?.observedGeneration,
            desiredReplicas: desired, readyReplicas: Number(deployment.status?.readyReplicas ?? 0),
            availableReplicas: Number(deployment.status?.availableReplicas ?? 0),
            tenantBindingValid: deployment.metadata?.labels?.['factoryos.io/tenant-id'] === context.tenantId,
            artifactDigest,
            artifactMatches,
          });
        } catch (error) {
          allReady = false;
          providerUnavailable = true;
          lastStates.push({ target: target.code, observed: false, reasonCode: this.safeProviderCode(error) });
        }
      }
      if (allReady) {
        return {
          healthy: true,
          checkedAt: new Date().toISOString(),
          evidenceDigest: this.hash({ runId: context.runId, deploymentReference, healthy: true, states: lastStates }),
        };
      }
      if (Date.now() < deadline) await this.sleep(1500);
    } while (Date.now() < deadline);

    return {
      healthy: false,
      checkedAt: new Date().toISOString(),
      reasonCode: providerUnavailable ? 'HEALTH_PROVIDER_UNAVAILABLE' : 'READINESS_TIMEOUT',
      evidenceDigest: this.hash({
        runId: context.runId, deploymentReference, healthy: false, providerUnavailable, states: lastStates,
      }),
    };
  }

  async haltRelease(
    context: PhysicalOperationContext,
    deploymentReference: string,
    _reasonCode: string,
    _idempotencyKey: string,
  ): Promise<PhysicalHaltReceipt> {
    const parsed = this.parseDeploymentReference(deploymentReference);
    const targets = this.targets(context.profile);
    const receipts: Record<string, unknown>[] = [];
    let halted = true;

    for (const target of targets) {
      const path = '/apis/apps/v1/namespaces/' + parsed.namespace + '/deployments/' + parsed.name;
      const current = await this.getRequired(target, path);
      this.assertDeploymentOwned(current, context);
      const updated = { ...current, spec: { ...current.spec, replicas: 0 } };
      const result = await this.call(target, path, 'PUT', updated);
      const stopped = await this.waitFor(
        () => this.getRequired(target, path),
        (resource) => Number(resource.status?.readyReplicas ?? 0) === 0 &&
          Number(resource.spec?.replicas ?? -1) === 0,
        this.provisionTimeoutSeconds(),
        'Failed rollout did not scale down before the halt deadline',
      );
      halted = halted && Number(stopped.status?.readyReplicas ?? 0) === 0;
      receipts.push({ target: target.code, uid: result.metadata?.uid, generation: result.metadata?.generation,
        readyReplicas: Number(stopped.status?.readyReplicas ?? 0), halted: Number(stopped.spec?.replicas ?? -1) === 0 });
    }
    return {
      halted,
      evidenceDigest: this.hash({ runId: context.runId, deploymentReference, operation: 'HALT', receipts }),
    };
  }

  async rollbackRelease(
    context: PhysicalOperationContext,
    deploymentReference: string,
    targetRelease: PhysicalReleaseInput,
    timeoutSeconds: number,
    _idempotencyKey: string,
  ): Promise<PhysicalRollbackReceipt> {
    const parsed = this.parseDeploymentReference(deploymentReference);
    const targets = this.targets(context.profile);
    const receipts: Record<string, unknown>[] = [];
    let deploymentReferenceOut = deploymentReference;

    for (const target of targets) {
      const path = '/apis/apps/v1/namespaces/' + parsed.namespace + '/deployments/' + parsed.name;
      const current = await this.getRequired(target, path);
      this.assertDeploymentOwned(current, context);
      const repository = this.releaseImageRepository();
      const image = repository + '@sha256:' + targetRelease.artifactDigest;
      const containers = Array.isArray(current.spec?.template?.spec?.containers)
        ? current.spec.template.spec.containers.map((container: JsonRecord, index: number) =>
          index === 0 ? { ...container, image } : container)
        : [];
      if (containers.length === 0) throw new ConflictException('Rollback deployment has no container image to restore');
      const annotations = {
        ...(current.metadata?.annotations ?? {}),
        'factoryos.io/artifact-digest': targetRelease.artifactDigest,
        'factoryos.io/rollback-target-key-hash': this.sha(targetRelease.rolloutKey).slice(0, 16),
        'factoryos.io/physical-run-id': context.runId,
      };
      const templateAnnotations = {
        ...(current.spec?.template?.metadata?.annotations ?? {}),
        'factoryos.io/artifact-digest': targetRelease.artifactDigest,
      };
      const updated = {
        ...current,
        metadata: { ...current.metadata, annotations },
        spec: {
          ...current.spec,
          template: {
            ...current.spec.template,
            metadata: { ...(current.spec.template?.metadata ?? {}), annotations: templateAnnotations },
            spec: { ...current.spec.template.spec, containers },
          },
        },
      };
      const saved = await this.call(target, path, 'PUT', updated);
      deploymentReferenceOut = deploymentReferenceOut || 'deployment:' + parsed.namespace + '/' + parsed.name;
      receipts.push({ target: target.code, uid: saved.metadata?.uid, generation: saved.metadata?.generation,
        targetArtifactDigest: targetRelease.artifactDigest });
    }

    const health = await this.checkReleaseHealth(context, deploymentReferenceOut, timeoutSeconds, targetRelease.artifactDigest);
    const evidenceDigest = this.hash({
      runId: context.runId, operation: 'ROLLBACK', deploymentReference: deploymentReferenceOut,
      targetArtifactDigest: targetRelease.artifactDigest, health, receipts,
    });
    return {
      rolledBack: receipts.length === targets.length && receipts.length > 0,
      healthy: health.healthy,
      deploymentReference: deploymentReferenceOut,
      artifactDigest: targetRelease.artifactDigest,
      topology: context.profile.profileType,
      evidenceDigest,
    };
  }

  private targets(profile: PhysicalDeploymentProfile): KubernetesTarget[] {
    switch (profile.profileType) {
      case SaasDeploymentProfile.SHARED_SAAS:
      case SaasDeploymentProfile.SINGLE_TENANT:
        return [this.targetFromConfig('SAAS_KUBERNETES_API_SERVER', 'SAAS_KUBERNETES_BEARER_TOKEN', 'shared')];
      case SaasDeploymentProfile.DEDICATED_VPC:
        if (!profile.deploymentReference) throw new ConflictException('DEDICATED_VPC requires a reviewed deployment_reference mapped to dedicated cluster credentials');
        return [this.referencedTarget('TARGET', profile.deploymentReference)];
      case SaasDeploymentProfile.HYBRID_EDGE_CLOUD:
        if (!profile.deploymentReference || !profile.edgeSiteCode) {
          throw new ConflictException('HYBRID_EDGE_CLOUD requires reviewed cloud deployment_reference and edge_site_code mappings');
        }
        return [
          this.referencedTarget('TARGET', profile.deploymentReference),
          this.referencedTarget('EDGE', profile.edgeSiteCode),
        ];
      default:
        throw new ConflictException('Unsupported SaaS deployment topology');
    }
  }

  private targetFromConfig(apiKey: string, tokenKey: string, code: string): KubernetesTarget {
    return this.makeTarget(
      code,
      this.config.get<string>(apiKey),
      this.config.get<string>(tokenKey),
    );
  }

  private referencedTarget(prefix: 'TARGET' | 'EDGE', reference: string): KubernetesTarget {
    const settingKey = this.targetConfigSuffix(reference);
    return this.targetFromConfig(
      'SAAS_KUBERNETES_' + prefix + '_' + settingKey + '_API_SERVER',
      'SAAS_KUBERNETES_' + prefix + '_' + settingKey + '_BEARER_TOKEN',
      prefix.toLowerCase() + '-' + this.sha(reference).slice(0, 8),
    );
  }

  private makeTarget(code: string, apiServerInput: string | undefined, tokenInput: string | undefined): KubernetesTarget {
    const apiServer = apiServerInput?.trim() ?? '';
    const bearerToken = tokenInput?.trim() ?? '';
    if (!apiServer || !bearerToken || /[\r\n]/.test(bearerToken) || bearerToken.length > 8192) {
      throw new ConflictException('Kubernetes API endpoint or secret-manager bearer token is not configured');
    }
    let url: URL;
    try {
      url = new URL(apiServer);
    } catch {
      throw new ConflictException('Configured Kubernetes API server URL is invalid');
    }
    const localHttpAllowed = this.config.get<string>('NODE_ENV')?.trim().toLowerCase() !== 'production' &&
      ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !localHttpAllowed) || url.username || url.password ||
      url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
      throw new ConflictException('Kubernetes API endpoint must be a trusted HTTPS origin configured by deployment operations');
    }
    return { code, apiServer: url.origin, bearerToken };
  }

  private targetConfigSuffix(reference: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(reference)) {
      throw new ConflictException('Deployment target reference is invalid');
    }
    const safe = reference.toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 32);
    return safe + '_' + this.sha(reference).slice(0, 8).toUpperCase();
  }

  private async ensureTenantNamespace(target: KubernetesTarget, context: PhysicalOperationContext): Promise<NamespaceEvidence> {
    const namespace = this.tenantNamespace(context.tenantId);
    const profileHash = this.profileTargetHash(context.profile);
    const spec: JsonRecord = {};
    const object: JsonRecord = {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: namespace,
        labels: {
          'factoryos.io/tenant-id': context.tenantId,
          'factoryos.io/topology': context.profile.profileType,
          'app.kubernetes.io/managed-by': 'factoryos',
        },
        annotations: {
          'factoryos.io/target-hash': profileHash,
          'factoryos.io/spec-hash': this.hash(spec),
        },
      },
      spec,
    };
    const namespaceObject = await this.ensureObject(
      target, '/api/v1/namespaces', '/api/v1/namespaces/' + namespace, object, context,
    );
    if (namespaceObject.status?.phase && namespaceObject.status.phase !== 'Active') {
      throw new ConflictException('Tenant Kubernetes namespace is not Active');
    }

    const quotaSpec = {
      hard: {
        'pods': '100',
        'persistentvolumeclaims': '10',
        'requests.cpu': '20',
        'requests.memory': '32Gi',
        'limits.cpu': '40',
        'limits.memory': '64Gi',
        'requests.storage': '1Ti',
      },
    };
    const quotaName = 'factoryos-tenant-quota';
    const quota = await this.ensureObject(
      target,
      '/api/v1/namespaces/' + namespace + '/resourcequotas',
      '/api/v1/namespaces/' + namespace + '/resourcequotas/' + quotaName,
      this.namespacedObject('ResourceQuota', quotaName, namespace, context, quotaSpec),
      context,
    );

    const limitsSpec = {
      limits: [{
        type: 'Container',
        defaultRequest: { cpu: '250m', memory: '256Mi' },
        default: { cpu: '1', memory: '1Gi' },
        max: { cpu: '4', memory: '8Gi' },
      }],
    };
    const limitRange = await this.ensureObject(
      target,
      '/api/v1/namespaces/' + namespace + '/limitranges',
      '/api/v1/namespaces/' + namespace + '/limitranges/factoryos-default-limits',
      this.namespacedObject('LimitRange', 'factoryos-default-limits', namespace, context, limitsSpec),
      context,
    );

    const networkPolicySpec = {
      podSelector: {},
      policyTypes: ['Ingress'],
      ingress: [{
        from: [{
          namespaceSelector: {
            matchLabels: { 'kubernetes.io/metadata.name': namespace },
          },
        }],
      }],
    };
    const networkPolicy = await this.ensureObject(
      target,
      '/apis/networking.k8s.io/v1/namespaces/' + namespace + '/networkpolicies',
      '/apis/networking.k8s.io/v1/namespaces/' + namespace + '/networkpolicies/factoryos-tenant-isolation',
      this.namespacedObject('NetworkPolicy', 'factoryos-tenant-isolation', namespace, context, networkPolicySpec),
      context,
    );

    return {
      namespace,
      uid: this.safeString(namespaceObject.metadata?.uid, 'namespace UID'),
      resourceQuotaUid: this.safeString(quota.metadata?.uid, 'resource quota UID'),
      limitRangeUid: this.safeString(limitRange.metadata?.uid, 'LimitRange UID'),
      networkPolicyUid: this.safeString(networkPolicy.metadata?.uid, 'network policy UID'),
    };
  }

  private namespacedObject(
    kind: string,
    name: string,
    namespace: string,
    context: PhysicalOperationContext,
    spec: JsonRecord,
    extraAnnotations: Record<string, string> = {},
    data?: Record<string, string>,
  ): JsonRecord {
    const annotations = {
      'factoryos.io/spec-hash': this.hash(spec),
      'factoryos.io/physical-run-id': context.runId,
      ...extraAnnotations,
    };
    const body: JsonRecord = {
      apiVersion: kind === 'Job' ? 'batch/v1' : kind === 'Deployment' ? 'apps/v1'
        : kind === 'NetworkPolicy' ? 'networking.k8s.io/v1' : 'v1',
      kind,
      metadata: {
        name, namespace,
        labels: this.resourceLabels(context),
        annotations,
      },
      spec,
    };
    if (kind !== 'ConfigMap' && kind !== 'Secret') body.spec = spec;
    if (data) body.data = data;
    return body;
  }

  private resourceLabels(context: PhysicalOperationContext, extra: Record<string, string> = {}) {
    return {
      'factoryos.io/tenant-id': context.tenantId,
      'factoryos.io/topology': context.profile.profileType,
      'app.kubernetes.io/managed-by': 'factoryos',
      ...extra,
    };
  }

  private async ensureObject(
    target: KubernetesTarget,
    collectionPath: string,
    itemPath: string,
    desired: JsonRecord,
    context: PhysicalOperationContext,
  ): Promise<JsonRecord> {
    const expectedSpecHash = desired.metadata?.annotations?.['factoryos.io/spec-hash'];
    try {
      return await this.call(target, collectionPath, 'POST', desired);
    } catch (error) {
      if (!(error instanceof KubernetesProviderError) || error.statusCode !== 409) throw error;
    }
    const existing = await this.getRequired(target, itemPath);
    if (!this.ownedByTenant(existing, context.tenantId) ||
      existing.metadata?.labels?.['factoryos.io/topology'] !== context.profile.profileType ||
      existing.metadata?.labels?.['app.kubernetes.io/managed-by'] !== 'factoryos') {
      throw new ConflictException('Existing Kubernetes resource is not owned by this tenant/topology');
    }
    if (expectedSpecHash && existing.metadata?.annotations?.['factoryos.io/spec-hash'] !== expectedSpecHash) {
      throw new ConflictException('Existing Kubernetes resource spec differs from the pinned provisioning request');
    }
    if (desired.metadata?.annotations?.['factoryos.io/target-hash'] &&
      existing.metadata?.annotations?.['factoryos.io/target-hash'] !== desired.metadata.annotations['factoryos.io/target-hash']) {
      throw new ConflictException('Existing Kubernetes namespace is bound to another deployment target');
    }
    if (desired.metadata?.annotations?.['factoryos.io/dataset-manifest-digest'] &&
      existing.metadata?.annotations?.['factoryos.io/dataset-manifest-digest'] !== desired.metadata.annotations['factoryos.io/dataset-manifest-digest']) {
      throw new ConflictException('Existing dataset resource is bound to a different manifest digest');
    }
    return existing;
  }

  private async applyReleaseDeployment(
    target: KubernetesTarget,
    namespace: string,
    context: PhysicalOperationContext,
    release: PhysicalReleaseInput,
    deploymentName: string,
    rollbackTarget?: { artifactDigest: string; rolloutKey: string },
  ): Promise<JsonRecord> {
    const repository = this.releaseImageRepository();
    const digest = rollbackTarget?.artifactDigest ?? release.artifactDigest;
    const rolloutKey = rollbackTarget?.rolloutKey ?? release.rolloutKey;
    const image = repository + '@sha256:' + digest;
    const scopeHash = this.releaseScopeHash(context.tenantId, release);
    const releaseHash = this.sha(release.rolloutKey).slice(0, 16);
    const replicas = this.releaseReplicas();
    const existing = await this.maybeGet(
      target, '/apis/apps/v1/namespaces/' + namespace + '/deployments/' + deploymentName,
    );
    if (existing) this.assertDeploymentOwned(existing, context);
    if (existing && existing.metadata?.labels?.['factoryos.io/release-scope-hash'] !== scopeHash) {
      throw new ConflictException('Existing Kubernetes deployment is bound to a different tenant release scope');
    }

    const labels = existing?.metadata?.labels ?? this.resourceLabels(context, {
      'factoryos.io/release-scope-hash': scopeHash,
      'factoryos.io/release-key-hash': releaseHash,
    });
    const podLabels = existing?.spec?.template?.metadata?.labels ?? labels;
    const desiredSpec = {
      replicas: existing ? Number(existing.spec?.replicas ?? replicas) : replicas,
      revisionHistoryLimit: 5,
      selector: { matchLabels: { 'factoryos.io/tenant-id': context.tenantId, 'factoryos.io/release-key-hash': releaseHash } },
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
      template: {
        metadata: {
          labels: podLabels,
          annotations: {
            ...(existing?.spec?.template?.metadata?.annotations ?? {}),
            'factoryos.io/artifact-digest': digest,
          },
        },
        spec: {
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, seccompProfile: { type: 'RuntimeDefault' } },
          containers: [{
            name: 'factoryos-release',
            image,
            imagePullPolicy: 'IfNotPresent',
            ports: [{ name: 'http', containerPort: this.releaseContainerPort(), protocol: 'TCP' }],
            env: [
              { name: 'FACTORYOS_TENANT_ID', value: context.tenantId },
              { name: 'FACTORYOS_RELEASE_ROLLOUT_KEY', value: rolloutKey },
              { name: 'FACTORYOS_RELEASE_SCOPE_TYPE', value: release.scopeType },
              { name: 'FACTORYOS_FACTORY_ID', value: release.factoryId ?? '' },
              { name: 'FACTORYOS_MODULE_KEY', value: release.moduleKey ?? '' },
              { name: 'FACTORYOS_AGENT_KEY', value: release.agentKey ?? '' },
              { name: 'FACTORYOS_RELEASE_CHANNEL', value: release.releaseChannel },
              { name: 'FACTORYOS_ROLLOUT_PERCENTAGE', value: String(release.rolloutPercentage) },
            ],
            readinessProbe: {
              httpGet: { path: this.readinessPath(), port: 'http', scheme: 'HTTP' },
              periodSeconds: 5, timeoutSeconds: 2, failureThreshold: 6, successThreshold: 1,
            },
            livenessProbe: {
              httpGet: { path: this.livenessPath(), port: 'http', scheme: 'HTTP' },
              periodSeconds: 10, timeoutSeconds: 2, failureThreshold: 6,
            },
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ['ALL'] },
              seccompProfile: { type: 'RuntimeDefault' },
            },
            resources: { requests: { cpu: '250m', memory: '256Mi' }, limits: { cpu: '2', memory: '2Gi' } },
          }],
        },
      },
    };
    const desired: JsonRecord = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: deploymentName,
        namespace,
        labels: { ...labels, 'factoryos.io/tenant-id': context.tenantId },
        annotations: {
          ...(existing?.metadata?.annotations ?? {}),
          'factoryos.io/spec-hash': this.hash(desiredSpec),
          'factoryos.io/artifact-digest': digest,
          'factoryos.io/physical-run-id': context.runId,
          'factoryos.io/rollout-key-hash': this.sha(rolloutKey).slice(0, 16),
        },
        ...(existing?.metadata?.resourceVersion ? { resourceVersion: existing.metadata.resourceVersion } : {}),
      },
      spec: desiredSpec,
    };

    if (!existing) {
      try {
        return await this.call(target, '/apis/apps/v1/namespaces/' + namespace + '/deployments', 'POST', desired);
      } catch (error) {
        if (!(error instanceof KubernetesProviderError) || error.statusCode !== 409) throw error;
        return this.applyReleaseDeployment(target, namespace, context, release, deploymentName, rollbackTarget);
      }
    }
    if (existing.spec?.selector?.matchLabels?.['factoryos.io/tenant-id'] !== context.tenantId ||
        existing.spec?.selector?.matchLabels?.['factoryos.io/release-key-hash'] !== releaseHash) {
      throw new ConflictException('Existing Deployment selector does not match the tenant/release identity');
    }
    const saved = await this.call(
      target, '/apis/apps/v1/namespaces/' + namespace + '/deployments/' + deploymentName, 'PUT', desired,
    );
    return saved;
  }

  private async applyReleaseService(
    target: KubernetesTarget,
    namespace: string,
    context: PhysicalOperationContext,
    release: PhysicalReleaseInput,
    deploymentName: string,
  ) {
    const serviceName = this.releaseServiceName(deploymentName);
    const releaseHash = this.sha(release.rolloutKey).slice(0, 16);
    const spec = {
      type: 'ClusterIP',
      selector: {
        'factoryos.io/tenant-id': context.tenantId,
        'factoryos.io/release-key-hash': releaseHash,
      },
      ports: [{ name: 'http', port: this.releaseContainerPort(), targetPort: 'http', protocol: 'TCP' }],
    };
    return this.ensureObject(
      target,
      '/api/v1/namespaces/' + namespace + '/services',
      '/api/v1/namespaces/' + namespace + '/services/' + serviceName,
      this.namespacedObject('Service', serviceName, namespace, context, spec, {
        'factoryos.io/release-scope-hash': this.releaseScopeHash(context.tenantId, release),
      }),
      context,
    );
  }

remove unused rollback helpers  private async getRequired(target: KubernetesTarget, path: string): Promise<JsonRecord> {
    const result = await this.call(target, path, 'GET');
    if (!isRecord(result) || !isRecord(result.metadata)) {
      throw new KubernetesProviderError(502, 'INVALID_PROVIDER_OBJECT');
    }
    return result;
  }

  private async maybeGet(target: KubernetesTarget, path: string): Promise<JsonRecord | null> {
    try {
      return await this.getRequired(target, path);
    } catch (error) {
      if (error instanceof KubernetesProviderError && error.statusCode === 404) return null;
      throw error;
    }
  }

  private async call(
    target: KubernetesTarget,
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    body?: JsonRecord,
  ): Promise<JsonRecord> {
    let response: Response;
    try {
      response = await fetch(new URL(path, target.apiServer + '/'), {
        method,
        headers: {
          Authorization: 'Bearer ' + target.bearerToken,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new KubernetesProviderError(503, 'KUBERNETES_API_UNAVAILABLE');
    }
    let result: unknown = {};
    try {
      const text = await response.text();
      result = text ? JSON.parse(text) : {};
    } catch {
      if (response.ok) throw new KubernetesProviderError(502, 'KUBERNETES_RESPONSE_INVALID');
      result = {};
    }
    if (!response.ok) {
      const providerCode = isRecord(result) && typeof result.reason === 'string'
        && /^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(result.reason)
        ? result.reason.toUpperCase()
        : response.status === 409 ? 'RESOURCE_CONFLICT'
          : response.status === 404 ? 'RESOURCE_NOT_FOUND'
            : 'KUBERNETES_REQUEST_FAILED';
      throw new KubernetesProviderError(response.status, providerCode);
    }
    if (!isRecord(result)) throw new KubernetesProviderError(502, 'KUBERNETES_RESPONSE_INVALID');
    return result;
  }

  private async waitFor(
    read: () => Promise<JsonRecord>,
    predicate: (resource: JsonRecord) => boolean,
    timeoutSeconds: number,
    failureMessage: string,
  ): Promise<JsonRecord> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let last: JsonRecord = {};
    do {
      last = await read();
      if (predicate(last)) return last;
      if (Date.now() < deadline) await this.sleep(1500);
    } while (Date.now() < deadline);
    throw new KubernetesProviderError(504, this.safeCodeFromMessage(failureMessage));
  }

remove unused ensureOwnedResource  private assertDeploymentOwned(resource: JsonRecord, context: PhysicalOperationContext) {
    if (!this.ownedByTenant(resource, context.tenantId) ||
      resource.metadata?.labels?.['factoryos.io/topology'] !== context.profile.profileType ||
      resource.metadata?.labels?.['app.kubernetes.io/managed-by'] !== 'factoryos') {
      throw new ConflictException('Kubernetes resource ownership/topology does not match the verified tenant context');
    }
  }

  private ownedByTenant(resource: JsonRecord, tenantId: string): boolean {
    return resource.metadata?.labels?.['factoryos.io/tenant-id'] === tenantId &&
      resource.metadata?.labels?.['app.kubernetes.io/managed-by'] === 'factoryos';
  }

  private parseDeploymentReference(reference: string): { namespace: string; name: string } {
    const match = /^deployment:([a-z0-9-]{1,63})\/([a-z0-9-]{1,63})$/.exec(reference);
    if (!match) throw new ConflictException('Saved provider deployment reference is invalid');
    return { namespace: match[1], name: match[2] };
  }

  private providerReferenceValid(reference: string) {
    return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/.test(reference) && !reference.includes('://');
  }

  private tenantNamespace(tenantId: string) {
    return 'fo-' + tenantId.replace(/-/g, '').slice(0, 24).toLowerCase();
  }

  private sandboxPvcName(sandboxId: string) {
    return 'fo-sandbox-' + sandboxId.replace(/-/g, '').slice(0, 16).toLowerCase();
  }

  private datasetJobName(runId: string) {
    return 'fo-ds-' + runId.replace(/-/g, '').slice(0, 20).toLowerCase();
  }

  private datasetConfigMapName(runId: string) {
    return 'fo-dataset-' + runId.replace(/-/g, '').slice(0, 20).toLowerCase();
  }

  private releaseDeploymentName(release: PhysicalReleaseInput) {
    const scope = this.sha(JSON.stringify({
      scopeType: release.scopeType, factoryId: release.factoryId, moduleKey: release.moduleKey, agentKey: release.agentKey,
    })).slice(0, 12);
    const rollout = this.sha(release.rolloutKey).slice(0, 12);
    return 'fo-rel-' + scope + '-' + rollout;
  }

  private releaseServiceName(deploymentName: string) {
    return 'svc-' + deploymentName.slice(0, 59);
  }

  private profileTargetHash(profile: PhysicalDeploymentProfile) {
    return this.hash({
      topology: profile.profileType,
      deploymentReference: profile.deploymentReference,
      regionCode: profile.regionCode,
      residencyDomain: profile.residencyDomain,
      edgeSiteCode: profile.edgeSiteCode,
    });
  }

  private releaseScopeHash(tenantId: string, release: PhysicalReleaseInput) {
    return this.hash({
      tenantId, scopeType: release.scopeType, factoryId: release.factoryId,
      moduleKey: release.moduleKey, agentKey: release.agentKey, channel: release.releaseChannel,
    }).slice(0, 32);
  }

  private storageRequest() {
    const value = this.config.get<string>('SAAS_KUBERNETES_SANDBOX_STORAGE_REQUEST')?.trim() || '10Gi';
    if (!/^[1-9][0-9]{0,3}(Mi|Gi|Ti)$/.test(value)) {
      throw new ConflictException('SAAS_KUBERNETES_SANDBOX_STORAGE_REQUEST must be an approved positive Mi/Gi/Ti quantity');
    }
    return value;
  }

  private pinnedDatasetProvisionerImage() {
    const value = this.config.get<string>('SAAS_SANDBOX_DATASET_PROVISIONER_IMAGE')?.trim() || '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}@sha256:[a-f0-9]{64}$/.test(value) || value.includes('://')) {
      throw new ConflictException('SAAS_SANDBOX_DATASET_PROVISIONER_IMAGE must be an approved image pinned by SHA-256 digest');
    }
    return value;
  }

  private maskedSourceSecretName() {
    const value = this.config.get<string>('SAAS_KUBERNETES_MASKED_SOURCE_SECRET_NAME')?.trim() || 'factoryos-masked-source';
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value) || value.length > 63) {
      throw new ConflictException('Masked-data source secret name is not a valid Kubernetes Secret name');
    }
    return value;
  }

  private releaseImageRepository() {
    const value = this.config.get<string>('SAAS_RELEASE_IMAGE_REPOSITORY')?.trim() || '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/.test(value) || value.includes('://') || value.includes('@')) {
      throw new ConflictException('SAAS_RELEASE_IMAGE_REPOSITORY must identify a configured OCI repository without an embedded digest');
    }
    return value;
  }

  private releaseReplicas() {
    const value = Number(this.config.get<string>('SAAS_RELEASE_REPLICAS') ?? '1');
    if (!Number.isSafeInteger(value) || value < 1 || value > 20) {
      throw new ConflictException('SAAS_RELEASE_REPLICAS must be an integer from 1 to 20');
    }
    return value;
  }

  private releaseContainerPort() {
    const value = Number(this.config.get<string>('SAAS_RELEASE_CONTAINER_PORT') ?? '3001');
    if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
      throw new ConflictException('SAAS_RELEASE_CONTAINER_PORT must be an integer from 1 to 65535');
    }
    return value;
  }

  private readinessPath() {
    return this.safeHealthPath(this.config.get<string>('SAAS_RELEASE_READINESS_PATH')?.trim() || '/api/health/ready');
  }

  private livenessPath() {
    return this.safeHealthPath(this.config.get<string>('SAAS_RELEASE_LIVENESS_PATH')?.trim() || '/api/health/live');
  }

  private safeHealthPath(value: string) {
    if (!/^\/[A-Za-z0-9/_-]{0,180}$/.test(value)) {
      throw new ConflictException('Kubernetes release health paths must be local absolute paths without query strings');
    }
    return value;
  }

  private provisionTimeoutSeconds() {
    const value = Number(this.config.get<string>('SAAS_KUBERNETES_PROVISION_TIMEOUT_SECONDS') ?? '180');
    if (!Number.isSafeInteger(value) || value < 30 || value > 600) {
      throw new ConflictException('SAAS_KUBERNETES_PROVISION_TIMEOUT_SECONDS must be an integer from 30 to 600');
    }
    return value;
  }

  private safeString(value: unknown, label: string) {
    if (typeof value !== 'string' || !value.trim() || value.length > 255) {
      throw new KubernetesProviderError(502, 'INVALID_' + label.toUpperCase().replace(/[^A-Z0-9]/g, '_'));
    }
    return value;
  }

  private safeCodeFromMessage(message: string) {
    const normalized = message.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 70);
    return normalized || 'PROVIDER_OPERATION_TIMEOUT';
  }

  private safeProviderCode(error: unknown) {
    return error instanceof KubernetesProviderError ? error.providerCode : 'KUBERNETES_PROVIDER_ERROR';
  }

  private sha(value: string) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private hash(value: unknown) {
    return this.sha(JSON.stringify(canonicalize(value)));
  }

  private sleep(milliseconds: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
