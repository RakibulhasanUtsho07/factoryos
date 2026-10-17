# Unit of Measure (UoM) and Conversion Controls

Implements the SRS/Blueprint Core Domain Kernel requirement for explicit, reviewed quantity conversion and validation.

## Rules

- UoM unit codes and definitions are immutable and scoped to a tenant/factory. Each unit declares a dimension (e.g. MASS, COUNT, LENGTH, VOLUME) and maximum input decimal precision (0–8).
- Conversion rules use an exact rational factor: `target quantity = source quantity × numerator / denominator`. Rules begin `PENDING_APPROVAL`; only `APPROVED` rules are usable. A different reviewer must approve/reject the submitter's rule. Approved rules can be retired; factor changes require a new rule.
- Approved rules convert in either direction through the exact inverse ratio. Units must have the same dimension and belong to the same factory; duplicate active pairs, including the reverse pair, are rejected.
- Rounding is explicit per rule: `REJECT` disallows values not exactly representable at target precision; `HALF_UP` rounds to the configured target precision. No implicit conversion or silent rounding occurs.
- Inventory item `unit` remains the canonical/base stock unit. A stock movement may send `input_unit_code`; conversion is checked inside the same stock transaction, the base quantity is posted to the existing 4-decimal ledger, and original quantity/unit plus rule/factor/rounding snapshot are stored on the immutable movement row.
- UoM mutations are tenant/factory scoped, idempotent, audited and outbox-backed. Definitions, rule factors and approval history are protected by database triggers and forced tenant RLS.

## API

- `POST /api/v1/inventory/uom/units` — register unit code, dimension and precision; `uom.write` and Idempotency-Key required.
- `GET /api/v1/inventory/uom/units?search=&dimension_code=&limit=100` — list definitions; `uom.read` required.
- `POST /api/v1/inventory/uom/conversions` — submit factor numerator/denominator, rounding mode and reason; `uom.write` and Idempotency-Key required.
- `GET /api/v1/inventory/uom/conversions?status=PENDING_APPROVAL&dimension_code=&limit=100` — list scoped rules and review status; `uom.read` required.
- `POST /api/v1/inventory/uom/conversions/:ruleId/review` — `APPROVE`, `REJECT` or (for an approved rule) `RETIRE`; `uom.approve`, reason and Idempotency-Key required.
- `POST /api/v1/inventory/uom/convert` — preview a plain-decimal-string quantity (up to 8 fractional digits), validating dimensions, source precision and approved rule; `uom.read` required.
- Existing `POST /api/v1/inventory/items/:itemId/movements` accepts optional `input_unit_code`. Omitting it preserves the original canonical-unit, four-decimal request behavior.

## Verification

Migration: `075_uom_conversion_controls.sql`. PostgreSQL regression: `services/api/test/uom-conversion.sql`; service validation regression: `services/api/src/inventory/uom.service.spec.ts`.
