import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { KubernetesSaasPhysicalInfrastructureAdapter } from './kubernetes-saas-physical-infrastructure.adapter';
import { SaasDeploymentProfile } from './dto/create-saas-subscription-plan.dto';
import type {
  PhysicalDeploymentProfile,
  PhysicalOperationContext,
} from './saas-physical-infrastructure.adapters';

function referenceKey(reference: string) {
  const normalized = reference.toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 32);
  return normalized + '_' + createHash('sha256').update(reference, 'utf8').digest('hex').slice(0, 8).toUpperCase();
}

function profile(type: SaasDeploymentProfile, deploymentReference: string | null, edgeSiteCode: string | null): PhysicalDeploymentProfile {
  return {
    id: '456f2b7f-8c46-4d9a-8b44-18eae66a4450',
    profileType: type,
    deploymentReference,
    regionCode: 'ap-south-1',
    residencyDomain: 'BD',
    edgeSiteCode,
  };
}

const contextBase: Omit<PhysicalOperationContext, 'profile'> = {
  tenantId: 'faaab63d-c447-46ce-950d-deebdd7f5f30',
  actorUserId: '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001',
  runId: 'd55101bb-a716-4b2a-9fb4-ff20b1b36ac1',
  resourceId: '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
  resourceVersion: 4,
};

describe('physical deployment profile topology orchestration', () => {
  it('provisions and attests every configured cluster boundary for shared, dedicated-VPC, and hybrid profiles', async () => {
    const cloudReference = 'cloud-prod-01';
    const edgeReference = 'edge-dhaka-01';
    const dedicatedReference = 'deploy-vpc-prod-01';

    const configValues: Record<string, string> = {
      NODE_ENV: 'production',
      SAAS_KUBERNETES_API_SERVER: 'https://shared-kube.example.test',
      SAAS_KUBERNETES_BEARER_TOKEN: 'shared-cluster-token',
      ['SAAS_KUBERNETES_TARGET_' + referenceKey(dedicatedReference) + '_API_SERVER']: 'https://dedicated-kube.example.test',
      ['SAAS_KUBERNETES_TARGET_' + referenceKey(dedicatedReference) + '_BEARER_TOKEN']: 'dedicated-cluster-token',
      ['SAAS_KUBERNETES_TARGET_' + referenceKey(cloudReference) + '_API_SERVER']: 'https://cloud-kube.example.test',
      ['SAAS_KUBERNETES_TARGET_' + referenceKey(cloudReference) + '_BEARER_TOKEN']: 'cloud-cluster-token',
      ['SAAS_KUBERNETES_EDGE_' + referenceKey(edgeReference) + '_API_SERVER']: 'https://edge-kube.example.test',
      ['SAAS_KUBERNETES_EDGE_' + referenceKey(edgeReference) + '_BEARER_TOKEN']: 'edge-cluster-token',
    };

    const scenarios: Array<{
      name: string;
      profile: PhysicalDeploymentProfile;
      expectedTargets: string[];
    }> = [
      {
        name: 'shared',
        profile: profile(SaasDeploymentProfile.SHARED_SAAS, null, null),
        expectedTargets: ['shared'],
      },
      {
        name: 'dedicated VPC cluster',
        profile: profile(SaasDeploymentProfile.DEDICATED_VPC, dedicatedReference, null),
        expectedTargets: ['target-' + createHash('sha256').update(dedicatedReference).digest('hex').slice(0, 8)],
      },
      {
        name: 'hybrid cloud and edge',
        profile: profile(SaasDeploymentProfile.HYBRID_EDGE_CLOUD, cloudReference, edgeReference),
        expectedTargets: [
          'target-' + createHash('sha256').update(cloudReference).digest('hex').slice(0, 8),
          'edge-' + createHash('sha256').update(edgeReference).digest('hex').slice(0, 8),
        ],
      },
    ];

    for (const scenario of scenarios) {
      const adapter = new KubernetesSaasPhysicalInfrastructureAdapter({
        get: (key: string) => configValues[key],
      } as never);
      const visitedTargets: string[] = [];
      const internals = adapter as unknown as {
        ensureTenantNamespace: (...args: unknown[]) => Promise<unknown>;
      };
      internals.ensureTenantNamespace = jest.fn<(...args: unknown[]) => Promise<unknown>>()
        .mockImplementation(async (target) => {
          const targetCode = (target as { code: string }).code;
          visitedTargets.push(targetCode);
          return {
            namespace: 'fo-faaab63dc44746ce950ddeeb',
            uid: targetCode + '-namespace-uid',
            resourceQuotaUid: targetCode + '-quota-uid',
            limitRangeUid: targetCode + '-limit-uid',
            networkPolicyUid: targetCode + '-network-policy-uid',
          };
        });

      const receipt = await adapter.provisionDeploymentProfile(
        { ...contextBase, profile: scenario.profile },
        { scopeType: 'TENANT', scopeKey: 'tenant-default', factoryId: null, status: 'PROVISIONING', version: 4 },
        'physical-topology-' + scenario.name.replace(/[^a-z0-9]+/gi, '-'),
      );

      expect(visitedTargets).toEqual(scenario.expectedTargets);
      expect(receipt.topology).toBe(scenario.profile.profileType);
      expect(receipt.isolationVerified).toBe(true);
      expect(receipt.providerReference).toBe('namespace:fo-faaab63dc44746ce950ddeeb');
      expect(receipt.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('does not attest isolation when any target fails to return namespace, quota, limit, and network-policy identities', async () => {
    const cloudReference = 'cloud-prod-01';
    const edgeReference = 'edge-dhaka-01';
    const adapter = new KubernetesSaasPhysicalInfrastructureAdapter({
      NODE_ENV: 'production',
      ['SAAS_KUBERNETES_TARGET_' + referenceKey(cloudReference) + '_API_SERVER']: 'https://cloud-kube.example.test',
      ['SAAS_KUBERNETES_TARGET_' + referenceKey(cloudReference) + '_BEARER_TOKEN']: 'cloud-cluster-token',
      ['SAAS_KUBERNETES_EDGE_' + referenceKey(edgeReference) + '_API_SERVER']: 'https://edge-kube.example.test',
      ['SAAS_KUBERNETES_EDGE_' + referenceKey(edgeReference) + '_BEARER_TOKEN']: 'edge-cluster-token',
    } as never);
    const internals = adapter as unknown as {
      ensureTenantNamespace: (...args: unknown[]) => Promise<unknown>;
    };
    internals.ensureTenantNamespace = jest.fn<(...args: unknown[]) => Promise<unknown>>()
      .mockImplementation(async (target) => {
        const code = (target as { code: string }).code;
        return {
          namespace: 'fo-faaab63dc44746ce950ddeeb',
          uid: code + '-namespace-uid',
          resourceQuotaUid: code === 'edge-' + createHash('sha256').update(edgeReference).digest('hex').slice(0, 8)
            ? '' : code + '-quota-uid',
          limitRangeUid: code + '-limit-uid',
          networkPolicyUid: code + '-network-policy-uid',
        };
      });

    const receipt = await adapter.provisionDeploymentProfile(
      {
        ...contextBase,
        profile: profile(SaasDeploymentProfile.HYBRID_EDGE_CLOUD, cloudReference, edgeReference),
      },
      { scopeType: 'TENANT', scopeKey: 'tenant-default', factoryId: null, status: 'PROVISIONING', version: 4 },
      'physical-hybrid-missing-quota',
    );

    expect(receipt.isolationVerified).toBe(false);
  });
});
