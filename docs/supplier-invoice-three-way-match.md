# External supplier invoice three-way match (WP02 / Finance)

**SRS traceability:** FR-SUP-01, FR-SUP-02, FR-FIN-08 and FR-FIN-09.  
**System-of-record boundary:** the external AP/accounting platform remains authoritative for supplier invoices, payables and payment status. FactoryOS stores only the mapped immutable AP fact and its internal operational reconciliation evidence; it does not create an invoice ledger, approve/pay invoices, post journals or change the external accounting system.

## Accepted invoice-line contract

An external AP connector may identify an invoice line with `source_record_type = SUPPLIER_INVOICE_LINE`. Such a fact is accepted only when all of the following hold:

- The connector domain is `AP`, the fact type is `AP_OPEN`, and the payable due date is supplied.
- The invoice line includes its exact source quantity, unit rate and UOM as one complete evidence tuple.
- The fact includes a reconciliation to one `GOODS_RECEIPT_LINE` in the same tenant and factory. The source reference identifies the exact GRN line (or the supported receipt/PO/line composite reference).
- `metadata_snapshot.factoryos_supplier_code` contains the canonical, already-mapped FactoryOS supplier code. No fuzzy supplier-name match or inferred vendor mapping is used.

The operational resolver follows the selected GRN line to its parent receipt, its exact PO line, the approved PO header and the tenant-scoped supplier master. It returns the accepted receipt quantity, approved PO unit price, UOM, PO currency and canonical supplier code. The invoice's supplier crosswalk must match the supplier on that PO. The caller cannot supply or override the expected quantity/rate/UOM/currency.

## Match and exception semantics

The expected quantity is the GRN line's accepted quantity; the expected rate is the approved PO line's unit price. Invoice source quantity/rate are compared with those values using the explicit non-negative tolerances already carried by the finance reconciliation contract. UOM and currency must match exactly; conversions must occur in the external source mapping under an explicitly governed rule.

An invoice price/quantity variance is retained as an immutable `MISMATCH` rather than silently corrected or discarded. Open mismatches remain visible and keep the affected finance reporting result not ready. Only a reviewer distinct from the fact ingester may resolve or waive the finding, with the existing reason and reviewer audit evidence.

A missing/ambiguous GRN line, unposted receipt, unapproved PO, cross-factory join, missing supplier crosswalk or supplier mismatch fails closed. Partial invoice/receipt matching is not inferred: each invoice line must identify the exact receipt line being reconciled.

## Scope boundary and remaining work

This is a read-side AP invoice-line-to-GRN/PO three-way match. It does **not** implement freight/duty/insurance allocation, landed-cost capitalization, invoice tax treatment, credit-note matching, supplier claims/RMA, inventory revaluation, WIP or finished-goods valuation, or GL posting. Those require separately governed accounting policies and source evidence. No invoice table or AP write API is introduced.
