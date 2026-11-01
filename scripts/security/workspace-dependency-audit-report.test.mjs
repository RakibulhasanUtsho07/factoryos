import assert from "node:assert/strict";
import test from "node:test";
import { formatWorkspaceAuditReport, summarizeWorkspaceAudit } from "./workspace-dependency-audit-report.mjs";

const sample = {
  vulnerabilities: {
    braces: {
      severity: "high",
      isDirect: false,
      range: "<3.0.3",
      via: [{ source: 1234, name: "braces", title: "Example advisory", url: "https://example.invalid/advisory", range: "<3.0.3" }],
      effects: ["micromatch"],
      nodes: ["node_modules/braces"],
      fixAvailable: { name: "braces", version: "3.0.4", isSemVerMajor: false },
    },
    "example-direct": {
      severity: "moderate",
      isDirect: true,
      range: "1.x",
      via: ["transitive-advisory"],
      effects: [],
      nodes: ["node_modules/example-direct"],
      fixAvailable: false,
    },
  },
  metadata: {
    vulnerabilities: { total: 2, critical: 0, high: 1, moderate: 1, low: 0 },
  },
};

test("summarizes severity, directness, advisory metadata and installed paths", () => {
  const result = summarizeWorkspaceAudit(sample);
  assert.deepEqual(result.summary, { total: 2, critical: 0, high: 1, moderate: 1, low: 0 });
  assert.equal(result.packageCount, 2);
  assert.equal(result.entries[0].name, "braces");
  assert.equal(result.entries[0].isDirect, false);
  assert.equal(result.entries[0].nodes[0], "node_modules/braces");
  assert.match(result.entries[0].via[0], /Example advisory/);
  assert.match(result.entries[0].fix, /braces@3.0.4/);
  assert.equal(result.entries[1].isDirect, true);
  assert.match(result.entries[1].fix, /no compatible automatic fix/);
});

test("formats all advisory evidence without suppressing unresolved findings", () => {
  const output = formatWorkspaceAuditReport(summarizeWorkspaceAudit(sample));
  assert.match(output, /2 total — 0 critical, 1 high, 1 moderate, 0 low/);
  assert.match(output, /Example advisory/);
  assert.match(output, /node_modules\/braces/);
  assert.match(output, /no compatible automatic fix reported/);
  assert.match(output, /does not weaken the production audit gate/);
});

test("rejects malformed or incomplete npm audit reports", () => {
  assert.throws(() => summarizeWorkspaceAudit(null), /missing vulnerabilities or metadata/);
  assert.throws(() => summarizeWorkspaceAudit({ vulnerabilities: {}, metadata: {} }), /missing metadata/);
  assert.throws(() => summarizeWorkspaceAudit({
    vulnerabilities: {},
    metadata: { vulnerabilities: { total: "0" } },
  }), /missing metadata/);
});
