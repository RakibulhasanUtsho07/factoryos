import { validate } from 'class-validator';
import {
  CreateSaasSchemaCompatibilityRuleDto,
  SaasSchemaCompatibilityDecision,
  SaasTransferDatasetCategory,
} from './create-saas-schema-compatibility-rule.dto';

describe('CreateSaasSchemaCompatibilityRuleDto', () => {
  it('accepts all defined transfer categories together', async () => {
    const dto = Object.assign(new CreateSaasSchemaCompatibilityRuleDto(), {
      source_schema_version: '1.0.0',
      target_schema_version: '1.0.0',
      decision: SaasSchemaCompatibilityDecision.COMPATIBLE,
      required_categories: Object.values(SaasTransferDatasetCategory),
      reason: 'Preserve every category supported by the schema contract',
      idempotency_key: 'compatibility-all-categories-v1',
    });

    expect(Object.values(SaasTransferDatasetCategory)).toHaveLength(10);
    await expect(validate(dto)).resolves.toEqual([]);
  });
});
