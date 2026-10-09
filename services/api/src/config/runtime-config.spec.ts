import { resolveCorsOrigins, resolveSwaggerEnabled } from './runtime-config';

describe('runtime configuration', () => {
  describe('resolveCorsOrigins', () => {
    it('defaults to localhost during development', () => {
      expect(resolveCorsOrigins('development')).toEqual(['http://localhost:3000']);
    });

    it('requires explicit origins in production', () => {
      expect(() => resolveCorsOrigins('production')).toThrow(/CORS_ORIGINS must be configured/);
    });

    it('accepts exact HTTPS origins in production', () => {
      expect(resolveCorsOrigins('production', 'https://app.example.com,https://admin.example.com'))
        .toEqual(['https://app.example.com', 'https://admin.example.com']);
    });

    it.each([
      '*',
      'https://app.example.com/path',
      'http://app.example.com',
      'https://user:password@app.example.com',
      'https://app.example.com,',
    ])('rejects unsafe production origin configuration: %s', (origins) => {
      expect(() => resolveCorsOrigins('production', origins)).toThrow();
    });

    it('deduplicates origins', () => {
      expect(resolveCorsOrigins('development', 'http://localhost:3000,http://localhost:3000'))
        .toEqual(['http://localhost:3000']);
    });
  });

  describe('resolveSwaggerEnabled', () => {
    it('defaults off in production and on outside production', () => {
      expect(resolveSwaggerEnabled('production')).toBe(false);
      expect(resolveSwaggerEnabled('development')).toBe(true);
    });

    it('honors explicit true/false values', () => {
      expect(resolveSwaggerEnabled('production', 'true')).toBe(true);
      expect(resolveSwaggerEnabled('development', 'false')).toBe(false);
    });

    it('rejects invalid values', () => {
      expect(() => resolveSwaggerEnabled('production', 'sometimes')).toThrow(/SWAGGER_ENABLED/);
    });
  });
});
