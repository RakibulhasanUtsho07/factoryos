#!/usr/bin/env node
/**
 * FactoryOS production deployment admission supports only Kubernetes minor
 * releases that are currently maintained and exercised by the admission CI.
 * Refresh this list together with the Kubernetes CI matrix when upstream
 * support rotates.
 */
import { pathToFileURL } from 'node:url';

export const SUPPORTED_KUBERNETES_MINOR_VERSIONS = Object.freeze([35, 36, 37]);

export function validateKubernetesServerVersion(document) {
  const version = document?.serverVersion;
  const majorText = String(version?.major ?? '');
  const minorText = String(version?.minor ?? '');
  const major = /^\d+$/.test(majorText) ? Number(majorText) : NaN;
  const minorMatch = /^(\d+)(?:\+)?$/.exec(minorText);
  const minor = minorMatch ? Number(minorMatch[1]) : NaN;

  if (major !== 1 || !Number.isSafeInteger(minor) ||
      !SUPPORTED_KUBERNETES_MINOR_VERSIONS.includes(minor)) {
    const supported = SUPPORTED_KUBERNETES_MINOR_VERSIONS.map((item) => '1.' + item).join(', ');
    const received = version?.gitVersion || ('v' + (majorText || 'unknown') + '.' + (minorText || 'unknown'));
    throw new Error(
      'Unsupported Kubernetes server version ' + received +
      '. FactoryOS backup-evidence enforcement requires a currently maintained, CI-tested version: ' + supported + '.',
    );
  }

  return { major, minor, gitVersion: version.gitVersion ?? ('v1.' + minor) };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const document = JSON.parse(input);
  const accepted = validateKubernetesServerVersion(document);
  process.stdout.write('Kubernetes server ' + accepted.gitVersion + ' is supported by FactoryOS backup-evidence enforcement.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write('[backup-evidence] ' + error.message + '\n');
    process.exitCode = 1;
  });
}
