#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

export function validateAdmissionPolicyStatus(policy) {
  const name = policy?.metadata?.name ?? '<unknown>';
  const generation = policy?.metadata?.generation;
  const observed = policy?.status?.observedGeneration;
  if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(observed) || observed !== generation) {
    throw new Error('ValidatingAdmissionPolicy ' + name + ' has not observed its current generation: generation=' + generation + ', observedGeneration=' + observed);
  }

  if (!Object.prototype.hasOwnProperty.call(policy?.status ?? {}, 'typeChecking') || policy.status.typeChecking === null) {
    throw new Error('ValidatingAdmissionPolicy ' + name + ' has not completed CEL type-checking; status.typeChecking is absent');
  }

  const warnings = policy.status.typeChecking.expressionWarnings ?? [];
  if (!Array.isArray(warnings)) {
    throw new Error('ValidatingAdmissionPolicy ' + name + ' returned malformed typeChecking.expressionWarnings');
  }
  if (warnings.length > 0) {
    throw new Error(
      'ValidatingAdmissionPolicy ' + name + ' has CEL type-checking warnings:\n' +
      warnings.map((entry) => (entry.fieldRef ?? '<expression>') + ': ' + (entry.warning ?? JSON.stringify(entry))).join('\n'),
    );
  }

  return { name, generation, observedGeneration: observed, typeChecking: 'PASS', expressionWarnings: 0 };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const result = validateAdmissionPolicyStatus(JSON.parse(input));
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write('[admission-policy-status] ' + error.message + '\n');
    process.exitCode = 1;
  });
}
