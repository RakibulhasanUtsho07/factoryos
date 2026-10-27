import qrcode from "./vendor/qrcode.mjs";

const CODE128_PATTERNS = [
  11011001100,11001101100,11001100110,10010011000,10010001100,10001001100,10011001000,10011000100,10001100100,11001001000,
  11001000100,11000100100,10110011100,10011011100,10011001110,10111001100,10011101100,10011100110,11001110010,11001011100,
  11001001110,11011100100,11001110100,11101101110,11101001100,11100101100,11100100110,11101100100,11100110100,11100110010,
  11011011000,11011000110,11000110110,10100011000,10001011000,10001000110,10110001000,10001101000,10001100010,11010001000,
  11000101000,11000100010,10110111000,10110001110,10001101110,10111011000,10111000110,10001110110,11101110110,11010001110,
  11000101110,11011101000,11011100010,11011101110,11101011000,11101000110,11100010110,11101101000,11101100010,11100011010,
  11101111010,11001000010,11110001010,10100110000,10100001100,10010110000,10010000110,10000101100,10000100110,10110010000,
  10110000100,10011010000,10011000010,10000110100,10000110010,11000010010,11001010000,11110111010,11000010100,10001111010,
  10100111100,10010111100,10010011110,10111100100,10011110100,10011110010,11110100100,11110010100,11110010010,11011011110,
  11011110110,11110110110,10101111000,10100011110,10001011110,10111101000,10111100010,11110101000,11110100010,10111011110,
  10111101110,11101011110,11110101110,11010000100,11010010000,11010011100,1100011101011,
].map(String);

const VALID_STATUSES = new Set(["ACTIVE", "QUARANTINED", "RECALLED", "DISPOSED", "SHIPPED", "SHIPPED_REVIEW_REQUIRED"]);

export class WmsLabelRenderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WmsLabelRenderError";
    this.code = code;
  }
}

function requireCondition(condition, code, message) {
  if (!condition) throw new WmsLabelRenderError(code, message);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function extractContract(issue) {
  if (issue?.print_contract && typeof issue.print_contract === "object") return issue.print_contract;
  return {
    symbology: issue?.symbology,
    encoded_value: issue?.barcode_value ?? issue?.barcode_value_snapshot,
    copies: issue?.copy_count,
    layout: issue?.label_layout,
    identity_payload: issue?.encoded_payload,
  };
}

function geometry(layout) {
  const page = layout && typeof layout === "object" && layout.page && typeof layout.page === "object" ? layout.page : {};
  const width = page.width_mm ?? 50;
  const height = page.height_mm ?? 30;
  requireCondition(Number.isFinite(width) && width >= 10 && width <= 300, "INVALID_LABEL_WIDTH", "Label width must be between 10 and 300 mm.");
  requireCondition(Number.isFinite(height) && height >= 10 && height <= 300, "INVALID_LABEL_HEIGHT", "Label height must be between 10 and 300 mm.");
  return { width, height };
}

function code128Svg(value, ariaLabel) {
  requireCondition(/^[\x20-\x7e]{1,128}$/.test(value), "INVALID_CODE128_VALUE", "Code 128 B accepts 1–128 printable ASCII characters in this renderer.");
  const codes = [104, ...Array.from(value, (character) => character.charCodeAt(0) - 32)];
  const checksum = codes.reduce((sum, code, index) => sum + code * (index === 0 ? 1 : index), 0) % 103;
  codes.push(checksum, 106);
  const patterns = codes.map((code) => CODE128_PATTERNS[code]);
  requireCondition(patterns.every(Boolean), "CODE128_ENCODER_ERROR", "Code 128 encoder table is incomplete.");
  const bits = patterns.join("");
  const quiet = 10;
  const fullWidth = bits.length + quiet * 2;
  const bars = [];
  let start = -1;
  for (let i = 0; i <= bits.length; i += 1) {
    const dark = bits[i] === "1";
    if (dark && start < 0) start = i;
    if (!dark && start >= 0) {
      bars.push('<rect x="' + (start + quiet) + '" y="2" width="' + (i - start) + '" height="76"/>');
      start = -1;
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="' + escapeHtml(ariaLabel) + '" viewBox="0 0 ' + fullWidth + ' 82" width="100%" height="82" preserveAspectRatio="none"><title>' + escapeHtml(ariaLabel) + '</title><rect width="' + fullWidth + '" height="82" fill="#fff"/><g fill="#000">' + bars.join("") + '</g><text x="' + (fullWidth / 2) + '" y="81" text-anchor="middle" font-family="monospace" font-size="1" fill="#000">' + escapeHtml(value) + '</text></svg>';
}

export function normalizeScannedLabel(rawCode) {
  requireCondition(typeof rawCode === "string", "INVALID_SCAN", "Scanned data must be text.");
  const code = rawCode.replace(/[\r\n\t]+$/g, "").trim().toUpperCase();
  requireCondition(code.length > 0 && code.length <= 255, "INVALID_SCAN", "Scanned code must contain 1–255 characters.");
  requireCondition(/^[\x20-\x7e]+$/.test(code), "INVALID_SCAN", "Scanned code contains unsupported control or non-ASCII characters.");
  return code;
}

export function validateWmsLabelIssue(issue, options = {}) {
  const contract = extractContract(issue);
  const symbology = String(contract.symbology ?? "").toUpperCase();
  requireCondition(["QR", "CODE128", "DATAMATRIX", "GS1_128"].includes(symbology), "UNSUPPORTED_SYMBOLOGY", "The label issue has an unsupported symbology.");
  requireCondition(symbology === "QR" || symbology === "CODE128", "ENCODER_NOT_IMPLEMENTED", symbology + " is accepted by the API template contract but does not yet have a verified client renderer.");
  const value = String(contract.encoded_value ?? "").trim();
  requireCondition(value.length > 0 && value.length <= 512, "INVALID_LABEL_VALUE", "Label encoded value must contain 1–512 characters.");
  requireCondition(/^[\x20-\x7e]+$/.test(value), "INVALID_LABEL_VALUE", "Label encoded value must contain printable ASCII for a portable print payload.");
  const copies = contract.copies ?? 1;
  requireCondition(Number.isInteger(copies) && copies >= 1 && copies <= 100, "INVALID_COPY_COUNT", "Label copies must be an integer between 1 and 100.");
  const identity = contract.identity_payload;
  requireCondition(identity && typeof identity === "object" && !Array.isArray(identity), "MISSING_IDENTITY_SNAPSHOT", "The persisted identity payload is required to render a traceability label.");
  const canonicalValue = String(identity.barcode_value ?? identity.sku ?? identity.unit_code ?? "").trim();
  requireCondition(canonicalValue.length > 0 && canonicalValue.toUpperCase() === value.toUpperCase(), "LABEL_IDENTITY_MISMATCH", "Encoded value does not match the persisted identity barcode/SKU/unit code.");
  const status = String(identity.status ?? "").toUpperCase();
  requireCondition(VALID_STATUSES.has(status), "INVALID_IDENTITY_STATUS", "A recognized lifecycle status is required so printed labels expose handling state.");
  if (options.currentIdentity) {
    const current = options.currentIdentity;
    const sameIdentifier = !identity.unit_id || !current.id || String(identity.unit_id).toLowerCase() === String(current.id).toLowerCase();
    const currentStatus = String(current.status ?? "").toUpperCase();
    const currentCode = String(current.barcode_value ?? current.sku ?? current.unit_code ?? "").trim().toUpperCase();
    requireCondition(sameIdentifier && currentCode === canonicalValue.toUpperCase(), "STALE_LABEL_IDENTITY", "The stored label snapshot does not match the current identity.");
    requireCondition(currentStatus === status, "STALE_LABEL_STATUS", "Lifecycle status changed after this label was issued; issue a fresh label before printing.");
  }
  const dimensions = geometry(contract.layout);
  return { symbology, value, copies, layout: contract.layout ?? {}, identity, status, width: dimensions.width, height: dimensions.height };
}

export function renderWmsLabel(issue, options = {}) {
  const label = validateWmsLabelIssue(issue, options);
  const description = label.symbology + " label " + label.value + "; status " + label.status;
  let svg;
  if (label.symbology === "QR") {
    try {
      const qr = qrcode(0, "M");
      qr.addData(label.value, "Byte");
      qr.make();
      svg = qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true })
        .replace("<svg ", '<svg role="img" aria-label="' + escapeHtml(description) + '" ');
    } catch {
      throw new WmsLabelRenderError("QR_ENCODING_FAILED", "QR payload could not be encoded by the local renderer.");
    }
  } else {
    svg = code128Svg(label.value, description);
  }

  const fieldKeys = Array.isArray(label.layout?.fields)
    ? label.layout.fields.filter((field) => typeof field === "string").slice(0, 12)
    : ["unit_code", "barcode_value", "sku", "product_role", "expires_at"];
  const fields = fieldKeys.map((key) => {
    const val = label.identity[key];
    if (val === undefined || val === null || String(val).length === 0) return "";
    return '<div class="field"><span>' + escapeHtml(key.replace(/_/g, " ")) + '</span><strong>' + escapeHtml(val) + '</strong></div>';
  }).join("");
  const title = label.identity.unit_code ?? label.identity.sku ?? label.value;
  const printLabel = '<article class="label" aria-label="' + escapeHtml(description) + '"><header><strong>' + escapeHtml(title) + '</strong><span class="status status-' + escapeHtml(label.status.toLowerCase()) + '">' + escapeHtml(label.status.replace(/_/g, " ")) + '</span></header><div class="symbol">' + svg + '</div><p class="encoded">' + escapeHtml(label.value) + '</p><section class="fields">' + fields + '</section></article>';
  const pages = Array.from({ length: label.copies }, (_, index) => '<section class="print-page" data-copy="' + (index + 1) + '">' + printLabel + '</section>').join("");
  const printHtml = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>FactoryOS label ' + escapeHtml(label.value) + '</title><style>@page{size:' + label.width + 'mm ' + label.height + 'mm;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#000;font-family:Arial,Helvetica,sans-serif}.print-page{width:' + label.width + 'mm;height:' + label.height + 'mm;overflow:hidden;break-after:page;page-break-after:always;padding:1.2mm}.print-page:last-child{break-after:auto;page-break-after:auto}.label{width:100%;height:100%;overflow:hidden;display:flex;flex-direction:column;gap:1mm}.label header{display:flex;justify-content:space-between;gap:1mm;font-size:7pt;line-height:1.1}.status{font-size:6pt;font-weight:700;border:0.25mm solid #000;padding:0.25mm 0.5mm;white-space:nowrap}.symbol{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden}.symbol svg{max-width:100%;max-height:100%;height:auto}.encoded{margin:0;text-align:center;overflow-wrap:anywhere;font:6pt monospace}.fields{font-size:5pt;display:flex;flex-wrap:wrap;gap:0.5mm 2mm;line-height:1.05}.field{display:flex;gap:0.7mm}.field span{text-transform:uppercase}.field strong{font-weight:700}@media screen{body{background:#e5e7eb}.print-page{background:#fff;box-shadow:0 1px 7px #999;margin:12px auto}}</style></head><body>' + pages + '</body></html>';
  return {
    symbology: label.symbology,
    encoded_value: label.value,
    copies: label.copies,
    status: label.status,
    width_mm: label.width,
    height_mm: label.height,
    svg,
    print_html: printHtml,
    svg_data_uri: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg),
  };
}

export function createWmsLabelScanResolver(options) {
  const endpoint = String(options?.endpoint ?? "").trim();
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  if (!endpoint || typeof fetchImpl !== "function") {
    throw new WmsLabelRenderError("INVALID_SCAN_TRANSPORT", "A configured label resolve endpoint and fetch implementation are required.");
  }
  return async function resolveScannedLabel(rawCode) {
    const code = normalizeScannedLabel(rawCode);
    const url = new URL(endpoint);
    url.searchParams.set("code", code);
    const headers = { Accept: "application/json" };
    const token = await options?.getAccessToken?.();
    if (token) headers.Authorization = "Bearer " + token;
    const response = await fetchImpl(url.toString(), { method: "GET", credentials: "include", headers });
    if (response.status === 404) throw new WmsLabelRenderError("UNKNOWN_LABEL", "No label matches this code in the current factory.");
    if (response.status === 409) throw new WmsLabelRenderError("AMBIGUOUS_LABEL", "This code matches multiple identities; do not pick one automatically.");
    if (!response.ok) throw new WmsLabelRenderError("LABEL_LOOKUP_FAILED", "Label lookup failed with HTTP " + response.status + ".");
    const result = await response.json();
    if (!result || !["TRACEABILITY_UNIT", "MATERIAL"].includes(result.identity_type) || !result.identity) {
      throw new WmsLabelRenderError("INVALID_LOOKUP_RESPONSE", "Label lookup response is missing its identity contract.");
    }
    return result;
  };
}
