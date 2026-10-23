import { createHash } from 'node:crypto';

export const RESEARCH_DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;
export const RESEARCH_DOCUMENT_MAX_PARSED_BYTES = 1024 * 1024;
export const RESEARCH_DOCUMENT_PARSER_VERSION = 'factoryos-text-parser.v1';
export const RESEARCH_DOCUMENT_MEDIA_TYPES = [
  'text/plain',
  'text/csv',
  'text/markdown',
  'text/html',
  'application/json',
] as const;

export type ResearchDocumentMediaType = (typeof RESEARCH_DOCUMENT_MEDIA_TYPES)[number];

export interface ParsedResearchDocument {
  mediaType: ResearchDocumentMediaType;
  extractedText: string;
  normalizedText: string;
  contentSha256: string;
  extractedTextSha256: string;
  normalizedTextSha256: string;
  textSignature: string[];
}

function hash(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d{1,7});/g, (_match, decimal: string) => {
      const codePoint = Number(decimal);
      return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : ' ';
    })
    .replace(/&#x([0-9a-f]{1,6});/gi, (_match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : ' ';
    });
}

function parseHtml(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<!--([\s\S]*?)-->/g, ' ')
      .replace(/<(script|style|iframe|object|embed|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<(br|hr|p|div|li|tr|h[1-6])\b[^>]*>/gi, '\n')
      .replace(/<[^>]*>/g, ' '),
  );
}

function buildSignature(normalizedText: string): string[] {
  const tokens = normalizedText.split(' ').filter(Boolean).slice(0, 20_000);
  if (tokens.length === 0) return [];
  const shingles = new Set<string>();
  if (tokens.length < 5) {
    shingles.add(tokens.join(' '));
  } else {
    for (let index = 0; index <= tokens.length - 5; index += 1) {
      shingles.add(tokens.slice(index, index + 5).join(' '));
    }
  }

  const signature = Array<string>(16).fill('f'.repeat(16));
  for (const shingle of shingles) {
    for (let slot = 0; slot < signature.length; slot += 1) {
      const digest = hash(`${slot}:${shingle}`).slice(0, 16);
      if (digest < signature[slot]) signature[slot] = digest;
    }
  }
  return signature;
}

export function researchTextSignatureSimilarity(left: unknown, right: unknown): number {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== 16 || right.length !== 16) {
    return 0;
  }
  let compared = 0;
  let equal = 0;
  for (let index = 0; index < 16; index += 1) {
    const a = left[index];
    const b = right[index];
    if (typeof a !== 'string' || typeof b !== 'string') return 0;
    if (a === 'f'.repeat(16) || b === 'f'.repeat(16)) continue;
    compared += 1;
    if (a === b) equal += 1;
  }
  return compared ? Number((equal / compared).toFixed(4)) : 0;
}

export function parseResearchDocument(
  input: Buffer,
  requestedMediaType: string,
): ParsedResearchDocument {
  const mediaType = requestedMediaType.split(';', 1)[0].trim().toLowerCase();
  if (!RESEARCH_DOCUMENT_MEDIA_TYPES.includes(mediaType as ResearchDocumentMediaType)) {
    throw new Error('RESEARCH_DOCUMENT_MEDIA_TYPE_UNSUPPORTED');
  }
  if (input.length < 1 || input.length > RESEARCH_DOCUMENT_MAX_BYTES) {
    throw new Error('RESEARCH_DOCUMENT_SIZE_OUT_OF_RANGE');
  }
  if (input.subarray(0, 5).toString('ascii') === '%PDF-') {
    throw new Error('RESEARCH_DOCUMENT_BINARY_PDF_REQUIRES_APPROVED_PDF_PARSER');
  }
  if (input.subarray(0, 2).toString('ascii') === 'PK') {
    throw new Error('RESEARCH_DOCUMENT_ARCHIVE_FORMAT_UNSUPPORTED');
  }

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(input).replace(/^\uFEFF/, '');
  } catch {
    throw new Error('RESEARCH_DOCUMENT_UTF8_INVALID');
  }
  if (decoded.includes('\0')) throw new Error('RESEARCH_DOCUMENT_BINARY_CONTENT_REJECTED');

  let extractedText: string;
  if (mediaType === 'application/json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      throw new Error('RESEARCH_DOCUMENT_JSON_INVALID');
    }
    extractedText = JSON.stringify(parsed, null, 2);
  } else if (mediaType === 'text/html') {
    extractedText = parseHtml(decoded);
  } else {
    extractedText = decoded.replace(/\r\n?/g, '\n');
  }

  extractedText = extractedText.trim();
  if (!extractedText) throw new Error('RESEARCH_DOCUMENT_TEXT_EMPTY');
  if (Buffer.byteLength(extractedText, 'utf8') > RESEARCH_DOCUMENT_MAX_PARSED_BYTES) {
    throw new Error('RESEARCH_DOCUMENT_PARSED_TEXT_TOO_LARGE');
  }

  const normalizedText = extractedText
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalizedText) throw new Error('RESEARCH_DOCUMENT_NORMALIZED_TEXT_EMPTY');

  return {
    mediaType: mediaType as ResearchDocumentMediaType,
    extractedText,
    normalizedText,
    contentSha256: hash(input),
    extractedTextSha256: hash(extractedText),
    normalizedTextSha256: hash(normalizedText),
    textSignature: buildSignature(normalizedText),
  };
}
