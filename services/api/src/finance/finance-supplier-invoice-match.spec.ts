import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import { assertSupplierInvoiceThreeWayMatch, type SupplierInvoiceFactContract } from './finance-supplier-invoice-match';
import type { FinanceOperationalSourceEvidence } from './finance-operational-source';

const baseFact: SupplierInvoiceFactContract = {
  fact_type: 'AP_OPEN',
  source_record_type: 'SUPPLIER_INVOICE_LINE',
  due_at: '2026-12-01T00:00:00.000Z',
  source_quantity: '12.5',
  source_rate: '4.25',
  source_uom_code: 'KG',
  metadata_snapshot: { factoryos_supplier_code: 'SUP-001' },
  reconciliation: { expected_source_type: 'GOODS_RECEIPT_LINE', expected_source_ref: '10000000-0000-4000-8000-000000000001' },
};
const operational: FinanceOperationalSourceEvidence = {
  quantity: '12.5',
  rate: '4.25',
  uomCode: 'KG',
  currency: 'BDT',
  supplierCode: 'SUP-001',
};

describe('supplier invoice three-way match contract', () => {
  it('allows non-invoice financial facts to retain existing reconciliation behavior', () => {
    expect(() => assertSupplierInvoiceThreeWayMatch('GL', {
      ...baseFact, source_record_type: 'GL_COST_LINE', fact_type: 'ACTUAL_COST',
    })).not.toThrow();
  });

  it('requires an external AP payable invoice line and a due date', () => {
    expect(() => assertSupplierInvoiceThreeWayMatch('GL', baseFact)).toThrow(BadRequestException);
    expect(() => assertSupplierInvoiceThreeWayMatch('AP', { ...baseFact, fact_type: 'ACTUAL_COST' }))
      .toThrow('AP_OPEN');
    expect(() => assertSupplierInvoiceThreeWayMatch('AP', { ...baseFact, due_at: null }))
      .toThrow('due_at');
  });

  it('requires complete invoice quantity/rate/UOM and a posted GRN source reference', () => {
    expect(() => assertSupplierInvoiceThreeWayMatch('AP', { ...baseFact, source_rate: null }))
      .toThrow('complete invoice quantity');
    expect(() => assertSupplierInvoiceThreeWayMatch('AP', { ...baseFact, reconciliation: null }))
      .toThrow('must be reconciled');
    expect(() => assertSupplierInvoiceThreeWayMatch('AP', {
      ...baseFact, reconciliation: { ...baseFact.reconciliation!, expected_source_type: 'PURCHASE_ORDER_LINE' },
    })).toThrow('GOODS_RECEIPT_LINE');
  });

  it('requires a governed supplier crosswalk and checks it against the PO supplier', () => {
    expect(() => assertSupplierInvoiceThreeWayMatch('AP', {
      ...baseFact, metadata_snapshot: {},
    })).toThrow('factoryos_supplier_code');
    expect(() => assertSupplierInvoiceThreeWayMatch('AP', baseFact, {
      ...operational, supplierCode: 'SUP-OTHER',
    })).toThrow('must match the supplier on the referenced approved PO');
    expect(() => assertSupplierInvoiceThreeWayMatch('AP', baseFact, operational)).not.toThrow();
  });
});
