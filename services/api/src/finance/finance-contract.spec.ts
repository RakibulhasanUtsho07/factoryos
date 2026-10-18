import { describe, expect, it } from '@jest/globals';
import {
  assertFactCompatibleWithDomain,
  financeRequestHash,
  isPositionFactType,
  normalizeFinanceCurrency,
  normalizeFinanceDecimal,
  reconciliationMatches,
  validateFinanceEndpoint,
  validateFinanceSecretReference,
} from './finance-contract';

describe('finance integration contract', () => {
  it('normalizes currency codes while rejecting non ISO-shaped identifiers', () => {
    expect(normalizeFinanceCurrency(' bdt ')).toBe('BDT');
    expect(() => normalizeFinanceCurrency('BDTK')).toThrow('FINANCE_CURRENCY_MUST_BE_ISO_4217_CODE');
    expect(() => normalizeFinanceCurrency('12$')).toThrow('FINANCE_CURRENCY_MUST_BE_ISO_4217_CODE');
  });

  it('preserves exact decimal precision without accepting exponents or excess scale', () => {
    expect(normalizeFinanceDecimal('0.00050000')).toBe('0.0005');
    expect(normalizeFinanceDecimal('-12.340000', { allowNegative: true })).toBe('-12.34');
    expect(() => normalizeFinanceDecimal('1e-8')).toThrow('FINANCE_DECIMAL_INVALID');
    expect(() => normalizeFinanceDecimal('1.00001', { maxFractionDigits: 4 })).toThrow('FINANCE_DECIMAL_SCALE_EXCEEDED');
    expect(() => normalizeFinanceDecimal('-1')).toThrow('FINANCE_DECIMAL_INVALID');
  });

  it('compares quantity and rate deltas against independent decimal tolerances', () => {
    expect(reconciliationMatches('5.001', '5', '0.001', '2.5', '2.4', '0.1')).toBe(true);
    expect(reconciliationMatches('5.002', '5', '0.001', '2.5', '2.4', '0.1')).toBe(false);
    expect(reconciliationMatches('1', '1', '0', '1', '1.00000001', '0')).toBe(false);
  });

  it('requires a fact type to be supported by its source system domain', () => {
    expect(() => assertFactCompatibleWithDomain('AP', 'AP_OPEN')).not.toThrow();
    expect(() => assertFactCompatibleWithDomain('BANK_RECONCILIATION', 'BANK_BALANCE')).not.toThrow();
    expect(() => assertFactCompatibleWithDomain('AP', 'ACTUAL_REVENUE')).toThrow(
      'FINANCE_FACT_TYPE_NOT_ALLOWED_FOR_CONNECTOR_DOMAIN',
    );
    expect(() => assertFactCompatibleWithDomain('CUSTOM', 'ACTUAL_REVENUE')).not.toThrow();
  });

  it('distinguishes dated balance positions from additive actual events', () => {
    expect(isPositionFactType('AR_OPEN')).toBe(true);
    expect(isPositionFactType('FORECAST_COST')).toBe(true);
    expect(isPositionFactType('ACTUAL_COST')).toBe(false);
    expect(isPositionFactType('ACTUAL_REVENUE')).toBe(false);
  });

  it('hashes logically equivalent objects independent of property ordering', () => {
    expect(financeRequestHash({ b: 2, a: { d: true, c: 1 } }))
      .toBe(financeRequestHash({ a: { c: 1, d: true }, b: 2 }));
    expect(financeRequestHash({ amount: '1.00' })).not.toBe(financeRequestHash({ amount: '1' }));
  });

  it('accepts only secret-manager references, never inline secrets', () => {
    expect(validateFinanceSecretReference('vault://factoryos/prod/gl')).toBe('vault://factoryos/prod/gl');
    expect(validateFinanceSecretReference(null)).toBeNull();
    expect(() => validateFinanceSecretReference('super-secret-value')).toThrow(
      'FINANCE_SECRET_MUST_BE_A_VAULT_REFERENCE',
    );
  });

  it('requires TLS endpoints without embedded credentials for live connectors', () => {
    expect(validateFinanceEndpoint('REST_API', 'https://finance.example.com/api')).toBe(
      'https://finance.example.com/api',
    );
    expect(() => validateFinanceEndpoint('REST_API', null)).toThrow('FINANCE_CONNECTOR_ENDPOINT_REQUIRED');
    expect(() => validateFinanceEndpoint('WEBHOOK', 'http://finance.example.com')).toThrow(
      'FINANCE_CONNECTOR_ENDPOINT_MUST_BE_HTTPS_WITHOUT_EMBEDDED_CREDENTIALS',
    );
    expect(() => validateFinanceEndpoint('REST_API', 'https://user:password@finance.example.com')).toThrow(
      'FINANCE_CONNECTOR_ENDPOINT_MUST_BE_HTTPS_WITHOUT_EMBEDDED_CREDENTIALS',
    );
    expect(() => validateFinanceEndpoint('REST_API', 'https://finance.example.com/api?api_key=inline-secret')).toThrow(
      'FINANCE_CONNECTOR_ENDPOINT_MUST_NOT_CONTAIN_CREDENTIAL_QUERY_PARAMETERS',
    );
  });
});
