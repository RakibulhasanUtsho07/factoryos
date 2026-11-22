const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUOTATION_STATUSES = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED", "SENT", "ACCEPTED", "CONVERTED", "CANCELLED", "EXPIRED"];

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function nonNegativeScaled(value, scale, field) {
  const source = clean(String(value ?? ""));
  const expression = new RegExp("^(?:0|[1-9]\\d*)(?:\\.(\\d{1," + scale + "}))?$");
  if (!expression.test(source)) {
    throw new Error(field + " must be a non-negative decimal with at most " + scale + " decimal places.");
  }
  const [whole, fraction = ""] = source.split(".");
  return BigInt(whole) * (10n ** BigInt(scale)) + BigInt(fraction.padEnd(scale, "0"));
}

function scaledString(value, scale) {
  const factor = 10n ** BigInt(scale);
  const whole = value / factor;
  const fraction = String(value % factor).padStart(scale, "0");
  return whole.toString() + (scale ? "." + fraction : "");
}

function roundDivide(numerator, denominator) {
  if (denominator <= 0n) throw new Error("Calculation denominator must be positive.");
  return (numerator + denominator / 2n) / denominator;
}

function percentScale(value, fallback, field) {
  const source = value === "" || value === null || value === undefined ? fallback : value;
  const scaled = nonNegativeScaled(source, 2, field);
  if (scaled > 10000n) throw new Error(field + " must be between 0 and 100.");
  return scaled;
}

function requiredText(value, field, max) {
  const result = clean(value);
  if (!result || result.length > max) {
    throw new Error(field + " is required and must be at most " + max + " characters.");
  }
  return result;
}

function optionalText(value, field, max) {
  const result = clean(value);
  if (result.length > max) throw new Error(field + " must be at most " + max + " characters.");
  return result;
}

function currency(value, field = "Currency") {
  const result = clean(value).toUpperCase();
  if (!/^[A-Z]{3}$/.test(result)) throw new Error(field + " must be a three-letter currency code.");
  return result;
}

function date(value, field) {
  const result = clean(value);
  if (!result) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new Error(field + " must be a valid date.");
  const parsed = new Date(result + "T00:00:00Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    throw new Error(field + " must be a valid calendar date.");
  }
  return result;
}

export function asCommercialRows(value, key = "items") {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    if (Array.isArray(value[key])) return value[key];
    if (Array.isArray(value.items)) return value.items;
    if (Array.isArray(value.lines)) return value.lines;
    if (Array.isArray(value.history)) return value.history;
  }
  return [];
}

export function resolveCurrentPricingRule(rules = [], customerReference = "", selectedRuleCode = "") {
  const customer = clean(customerReference).toLowerCase();
  const selected = clean(selectedRuleCode).toUpperCase();
  const eligible = rules.filter((rule) => rule.is_current === true
    && (!rule.customer_reference || String(rule.customer_reference).trim().toLowerCase() === customer));
  if (selected) return eligible.find((rule) => String(rule.rule_code).toUpperCase() === selected) ?? null;
  return eligible.find((rule) => String(rule.customer_reference ?? "").trim() !== "")
    ?? eligible.find((rule) => !rule.customer_reference)
    ?? null;
}

export function resolveExchangeRate(rates = [], sourceCurrency, baseCurrency, asOfDate) {
  const source = currency(sourceCurrency, "Quote currency");
  const base = currency(baseCurrency, "Base currency");
  if (source === base) return { rate_to_base: "1.0000000000", effective_on: asOfDate, source: "IDENTITY" };
  return rates
    .filter((rate) => String(rate.currency).toUpperCase() === source
      && String(rate.base_currency).toUpperCase() === base
      && String(rate.effective_on) <= asOfDate)
    .sort((a, b) => String(b.effective_on).localeCompare(String(a.effective_on)))
    [0] ?? null;
}

export function calculateQuotationPreview(lines, defaultTaxPercent = 0, maxDiscountPercent = 0, rateToBase = "1") {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error("Add at least one quotation line.");
  const defaultTax = percentScale(defaultTaxPercent, 0, "Default tax");
  const maxDiscount = percentScale(maxDiscountPercent, 0, "Maximum discount");
  const seen = new Set();
  let subtotal = 0n;
  let discounts = 0n;
  let taxes = 0n;
  let total = 0n;
  let maxLineDiscountPercent = 0n;
  const calculatedLines = lines.map((line, index) => {
    const lineNumber = Number(line.line_number ?? index + 1);
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || seen.has(lineNumber)) {
      throw new Error("Quotation line numbers must be unique positive integers.");
    }
    seen.add(lineNumber);
    const productCode = requiredText(line.product_code, "Product code", 100);
    const productName = requiredText(line.product_name, "Product name", 255);
    const unit = requiredText(line.unit, "Unit", 50);
    const quantity = nonNegativeScaled(line.quantity, 4, "Quantity");
    if (quantity <= 0n) throw new Error("Quantity must be greater than zero.");
    const price = nonNegativeScaled(line.unit_price, 4, "Unit price");
    const discount = percentScale(line.discount_percent, 0, "Discount");
    const tax = percentScale(line.tax_percent, scaledString(defaultTax, 2), "Tax");
    if (discount > maxDiscount) throw new Error("Line discount exceeds the active pricing rule maximum of " + scaledString(maxDiscount, 2) + "%.");
    const lineSubtotal = roundDivide(quantity * price, 10000n);
    const lineDiscount = roundDivide(lineSubtotal * discount, 10000n);
    const taxable = lineSubtotal - lineDiscount;
    const lineTax = roundDivide(taxable * tax, 10000n);
    const lineTotal = taxable + lineTax;
    subtotal += lineSubtotal;
    discounts += lineDiscount;
    taxes += lineTax;
    total += lineTotal;
    if (discount > maxLineDiscountPercent) maxLineDiscountPercent = discount;
    return {
      line_number: lineNumber,
      product_code: productCode,
      product_name: productName,
      quantity: scaledString(quantity, 4),
      unit,
      unit_price: scaledString(price, 4),
      discount_percent: scaledString(discount, 2),
      tax_percent: scaledString(tax, 2),
      line_subtotal: scaledString(lineSubtotal, 4),
      line_discount: scaledString(lineDiscount, 4),
      line_tax: scaledString(lineTax, 4),
      line_total: scaledString(lineTotal, 4),
      notes: optionalText(line.notes, "Line notes", 2000) || null,
    };
  });
  const rate = nonNegativeScaled(rateToBase, 10, "Exchange rate");
  if (rate <= 0n) throw new Error("Exchange rate must be greater than zero.");
  const totalBase = roundDivide(total * rate, 10_000_000_000n);
  return {
    lines: calculatedLines,
    totals: {
      subtotal: scaledString(subtotal, 4),
      discount_total: scaledString(discounts, 4),
      tax_total: scaledString(taxes, 4),
      total: scaledString(total, 4),
      total_base: scaledString(totalBase, 4),
    },
    max_line_discount_percent: scaledString(maxLineDiscountPercent, 2),
  };
}

function normalizeLines(lines) {
  const calculated = calculateQuotationPreview(lines, 0, 100).lines;
  return calculated.map((line, index) => {
    const source = lines[index] ?? {};
    const discount = clean(String(source.discount_percent ?? ""));
    const tax = clean(String(source.tax_percent ?? ""));
    return {
      line_number: line.line_number,
      product_code: line.product_code,
      product_name: line.product_name,
      quantity: Number(line.quantity),
      unit: line.unit,
      unit_price: Number(line.unit_price),
      ...(discount ? { discount_percent: Number(line.discount_percent) } : {}),
      ...(tax ? { tax_percent: Number(line.tax_percent) } : {}),
      ...(line.notes ? { notes: line.notes } : {}),
    };
  });
}

export function buildQuotationPayload(input, factoryId) {
  const id = clean(factoryId);
  if (!UUID.test(id)) throw new Error("An authenticated active factory is required.");
  const lines = normalizeLines(input.lines);
  const payload = {
    factory_id: id,
    quote_number: requiredText(input.quote_number, "Quote number", 100),
    customer_name: requiredText(input.customer_name, "Customer name", 255),
    lines,
  };
  const customerReference = optionalText(input.customer_reference, "Customer reference", 255);
  const quoteCurrency = currency(input.currency || "BDT");
  const ruleCode = optionalText(input.pricing_rule_code, "Pricing rule code", 80);
  const delivery = date(input.requested_delivery_date, "Requested delivery date");
  const validUntil = date(input.valid_until, "Valid until");
  const incoterms = optionalText(input.incoterms, "Incoterms", 80);
  const paymentTerms = optionalText(input.payment_terms, "Payment terms", 255);
  const notes = optionalText(input.notes, "Quotation notes", 4000);
  if (customerReference) payload.customer_reference = customerReference;
  if (quoteCurrency !== "BDT" || input.currency) payload.currency = quoteCurrency;
  if (ruleCode) payload.pricing_rule_code = ruleCode;
  if (delivery) payload.requested_delivery_date = delivery;
  if (validUntil) payload.valid_until = validUntil;
  if (incoterms) payload.incoterms = incoterms;
  if (paymentTerms) payload.payment_terms = paymentTerms;
  if (notes) payload.notes = notes;
  return payload;
}

export function buildQuotationRevisionPayload(input, quote) {
  const expectedVersion = Number(quote.version);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new Error("The selected quotation has an invalid version; refresh it before revising.");
  }
  const reason = requiredText(input.reason, "Revision reason", 1000);
  const lines = normalizeLines(input.lines);
  const payload = { expected_version: expectedVersion, reason, lines };
  const quoteCurrency = currency(input.currency || quote.currency || "BDT");
  if (quoteCurrency !== String(quote.currency).toUpperCase()) payload.currency = quoteCurrency;
  const ruleCode = optionalText(input.pricing_rule_code, "Pricing rule code", 80);
  if (ruleCode) payload.pricing_rule_code = ruleCode;
  else if (input.clear_pricing_rule === true) payload.pricing_rule_code = "DEFAULT_BDT";
  const delivery = date(input.requested_delivery_date, "Requested delivery date");
  const validUntil = date(input.valid_until, "Valid until");
  if (input.requested_delivery_date !== undefined) payload.requested_delivery_date = delivery ?? null;
  if (input.valid_until !== undefined) payload.valid_until = validUntil ?? null;
  if (input.incoterms !== undefined) payload.incoterms = optionalText(input.incoterms, "Incoterms", 80) || null;
  if (input.payment_terms !== undefined) payload.payment_terms = optionalText(input.payment_terms, "Payment terms", 255) || null;
  if (input.notes !== undefined) payload.notes = optionalText(input.notes, "Quotation notes", 4000) || null;
  return payload;
}

export function buildQuotationTransitionPayload(input, quote) {
  const expectedVersion = Number(quote.version);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new Error("The selected quotation has an invalid version; refresh it before changing its status.");
  }
  return {
    expected_version: expectedVersion,
    reason: requiredText(input.reason, "Decision reason", 1000),
  };
}

export function buildQuotationConversionPayload(input, quote) {
  return {
    ...buildQuotationTransitionPayload(input, quote),
    order_number: requiredText(input.order_number, "New order number", 100),
  };
}

export function buildPricingRulePayload(input, factoryId) {
  const id = clean(factoryId);
  if (!UUID.test(id)) throw new Error("An authenticated active factory is required.");
  const ruleCode = requiredText(input.rule_code, "Rule code", 80).toUpperCase();
  const baseCurrency = currency(input.base_currency || "BDT", "Base currency");
  const allowedCurrencies = [...new Set(String(input.allowed_currencies ?? "")
    .split(",").map((value) => currency(value, "Allowed currency")))];
  if (!allowedCurrencies.length || !allowedCurrencies.includes(baseCurrency)) {
    throw new Error("Allowed currencies must include the pricing rule base currency.");
  }
  const customerReference = optionalText(input.customer_reference, "Customer reference", 255);
  const approvalThreshold = clean(String(input.approval_total_threshold ?? ""));
  const payload = {
    factory_id: id,
    rule_code: ruleCode,
    base_currency: baseCurrency,
    allowed_currencies: allowedCurrencies,
    default_tax_percent: Number(percentScale(input.default_tax_percent ?? 0, 0, "Default tax")) / 100,
    max_discount_percent: Number(percentScale(input.max_discount_percent ?? 0, 0, "Maximum discount")) / 100,
    approval_required: input.approval_required !== false,
    approval_discount_threshold_percent: Number(percentScale(input.approval_discount_threshold_percent ?? 0, 0, "Approval discount threshold")) / 100,
    incoterms_required: input.incoterms_required === true,
    payment_terms_required: input.payment_terms_required === true,
  };
  if (customerReference) payload.customer_reference = customerReference;
  if (approvalThreshold) payload.approval_total_threshold = Number(nonNegativeScaled(approvalThreshold, 4, "Approval total threshold")) / 10000;
  return payload;
}

export function buildExchangeRatePayload(input, factoryId) {
  const id = clean(factoryId);
  if (!UUID.test(id)) throw new Error("An authenticated active factory is required.");
  const quoteCurrency = currency(input.currency, "Source currency");
  const baseCurrency = currency(input.base_currency, "Base currency");
  if (quoteCurrency === baseCurrency) throw new Error("Source and base currencies must differ.");
  const rate = nonNegativeScaled(input.rate_to_base, 10, "Exchange rate");
  if (rate <= 0n) throw new Error("Exchange rate must be greater than zero.");
  const effectiveOn = date(input.effective_on, "Effective date");
  if (!effectiveOn) throw new Error("An effective date is required.");
  const source = requiredText(input.source, "Exchange-rate source", 120);
  return {
    factory_id: id,
    currency: quoteCurrency,
    base_currency: baseCurrency,
    rate_to_base: Number(scaledString(rate, 10)),
    effective_on: effectiveOn,
    source,
  };
}

export function filterQuotations(rows = [], search = "", status = "ALL") {
  const query = clean(search).toLowerCase();
  const wanted = clean(status).toUpperCase();
  return rows.filter((quote) => {
    if (wanted !== "ALL" && String(quote.status).toUpperCase() !== wanted) return false;
    if (!query) return true;
    return [
      quote.quote_number, quote.customer_name, quote.customer_reference,
      quote.status, quote.converted_order_id,
    ].some((value) => String(value ?? "").toLowerCase().includes(query));
  });
}

export function summarizeQuotations(rows = []) {
  const result = {
    total: rows.length, draft: 0, pendingApproval: 0, approved: 0,
    sent: 0, accepted: 0, converted: 0, rejected: 0, cancelled: 0, expired: 0,
  };
  const fieldByStatus = {
    DRAFT: "draft", PENDING_APPROVAL: "pendingApproval", APPROVED: "approved",
    SENT: "sent", ACCEPTED: "accepted", CONVERTED: "converted",
    REJECTED: "rejected", CANCELLED: "cancelled", EXPIRED: "expired",
  };
  for (const quote of rows) {
    const field = fieldByStatus[String(quote.status).toUpperCase()];
    if (field) result[field] += 1;
  }
  return result;
}

export function quotationStatusLabel(value) {
  const status = clean(value).toUpperCase();
  return status ? status.replaceAll("_", " ") : "UNKNOWN";
}
