#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const RELEASE_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const FORBIDDEN_FIELD = /(authorization|access[_-]?key(_id)?|secret(_value)?|token(_value)?|password|private[_-]?key|raw[_-]?signature|signature[_-]?value|credential[_-]?value)/i;

const SCENARIOS = {
  airplane_mode_queue_reload_reconnect: ["offline_mobile"],
  lost_response_duplicate_tap_retry: ["offline_mobile"],
  multi_tab_and_cross_device_sync: ["offline_mobile"],
  server_conflict_receipt_reconciliation: ["offline_mobile"],
  qr_and_code128_physical_print_scan: ["label_print_scan"],
  damaged_or_stale_label_rejection: ["label_print_scan"],
  reprint_after_lifecycle_change: ["label_print_scan"],
  epc_repeat_dedup_and_unknown_tag: ["rfid"],
  wrong_or_ineligible_tag_rejected: ["rfid"],
  quantity_reconciliation: ["rfid"],
  rf_burst_disconnect_reconnect: ["rfid"],
};

const SCENARIO_DEVICE_TYPES = {
  airplane_mode_queue_reload_reconnect: ["handhelds"],
  lost_response_duplicate_tap_retry: ["handhelds"],
  multi_tab_and_cross_device_sync: ["handhelds"],
  server_conflict_receipt_reconciliation: ["handhelds"],
  qr_and_code128_physical_print_scan: ["handhelds", "scanners", "printers"],
  damaged_or_stale_label_rejection: ["handhelds", "scanners"],
  reprint_after_lifecycle_change: ["handhelds", "printers"],
  epc_repeat_dedup_and_unknown_tag: ["rfid_readers"],
  wrong_or_ineligible_tag_rejected: ["rfid_readers"],
  quantity_reconciliation: ["rfid_readers"],
  rf_burst_disconnect_reconnect: ["rfid_readers"],
};

const SCENARIO_EVIDENCE = {
  airplane_mode_queue_reload_reconnect: ["screen-recording", "api-sync-receipts"],
  lost_response_duplicate_tap_retry: ["screen-recording", "api-sync-receipts", "stock-ledger-reconciliation"],
  multi_tab_and_cross_device_sync: ["screen-recording", "api-sync-receipts", "stock-ledger-reconciliation"],
  server_conflict_receipt_reconciliation: ["api-sync-receipts", "stock-ledger-reconciliation"],
  qr_and_code128_physical_print_scan: ["printed-label-photo", "scanner-decode-log", "printer-settings"],
  damaged_or_stale_label_rejection: ["scanner-decode-log", "label-defect-results"],
  reprint_after_lifecycle_change: ["printed-label-photo", "label-defect-results"],
  epc_repeat_dedup_and_unknown_tag: ["rfid-reader-log", "epc-reconciliation-report"],
  wrong_or_ineligible_tag_rejected: ["rfid-reader-log", "epc-reconciliation-report"],
  quantity_reconciliation: ["epc-reconciliation-report", "rfid-stock-reconciliation"],
  rf_burst_disconnect_reconnect: ["rfid-reader-log", "rf-burst-reconnect-log"],
};

const REQUIRED_APPROVALS = ["wms_process_owner", "device_security_owner", "site_owner"];

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isText(value, max = 500) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isTimestamp(value) {
  return typeof value === "string" && ISO_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function addIssue(issues, code, path) {
  issues.push({ code, path });
}

function scanForbiddenFields(value, issues, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbiddenFields(item, issues, path + "[" + index + "]"));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const itemPath = path + "." + key;
    if (FORBIDDEN_FIELD.test(key)) addIssue(issues, "SECRET_BEARING_FIELD_NAME", itemPath);
    scanForbiddenFields(item, issues, itemPath);
  }
}

function requireText(value, path, issues, max = 500) {
  if (!isText(value, max)) addIssue(issues, "REQUIRED_TEXT_MISSING_OR_INVALID", path);
}

function requireTimestamp(value, path, issues) {
  if (!isTimestamp(value)) addIssue(issues, "INVALID_TIMESTAMP", path);
}

function requireDigest(value, path, issues) {
  if (typeof value !== "string" || !SHA256.test(value)) addIssue(issues, "INVALID_SHA256", path);
}

function validateDeviceList(devices, key, requiredFields, issues) {
  const list = devices[key];
  if (!Array.isArray(list) || list.length === 0) {
    addIssue(issues, "REQUIRED_PHYSICAL_DEVICE_MISSING", "$.devices." + key);
    return new Set();
  }
  const ids = new Set();
  list.forEach((device, index) => {
    const path = "$.devices." + key + "[" + index + "]";
    if (!isRecord(device)) {
      addIssue(issues, "INVALID_DEVICE_RECORD", path);
      return;
    }
    requireText(device.asset_id, path + ".asset_id", issues, 150);
    if (isText(device.asset_id) && ids.has(device.asset_id)) {
      addIssue(issues, "DUPLICATE_DEVICE_ASSET_ID", path + ".asset_id");
    }
    if (isText(device.asset_id)) ids.add(device.asset_id);
    for (const field of requiredFields) requireText(device[field], path + "." + field, issues, 255);
  });
  return ids;
}

function applicableScenarios(scope) {
  return Object.entries(SCENARIOS)
    .filter(([, requiredScopes]) => requiredScopes.every((key) => scope[key] === true))
    .map(([id]) => id);
}

function validateScenarioResults(manifest, expectedScenarioIds, knownDeviceIds, knownDeviceTypes, issues) {
  if (!Array.isArray(manifest.scenarios)) {
    addIssue(issues, "SCENARIO_RESULTS_REQUIRED", "$.scenarios");
    return;
  }
  const byId = new Map();
  manifest.scenarios.forEach((scenario, index) => {
    const path = "$.scenarios[" + index + "]";
    if (!isRecord(scenario) || !isText(scenario.id, 200)) {
      addIssue(issues, "INVALID_SCENARIO_RECORD", path);
      return;
    }
    if (byId.has(scenario.id)) addIssue(issues, "DUPLICATE_SCENARIO", path + ".id");
    byId.set(scenario.id, scenario);
    if (!Object.hasOwn(SCENARIOS, scenario.id)) {
      addIssue(issues, "UNKNOWN_SCENARIO", path + ".id");
    }
    if (scenario.execution_mode !== "PHYSICAL_HARDWARE") {
      addIssue(issues, "SIMULATED_RUN_NOT_PHYSICAL_ACCEPTANCE", path + ".execution_mode");
    }
    if (scenario.status !== "PASS") addIssue(issues, "SCENARIO_NOT_PASSED", path + ".status");
    requireTimestamp(scenario.observed_at, path + ".observed_at", issues);
    requireText(scenario.observation, path + ".observation", issues, 2000);
    if (!Array.isArray(scenario.device_ids) || scenario.device_ids.length === 0) {
      addIssue(issues, "SCENARIO_DEVICE_IDS_REQUIRED", path + ".device_ids");
    } else {
      for (const deviceId of scenario.device_ids) {
        if (!knownDeviceIds.has(deviceId)) addIssue(issues, "SCENARIO_REFERENCES_UNKNOWN_DEVICE", path + ".device_ids");
      }
      const requiredTypes = SCENARIO_DEVICE_TYPES[scenario.id] ?? [];
      if (requiredTypes.length > 0 &&
          !scenario.device_ids.some((deviceId) => requiredTypes.includes(knownDeviceTypes.get(deviceId)))) {
        addIssue(issues, "SCENARIO_MISSING_REQUIRED_PHYSICAL_DEVICE_TYPE", path + ".device_ids");
      }
    }
  });
  for (const scenarioId of expectedScenarioIds) {
    if (!byId.has(scenarioId)) addIssue(issues, "REQUIRED_PHYSICAL_SCENARIO_MISSING", "$.scenarios." + scenarioId);
  }
  for (const scenarioId of byId.keys()) {
    if (!expectedScenarioIds.includes(scenarioId)) addIssue(issues, "SCENARIO_OUTSIDE_DECLARED_SCOPE", "$.scenarios." + scenarioId);
  }
}

async function validateAttachments(manifest, rootPath, expectedScenarioIds, issues) {
  if (!Array.isArray(manifest.attachments)) {
    addIssue(issues, "PHYSICAL_EVIDENCE_ATTACHMENTS_REQUIRED", "$.attachments");
    return 0;
  }

  const byKind = new Map();
  const paths = new Set();
  manifest.attachments.forEach((attachment, index) => {
    const path = "$.attachments[" + index + "]";
    if (!isRecord(attachment)) {
      addIssue(issues, "INVALID_ATTACHMENT_RECORD", path);
      return;
    }
    if (!isText(attachment.kind, 100)) addIssue(issues, "INVALID_ATTACHMENT_KIND", path + ".kind");
    else if (byKind.has(attachment.kind)) addIssue(issues, "DUPLICATE_ATTACHMENT_KIND", path + ".kind");
    else byKind.set(attachment.kind, attachment);
    requireDigest(attachment.sha256, path + ".sha256", issues);
    if (!isText(attachment.path, 500) || isAbsolute(String(attachment.path)) ||
        String(attachment.path).includes("\\") ||
        String(attachment.path).split("/").some((part) => !part || part === "." || part === "..")) {
      addIssue(issues, "UNSAFE_ATTACHMENT_PATH", path + ".path");
    } else {
      if (paths.has(attachment.path)) addIssue(issues, "DUPLICATE_ATTACHMENT_PATH", path + ".path");
      paths.add(attachment.path);
    }
    if (!Array.isArray(attachment.scenario_ids) || attachment.scenario_ids.length === 0) {
      addIssue(issues, "ATTACHMENT_SCENARIO_LINK_REQUIRED", path + ".scenario_ids");
    } else {
      for (const scenarioId of attachment.scenario_ids) {
        if (!expectedScenarioIds.includes(scenarioId)) {
          addIssue(issues, "ATTACHMENT_LINKS_OUT_OF_SCOPE_SCENARIO", path + ".scenario_ids");
        }
      }
    }
  });

  for (const scenarioId of expectedScenarioIds) {
    for (const kind of SCENARIO_EVIDENCE[scenarioId]) {
      const attachment = byKind.get(kind);
      if (!attachment) {
        addIssue(issues, "REQUIRED_PHYSICAL_EVIDENCE_KIND_MISSING", "$.attachments." + kind);
      } else if (!Array.isArray(attachment.scenario_ids) || !attachment.scenario_ids.includes(scenarioId)) {
        addIssue(issues, "SCENARIO_MISSING_LINKED_EVIDENCE", "$.attachments." + kind + ".scenario_ids");
      }
    }
  }

  if (!isText(rootPath, 1000)) {
    addIssue(issues, "ATTACHMENT_ROOT_REQUIRED", "$.attachments");
    return 0;
  }

  let root;
  try {
    root = await realpath(resolve(rootPath));
    if (!(await lstat(root)).isDirectory()) throw new Error("not a directory");
  } catch {
    addIssue(issues, "ATTACHMENT_ROOT_UNAVAILABLE", "$.attachments");
    return 0;
  }

  let checked = 0;
  for (const attachment of byKind.values()) {
    if (!isText(attachment.path, 500) || isAbsolute(attachment.path) ||
        attachment.path.includes("\\") ||
        attachment.path.split("/").some((part) => !part || part === "." || part === "..")) continue;
    const candidate = resolve(root, ...attachment.path.split("/"));
    try {
      const canonical = await realpath(candidate);
      if (!canonical.startsWith(root + sep)) throw new Error("outside evidence root");
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) {
        throw new Error("unsafe evidence file");
      }
      const bytes = await readFile(candidate);
      checked += 1;
      if (SHA256.test(String(attachment.sha256)) && sha256(bytes) !== attachment.sha256) {
        addIssue(issues, "ATTACHMENT_DIGEST_MISMATCH", "$.attachments." + attachment.kind);
      }
      if (bytes.byteLength === 0) addIssue(issues, "EMPTY_PHYSICAL_EVIDENCE_FILE", "$.attachments." + attachment.kind);
    } catch {
      addIssue(issues, "ATTACHMENT_FILE_MISSING_OR_UNSAFE", "$.attachments." + attachment.kind);
    }
  }
  return checked;
}

/**
 * Validates a physical WMS acceptance evidence bundle. Automated tests and
 * simulator output are deliberately not accepted as physical-device evidence.
 * This verifies completeness and local file digests, not the truth of field observations.
 */
export async function validateWmsHardwareAcceptanceManifest(manifest, {
  evidenceRoot,
  expectedReleaseSha,
} = {}) {
  const issues = [];
  if (!isRecord(manifest)) {
    return {
      pass: false,
      result: "FAIL_PHYSICAL_HARDWARE_ACCEPTANCE",
      release_sha: null,
      attachment_files_checked: 0,
      issues: [{ code: "INVALID_MANIFEST", path: "$" }],
      limitations: ["The validator checks completeness and local file digests, not the truth of physical observations."],
    };
  }
  scanForbiddenFields(manifest, issues);
  if (manifest.schema !== "factoryos.wms.hardware-acceptance/v1") {
    addIssue(issues, "UNSUPPORTED_SCHEMA", "$.schema");
  }
  if (!RELEASE_SHA.test(String(manifest.release_sha ?? ""))) addIssue(issues, "INVALID_RELEASE_SHA", "$.release_sha");
  if (expectedReleaseSha !== undefined &&
      (!RELEASE_SHA.test(String(expectedReleaseSha)) ||
       String(manifest.release_sha).toLowerCase() !== String(expectedReleaseSha).toLowerCase())) {
    addIssue(issues, "RELEASE_SHA_MISMATCH", "$.release_sha");
  }
  if (!["staging", "preproduction", "production"].includes(manifest.environment)) {
    addIssue(issues, "INVALID_ACCEPTANCE_ENVIRONMENT", "$.environment");
  }
  if (manifest.environment === "production" &&
      (manifest.production_side_effects_authorized !== true || !isText(manifest.production_authorization_reference, 255))) {
    addIssue(issues, "PRODUCTION_TEST_REQUIRES_AUTHORIZATION_REFERENCE", "$.production_side_effects_authorized");
  }
  requireText(manifest.site, "$.site", issues, 255);
  requireText(manifest.test_run_id, "$.test_run_id", issues, 255);
  requireText(manifest.operator_identity, "$.operator_identity", issues, 255);
  requireTimestamp(manifest.tested_at, "$.tested_at", issues);

  const scope = manifest.scope;
  if (!isRecord(scope)) {
    addIssue(issues, "DECLARED_RELEASE_SCOPE_REQUIRED", "$.scope");
    return summarize(manifest, issues, 0);
  }
  for (const key of ["offline_mobile", "label_print_scan", "rfid"]) {
    if (typeof scope[key] !== "boolean") addIssue(issues, "SCOPE_FLAG_MUST_BE_BOOLEAN", "$.scope." + key);
  }
  if (scope.offline_mobile !== true) addIssue(issues, "OFFLINE_MOBILE_ACCEPTANCE_REQUIRED", "$.scope.offline_mobile");
  if (scope.label_print_scan !== true) addIssue(issues, "LABEL_PRINT_SCAN_ACCEPTANCE_REQUIRED", "$.scope.label_print_scan");
  if (scope.rfid === false) requireText(scope.rfid_exclusion_reason, "$.scope.rfid_exclusion_reason", issues, 1000);
  const expectedScenarios = applicableScenarios(scope);
  const requiredKinds = new Set(expectedScenarios.flatMap((id) => SCENARIO_EVIDENCE[id]));

  const devices = isRecord(manifest.devices) ? manifest.devices : {};
  const knownDeviceIds = new Set();
  const knownDeviceTypes = new Map();
  function registerDevices(key, fields) {
    for (const id of validateDeviceList(devices, key, fields, issues)) {
      if (knownDeviceTypes.has(id)) addIssue(issues, "DUPLICATE_ASSET_ID_ACROSS_DEVICE_TYPES", "$.devices." + key);
      knownDeviceIds.add(id);
      knownDeviceTypes.set(id, key);
    }
  }
  if (scope.offline_mobile === true || scope.label_print_scan === true) {
    registerDevices("handhelds", ["manufacturer", "model", "firmware", "os_version", "browser_version"]);
  }
  if (scope.label_print_scan === true) {
    registerDevices("scanners", ["manufacturer", "model", "firmware", "interface"]);
    registerDevices("printers", ["manufacturer", "model", "firmware", "driver", "dpi", "media"]);
  }
  if (scope.rfid === true) {
    registerDevices("rfid_readers", ["manufacturer", "model", "firmware", "interface", "antenna_configuration"]);
  }

  validateScenarioResults(manifest, expectedScenarios, knownDeviceIds, knownDeviceTypes, issues);
  const attachmentFilesChecked = await validateAttachments(manifest, evidenceRoot, expectedScenarios, issues);

  const approvalRoles = [...REQUIRED_APPROVALS, ...(scope.rfid === true ? ["rfid_specialist"] : [])];
  if (!Array.isArray(manifest.approvals)) {
    addIssue(issues, "OWNER_APPROVALS_REQUIRED", "$.approvals");
  } else {
    const seenRoles = new Set();
    const seenIdentities = new Set();
    manifest.approvals.forEach((approval, index) => {
      const path = "$.approvals[" + index + "]";
      if (!isRecord(approval)) {
        addIssue(issues, "INVALID_OWNER_APPROVAL", path);
        return;
      }
      if (!approvalRoles.includes(approval.role) || seenRoles.has(approval.role)) {
        addIssue(issues, "UNKNOWN_OR_DUPLICATE_OWNER_ROLE", path + ".role");
      }
      seenRoles.add(approval.role);
      requireText(approval.identity_reference, path + ".identity_reference", issues, 255);
      if (isText(approval.identity_reference) && seenIdentities.has(approval.identity_reference)) {
        addIssue(issues, "OWNER_APPROVERS_MUST_BE_DISTINCT", path + ".identity_reference");
      }
      seenIdentities.add(approval.identity_reference);
      if (approval.decision !== "APPROVED") addIssue(issues, "OWNER_APPROVAL_NOT_APPROVED", path + ".decision");
      requireTimestamp(approval.approved_at, path + ".approved_at", issues);
      if (String(approval.release_sha ?? "").toLowerCase() !== String(manifest.release_sha ?? "").toLowerCase()) {
        addIssue(issues, "OWNER_APPROVAL_RELEASE_SHA_MISMATCH", path + ".release_sha");
      }
    });
    for (const role of approvalRoles) {
      if (!seenRoles.has(role)) addIssue(issues, "REQUIRED_OWNER_ROLE_MISSING", "$.approvals." + role);
    }
  }

  return summarize(manifest, issues, attachmentFilesChecked);
}

function summarize(manifest, issues, attachmentFilesChecked) {
  const deduplicated = issues.filter((issue, index) =>
    issues.findIndex((candidate) => candidate.code === issue.code && candidate.path === issue.path) === index,
  );
  return {
    pass: deduplicated.length === 0,
    result: deduplicated.length === 0 ? "PASS_PHYSICAL_HARDWARE_ACCEPTANCE_BUNDLE" : "FAIL_PHYSICAL_HARDWARE_ACCEPTANCE",
    release_sha: RELEASE_SHA.test(String(manifest.release_sha ?? "")) ? String(manifest.release_sha).toLowerCase() : null,
    attachment_files_checked: attachmentFilesChecked,
    issues: deduplicated,
    limitations: [
      "This validates manifest completeness, exact-release binding and local attachment digests; it cannot prove that a field recording or operator statement is genuine.",
      "A named site owner and device/security owner must independently inspect original hardware evidence and approve the exact tested release SHA.",
      "Keep unredacted site, operator and security evidence in an approved restricted evidence store; do not commit credentials or private records.",
    ],
  };
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--manifest", "--evidence-root", "--release-sha"].includes(key)) {
      throw new Error("Usage: node wms-hardware-acceptance.mjs --manifest <manifest.json> --evidence-root <private-evidence-dir> --release-sha <exact-release-sha>");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("Missing value for " + key);
    values[key] = value;
    index += 1;
  }
  if (!values["--manifest"] || !values["--evidence-root"] || !values["--release-sha"]) {
    throw new Error("Usage: node wms-hardware-acceptance.mjs --manifest <manifest.json> --evidence-root <private-evidence-dir> --release-sha <exact-release-sha>");
  }
  return values;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const bytes = await readFile(args["--manifest"]);
  if (bytes.byteLength > MAX_MANIFEST_BYTES) throw new Error("Manifest exceeds the 1 MiB safety limit");
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Manifest must contain valid JSON");
  }
  const report = await validateWmsHardwareAcceptanceManifest(manifest, {
    evidenceRoot: args["--evidence-root"],
    expectedReleaseSha: args["--release-sha"],
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error("WMS physical acceptance validation failed: " + (error instanceof Error ? error.message : "unknown error"));
    process.exitCode = 1;
  });
}
