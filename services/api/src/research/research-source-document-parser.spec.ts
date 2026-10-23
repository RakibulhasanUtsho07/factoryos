import {
  parseResearchDocument,
  researchTextSignatureSimilarity,
} from './research-source-document-parser';

describe('research source document parser', () => {
  it('parses plain text and creates stable byte, text and normalized-text fingerprints', () => {
    const bytes = Buffer.from(' FactoryOS research\r\nLine two. ', 'utf8');
    const parsed = parseResearchDocument(bytes, 'text/plain; charset=utf-8');

    expect(parsed.mediaType).toBe('text/plain');
    expect(parsed.extractedText).toBe('FactoryOS research\nLine two.');
    expect(parsed.normalizedText).toBe('factoryos research line two.');
    expect(parsed.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.extractedTextSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.normalizedTextSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.textSignature).toHaveLength(16);
  });

  it('removes script/style blocks and decodes common HTML entities before indexing', () => {
    const parsed = parseResearchDocument(
      Buffer.from('<h1>Material &amp; quality</h1><script>exfiltrate secrets</script><p>Safe text</p>', 'utf8'),
      'text/html',
    );

    expect(parsed.extractedText).toContain('Material & quality');
    expect(parsed.extractedText).toContain('Safe text');
    expect(parsed.extractedText).not.toContain('exfiltrate secrets');
  });

  it('validates JSON before normalizing the extracted object text', () => {
    const parsed = parseResearchDocument(Buffer.from('{"claims":[{"id":1}]}', 'utf8'), 'application/json');
    expect(JSON.parse(parsed.extractedText)).toEqual({ claims: [{ id: 1 }] });
    expect(() => parseResearchDocument(Buffer.from('{broken', 'utf8'), 'application/json'))
      .toThrow('RESEARCH_DOCUMENT_JSON_INVALID');
  });

  it('rejects unsupported formats, PDF bytes, invalid UTF-8 and oversized files explicitly', () => {
    expect(() => parseResearchDocument(Buffer.from('x'), 'application/pdf'))
      .toThrow('RESEARCH_DOCUMENT_MEDIA_TYPE_UNSUPPORTED');
    expect(() => parseResearchDocument(Buffer.from('%PDF-1.7 body'), 'text/plain'))
      .toThrow('RESEARCH_DOCUMENT_BINARY_PDF_REQUIRES_APPROVED_PDF_PARSER');
    expect(() => parseResearchDocument(Buffer.from([0xff, 0xfe, 0xfd]), 'text/plain'))
      .toThrow('RESEARCH_DOCUMENT_UTF8_INVALID');
    expect(() => parseResearchDocument(Buffer.alloc(5 * 1024 * 1024 + 1, 65), 'text/plain'))
      .toThrow('RESEARCH_DOCUMENT_SIZE_OUT_OF_RANGE');
  });

  it('keeps exact normalized duplicates comparable without collapsing their provenance records', () => {
    const first = parseResearchDocument(Buffer.from('A controlled study of textile quality measures.', 'utf8'), 'text/plain');
    const sameText = parseResearchDocument(Buffer.from('  A CONTROLLED STUDY of textile quality measures.  ', 'utf8'), 'text/plain');

    expect(first.normalizedTextSha256).toBe(sameText.normalizedTextSha256);
    expect(researchTextSignatureSimilarity(first.textSignature, first.textSignature)).toBe(1);
    expect(researchTextSignatureSimilarity(first.textSignature, sameText.textSignature)).toBe(1);
    expect(researchTextSignatureSimilarity(first.textSignature, ['malformed'])).toBe(0);
  });
});
