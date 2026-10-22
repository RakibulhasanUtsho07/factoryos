import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

export type ResearchAuthenticityStatus =
  | 'VERIFIED'
  | 'REVIEW_REQUIRED'
  | 'MISMATCH'
  | 'NOT_FOUND'
  | 'UNSUPPORTED'
  | 'ERROR';

export type ResearchProvider = 'CROSSREF' | 'EUROPE_PMC' | 'NONE';

export interface ResearchSourceIdentity {
  doi?: string | null;
  title?: string | null;
  source_url?: string | null;
  source_metadata?: Record<string, unknown> | null;
}

export interface ResearchAuthenticityEvidence {
  provider: ResearchProvider;
  status: ResearchAuthenticityStatus;
  provider_record_id: string | null;
  canonical_doi: string | null;
  canonical_url: string | null;
  provider_title: string | null;
  title_similarity: number | null;
  response_sha256: string | null;
  reason_code: string;
  checked_at: string;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const PROVIDER_TIMEOUT_MS = 7_000;
const USER_AGENT = 'FactoryOS-Research-Source-Adapter/1.0';

export function normalizeResearchDoi(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.trim()
    .replace(/^doi:\s*/i, '')
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/[\s<>]+$/g, '')
    .toLowerCase();
  return /^10\.\d{4,9}\/[^\s?#]+$/i.test(cleaned) ? cleaned : null;
}

export function normalizeResearchTitle(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/&amp;/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function titleSimilarity(left: string, right: string): number | null {
  const a = normalizeResearchTitle(left);
  const b = normalizeResearchTitle(right);
  if (!a || !b) return null;
  if (a === b) return 1;
  const leftTokens = new Set(a.split(' ').filter(Boolean));
  const rightTokens = new Set(b.split(' ').filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  return Number((intersection / (leftTokens.size + rightTokens.size - intersection)).toFixed(4));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function readBoundedBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new Error('PROVIDER_RESPONSE_TOO_LARGE');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('PROVIDER_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(merged);
}

@Injectable()
export class ResearchSourceAdapterService {
  /**
   * Resolves source identity only against fixed, public metadata providers.
   * It intentionally never fetches source.source_url: that URL is untrusted
   * input and could otherwise introduce SSRF, redirect or credential leakage.
   */
  async verify(
    source: ResearchSourceIdentity,
    fetchImpl: FetchLike = globalThis.fetch,
  ): Promise<ResearchAuthenticityEvidence> {
    const checkedAt = new Date().toISOString();
    const doi = normalizeResearchDoi(source.doi);
    if (doi) return this.verifyCrossref(doi, source.title ?? '', fetchImpl, checkedAt);

    const pmid = this.pubmedId(source);
    if (pmid) return this.verifyEuropePmc(pmid, source.title ?? '', fetchImpl, checkedAt);

    return {
      provider: 'NONE',
      status: 'UNSUPPORTED',
      provider_record_id: null,
      canonical_doi: null,
      canonical_url: null,
      provider_title: null,
      title_similarity: null,
      response_sha256: null,
      reason_code: 'NO_SUPPORTED_PROVIDER_IDENTIFIER',
      checked_at: checkedAt,
    };
  }

  private async verifyCrossref(
    doi: string,
    expectedTitle: string,
    fetchImpl: FetchLike,
    checkedAt: string,
  ): Promise<ResearchAuthenticityEvidence> {
    try {
      const result = await this.fetchJson(
        `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
        fetchImpl,
      );
      const record = result.payload?.message;
      if (!record || typeof record !== 'object') {
        return this.failed('CROSSREF', 'NOT_FOUND', 'PROVIDER_RECORD_MISSING', checkedAt, result.sha256);
      }
      const returnedDoi = normalizeResearchDoi(String(record.DOI ?? ''));
      const providerTitle = Array.isArray(record.title) ? String(record.title[0] ?? '') : '';
      const similarity = titleSimilarity(expectedTitle, providerTitle);
      const identityMatches = returnedDoi === doi;
      const status = this.compareIdentity(identityMatches, similarity);
      return {
        provider: 'CROSSREF',
        status,
        provider_record_id: returnedDoi,
        canonical_doi: returnedDoi,
        canonical_url: typeof record.URL === 'string' ? record.URL : `https://doi.org/${doi}`,
        provider_title: providerTitle.slice(0, 1000) || null,
        title_similarity: similarity,
        response_sha256: result.sha256,
        reason_code: this.reasonFor(status, 'DOI'),
        checked_at: checkedAt,
      };
    } catch (error) {
      return this.failed('CROSSREF', 'ERROR', this.errorCode(error), checkedAt, null);
    }
  }

  private async verifyEuropePmc(
    pmid: string,
    expectedTitle: string,
    fetchImpl: FetchLike,
    checkedAt: string,
  ): Promise<ResearchAuthenticityEvidence> {
    try {
      const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=EXT_ID%3A${pmid}%20AND%20SRC%3AMED&format=json`;
      const result = await this.fetchJson(url, fetchImpl);
      const records = result.payload?.resultList?.result;
      const record = Array.isArray(records)
        ? records.find((item: Record<string, unknown>) => String(item.pmid ?? '') === pmid)
        : null;
      if (!record || typeof record !== 'object') {
        return this.failed('EUROPE_PMC', 'NOT_FOUND', 'PUBMED_RECORD_MISSING', checkedAt, result.sha256);
      }
      const returnedDoi = normalizeResearchDoi(String(record.doi ?? ''));
      const providerTitle = typeof record.title === 'string' ? record.title : '';
      const similarity = titleSimilarity(expectedTitle, providerTitle);
      const status = this.compareIdentity(String(record.pmid ?? '') === pmid, similarity);
      return {
        provider: 'EUROPE_PMC',
        status,
        provider_record_id: `PMID:${pmid}`,
        canonical_doi: returnedDoi,
        canonical_url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
        provider_title: providerTitle.slice(0, 1000) || null,
        title_similarity: similarity,
        response_sha256: result.sha256,
        reason_code: this.reasonFor(status, 'PMID'),
        checked_at: checkedAt,
      };
    } catch (error) {
      return this.failed('EUROPE_PMC', 'ERROR', this.errorCode(error), checkedAt, null);
    }
  }

  private async fetchJson(url: string, fetchImpl: FetchLike) {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    });
    if (!response.ok) {
      if (response.status === 404) return { payload: null, sha256: null };
      throw new Error(`PROVIDER_HTTP_${response.status}`);
    }
    const text = await readBoundedBody(response);
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(text) as Record<string, any>;
    } catch {
      throw new Error('PROVIDER_INVALID_JSON');
    }
    return { payload, sha256: sha256(text) };
  }

  private pubmedId(source: ResearchSourceIdentity): string | null {
    const metadata = source.source_metadata ?? {};
    const metadataPmid = typeof metadata.pubmedId === 'string' || typeof metadata.pubmedId === 'number'
      ? String(metadata.pubmedId)
      : '';
    const url = source.source_url ?? '';
    const match = url.match(/^https?:\/\/(?:www\.)?pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)(?:\/|$)/i)
      ?? url.match(/^https?:\/\/(?:www\.)?ncbi\.nlm\.nih\.gov\/pubmed\/(\d+)(?:\/|$)/i);
    const value = match?.[1] ?? metadataPmid;
    return /^\d{1,12}$/.test(value) ? value : null;
  }

  private compareIdentity(identifierMatches: boolean, similarity: number | null): ResearchAuthenticityStatus {
    if (!identifierMatches) return 'MISMATCH';
    if (similarity === null) return 'REVIEW_REQUIRED';
    if (similarity >= 0.85) return 'VERIFIED';
    if (similarity >= 0.55) return 'REVIEW_REQUIRED';
    return 'MISMATCH';
  }

  private reasonFor(status: ResearchAuthenticityStatus, identifier: 'DOI' | 'PMID'): string {
    if (status === 'VERIFIED') return `${identifier}_AND_TITLE_MATCH`;
    if (status === 'REVIEW_REQUIRED') return `${identifier}_MATCH_TITLE_REVIEW_REQUIRED`;
    return `${identifier}_OR_TITLE_MISMATCH`;
  }

  private failed(
    provider: ResearchProvider,
    status: ResearchAuthenticityStatus,
    reason: string,
    checkedAt: string,
    responseHash: string | null,
  ): ResearchAuthenticityEvidence {
    return {
      provider, status, provider_record_id: null, canonical_doi: null,
      canonical_url: null, provider_title: null, title_similarity: null,
      response_sha256: responseHash, reason_code: reason, checked_at: checkedAt,
    };
  }

  private errorCode(error: unknown): string {
    const message = error instanceof Error ? error.message : '';
    return /^[A-Z][A-Z0-9_]{1,79}$/.test(message)
      ? message
      : 'PROVIDER_REQUEST_FAILED';
  }
}
