export interface ResearchSource { id:string;title:string;source_type:string;access_status:string;license_status:string;namespace?:string;rights_basis?:string|null;full_text_storage_allowed:boolean;doi?:string|null;source_url?:string|null;venue?:string|null;authors?:string[];abstract?:string|null;ingested_at?:string;[key:string]:unknown }
export interface ResearchWatchlist { id:string;watchlist_key:string;title:string;topic_type:string;status:string;topic_terms?:string[];source_types?:string[];[key:string]:unknown }
export interface ResearchJob { id:string;source_id:string;status:string;mode:string;version?:number;stage?:string;progress_percent?:number;[key:string]:unknown }
export interface ResearchClaim { id:string;source_id:string;claim_text:string;status:string;evidence_grade:string;evidence_strength?:string;source_title?:string;topic_tags?:string[];provenance_ref?:Record<string,unknown>;[key:string]:unknown }
export interface ResearchRelease { id:string;release_key:string;version:number;title:string;status:string;claim_ids?:string[];evidence_grade:string;evaluation_id?:string|null;validation_report?:Record<string,unknown>;[key:string]:unknown }
export function normalizeResearchRows(value:unknown,key?:string):Record<string,unknown>[];
export function splitResearchTerms(value:unknown,maximum:number,required?:boolean):string[];
export function buildResearchSourcePayload(draft:Record<string,unknown>):Record<string,unknown>;
export function buildResearchWatchlistPayload(draft:Record<string,unknown>):Record<string,unknown>;
export function buildResearchIngestionJobPayload(mode:string,key:string):Record<string,unknown>;
export function buildResearchFreshnessPayload(mode:string,intervalMinutes:unknown,maxAttempts?:unknown):Record<string,unknown>;
export function buildResearchClaimPayload(draft:Record<string,unknown>):Record<string,unknown>;
export function buildResearchReleasePayload(draft:Record<string,unknown>,version:number,claimIds:string[]):Record<string,unknown>;
export function summarizeResearchWorkspace(input:{sources?:ResearchSource[];watchlists?:ResearchWatchlist[];jobs?:ResearchJob[];claims?:ResearchClaim[];releases?:ResearchRelease[]}):Record<string,number>;
export function filterResearchRows<T extends Record<string,unknown>>(rows:T[],search:string,status?:string):T[];
export function canResearchStoreFullText(source:Partial<ResearchSource>|null|undefined):boolean;
