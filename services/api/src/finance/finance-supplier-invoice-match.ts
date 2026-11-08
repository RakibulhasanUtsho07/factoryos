import { BadRequestException } from '@nestjs/common';
import type { FinanceOperationalSourceEvidence } from './finance-operational-source';

export interface SupplierInvoiceFactContract {
  fact_type: string;
  source_record_type: string;
  due_at: string | null;
  source_quantity: string | null;
  source_rate: string | null;
  source_uom_code: string | null;
  metadata_snapshot: Record<string, unknown>;
  reconciliation: null | {
    expected_source_type: string;
    expected_source_ref: string;
  };
}

/**
 * A supplier invoice remains an external AP record. When an AP connector
 * imports an invoice line with quantity/rate evidence, it must bind to one
 * posted GRN line; that GRN line in turn resolves its approved PO line.
 */
export function assertSupplierInvoiceThreeWayMatch(
  connectorDomain: string,
  fact: SupplierInvoiceFactContract,
  operationalSource?: FinanceOperationalSourceEvidence,
): void {
  if (fact.source_record_type.trim().toUpperCase() !== 'SUPPLIER_INVOICE_LINE') return;

  if (connectorDomain !== 'AP') {
    throw new BadRequestException('SUPPLIER_INVOICE_LINE must be ingested through the external AP system-of-record connector');
  }
  if (fact.fact_type !== 'AP_OPEN') {
    throw new BadRequestException('SUPPLIER_INVOICE_LINE must be represented as an AP_OPEN external payable fact');
  }
  if (!fact.due_at) {
    throw new BadRequestException('SUPPLIER_INVOICE_LINE requires the AP invoice due_at date');
  }
  if (!fact.source_quantity || !fact.source_rate || !fact.source_uom_code) {
    throw new BadRequestException('SUPPLIER_INVOICE_LINE requires the complete invoice quantity, unit-rate and UOM evidence tuple');
  }
  if (!fact.reconciliation) {
    throw new BadRequestException('SUPPLIER_INVOICE_LINE must be reconciled to one posted GOODS_RECEIPT_LINE');
  }
  if (fact.reconciliation.expected_source_type !== 'GOODS_RECEIPT_LINE') {
    throw new BadRequestException('SUPPLIER_INVOICE_LINE must reference GOODS_RECEIPT_LINE so the approved PO line is verified through the receipt');
  }

  const mappedSupplierCode = fact.metadata_snapshot.factoryos_supplier_code;
  if (typeof mappedSupplierCode !== 'string' || mappedSupplierCode.trim().length === 0) {
    throw new BadRequestException('SUPPLIER_INVOICE_LINE requires metadata_snapshot.factoryos_supplier_code from the governed AP supplier crosswalk');
  }

  if (operationalSource) {
    const expectedSupplierCode = operationalSource.supplierCode;
    if (!expectedSupplierCode || mappedSupplierCode.trim().toUpperCase() !== expectedSupplierCode) {
      throw new BadRequestException('Supplier invoice supplier crosswalk must match the supplier on the referenced approved PO');
    }
  }
}
