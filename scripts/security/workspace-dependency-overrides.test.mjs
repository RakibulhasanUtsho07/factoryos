import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"));
const expected = {
  undici: ["6.29.1", "https://registry.npmjs.org/undici/-/undici-6.29.1.tgz", "sha512-EvRlUt/QqAEvXdQeRMYUfwOQsfzpDztykrG2owGEE/rBOBoYv9uF39ZzsNDh4lTFHhTr2XOZjKkYgueD12ZmGA=="],
  "fast-uri": ["3.1.9", "https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.9.tgz", "sha512-hS/0Wt3Ya043oKXs0sIxrMpKQITXhMLIrVAKKXi4gozGC9v7YRWVnXIZzjNPTO02M9BdxLCWqK1yRXgNziVyJQ=="],
  zod: ["4.6.7", "https://registry.npmjs.org/zod/-/zod-4.6.7.tgz", "sha512-g8W2D2kU6a8untc053fX1uVBKzM7yqAxW/3zwk83+6RyF2+SKOuV+c0wBDhUwzV1PaGapmZH+rmcUzPf+3CGwg=="],
};

test("patched workspace overrides match exact lockfile artifacts and integrity", () => {
  for (const [name, [version, resolved, integrity]] of Object.entries(expected)) {
    assert.equal(root.overrides?.[name], version, `${name} override drifted`);
    const entry = lock.packages?.[`node_modules/${name}`];
    assert.ok(entry, `${name} lockfile entry missing`);
    assert.equal(entry.version, version, `${name} locked version drifted`);
    assert.equal(entry.resolved, resolved, `${name} resolved tarball drifted`);
    assert.equal(entry.integrity, integrity, `${name} integrity drifted`);
    assert.equal(entry.dev, true, `${name} should remain dev-only for this remediation`);
  }
});

test("unreviewed major overrides remain absent", () => {
  for (const name of ["glob", "minimatch", "deepmerge"]) {
    assert.equal(Object.hasOwn(root.overrides ?? {}, name), false, `${name} must stay under explicit compatibility review`);
  }
});
