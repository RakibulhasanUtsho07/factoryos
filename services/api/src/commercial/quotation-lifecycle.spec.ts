import {
  calculateCommercialLines,
  canTransitionQuotation,
  normalizeCurrency,
} from './quotation-lifecycle';

describe('commercial quotation lifecycle and decimal pricing', () => {
  it('allows only the documented quotation status transitions', () => {
    expect(canTransitionQuotation('DRAFT', 'PENDING_APPROVAL')).toBe(true);
    expect(canTransitionQuotation('DRAFT', 'APPROVED')).toBe(true);
    expect(canTransitionQuotation('PENDING_APPROVAL', 'REJECTED')).toBe(true);
    expect(canTransitionQuotation('ACCEPTED', 'CONVERTED')).toBe(true);
    expect(canTransitionQuotation('CONVERTED', 'DRAFT')).toBe(false);
    expect(canTransitionQuotation('SENT', 'APPROVED')).toBe(false);
    expect(canTransitionQuotation('ACCEPTED', 'CANCELLED')).toBe(false);
  });

  it('calculates subtotal, discount, tax and total using fixed decimal arithmetic', () => {
    const result = calculateCommercialLines([
      {
        line_number: 1,
        product_code: 'SKU-1',
        product_name: 'Fabric',
        quantity: 10,
        unit: 'M',
        unit_price: 12.5,
        discount_percent: 5,
        tax_percent: 7.5,
      },
    ], 0, 10);

    expect(result.lines[0]?.line_subtotal).toBe('125.0000');
    expect(result.lines[0]?.line_discount).toBe('6.2500');
    expect(result.lines[0]?.line_tax).toBe('8.9063');
    expect(result.lines[0]?.line_total).toBe('127.6563');
    expect(result.totals.total_scaled).toBe(1276563n);
  });

  it('rejects discounts above the active rule cap', () => {
    expect(() => calculateCommercialLines([
      {
        line_number: 1, product_code: 'SKU-1', product_name: 'Fabric', quantity: 2,
        unit: 'M', unit_price: 20, discount_percent: 10.01,
      },
    ], 0, 10)).toThrow('Line discount exceeds the active pricing rule maximum');
  });

  it('rejects duplicate line numbers and non-positive quantities', () => {
    expect(() => calculateCommercialLines([
      { line_number: 1, product_code: 'A', product_name: 'A', quantity: 1, unit: 'PCS', unit_price: 1 },
      { line_number: 1, product_code: 'B', product_name: 'B', quantity: 1, unit: 'PCS', unit_price: 1 },
    ], 0, 0)).toThrow('Quotation line numbers must be unique');

    expect(() => calculateCommercialLines([
      { line_number: 1, product_code: 'A', product_name: 'A', quantity: 0, unit: 'PCS', unit_price: 1 },
    ], 0, 0)).toThrow('Line quantity must be greater than zero');
  });

  it('normalizes currency codes and rejects malformed values', () => {
    expect(normalizeCurrency('usd')).toBe('USD');
    expect(() => normalizeCurrency('US')).toThrow('three-letter currency code');
    expect(() => normalizeCurrency('U1D')).toThrow('three-letter currency code');
  });
});
