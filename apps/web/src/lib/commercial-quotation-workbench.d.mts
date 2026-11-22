export type QuotationStatus = "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "SENT" | "ACCEPTED" | "CONVERTED" | "CANCELLED" | "EXPIRED";

export interface QuotationLine {
  id?: string;
  line_number: number;
  product_code: string;
  product_name: string;
  quantity: string | number;
  unit: string;
  unit_price: string | number;
  discount_percent?: string | number;
  tax_percent?: string | number;
  line_subtotal?: string;
  line_discount?: string;
  line_tax?: string;
  line_total?: string;
  notes?: string | null;
}

export interface CommercialQuotation {
  id: string;
  quote_number: string;
  customer_name: string;
  customer_reference: string | null;
  status: QuotationStatus;
  current_revision: number;
  version: string;
  converted_order_id?: string | null;
  currency: string;
  base_currency: string;
  exchange_rate_to_base: string;
  exchange_rate_as_of: string;
  exchange_rate_source: string;
  requested_delivery_date?: string | null;
  valid_until?: string | null;
  incoterms?: string | null;
  payment_terms?: string | null;
  notes?: string | null;
  subtotal: string;
  discount_total: string;
  tax_total: string;
  total: string;
  total_base: string;
  approval_required: boolean;
  approval_total_threshold?: string | null;
  approval_discount_threshold_percent: string;
  pricing_rule_code: string;
  pricing_rule_version?: number | null;
  pricing_rule_snapshot: Record<string, unknown>;
  lines: QuotationLine[];
  history: QuotationHistory[];
  created_by_user_id: string;
  updated_by_user_id: string;
  last_change_reason: string;
  created_at: string;
  updated_at: string;
}

export interface QuotationHistory {
  id: string;
  revision_number: number;
  from_status?: string | null;
  to_status: string;
  action: string;
  actor_user_id: string;
  reason: string;
  order_id?: string | null;
  details?: Record<string, unknown>;
  created_at: string;
}

export interface PricingRule {
  id: string;
  rule_code: string;
  customer_reference?: string | null;
  version: number;
  base_currency: string;
  allowed_currencies: string[];
  default_tax_percent: string;
  max_discount_percent: string;
  approval_required: boolean;
  approval_total_threshold?: string | null;
  approval_discount_threshold_percent: string;
  incoterms_required: boolean;
  payment_terms_required: boolean;
  is_current: boolean;
  created_at: string;
}

export interface ExchangeRate {
  id: string;
  currency: string;
  base_currency: string;
  rate_to_base: string;
  effective_on: string;
  source: string;
  created_at: string;
}

export interface QuotationListItem {
  id: string;
  quote_number: string;
  customer_name: string;
  customer_reference?: string | null;
  status: QuotationStatus;
  current_revision: number;
  version: string;
  converted_order_id?: string | null;
  currency: string;
  total: string;
  base_currency: string;
  total_base: string;
  created_at: string;
}

export interface QuotationPreviewLine {
  line_number: number; product_code: string; product_name: string; quantity: string; unit: string;
  unit_price: string; discount_percent: string; tax_percent: string; line_subtotal: string;
  line_discount: string; line_tax: string; line_total: string; notes: string | null;
}

export function asCommercialRows<T = Record<string, unknown>>(value: unknown, key?: string): T[];
export function resolveCurrentPricingRule(rules?: PricingRule[], customerReference?: string, selectedRuleCode?: string): PricingRule | null;
export function resolveExchangeRate(rates: ExchangeRate[], sourceCurrency: string, baseCurrency: string, asOfDate: string): ExchangeRate | { rate_to_base: string; effective_on: string; source: string } | null;
export function calculateQuotationPreview(lines: Array<Record<string, unknown>>, defaultTaxPercent?: string | number, maxDiscountPercent?: string | number, rateToBase?: string | number): {
  lines: QuotationPreviewLine[];
  totals: { subtotal: string; discount_total: string; tax_total: string; total: string; total_base: string };
  max_line_discount_percent: string;
};
export function buildQuotationPayload(input: Record<string, unknown>, factoryId: string): Record<string, unknown>;
export function buildQuotationRevisionPayload(input: Record<string, unknown>, quote: CommercialQuotation): Record<string, unknown>;
export function buildQuotationTransitionPayload(input: Record<string, unknown>, quote: CommercialQuotation): { expected_version: number; reason: string };
export function buildQuotationConversionPayload(input: Record<string, unknown>, quote: CommercialQuotation): { expected_version: number; reason: string; order_number: string };
export function buildPricingRulePayload(input: Record<string, unknown>, factoryId: string): Record<string, unknown>;
export function buildExchangeRatePayload(input: Record<string, unknown>, factoryId: string): Record<string, unknown>;
export function filterQuotations<T extends QuotationListItem>(rows: T[], search?: string, status?: string): T[];
export function summarizeQuotations(rows?: QuotationListItem[]): {
  total: number; draft: number; pendingApproval: number; approved: number; sent: number;
  accepted: number; converted: number; rejected: number; cancelled: number; expired: number;
};
export function quotationStatusLabel(value: string): string;
