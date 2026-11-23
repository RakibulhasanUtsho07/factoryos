const LICENSES = new Set(["OPEN_ACCESS","LICENSED","USER_PROVIDED_AUTHORIZED"]);
const SOURCE_TYPES = ["DOI_METADATA","OPEN_ACCESS_REPOSITORY","PUBLISHER_FEED","INSTITUTIONAL_REPOSITORY","CUSTOMER_PROVIDED","STANDARD","VENDOR_MATERIAL","SURVEY","PREPRINT","OPINION"];
const TOPIC_TYPES = ["SECTOR","TECHNOLOGY","PROCESS","MARKET","SUSTAINABILITY","STRATEGIC_QUESTION"];

export function normalizeResearchRows(value, key = "") {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if (key && Array.isArray(value[key])) return value[key];
  if (Array.isArray(value.items)) return value.items;
  if (Array.isArray(value.rows)) return value.rows;
  return value.data === undefined ? [] : normalizeResearchRows(value.data, key);
}
export function splitResearchTerms(value, maximum, required = false) {
  const terms = String(value ?? "").split(/\r?\n|,/).map((term) => term.trim()).filter(Boolean);
  if (terms.length > maximum || (required && !terms.length)) throw new Error("Enter " + (required ? "1-" : "0-") + maximum + " research terms.");
  const seen = new Set();
  for (const term of terms) {
    const key = term.toLocaleLowerCase();
    if (term.length > 200 || seen.has(key)) throw new Error("Research terms must be unique and no longer than 200 characters.");
    seen.add(key);
  }
  return terms;
}
export function buildResearchSourcePayload(draft) {
  const title = String(draft.title ?? "").trim();
  const doi = String(draft.doi ?? "").trim();
  const sourceUrl = String(draft.source_url ?? "").trim();
  const license = String(draft.license_status ?? "");
  const rights = String(draft.rights_basis ?? "").trim();
  const fullText = Boolean(draft.full_text_storage_allowed);
  if (!title) throw new Error("A source title is required.");
  if (!doi && !sourceUrl) throw new Error("Provide a DOI or source URL.");
  if (!SOURCE_TYPES.includes(draft.source_type)) throw new Error("Choose a supported source type.");
  if (!["OPEN_ACCESS","LICENSED","USER_PROVIDED_AUTHORIZED","RESTRICTED","UNKNOWN"].includes(license)) throw new Error("Choose a valid license status.");
  if (draft.source_type === "CUSTOMER_PROVIDED" && license !== "USER_PROVIDED_AUTHORIZED") throw new Error("Customer-provided material requires explicit user authorization.");
  if (fullText && (!LICENSES.has(license) || !rights)) throw new Error("Full-text storage requires permitted rights and a documented rights basis.");
  let safeUrl = "";
  if (sourceUrl) {
    try { const url = new URL(sourceUrl); if (!["http:","https:"].includes(url.protocol)) throw new Error(); safeUrl = url.toString(); }
    catch { throw new Error("Enter a valid HTTP or HTTPS source URL."); }
  }
  const authors = splitResearchTerms(draft.authors ?? "",100);
  return {
    source_type:draft.source_type,title,
    ...(authors.length?{authors}:{}),
    ...(String(draft.publication_date??"").trim()?{publication_date:draft.publication_date}:{}),
    ...(doi?{doi}:{}),
    ...(String(draft.venue??"").trim()?{venue:String(draft.venue).trim()}:{}),
    ...(String(draft.abstract??"").trim()?{abstract:String(draft.abstract).trim()}:{}),
    ...(safeUrl?{source_url:safeUrl}:{}),license_status:license,
    ...(rights?{rights_basis:rights}:{}),
    ...(String(draft.license_reference??"").trim()?{license_reference:String(draft.license_reference).trim()}:{}),
    full_text_storage_allowed:fullText,
  };
}
export function buildResearchWatchlistPayload(draft) {
  const key=String(draft.watchlist_key??"").trim().toLowerCase(),title=String(draft.title??"").trim();
  const topics=splitResearchTerms(draft.topic_terms??"",25,true);
  const include=splitResearchTerms(draft.inclusion_terms??"",50);
  const exclude=splitResearchTerms(draft.exclusion_terms??"",50);
  const sourceTypes=[...new Set((draft.source_types??[]).filter((item)=>SOURCE_TYPES.includes(item)))];
  if(!/^[a-z0-9][a-z0-9._-]{1,159}$/.test(key))throw new Error("Use a 2-160 character watchlist key.");
  if(!title)throw new Error("A watchlist title is required.");
  if(!TOPIC_TYPES.includes(draft.topic_type))throw new Error("Choose a valid topic type.");
  if(!sourceTypes.length)throw new Error("Select at least one source type.");
  return {watchlist_key:key,title,topic_type:draft.topic_type,...(String(draft.description??"").trim()?{description:String(draft.description).trim()}:{}),topic_terms:topics,inclusion_terms:include,exclusion_terms:exclude,source_types:sourceTypes};
}
export function buildResearchIngestionJobPayload(mode,key) {
  const idempotency=String(key??"").trim();
  if(!["METADATA_ONLY","FULL_TEXT"].includes(mode))throw new Error("Choose a supported ingestion mode.");
  if(!idempotency||idempotency.length>200)throw new Error("A unique ingestion idempotency key is required.");
  return {mode,idempotency_key:idempotency};
}
export function buildResearchFreshnessPayload(mode,intervalMinutes,maxAttempts=5) {
  const interval=Number(intervalMinutes),attempts=Number(maxAttempts);
  if(!["METADATA_ONLY","FULL_TEXT"].includes(mode))throw new Error("Choose a supported freshness mode.");
  if(!Number.isInteger(interval)||interval<60||interval>129600)throw new Error("Freshness interval must be between 60 and 129600 minutes.");
  if(!Number.isInteger(attempts)||attempts<1||attempts>10)throw new Error("Maximum attempts must be between 1 and 10.");
  return {mode,interval_minutes:interval,max_attempts:attempts};
}
export function buildResearchClaimPayload(draft) {
  const locator={},page=String(draft.page??"").trim();
  if(page){const n=Number(page);if(!Number.isInteger(n)||n<1)throw new Error("Source page must be a positive whole number.");locator.page=n;}
  for(const key of ["section","paragraph","url_fragment"]){const text=String(draft[key]??"").trim();if(text)locator[key]=text;}
  const claim=String(draft.claim_text??"").trim();
  if(!claim)throw new Error("Claim text is required.");
  if(!Object.keys(locator).length)throw new Error("Add at least one precise source locator.");
  return {claim_text:claim,...(String(draft.methodology??"").trim()?{methodology:String(draft.methodology).trim()}:{}),...(String(draft.dataset_description??"").trim()?{dataset_description:String(draft.dataset_description).trim()}:{}),...(String(draft.limitations??"").trim()?{limitations:String(draft.limitations).trim()}:{}),...(String(draft.practical_implication??"").trim()?{practical_implication:String(draft.practical_implication).trim()}:{}),evidence_grade:"UNASSESSED",evidence_strength:draft.evidence_strength||"UNASSESSED",topic_tags:splitResearchTerms(draft.topic_tags??"",50),provenance_ref:locator,...(String(draft.stored_excerpt??"").trim()?{stored_excerpt:String(draft.stored_excerpt).trim()}:{})};
}
export function buildResearchReleasePayload(draft,version,claimIds) {
  const key=String(draft.release_key??"").trim(),title=String(draft.title??"").trim();
  const ids=[...new Set((claimIds??[]).map((id)=>String(id).toLowerCase()))];
  if(!key||key.length>160)throw new Error("A release key of up to 160 characters is required.");
  if(!title)throw new Error("A release title is required.");
  if(!Number.isInteger(Number(version))||Number(version)<1)throw new Error("Release version must be a positive integer.");
  if(!ids.length)throw new Error("Select at least one approved research claim.");
  if(!["A","B","C","D","MIXED"].includes(draft.evidence_grade))throw new Error("Choose a valid release evidence grade.");
  return {release_key:key,version:Number(version),title,claim_ids:ids,evidence_grade:draft.evidence_grade};
}
export function summarizeResearchWorkspace({sources=[],watchlists=[],jobs=[],claims=[],releases=[]}={}) {
  const count=(rows,fn)=>rows.filter(fn).length;
  return {sources:sources.length,approvedSources:count(sources,(r)=>r.access_status==="APPROVED"),pendingSources:count(sources,(r)=>r.access_status==="PENDING"),activeWatchlists:count(watchlists,(r)=>r.status==="ACTIVE"),queuedJobs:count(jobs,(r)=>["QUEUED","RETRY_WAIT"].includes(r.status)),runningJobs:count(jobs,(r)=>r.status==="RUNNING"),pendingClaims:count(claims,(r)=>r.status==="PROPOSED"),approvedClaims:count(claims,(r)=>r.status==="APPROVED"),promotedReleases:count(releases,(r)=>r.status==="PROMOTED")};
}
export function filterResearchRows(rows, search, status = "ALL") {
  const term = String(search ?? "").trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (status !== "ALL" && String(row.status ?? row.access_status ?? "UNKNOWN") !== status) return false;
    if (!term) return true;
    return Object.values(row).some((value) => {
      if (typeof value === "string") return value.toLocaleLowerCase().includes(term);
      if (Array.isArray(value)) return value.some((item) => String(item).toLocaleLowerCase().includes(term));
      return false;
    });
  });
}
export function canResearchStoreFullText(source) {
  return source?.access_status==="APPROVED"&&LICENSES.has(source?.license_status)&&Boolean(String(source?.rights_basis??"").trim())&&source?.full_text_storage_allowed===true;
}
