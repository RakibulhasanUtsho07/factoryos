import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateWmsHardwareAcceptanceManifest } from "./wms-hardware-acceptance.mjs";

const RELEASE_SHA = "a".repeat(40);
const timestamp = "2026-10-26T11:00:00Z";

const scenarioEvidence = {
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

const scenarioDeviceIds = {
  airplane_mode_queue_reload_reconnect: ["HH-01"],
  lost_response_duplicate_tap_retry: ["HH-01"],
  multi_tab_and_cross_device_sync: ["HH-01", "HH-02"],
  server_conflict_receipt_reconciliation: ["HH-01"],
  qr_and_code128_physical_print_scan: ["HH-01", "SCAN-01", "PRINT-01"],
  damaged_or_stale_label_rejection: ["HH-01", "SCAN-01"],
  reprint_after_lifecycle_change: ["HH-01", "PRINT-01"],
  epc_repeat_dedup_and_unknown_tag: ["RFID-01"],
  wrong_or_ineligible_tag_rejected: ["RFID-01"],
  quantity_reconciliation: ["RFID-01"],
  rf_burst_disconnect_reconnect: ["RFID-01"],
};

const scenarios = Object.keys(scenarioEvidence);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function device(asset_id, extra = {}) {
  return {
    asset_id,
    manufacturer: "Fixture Hardware Manufacturer",
    model: "Acceptance Fixture Model",
    firmware: "1.2.3",
    ...extra,
  };
}

async function makeBundle(root, { rfid = true } = {}) {
  const activeScenarios = scenarios.filter((id) => rfid || !id.startsWith("epc_") &&
    id !== "wrong_or_ineligible_tag_rejected" &&
    id !== "quantity_reconciliation" &&
    id !== "rf_burst_disconnect_reconnect");
  const neededKinds = new Map();
  for (const id of activeScenarios) {
    for (const kind of scenarioEvidence[id]) {
      if (!neededKinds.has(kind)) neededKinds.set(kind, []);
      neededKinds.get(kind).push(id);
    }
  }

  const attachments = [];
  for (const [index, [kind, scenario_ids]] of [...neededKinds.entries()].entries()) {
    const body = JSON.stringify({ fixture: true, kind, index, captured_by: "physical-acceptance-operator" });
    const path = kind + ".json";
    await writeFile(join(root, path), body, { flag: "wx", mode: 0o600 });
    attachments.push({ kind, path, sha256: digest(body), scenario_ids });
  }

  const testScenarios = activeScenarios.map((id) => ({
    id,
    execution_mode: "PHYSICAL_HARDWARE",
    status: "PASS",
    observed_at: timestamp,
    observation: "Physical target-device run completed; see linked restricted evidence.",
    device_ids: scenarioDeviceIds[id],
  }));

  const approvals = [
    { role: "wms_process_owner", identity_reference: "approval-wms-123", decision: "APPROVED", approved_at: timestamp, release_sha: RELEASE_SHA },
    { role: "device_security_owner", identity_reference: "approval-device-security-456", decision: "APPROVED", approved_at: timestamp, release_sha: RELEASE_SHA },
    { role: "site_owner", identity_reference: "approval-site-789", decision: "APPROVED", approved_at: timestamp, release_sha: RELEASE_SHA },
  ];
  if (rfid) {
    approvals.push({ role: "rfid_specialist", identity_reference: "approval-rfid-012", decision: "APPROVED", approved_at: timestamp, release_sha: RELEASE_SHA });
  }

  return {
    schema: "factoryos.wms.hardware-acceptance/v1",
    release_sha: RELEASE_SHA,
    environment: "staging",
    site: "Plant acceptance lab",
    test_run_id: "WMS-HIL-2026-10-26-001",
    operator_identity: "operator-reference-123",
    tested_at: timestamp,
    scope: {
      offline_mobile: true,
      label_print_scan: true,
      rfid,
      ...(!rfid ? { rfid_exclusion_reason: "Release owner confirmed RFID is outside this site's approved release scope." } : {}),
    },
    devices: {
      handhelds: [
        device("HH-01", { os_version: "Android 15", browser_version: "Chrome 155" }),
        device("HH-02", { os_version: "Android 15", browser_version: "Chrome 155" }),
      ],
      scanners: [device("SCAN-01", { interface: "Bluetooth HID" })],
      printers: [device("PRINT-01", { driver: "Site approved driver 1.0", dpi: "203", media: "100x75mm thermal label" })],
      ...(rfid ? {
        rfid_readers: [device("RFID-01", { interface: "USB serial", antenna_configuration: "Antenna 1; approved test zone" })],
      } : {}),
    },
    scenarios: testScenarios,
    attachments,
    approvals,
  };
}

async function withBundle(options, run) {
  const evidenceRoot = await mkdtemp(join(tmpdir(), "factoryos-wms-hil-"));
  try {
    const manifest = await makeBundle(evidenceRoot, options);
    await run(evidenceRoot, manifest);
  } finally {
    await rm(evidenceRoot, { recursive: true, force: true });
  }
}

test("physical WMS acceptance accepts complete hash-checked field evidence bound to the exact release", async () => {
  await withBundle({ rfid: true }, async (evidenceRoot, manifest) => {
    const report = await validateWmsHardwareAcceptanceManifest(manifest, {
      evidenceRoot,
      expectedReleaseSha: RELEASE_SHA,
    });
    assert.equal(report.pass, true, JSON.stringify(report.issues));
    assert.equal(report.result, "PASS_PHYSICAL_HARDWARE_ACCEPTANCE_BUNDLE");
    assert.equal(report.attachment_files_checked, manifest.attachments.length);
  });
});

test("simulated RFID or browser-only test runs cannot be accepted as physical hardware evidence", async () => {
  await withBundle({ rfid: true }, async (evidenceRoot, manifest) => {
    manifest.scenarios.find((scenario) => scenario.id === "rf_burst_disconnect_reconnect").execution_mode = "SIMULATED_SERIAL_STREAM";
    const report = await validateWmsHardwareAcceptanceManifest(manifest, {
      evidenceRoot,
      expectedReleaseSha: RELEASE_SHA,
    });
    assert.equal(report.pass, false);
    assert.ok(report.issues.some((issue) => issue.code === "SIMULATED_RUN_NOT_PHYSICAL_ACCEPTANCE"));
  });
});

test("physical acceptance requires attachment digests to match and rejects path traversal", async () => {
  await withBundle({ rfid: true }, async (evidenceRoot, manifest) => {
    manifest.attachments[0].sha256 = "0".repeat(64);
    manifest.attachments[1].path = "../outside.json";
    const report = await validateWmsHardwareAcceptanceManifest(manifest, {
      evidenceRoot,
      expectedReleaseSha: RELEASE_SHA,
    });
    assert.equal(report.pass, false);
    assert.ok(report.issues.some((issue) => issue.code === "ATTACHMENT_DIGEST_MISMATCH"));
    assert.ok(report.issues.some((issue) => issue.code === "UNSAFE_ATTACHMENT_PATH"));
  });
});

test("physical acceptance rejects missing required device scenarios and release-SHA mismatch", async () => {
  await withBundle({ rfid: true }, async (evidenceRoot, manifest) => {
    manifest.scenarios = manifest.scenarios.filter((scenario) => scenario.id !== "multi_tab_and_cross_device_sync");
    const report = await validateWmsHardwareAcceptanceManifest(manifest, {
      evidenceRoot,
      expectedReleaseSha: "b".repeat(40),
    });
    assert.equal(report.pass, false);
    assert.ok(report.issues.some((issue) => issue.code === "REQUIRED_PHYSICAL_SCENARIO_MISSING"));
    assert.ok(report.issues.some((issue) => issue.code === "RELEASE_SHA_MISMATCH"));
  });
});

test("RFID-in-scope acceptance requires a named reader, all RFID scenarios and RFID specialist sign-off", async () => {
  await withBundle({ rfid: true }, async (evidenceRoot, manifest) => {
    manifest.devices.rfid_readers = [];
    manifest.approvals = manifest.approvals.filter((approval) => approval.role !== "rfid_specialist");
    manifest.scenarios = manifest.scenarios.filter((scenario) => scenario.id !== "quantity_reconciliation");
    const report = await validateWmsHardwareAcceptanceManifest(manifest, {
      evidenceRoot,
      expectedReleaseSha: RELEASE_SHA,
    });
    assert.equal(report.pass, false);
    assert.ok(report.issues.some((issue) => issue.code === "REQUIRED_PHYSICAL_DEVICE_MISSING"));
    assert.ok(report.issues.some((issue) => issue.code === "REQUIRED_PHYSICAL_SCENARIO_MISSING"));
    assert.ok(report.issues.some((issue) => issue.code === "REQUIRED_OWNER_ROLE_MISSING"));
  });
});

test("RFID may be excluded only with a release-scope reason; it does not imply an RFID pass", async () => {
  await withBundle({ rfid: false }, async (evidenceRoot, manifest) => {
    const report = await validateWmsHardwareAcceptanceManifest(manifest, {
      evidenceRoot,
      expectedReleaseSha: RELEASE_SHA,
    });
    assert.equal(report.pass, true, JSON.stringify(report.issues));
    manifest.scope.rfid_exclusion_reason = "";
    const rejected = await validateWmsHardwareAcceptanceManifest(manifest, {
      evidenceRoot,
      expectedReleaseSha: RELEASE_SHA,
    });
    assert.equal(rejected.pass, false);
    assert.ok(rejected.issues.some((issue) => issue.code === "REQUIRED_TEXT_MISSING_OR_INVALID" && issue.path === "$.scope.rfid_exclusion_reason"));
  });
});

test("production physical tests require explicit side-effect authorization and unique owner approvals for the same release", async () => {
  await withBundle({ rfid: false }, async (evidenceRoot, manifest) => {
    manifest.environment = "production";
    manifest.production_side_effects_authorized = false;
    manifest.approvals[1].identity_reference = manifest.approvals[0].identity_reference;
    manifest.approvals[2].release_sha = "b".repeat(40);
    const report = await validateWmsHardwareAcceptanceManifest(manifest, {
      evidenceRoot,
      expectedReleaseSha: RELEASE_SHA,
    });
    assert.equal(report.pass, false);
    assert.ok(report.issues.some((issue) => issue.code === "PRODUCTION_TEST_REQUIRES_AUTHORIZATION_REFERENCE"));
    assert.ok(report.issues.some((issue) => issue.code === "OWNER_APPROVERS_MUST_BE_DISTINCT"));
    assert.ok(report.issues.some((issue) => issue.code === "OWNER_APPROVAL_RELEASE_SHA_MISMATCH"));
  });
});

test("physical acceptance rejects secret-bearing manifest fields", async () => {
  await withBundle({ rfid: false }, async (evidenceRoot, manifest) => {
    manifest.private_key = "must-not-be-shared";
    const report = await validateWmsHardwareAcceptanceManifest(manifest, {
      evidenceRoot,
      expectedReleaseSha: RELEASE_SHA,
    });
    assert.equal(report.pass, false);
    assert.ok(report.issues.some((issue) => issue.code === "SECRET_BEARING_FIELD_NAME"));
  });
});
