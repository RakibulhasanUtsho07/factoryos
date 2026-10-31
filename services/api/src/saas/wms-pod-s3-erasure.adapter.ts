import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  deleteWmsPodObjectAndVerifyGone,
  listWmsPodTenantObjects,
  readWmsPodObjectDigestIfPresent,
  readWmsPodObjectDigest,
} from '../integrations/wms-pod-storage';
import {
  digestSaasExternalPropagationResources,
} from './saas-tenant-propagation.adapters';
import type {
  SaasExternalPropagationContext,
  SaasExternalPropagationDeleteReceipt,
  SaasExternalPropagationPlan,
  SaasExternalPropagationResourceIdentity,
  SaasExternalPropagationVerification,
  SaasTenantExternalDataPropagationAdapter,
  SaasTenantExternalDataTarget,
} from './saas-tenant-propagation.adapters';
import { SaasTransferDatasetCategory } from './dto/create-saas-schema-compatibility-rule.dto';

const CONFIG_REFERENCE = 'WMS_POD_STORAGE_CONFIG_REFERENCE';
const ADAPTER_VERSION = '1.0.0';
const STORE_KIND = 'OBJECT_STORAGE' as const;
const ADAPTER_KEY = 'wms.pod.s3.v1';
const RESOURCE_KIND = 'WMS_POD_OBJECT';
const PAGE_SIZE = 1000;
const DB_BATCH_SIZE = 500;
const MAX_PLAN_OBJECTS = 100000;
const READ_CONCURRENCY = 4;
const HEX_DIGEST = /^[a-f0-9]{64}$/;

@Injectable()
export class WmsPodS3ErasureAdapter implements SaasTenantExternalDataPropagationAdapter {
  readonly storeKind = STORE_KIND;
  readonly adapterKey = ADAPTER_KEY;
  readonly adapterVersion = ADAPTER_VERSION;

  constructor(private readonly config: ConfigService) {}

  async isConfigured(target: SaasTenantExternalDataTarget): Promise<boolean> {
    if (target.storeKind !== STORE_KIND || target.adapterKey !== ADAPTER_KEY || !target.required) return false;
    if (target.categories.length !== 1 || target.categories[0] !== SaasTransferDatasetCategory.EVIDENCE) return false;

    const expectedReference = this.config.get<string>(CONFIG_REFERENCE)?.trim();
    const suppliedReference = target.configReference.trim();
    if (!expectedReference || suppliedReference !== expectedReference) return false;

    const endpointInput = this.config.get<string>('WMS_POD_STORAGE_ENDPOINT')?.trim();
    const bucket = this.config.get<string>('WMS_POD_STORAGE_BUCKET')?.trim();
    const region = this.config.get<string>('WMS_POD_STORAGE_REGION')?.trim();
    const accessKeyId = this.config.get<string>('WMS_POD_STORAGE_ACCESS_KEY_ID')?.trim();
    const secretAccessKey = this.config.get<string>('WMS_POD_STORAGE_SECRET_ACCESS_KEY')?.trim();
    if (!endpointInput || !bucket || !region || !accessKeyId || !secretAccessKey) return false;

    try {
      const endpoint = new URL(endpointInput);
      if (!['https:', 'http:'].includes(endpoint.protocol)
        || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
        || (this.config.get<string>('NODE_ENV') === 'production' && endpoint.protocol !== 'https:')) {
        return false;
      }
    } catch {
      return false;
    }
    return true;
  }

  async prepare(input: SaasExternalPropagationContext): Promise<SaasExternalPropagationPlan> {
    this.assertSupportedContext(input);
    const keys = await listWmsPodTenantObjects(this.config, input.tenantId);
    if (keys.length > MAX_PLAN_OBJECTS) {
      throw new ConflictException('WMS POD tenant inventory exceeds the bounded erasure plan size');
    }

    const resources: SaasExternalPropagationResourceIdentity[] = [];
    for (let offset = 0; offset < keys.length; offset += READ_CONCURRENCY) {
      const batch = keys.slice(offset, offset + READ_CONCURRENCY);
      const digests = await Promise.all(batch.map(async (objectKey) => {
        const result = await readWmsPodObjectDigest(this.config, objectKey);
        return {
          resourceKind: RESOURCE_KIND,
          resourceReference: objectKey,
          resourceVersionReference: null,
          resourceContentDigest: result.sha256,
        };
      }));
      resources.push(...digests);
    }
    const manifestDigest = digestSaasExternalPropagationResources(resources);
    return {
      manifestDigest,
      plannedCopies: String(resources.length),
      planReference: 'wms-pod-plan.' + manifestDigest.slice(0, 40),
      adapterVersion: this.adapterVersion,
      resourceClass: RESOURCE_KIND,
      maxPageSize: PAGE_SIZE,
      maxBatchSize: DB_BATCH_SIZE,
      policyVersions: {
        inventory: 's3-list-v2-unversioned-v1',
        contentDigest: 'sha256-readback-v1',
        deletion: 'delete-readback-404-v1',
      },
      resources,
    };
  }

  async erase(
    input: SaasExternalPropagationContext & { plan: SaasExternalPropagationPlan },
  ): Promise<SaasExternalPropagationDeleteReceipt> {
    this.assertSupportedContext(input);
    this.assertPlan(input.tenantId, input.plan);
    let accounted = 0;
    for (const resource of input.plan.resources) {
      const objectKey = resource.resourceReference;
      const expectedDigest = resource.resourceContentDigest;
      if (typeof expectedDigest !== 'string' || !HEX_DIGEST.test(expectedDigest)) {
        throw new ConflictException('WMS POD resource manifest is missing a persisted content digest');
      }
      const current = await readWmsPodObjectDigestIfPresent(this.config, objectKey);
      if (current) {
        if (current.sha256 !== expectedDigest) {
          throw new ConflictException('WMS POD object bytes changed after the sealed resource inventory was prepared');
        }
        await deleteWmsPodObjectAndVerifyGone(this.config, input.tenantId, objectKey, expectedDigest);
      }
      // A prior DELETE may have succeeded before process termination. Absence
      // after the durable DELETE_REQUESTED intent is an idempotent accounted result.
      accounted += 1;
    }
    return {
      deletedCopies: String(accounted),
      manifestDigest: input.plan.manifestDigest,
      providerReceiptReference: 'wms-pod-s3-delete.' + input.plan.manifestDigest.slice(0, 40),
    };
  }

  async verify(
    input: SaasExternalPropagationContext & {
      plan: SaasExternalPropagationPlan;
      deletion: SaasExternalPropagationDeleteReceipt;
    },
  ): Promise<SaasExternalPropagationVerification> {
    this.assertSupportedContext(input);
    this.assertPlan(input.tenantId, input.plan);
    if (input.deletion.manifestDigest !== input.plan.manifestDigest
      || input.deletion.deletedCopies !== input.plan.plannedCopies) {
      throw new ConflictException('WMS POD deletion receipt does not match the sealed tenant object inventory');
    }
    const residualKeys = await listWmsPodTenantObjects(this.config, input.tenantId);
    return {
      verifiedManifestDigest: input.plan.manifestDigest,
      residualCopies: String(residualKeys.length),
      residualReferences: residualKeys.slice(0, 50),
      verificationReference: 'wms-pod-s3-verify.' + input.plan.manifestDigest.slice(0, 40),
    };
  }

  async recover(
    input: SaasExternalPropagationContext & { plan?: SaasExternalPropagationPlan },
  ): Promise<void> {
    this.assertSupportedContext(input);
    if (!input.plan) return;
    this.assertPlan(input.tenantId, input.plan);
    // Recovery is deliberately read-only. Present objects must still match the
    // prepared content digest; absent ones are reconciled by the subsequent erase
    // and whole-prefix verification after the saga's durable intent event.
    for (const resource of input.plan.resources) {
      if (!resource.resourceContentDigest || !HEX_DIGEST.test(resource.resourceContentDigest)) {
        throw new ConflictException('WMS POD recovery plan lacks a verified content digest');
      }
      const current = await readWmsPodObjectDigestIfPresent(this.config, resource.resourceReference);
      if (current && current.sha256 !== resource.resourceContentDigest) {
        throw new ConflictException('WMS POD object changed after the sealed plan; provider deletion is blocked');
      }
    }
  }

  private assertSupportedContext(input: SaasExternalPropagationContext & { plan?: SaasExternalPropagationPlan }) {
    if (input.target.storeKind !== STORE_KIND || input.target.adapterKey !== ADAPTER_KEY
      || input.target.categories.length !== 1
      || input.target.categories[0] !== SaasTransferDatasetCategory.EVIDENCE
      || !input.target.required) {
      throw new ConflictException('WMS POD S3 erasure supports required OBJECT_STORAGE targets for EVIDENCE only');
    }
    const expectedReference = this.config.get<string>(CONFIG_REFERENCE)?.trim();
    if (!expectedReference || input.target.configReference !== expectedReference) {
      throw new ConflictException('WMS POD target config reference does not match the configured storage boundary');
    }
  }

  private assertPlan(tenantId: string, plan: SaasExternalPropagationPlan) {
    if (plan.adapterVersion !== this.adapterVersion || plan.resourceClass !== RESOURCE_KIND
      || !HEX_DIGEST.test(plan.manifestDigest) || Number(plan.plannedCopies) !== plan.resources.length
      || digestSaasExternalPropagationResources(plan.resources) !== plan.manifestDigest) {
      throw new ConflictException('WMS POD plan does not match the exact canonical content-digested inventory');
    }
    for (const resource of plan.resources) {
      const parts = resource.resourceReference.split('/');
      const expectedPrefix = 'pod/' + tenantId.toLowerCase() + '/';
      if (!resource.resourceReference.startsWith(expectedPrefix) || parts.length !== 5
        || parts.some((part) => !part || part === '.' || part === '..')
        || parts.slice(1).some((part) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(part))
        || resource.resourceKind !== RESOURCE_KIND
        || resource.resourceVersionReference !== null
        || typeof resource.resourceContentDigest !== 'string'
        || !HEX_DIGEST.test(resource.resourceContentDigest)) {
        throw new ConflictException('WMS POD plan contains an invalid tenant-scoped object identity');
      }
    }
  }
}
