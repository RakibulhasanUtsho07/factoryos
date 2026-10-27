#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { renderWmsLabel } from "../../apps/web/src/lib/wms-label-renderer.mjs";

const FIXTURES = [
  {
    name: "Code 128 B plain identifier",
    symbology: "CODE128",
    value: "LOT-TEST-01",
    expected: "LOT-TEST-01",
  },
  {
    name: "GS1 fixed GTIN plus net weight in kg",
    symbology: "GS1_128",
    value: "(01)09506000134352(3102)001250",
    expected: "01095060001343523102001250",
  },
  {
    name: "GS1 variable lot separator plus net weight in pounds",
    symbology: "GS1_128",
    value: "(10)LOT-01(01)09506000134352(3205)000125",
    expected: "10LOT-01\u001d01095060001343523205000125",
  },
  {
    name: "GS1 logistic gross weight",
    symbology: "GS1_128",
    value: "(3300)000125",
    expected: "3300000125",
  },
];

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    throw new Error(
      "Required independent decode tool \"" + command +
      "\" is unavailable. Install zbar-tools and librsvg2-bin. Details: " +
      result.error.message,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      "Independent decode tool \"" + command + "\" exited " + result.status +
      ". stdout=" + JSON.stringify(result.stdout) +
      " stderr=" + JSON.stringify(result.stderr),
    );
  }
  return result;
}

function makeLabelIssue(fixture) {
  return {
    symbology: fixture.symbology,
    barcode_value: fixture.value,
    copy_count: 1,
    label_layout: {
      page: { width_mm: 100, height_mm: 50 },
      fields: ["unit_code", "barcode_value", "status"],
    },
    encoded_payload: {
      schema: "factoryos.traceability-label/v1",
      identity_type: "TRACEABILITY_UNIT",
      unit_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      unit_code: fixture.value,
      barcode_value: fixture.value,
      status: "ACTIVE",
    },
  };
}

async function main() {
  const workspace = await mkdtemp(join(tmpdir(), "factoryos-wms-zbar-"));
  try {
    for (const [index, fixture] of FIXTURES.entries()) {
      const rendered = renderWmsLabel(makeLabelIssue(fixture));
      assert.equal(rendered.symbology, fixture.symbology);

      const dimensions = rendered.svg.match(/viewBox="0 0 (\d+) (\d+)"/);
      assert.ok(dimensions, "SVG viewBox missing for " + fixture.name);
      const rasterWidth = Number(dimensions[1]) * 8;
      const rasterHeight = Number(dimensions[2]) * 8;
      assert.ok(rasterWidth > 0 && rasterHeight > 0, "Invalid SVG dimensions for " + fixture.name);

      const prefix = String(index + 1).padStart(2, "0");
      const svgPath = join(workspace, prefix + ".svg");
      const pngPath = join(workspace, prefix + ".png");
      await writeFile(svgPath, rendered.svg, "utf8");

      // Rasterize the rendered output, then let ZBar independently decode pixels.
      // This checks the produced symbol rather than trusting the input HRI text.
      run("rsvg-convert", [
        "--width", String(rasterWidth),
        "--height", String(rasterHeight),
        "--output", pngPath,
        svgPath,
      ]);
      const decodedResult = run("zbarimg", [
        "--raw",
        "--quiet",
        "--set=code128.enable=1",
        pngPath,
      ]);
      const decoded = decodedResult.stdout.replace(/\r?\n$/, "");
      assert.equal(
        decoded,
        fixture.expected,
        "ZBar decode mismatch for " + fixture.name +
        ": expected " + JSON.stringify(fixture.expected) +
        ", received " + JSON.stringify(decoded),
      );
      console.log("PASS independent ZBar decode: " + fixture.name + " -> " + JSON.stringify(decoded));
    }
    console.log("PASS: " + FIXTURES.length + " rendered Code 128 / GS1-128 vectors decoded from rasterized pixels.");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
