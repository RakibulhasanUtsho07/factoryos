export const QUOTATION_STATUSES = [
  'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SENT', 'ACCEPTED', 'CONVERTED', 'CANCELLED', 'EXPIRED',
] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];

const transitions: Record<QuotationStatus, readonly QuotationStatus[]> = {
  DRAFT: ['PENDING_APPROVAL', 'APPROVED', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['SENT', 'CANCELLED'],
  REJECTED: ['DRAFT', 'CANCELLED'],
  SENT: ['ACCEPTED', 'CANCELLED', 'EXPIRED'],
  ACCEPTED: ['CONVERTED', 'EXPIRED'],
  CONVERTED: [],
  CANCELLED: [],
  EXPIRED: [],
};
export function canTransitionQuotation(from: QuotationStatus, to: QuotationStatus): boolean {
  return transitions[from].includes(to);
}
export function normalizeCurrency(value: string, field = 'currency'): string {
  const result = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(result)) throw new RangeError(field + ' must be a three-letter currency code');
  return result;
}
export function decimalScaled(value: string | number, scale: number): bigint {
  const raw = typeof value === 'number' ? value.toFixed(scale) : value.trim();
  if (!Number.isFinite(Number(raw)) || !/^\d+(?:\.\d+)?$/.test(raw)) {
    throw new RangeError('Value must be a finite non-negative decimal');
  }
  const parts = raw.split('.');
  const whole = parts[0] ?? '0';
  const fraction = parts[1] ?? '';
  if (fraction.length > scale) throw new RangeError('Decimal precision exceeds supported scale');
  const factor = 10n ** BigInt(scale);
  return BigInt(whole) * factor + BigInt((fraction + '0'.repeat(scale)).slice(0, scale) || '0');
}
export function formatScaled(value: bigint, scale: number): string {
  const factor = 10n ** BigInt(scale);
  const absolute = value < 0n ? -value : value;
  const whole = absolute / factor;
  const fraction = (absolute % factor).toString().padStart(scale, '0');
  return (value < 0n ? '-' : '') + whole.toString() + (scale ? '.' + fraction : '');
}
function roundDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('denominator must be positive');
  return (numerator + denominator / 2n) / denominator;
}
export interface CommercialLineInput {
  line_number: number; product_code: string; product_name: string; quantity: number; unit: string;
  unit_price: number; discount_percent?: number; tax_percent?: number; notes?: string;
}
export interface CommercialLineCalculation {
  line_number: number; product_code: string; product_name: string; quantity: string; unit: string;
  unit_price: string; discount_percent: string; tax_percent: string; line_subtotal: string;
  line_discount: string; line_tax: string; line_total: string; notes: string | null;
  subtotal_scaled: bigint; discount_scaled: bigint; tax_scaled: bigint; total_scaled: bigint;
}
export function calculateCommercialLines(
  lines: CommercialLineInput[], defaultTaxPercent: number, maxDiscountPercent: number,
) {
  if (!Array.isArray(lines) || lines.length === 0) throw new RangeError('At least one quotation line is required');
  if (new Set(lines.map((line) => line.line_number)).size !== lines.length) {
    throw new RangeError('Quotation line numbers must be unique');
  }
  const maxAllowed = decimalScaled(maxDiscountPercent, 2);
  let subtotal = 0n; let discounts = 0n; let taxes = 0n; let total = 0n; let maxLineDiscountPercent = 0;
  const calculated: CommercialLineCalculation[] = lines.map((line) => {
    if (!Number.isSafeInteger(line.line_number) || line.line_number < 1) throw new RangeError('line_number must be a positive integer');
    if (!line.product_code.trim() || !line.product_name.trim() || !line.unit.trim()) {
      throw new RangeError('Each line requires product_code, product_name and unit');
    }
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) throw new RangeError('Line quantity must be greater than zero');
    if (!Number.isFinite(line.unit_price) || line.unit_price < 0) throw new RangeError('Unit price must not be negative');
    const qty = decimalScaled(line.quantity, 4);
    const price = decimalScaled(line.unit_price, 4);
    const discount = line.discount_percent ?? 0;
    const tax = line.tax_percent ?? defaultTaxPercent;
    if (!Number.isFinite(discount) || discount < 0 || discount > 100) throw new RangeError('Discount must be between 0 and 100 percent');
    if (!Number.isFinite(tax) || tax < 0 || tax > 100) throw new RangeError('Tax must be between 0 and 100 percent');
    const discountScaled = decimalScaled(discount, 2);
    const taxScaled = decimalScaled(tax, 2);
    if (discountScaled > maxAllowed) throw new RangeError('Line discount exceeds the active pricing rule maximum');
    const lineSubtotal = roundDivide(qty * price, 10000n);
    const lineDiscount = roundDivide(lineSubtotal * discountScaled, 10000n);
    const taxable = lineSubtotal - lineDiscount;
    const lineTax = roundDivide(taxable * taxScaled, 10000n);
    const lineTotal = taxable + lineTax;
    subtotal += lineSubtotal; discounts += lineDiscount; taxes += lineTax; total += lineTotal;
    maxLineDiscountPercent = Math.max(maxLineDiscountPercent, discount);
    return {
      line_number: line.line_number, product_code: line.product_code.trim(), product_name: line.product_name.trim(),
      quantity: formatScaled(qty, 4), unit: line.unit.trim(), unit_price: formatScaled(price, 4),
      discount_percent: formatScaled(discountScaled, 2), tax_percent: formatScaled(taxScaled, 2),
      line_subtotal: formatScaled(lineSubtotal, 4), line_discount: formatScaled(lineDiscount, 4),
      line_tax: formatScaled(lineTax, 4), line_total: formatScaled(lineTotal, 4), notes: line.notes?.trim() || null,
      subtotal_scaled: lineSubtotal, discount_scaled: lineDiscount, tax_scaled: lineTax, total_scaled: lineTotal,
    };
  });
  return {
    lines: calculated, maxLineDiscountPercent,
    totals: { subtotal_scaled: subtotal, discount_scaled: discounts, tax_scaled: taxes, total_scaled: total },
  };
}
export function convertAmountToBase(totalScaled: bigint, rate: string | number): string {
  return formatScaled(roundDivide(totalScaled * decimalScaled(rate, 10), 10_000_000_000n), 4);
}
