#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const MAX_AUDIT_OUTPUT_BYTES = 16 * 1024 * 1024;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeFixAvailable(value) {
  if (value === true) return "available (review semver impact)";
  if (value === false || value == null) return "no compatible automatic fix reported";
  if (!isRecord(value)) return String(value);
  const name = typeof value.name === "string" ? value.name : "package update";
  const version = typeof value.version === "string" ? value.version : "version unspecified";
  const major = value.isSemVerMajor === true ? " (major update)" : "";
  return `${name}@${version}${major}`;
}

function normalizeAdvisory(via) {
  if (typeof via === "string") return via;
  if (!isRecord(via)) return "unclassified advisory metadata";
  const title = typeof via.title === "string" ? via.title : via.name ?? "unnamed advisory";
  const source = via.source == null ? "" : ` [${via.source}]`;
  const range = typeof via.range === "string" ? ` — affected range ${via.range}` : "";
  const url = typeof via.url === "string" ? ` — ${via.url}` : "";
  return `${title}${source}${range}${url}`;
}

export function summarizeWorkspaceAudit(report) {
  if (!isRecord(report) || !isRecord(report.vulnerabilities) || !isRecord(report.metadata)) {
    throw new TypeError("npm audit JSON is missing vulnerabilities or metadata");
  }
  const counts = report.metadata.vulnerabilities;
  if (!isRecord(counts) || !Number.isInteger(counts.total)) {
    throw new TypeError("npm audit JSON is missing metadata.vulnerabilities.total");
  }

  const entries = Object.entries(report.vulnerabilities).map(([name, item]) => {
    if (!isRecord(item)) throw new TypeError(`Invalid vulnerability record for ${name}`);
    const via = Array.isArray(item.via) ? item.via.map(normalizeAdvisory) : [];
    const nodes = Array.isArray(item.nodes) ? item.nodes.filter(x => typeof x === "string") : [];
    const effects = Array.isArray(item.effects) ? item.effects.filter(x => typeof x === "string") : [];
    return {
      name,
      severity: typeof item.severity === "string" ? item.severity : "unknown",
      isDirect: item.isDirect === true,
      range: typeof item.range === "string" ? item.range : "unspecified",
      via,
      nodes,
      effects,
      fix: normalizeFixAvailable(item.fixAvailable),
    };
  }).sort((a, b) => {
    const rank = { critical: 0, high: 1, moderate: 2, low: 3, unknown: 4 };
    return (rank[a.severity] ?? 4) - (rank[b.severity] ?? 4) || a.name.localeCompare(b.name);
  });

  return {
    summary: {
      total: counts.total,
      critical: Number.isInteger(counts.critical) ? counts.critical : 0,
      high: Number.isInteger(counts.high) ? counts.high : 0,
      moderate: Number.isInteger(counts.moderate) ? counts.moderate : 0,
      low: Number.isInteger(counts.low) ? counts.low : 0,
    },
    packageCount: entries.length,
    entries,
  };
}

export function formatWorkspaceAuditReport(summary) {
  const { total, critical, high, moderate, low } = summary.summary;
  const lines = [
    "Workspace npm audit diagnostic (informational; does not weaken the production audit gate)",
    `Summary: ${total} total — ${critical} critical, ${high} high, ${moderate} moderate, ${low} low`,
    `Affected package records: ${summary.packageCount}`,
  ];
  if (summary.packageCount === 0) {
    lines.push("No vulnerable package records were returned by npm audit.");
  }
  for (const item of summary.entries) {
    lines.push(
      "",
      `- ${item.name} [${item.severity}; ${item.isDirect ? "direct" : "transitive"}]`,
      `  Affected range: ${item.range}`,
      `  Installed paths: ${item.nodes.length ? item.nodes.join(", ") : "not supplied"}`,
      `  Dependents: ${item.effects.length ? item.effects.join(", ") : "none listed"}`,
      `  Fix: ${item.fix}`,
    );
    for (const advisory of item.via) lines.push(`  Advisory: ${advisory}`);
  }
  return `${lines.join("\n")}\n`;
}

function run() {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(executable, ["audit", "--json"], {
    encoding: "utf8",
    maxBuffer: MAX_AUDIT_OUTPUT_BYTES,
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (typeof result.stdout !== "string" || result.stdout.trim() === "") {
    throw new Error(`npm audit returned no JSON output (exit ${result.status ?? "unknown"}): ${result.stderr ?? ""}`);
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`npm audit output was not valid JSON: ${error.message}`);
  }
  const summary = summarizeWorkspaceAudit(report);
  process.stdout.write(formatWorkspaceAuditReport(summary));
  // Vulnerability findings are intentionally reported, not hidden or converted
  // into a passing security claim. The separate production audit remains gating.
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`Workspace dependency audit report failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
