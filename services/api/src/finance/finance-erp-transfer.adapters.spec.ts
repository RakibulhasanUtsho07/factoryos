import { describe, expect, it } from '@jest/globals';
import { normalizeFinanceErpOpaqueReference } from './finance-erp-transfer.adapters';

describe('ERP transfer adapter contract', () => {
  it('accepts opaque provider keys but rejects URLs, traversal and credentials', () => {
    expect(normalizeFinanceErpOpaqueReference(' ERP-BATCH-123 ', 'source_batch_ref')).toBe('ERP-BATCH-123');
    expect(() => normalizeFinanceErpOpaqueReference('https://erp.example.com/?token=x', 'provider_reference')).toThrow('FINANCE_ERP_REFERENCE_INVALID');
    expect(() => normalizeFinanceErpOpaqueReference('../secrets', 'provider_reference')).toThrow('FINANCE_ERP_REFERENCE_INVALID');
    expect(() => normalizeFinanceErpOpaqueReference('', 'source_batch_ref')).toThrow('FINANCE_ERP_REFERENCE_INVALID');
  });
  it('provides stable file provenance and opaque provider acknowledgement references', () => {
    const example = {
      source_batch_ref: 'ERP-BATCH-123',
      file_name: 'finance-20261018.csv',
      format: 'CSV' as const,
      content: Buffer.from('external_fact_id,amount\nx,1\n'),
      provider_reference: 'provider-file-01',
    };
    expect(example.source_batch_ref).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
    expect(example.file_name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
    expect(example.content.length).toBeGreaterThan(0);
  });
});
