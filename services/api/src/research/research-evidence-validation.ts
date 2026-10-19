export type ResearchCitationStatus = 'CONSISTENT' | 'REVIEW_REQUIRED' | 'INVALID';

export interface ResearchCitationSource {
  doi?: string | null;
  source_url?: string | null;
}

export interface ResearchCitationValidation {
  status: ResearchCitationStatus;
  findings: string[];
  verificationLevel: 'METADATA_ONLY';
}

export interface ResearchEvidenceInput {
  citationStatus: ResearchCitationStatus;
  title: string | null;
  doi: string | null;
  sourceUrl: string | null;
  authors: unknown;
  publicationDate: string | null;
  methodology: string | null;
  datasetDescription: string | null;
  limitations: string | null;
  practicalImplication: string | null;
  independentSourceCount: number;
}

export interface ResearchEvidenceScore {
  rubricVersion: 'research-evidence-rubric.v1';
  score: number;
  suggestedGrade: 'A' | 'B' | 'C' | 'D';
  factors: Record<string, { score: number; max: number; explanation: string }>;
}

const PRECISE_LOCATORS = ['page', 'section', 'paragraph', 'url_fragment'] as const;
const DOI_KEYS = ['doi', 'source_doi'] as const;
const URL_KEYS = ['url', 'source_url', 'canonical_url', 'source_url_at_citation'] as const;

function cleanText(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF\u00AD]/g, '').trim()
    : '';
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && cleanText(value).length > 0;
}

function normalizeDoi(value: unknown): string | null {
  const text = cleanText(value).toLowerCase();
  if (!text) return null;
  const withoutPrefix = text
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi\s*:\s*/i, '')
    .replace(/[?#].*$/, '')
    .replace(/[.)\],;]+$/, '');
  const match = withoutPrefix.match(/10\.\d{4,9}\/[^\s]+/i);
  return match ? match[0].toLowerCase() : null;
}

function normalizeUrl(value: unknown): string | null {
  const text = cleanText(value);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid)$/i.test(key)) parsed.searchParams.delete(key);
    }
    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
    parsed.searchParams.sort();
    return parsed.host + parsed.pathname + (parsed.search ? parsed.search : '');
  } catch {
    return null;
  }
}

function sameSourceUrl(candidate: string, source: ResearchCitationSource): boolean {
  const candidateDoi = normalizeDoi(candidate);
  const sourceDoi = normalizeDoi(source.doi);
  if (candidateDoi && sourceDoi) return candidateDoi === sourceDoi;
  const candidateUrl = normalizeUrl(candidate);
  const sourceUrl = normalizeUrl(source.source_url);
  return candidateUrl !== null && sourceUrl !== null && candidateUrl === sourceUrl;
}

/**
 * Checks that a source locator is structurally precise and that any explicit URL/DOI
 * agrees with the registered source identity. This deliberately does not claim to
 * verify the contents at the remote URL; no remote fetch occurs in this API.
 */
export function validateResearchCitation(
  locatorValue: unknown,
  source: ResearchCitationSource,
): ResearchCitationValidation {
  const findings = new Set<string>();
  if (!locatorValue || typeof locatorValue !== 'object' || Array.isArray(locatorValue)) {
    return {
      status: 'INVALID',
      findings: ['LOCATOR_MISSING', 'SOURCE_CONTENT_NOT_FETCHED'],
      verificationLevel: 'METADATA_ONLY',
    };
  }

  const outer = locatorValue as Record<string, unknown>;
  // Extraction provenance wraps the actual locator with immutable run metadata.
  // Validate the located passage itself, not the wrapper keys (for example "extraction").
  const locator = outer.locator && typeof outer.locator === 'object' && !Array.isArray(outer.locator)
    ? outer.locator as Record<string, unknown>
    : outer;
  const hasPreciseLocator = PRECISE_LOCATORS.some((key) => {
    const value = locator[key];
    if (key === 'page') return Number.isInteger(value) && Number(value) > 0;
    return nonEmpty(value);
  });
  if (!hasPreciseLocator) findings.add('PRECISE_LOCATOR_MISSING');

  const sourceDoi = normalizeDoi(source.doi);
  const sourceUrl = normalizeUrl(source.source_url);
  if (!sourceDoi && !sourceUrl) findings.add('SOURCE_IDENTITY_MISSING');

  const suppliedDoiKeys = DOI_KEYS.filter((key) => nonEmpty(locator[key]));
  for (const key of suppliedDoiKeys) {
    const citedDoi = normalizeDoi(locator[key]);
    if (!citedDoi) {
      findings.add('CITATION_DOI_INVALID');
    } else if (!sourceDoi) {
      findings.add('CITATION_DOI_UNREGISTERED');
    } else if (citedDoi !== sourceDoi) {
      findings.add('CITATION_DOI_MISMATCH');
    }
  }

  const suppliedUrlKeys = URL_KEYS.filter((key) => nonEmpty(locator[key]));
  for (const key of suppliedUrlKeys) {
    const citedUrl = cleanText(locator[key]);
    if (!normalizeUrl(citedUrl)) {
      findings.add('CITATION_URL_INVALID');
    } else if (!sourceDoi && !sourceUrl) {
      findings.add('CITATION_URL_UNREGISTERED');
    } else if (!sameSourceUrl(citedUrl, source)) {
      findings.add('CITATION_URL_MISMATCH');
    }
  }

  if (nonEmpty(locator.source_identifier)) {
    const identifier = cleanText(locator.source_identifier);
    const identifierDoi = normalizeDoi(identifier);
    if (identifierDoi) {
      if (!sourceDoi) findings.add('SOURCE_IDENTIFIER_UNREGISTERED');
      else if (identifierDoi !== sourceDoi) findings.add('SOURCE_IDENTIFIER_MISMATCH');
    } else if (/^https?:\/\//i.test(identifier)) {
      if (!sameSourceUrl(identifier, source)) findings.add('SOURCE_IDENTIFIER_MISMATCH');
    } else {
      findings.add('SOURCE_IDENTIFIER_UNVERIFIED');
    }
  }

  const findingList = [...findings].sort();
  const hardFailures = findingList.some((item) =>
    item === 'PRECISE_LOCATOR_MISSING'
    || item === 'SOURCE_IDENTITY_MISSING'
    || item.endsWith('_INVALID')
    || item.endsWith('_MISMATCH')
    || item === 'CITATION_DOI_UNREGISTERED'
    || item === 'CITATION_URL_UNREGISTERED'
    || item === 'SOURCE_IDENTIFIER_UNREGISTERED',
  );
  const needsReview = findingList.includes('SOURCE_IDENTIFIER_UNVERIFIED');
  return {
    status: hardFailures ? 'INVALID' : needsReview ? 'REVIEW_REQUIRED' : 'CONSISTENT',
    findings: findingList,
    verificationLevel: 'METADATA_ONLY',
  };
}

export function scoreResearchEvidence(input: ResearchEvidenceInput): ResearchEvidenceScore {
  const authorList = Array.isArray(input.authors)
    ? input.authors.filter((author) => nonEmpty(author))
    : [];
  const hasSourceIdentifier = nonEmpty(input.doi) || nonEmpty(input.sourceUrl);
  const hasTitle = nonEmpty(input.title);
  const factor = (
    score: number,
    max: number,
    explanation: string,
  ) => ({ score, max, explanation });

  const factors = {
    citation: factor(
      input.citationStatus === 'CONSISTENT' ? 25 : input.citationStatus === 'REVIEW_REQUIRED' ? 10 : 0,
      25,
      input.citationStatus === 'CONSISTENT'
        ? 'A precise locator and registered source identity are structurally consistent; remote content was not fetched.'
        : input.citationStatus === 'REVIEW_REQUIRED'
          ? 'Citation metadata needs a reviewer to resolve an identity that cannot be verified automatically.'
          : 'A required locator or registered-source identity is missing, malformed, or conflicting.',
    ),
    source_identity: factor(
      hasTitle && hasSourceIdentifier ? 15 : hasTitle || hasSourceIdentifier ? 8 : 0,
      15,
      hasTitle && hasSourceIdentifier
        ? 'A source title and DOI or URL are registered.'
        : 'The registered source identity is incomplete.',
    ),
    authors_and_date: factor(
      (authorList.length > 0 ? 5 : 0) + (nonEmpty(input.publicationDate) ? 5 : 0),
      10,
      'Authorship and publication date improve traceability; absence is not interpreted as proof that a source is false.',
    ),
    methodology: factor(
      nonEmpty(input.methodology) ? 15 : 0,
      15,
      nonEmpty(input.methodology) ? 'A methodology description is recorded.' : 'No methodology description is recorded.',
    ),
    dataset_description: factor(
      nonEmpty(input.datasetDescription) ? 15 : 0,
      15,
      nonEmpty(input.datasetDescription) ? 'The dataset or underlying material is described.' : 'No dataset/material description is recorded.',
    ),
    limitations: factor(
      nonEmpty(input.limitations) ? 10 : 0,
      10,
      nonEmpty(input.limitations) ? 'Known limitations are documented.' : 'No limitations are documented.',
    ),
    practical_implication: factor(
      nonEmpty(input.practicalImplication) ? 5 : 0,
      5,
      nonEmpty(input.practicalImplication) ? 'A practical implication is recorded.' : 'No practical implication is recorded.',
    ),
    independent_corroboration: factor(
      input.independentSourceCount > 0 ? 5 : 0,
      5,
      input.independentSourceCount > 0
        ? 'At least one approved related claim from an independent source is linked.'
        : 'No approved independent-source corroboration is linked.',
    ),
  };
  const score = Object.values(factors).reduce((sum, item) => sum + item.score, 0);
  const suggestedGrade = input.citationStatus === 'INVALID' || score < 50
    ? 'D'
    : score >= 85 ? 'A' : score >= 70 ? 'B' : 'C';

  return { rubricVersion: 'research-evidence-rubric.v1', score, suggestedGrade, factors };
}

function normalizedPromptText(value: string): { spaced: string; compact: string } {
  const unicodeNormalized = value.normalize('NFKC')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF\u00AD]/g, '')
    .toLowerCase();
  return {
    spaced: unicodeNormalized.replace(/[^a-z0-9]+/g, ' ').trim(),
    compact: unicodeNormalized.replace(/[^a-z0-9]+/g, ''),
  };
}

/**
 * Conservative screening only. It returns finding codes, never raw matched source text,
 * and is not a substitute for a model-level security evaluation or human review.
 */
export function scanResearchPromptInjection(value: string): string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  const { spaced, compact } = normalizedPromptText(value);
  const findings = new Set<string>();

  const controlPattern = /\b(ignore|disregard|override|forget|bypass|disable|skip)\b.{0,80}\b(all|any|the|previous|prior|system|developer|safety|security)\b.{0,80}\b(instructions?|rules?|polic(y|ies)|guardrails?|prompt|restrictions?)\b/i;
  const secretPattern = /\b(reveal|print|expose|dump|show|leak|return|extract)\b.{0,80}\b(system prompt|hidden prompt|hidden instructions?|credentials?|secrets?|api keys?|passwords?|access tokens?)\b/i;
  const exfilPattern = /\b(exfiltrat\w*|steal|send|upload|forward|export|transmit)\b.{0,100}\b(credentials?|secrets?|private data|customer data|api keys?|database records?)\b/i;
  const toolPattern = /\b(call|invoke|run|execute|use)\b.{0,50}\b(tool|function|browser|shell|terminal|python|sql|command)\b.{0,100}\b(exfiltrat\w*|fetch|delete|modify|send|upload|export|read|dump|secret|credential|private data)\b/i;
  const jailbreakPattern = /\b(enable|activate|enter|switch to|turn on|use)\b.{0,40}\b(developer mode|dan mode|unrestricted mode)\b|\b(jailbreak|without (any )?restrictions|bypass (the )?safety|disable (the )?safety)\b/i;

  if (
    controlPattern.test(spaced)
    || /(ignore|disregard|override|forget|bypass|disable|skip)(all|any|the|previous|prior|system|developer|safety|security){0,3}(instructions?|rules?|polic(y|ies)|guardrails?|prompt|restrictions?)/.test(compact)
  ) findings.add('PROMPT_CONTROL_INSTRUCTION');
  if (
    secretPattern.test(spaced)
    || /(reveal|print|expose|dump|show|leak|return|extract)(the|hidden|system|all|your|my){0,3}(systemprompt|hiddenprompt|hiddeninstructions?|credentials?|secrets?|apikeys?|passwords?|accesstokens?)/.test(compact)
  ) findings.add('SECRET_EXTRACTION_INSTRUCTION');
  if (
    exfilPattern.test(spaced)
    || /(exfiltrat\w*|steal|send|upload|forward|export|transmit)(the|all|private|customer|api){0,3}(credentials?|secrets?|privatedata|customerdata|apikeys?|databaserecords?)/.test(compact)
  ) findings.add('POSSIBLE_DATA_EXFILTRATION_INSTRUCTION');
  if (
    toolPattern.test(spaced)
    || /(?:call|invoke|run|execute|use)(?:the)?(?:tool|function|browser|shell|terminal|python|sql|command)(?:to|and)?(?:exfiltrat\w*|fetch|delete|modify|send|upload|export|read|dump|secret|credential)/.test(compact)
  ) findings.add('TOOL_OR_COMMAND_ABUSE_INSTRUCTION');
  if (
    jailbreakPattern.test(spaced)
    || /(?:(?:enable|activate|enter|switchto|turnon|use)(?:the)?(?:developermode|danmode|unrestrictedmode)|jailbreak|withoutrestrictions|bypass(?:the)?safety)/.test(compact)
  ) findings.add('SAFETY_BYPASS_INSTRUCTION');
  if (
    /<<\s*sys\s*>>|\[\s*inst\s*\]|<\s*\/?\s*(system|developer|assistant)\s*>/i.test(value)
    || /\bassistant\s+to\s*[=:]/i.test(spaced)
  ) findings.add('MODEL_ROLE_MARKUP');

  return [...findings].sort();
}
