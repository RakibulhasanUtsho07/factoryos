import { ResearchSourceAdapterService } from './research-source-adapters';

describe('ResearchSourceAdapterService', () => {
  const service = new ResearchSourceAdapterService();

  it('verifies a DOI using the fixed Crossref metadata endpoint and binds the digest', async () => {
    let requestedUrl = '';
    let requestInit: RequestInit | undefined;
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requestedUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify({
        message: {
          DOI: '10.1234/research.1',
          title: ['A study of reliable research ingestion'],
          URL: 'https://doi.org/10.1234/research.1',
          author: [{ given: 'Ada', family: 'Researcher' }],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const result = await service.verify({
      doi: 'https://doi.org/10.1234/RESEARCH.1',
      title: 'A study of reliable research ingestion',
      source_url: 'http://127.0.0.1:8080/admin',
    }, fetchImpl);

    expect(result.status).toBe('VERIFIED');
    expect(result.provider).toBe('CROSSREF');
    expect(result.canonical_doi).toBe('10.1234/research.1');
    expect(result.title_similarity).toBe(1);
    expect(result.response_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(requestedUrl).toBe('https://api.crossref.org/works/10.1234%2Fresearch.1');
    expect(requestInit?.redirect).toBe('error');
    expect(requestInit?.headers).toEqual(expect.objectContaining({ accept: 'application/json' }));
    expect(requestedUrl).not.toContain('127.0.0.1');
  });

  it('flags a provider record whose registered DOI matches but whose title does not', async () => {
    const fetchImpl = async (): Promise<Response> => new Response(JSON.stringify({
      message: { DOI: '10.1234/research.1', title: ['Unrelated aerospace materials investigation'] },
    }), { status: 200 });

    const result = await service.verify({
      doi: '10.1234/research.1',
      title: 'A controlled test of textile wastewater treatment',
    }, fetchImpl);

    expect(result.status).toBe('MISMATCH');
    expect(result.reason_code).toBe('DOI_OR_TITLE_MISMATCH');
  });

  it('resolves PubMed identifiers against Europe PMC without following the source URL', async () => {
    let requestedUrl = '';
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({
        resultList: {
          result: [{
            pmid: '123456',
            doi: '10.9999/pubmed.paper',
            title: 'A study of reliable research ingestion',
            authorString: 'Ada Researcher',
          }],
        },
      }), { status: 200 });
    };

    const result = await service.verify({
      title: 'A study of reliable research ingestion',
      source_url: 'https://pubmed.ncbi.nlm.nih.gov/123456/',
    }, fetchImpl);

    expect(result.status).toBe('VERIFIED');
    expect(result.provider).toBe('EUROPE_PMC');
    expect(result.provider_record_id).toBe('PMID:123456');
    expect(requestedUrl).toContain('https://www.ebi.ac.uk/europepmc/webservices/rest/search?');
    expect(requestedUrl).toContain('EXT_ID%3A123456');
  });

  it('does not request arbitrary URLs when a source lacks a supported provider identifier', async () => {
    let calls = 0;
    const fetchImpl = async (): Promise<Response> => {
      calls += 1;
      return new Response('{}', { status: 200 });
    };

    const result = await service.verify({
      title: 'A customer file',
      source_url: 'http://169.254.169.254/latest/meta-data/',
    }, fetchImpl);

    expect(result.status).toBe('UNSUPPORTED');
    expect(result.reason_code).toBe('NO_SUPPORTED_PROVIDER_IDENTIFIER');
    expect(calls).toBe(0);
  });

  it('bounds provider responses and returns a safe stable error code', async () => {
    const fetchImpl = async (): Promise<Response> => new Response('{}', {
      status: 200,
      headers: { 'content-length': String(1024 * 1024 + 1) },
    });

    const result = await service.verify({
      doi: '10.1234/research.1',
      title: 'A study of reliable research ingestion',
    }, fetchImpl);

    expect(result.status).toBe('ERROR');
    expect(result.reason_code).toBe('PROVIDER_RESPONSE_TOO_LARGE');
    expect(result.response_sha256).toBeNull();
  });

  it('records transient provider failures without claiming authenticity', async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new Error('network unavailable');
    };

    const result = await service.verify({
      doi: '10.1234/research.1',
      title: 'A study of reliable research ingestion',
    }, fetchImpl);

    expect(result.status).toBe('ERROR');
    expect(result.reason_code).toBe('PROVIDER_REQUEST_FAILED');
  });
});
