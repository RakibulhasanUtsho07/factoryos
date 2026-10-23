import { createHash } from 'node:crypto';
import { KubernetesSaasPhysicalInfrastructureAdapter } from './kubernetes-saas-physical-infrastructure.adapter';
import { SaasDeploymentProfile } from './dto/create-saas-subscription-plan.dto';
import { PhysicalDeploymentProfile } from './saas-physical-infrastructure.adapters';

function config(values: Record<string, string | undefined>) {
  return { get: (name: string) => values[name] };
}

const sharedProfile: PhysicalDeploymentProfile = {
  id: 'profile-v3',
  profileType: SaasDeploymentProfile.SHARED_SAAS,
  deploymentReference: null,
  regionCode: 'ap-south-1',
  residencyDomain: 'BD',
  edgeSiteCode: null,
};

function suffix(reference: string) {
  const normalized = reference.toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 32);
  return normalized + '_' + createHash('sha256').update(reference, 'utf8').digest('hex').slice(0, 8).toUpperCase();
}

describe('KubernetesSaasPhysicalInfrastructureAdapter', () => {
  it('does not claim to support a topology when endpoint credentials are absent', () => {
    const adapter = new KubernetesSaasPhysicalInfrastructureAdapter(config({}) as never);
    expect(adapter.supports(sharedProfile)).toBe(false);
    expect(adapter.supports({
      ...sharedProfile,
      profileType: SaasDeploymentProfile.DEDICATED_VPC,
      deploymentReference: 'vpc-prod-01',
    })).toBe(false);
    expect(adapter.supports({
      ...sharedProfile,
      profileType: SaasDeploymentProfile.HYBRID_EDGE_CLOUD,
      deploymentReference: 'cloud-prod-01',
      edgeSiteCode: 'edge-dhaka-01',
    })).toBe(false);
  });

  it('accepts only a configured trusted HTTPS shared-cluster origin in production', () => {
    const insecure = new KubernetesSaasPhysicalInfrastructureAdapter(config({
      NODE_ENV: 'production',
      SAAS_KUBERNETES_API_SERVER: 'http://kubernetes.internal',
      SAAS_KUBERNETES_BEARER_TOKEN: 'secret-from-environment',
    }) as never);
    expect(insecure.supports(sharedProfile)).toBe(false);

    const embeddedCredential = new KubernetesSaasPhysicalInfrastructureAdapter(config({
      NODE_ENV: 'production',
      SAAS_KUBERNETES_API_SERVER: 'https://user:password@kubernetes.example.test',
      SAAS_KUBERNETES_BEARER_TOKEN: 'secret-from-environment',
    }) as never);
    expect(embeddedCredential.supports(sharedProfile)).toBe(false);

    const valid = new KubernetesSaasPhysicalInfrastructureAdapter(config({
      NODE_ENV: 'production',
      SAAS_KUBERNETES_API_SERVER: 'https://kubernetes.example.test',
      SAAS_KUBERNETES_BEARER_TOKEN: 'secret-from-environment',
    }) as never);
    expect(valid.supports(sharedProfile)).toBe(true);
  });

  it('selects dedicated VPC credentials by opaque deployment reference rather than accepting caller URLs', () => {
    const deploymentReference = 'deploy-vpc-prod-01';
    const key = suffix(deploymentReference);
    const adapter = new KubernetesSaasPhysicalInfrastructureAdapter(config({
      NODE_ENV: 'production',
      ['SAAS_KUBERNETES_TARGET_' + key + '_API_SERVER']: 'https://dedicated-kube.example.test',
      ['SAAS_KUBERNETES_TARGET_' + key + '_BEARER_TOKEN']: 'dedicated-cluster-token',
    }) as never);
    expect(adapter.supports({
      ...sharedProfile,
      profileType: SaasDeploymentProfile.DEDICATED_VPC,
      deploymentReference,
    })).toBe(true);
    expect(adapter.supports({
      ...sharedProfile,
      profileType: SaasDeploymentProfile.DEDICATED_VPC,
      deploymentReference: 'https://caller-controlled.example.test',
    })).toBe(false);
  });

  it('requires both cloud and edge credentials for a hybrid deployment profile', () => {
    const cloudReference = 'cloud-prod-01';
    const edgeReference = 'edge-dhaka-01';
    const cloud = suffix(cloudReference);
    const edge = suffix(edgeReference);
    const values: Record<string, string> = {
      NODE_ENV: 'production',
      ['SAAS_KUBERNETES_TARGET_' + cloud + '_API_SERVER']: 'https://cloud-kube.example.test',
      ['SAAS_KUBERNETES_TARGET_' + cloud + '_BEARER_TOKEN']: 'cloud-cluster-token',
      ['SAAS_KUBERNETES_EDGE_' + edge + '_API_SERVER']: 'https://edge-kube.example.test',
      ['SAAS_KUBERNETES_EDGE_' + edge + '_BEARER_TOKEN']: 'edge-cluster-token',
    };
    const adapter = new KubernetesSaasPhysicalInfrastructureAdapter(config(values) as never);
    expect(adapter.supports({
      ...sharedProfile,
      profileType: SaasDeploymentProfile.HYBRID_EDGE_CLOUD,
      deploymentReference: cloudReference,
      edgeSiteCode: edgeReference,
    })).toBe(true);

    delete values['SAAS_KUBERNETES_EDGE_' + edge + '_BEARER_TOKEN'];
    const missingEdge = new KubernetesSaasPhysicalInfrastructureAdapter(config(values) as never);
    expect(missingEdge.supports({
      ...sharedProfile,
      profileType: SaasDeploymentProfile.HYBRID_EDGE_CLOUD,
      deploymentReference: cloudReference,
      edgeSiteCode: edgeReference,
    })).toBe(false);
  });

  it('applies cross-tenant default-deny ingress/egress and only opens same-namespace traffic plus DNS', async () => {
    const adapter = new KubernetesSaasPhysicalInfrastructureAdapter(config({}) as never);
    const captured: Record<string, unknown>[] = [];
    const internals = adapter as unknown as {
      ensureTenantNamespace: (target: unknown, context: unknown) => Promise<unknown>;
      ensureObject: (...args: unknown[]) => Promise<Record<string, unknown>>;
    };
    internals.ensureObject = jest.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(async (...args) => {
      const desired = args[3] as Record<string, unknown>;
      captured.push(desired);
      const metadata = desired.metadata as Record<string, unknown>;
      const kind = desired.kind;
      return {
        ...desired,
        metadata: { ...metadata, uid: String(kind).toLowerCase() + '-uid' },
        ...(kind === 'Namespace' ? { status: { phase: 'Active' } } : {}),
      };
    });
    await internals.ensureTenantNamespace(
      { code: 'shared', apiServer: 'https://kubernetes.example.test', bearerToken: 'not-persisted' },
      {
        tenantId: 'faaab63d-c447-46ce-950d-deebdd7f5f30',
        actorUserId: '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001',
        runId: '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
        resourceId: '456f2b7f-8c46-4d9a-8b44-18eae66a4450',
        resourceVersion: 1,
        profile: sharedProfile,
      },
    );
    const policy = captured.find((resource) => resource.kind === 'NetworkPolicy');
    expect(policy).toBeDefined();
    const spec = policy?.spec as Record<string, unknown>;
    expect(spec.policyTypes).toEqual(['Ingress', 'Egress']);
    expect(spec.ingress).toHaveLength(1);
    const egress = spec.egress as Array<Record<string, unknown>>;
    expect(egress).toHaveLength(2);
    expect(egress[0].to).toBeDefined(); // same tenant namespace only
    expect((egress[1].ports as Array<Record<string, unknown>>).map((port) => port.port))
      .toEqual([53, 53]);
    expect((egress[1].ports as Array<Record<string, unknown>>).map((port) => port.protocol))
      .toEqual(['UDP', 'TCP']);
  });

  it('limits masked materializer egress to reviewed HTTPS destination CIDRs', async () => {
    const adapter = new KubernetesSaasPhysicalInfrastructureAdapter(config({}) as never);
    let applied: Record<string, unknown> | null = null;
    const internals = adapter as unknown as {
      ensureMaskedDatasetEgressPolicy: (
        target: unknown, namespace: string, context: unknown, cidrs: string[],
      ) => Promise<unknown>;
      ensureObject: (...args: unknown[]) => Promise<Record<string, unknown>>;
    };
    internals.ensureObject = jest.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(async (...args) => {
      applied = args[3] as Record<string, unknown>;
      return { ...applied, metadata: { ...((applied.metadata as Record<string, unknown>) ?? {}), uid: 'network-policy-uid' } };
    });
    await internals.ensureMaskedDatasetEgressPolicy(
      { code: 'shared', apiServer: 'https://kubernetes.example.test', bearerToken: 'never-record-this' },
      'fo-faaab63dc44746ce950ddeeb',
      {
        tenantId: 'faaab63d-c447-46ce-950d-deebdd7f5f30',
        actorUserId: '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001',
        runId: '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
        resourceId: '456f2b7f-8c46-4d9a-8b44-18eae66a4450',
        resourceVersion: 1,
        profile: sharedProfile,
      },
      ['203.0.113.14/32', '198.51.100.0/24'],
    );
    expect(applied).not.toBeNull();
    const desired = applied as Record<string, unknown>;
    const spec = desired.spec as Record<string, unknown>;
    expect(spec.policyTypes).toEqual(['Egress']);
    expect((spec.podSelector as Record<string, unknown>).matchLabels).toEqual({
      'factoryos.io/workload-role': 'dataset-materializer',
    });
    const egress = spec.egress as Array<Record<string, unknown>>;
    expect(egress).toHaveLength(3);
    expect((egress[2].to as Array<Record<string, unknown>>).map((entry) =>
      (entry.ipBlock as Record<string, unknown>).cidr)).toEqual(['203.0.113.14/32', '198.51.100.0/24']);
    expect((egress[2].ports as Array<Record<string, unknown>>)).toEqual([{ protocol: 'TCP', port: 443 }]);
    expect(JSON.stringify(desired)).not.toContain('never-record-this');
  });

  it('rejects invalid pinned dataset-provisioner and workload image settings before provider requests', () => {
    const adapter = new KubernetesSaasPhysicalInfrastructureAdapter(config({
      NODE_ENV: 'production',
      SAAS_KUBERNETES_API_SERVER: 'https://kubernetes.example.test',
      SAAS_KUBERNETES_BEARER_TOKEN: 'cluster-token',
      SAAS_SANDBOX_DATASET_PROVISIONER_IMAGE: 'registry.example.test/factoryos/materializer:latest',
      SAAS_RELEASE_IMAGE_REPOSITORY: 'registry.example.test/factoryos/runtime',
    }) as never);
    expect(() => (adapter as never as { pinnedDatasetProvisionerImage: () => string })
      .pinnedDatasetProvisionerImage()).toThrow('pinned by SHA-256 digest');
    expect(() => (adapter as never as { releaseImageRepository: () => string })
      .releaseImageRepository()).not.toThrow();
  });
});
