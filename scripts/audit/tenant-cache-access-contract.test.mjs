import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const SOURCE_ROOTS = ['apps', 'packages', 'services'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const RAW_CLIENT_PATH = 'services/api/src/saas/redis-tenant-cache.client.ts';
const CACHE_SERVICE_PATH = 'services/api/src/saas/tenant-cache.service.ts';
const CACHE_CONTRACT_PATH = 'services/api/src/saas/tenant-cache.contract.ts';
const CACHE_ADAPTER_PATH = 'services/api/src/saas/redis-cache-erasure.adapter.ts';
const CACHE_MODULE_PATH = 'services/api/src/saas/tenant-cache.module.ts';
const SAAS_MODULE_PATH = 'services/api/src/saas/saas.module.ts';
const RAW_CLIENT_REFERENCES = new Set([RAW_CLIENT_PATH, CACHE_SERVICE_PATH, CACHE_ADAPTER_PATH, CACHE_MODULE_PATH]);
const LOW_LEVEL_REDIS_IMPLEMENTATIONS = new Set([RAW_CLIENT_PATH, CACHE_SERVICE_PATH, CACHE_ADAPTER_PATH]);
const RAW_DRIVER_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](?:@redis\/client|ioredis|redis)['"]/;
const SOURCE_CLIENT_FACTORY = /\bcreateClient\s*\(|\bnew\s+(?:Redis|IORedis)\s*\(/;
const DIRECT_REDIS_SCRIPT = /\bredis\.call\s*\(/i;
const CACHE_NAMESPACE_LITERAL = 'factoryos:tenant:';

function relativePath(path) {
  return relative(ROOT, path).split(sep).join('/');
}

function isTestPath(path) {
  return path.split(sep).some((part) => ['test', 'tests', '__tests__'].includes(part))
    || /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(path);
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    if (['node_modules', 'dist', '.next', 'coverage', 'build'].includes(entry.name)) continue;
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(fullPath));
    else output.push(fullPath);
  }
  return output;
}

async function productionSources() {
  const result = [];
  for (const directory of SOURCE_ROOTS) {
    try {
      const entries = await walk(resolve(ROOT, directory));
      result.push(...entries.filter((path) => SOURCE_EXTENSIONS.has(extname(path)) && !isTestPath(path)));
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
  }
  return result.sort();
}

async function packageManifests() {
  const result = [resolve(ROOT, 'package.json')];
  for (const directory of SOURCE_ROOTS) {
    try {
      const entries = await walk(resolve(ROOT, directory));
      result.push(...entries.filter((path) => path.endsWith(sep + 'package.json')));
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
  }
  return [...new Set(result)].filter((path) => path.split(sep).at(-1) === 'package.json').sort();
}

async function readRequired(path) {
  return readFile(resolve(ROOT, path), 'utf8');
}

function methodBody(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, 'missing method marker: ' + startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, 'missing method boundary: ' + endMarker);
  return source.slice(start, end);
}

test('raw Redis driver/client construction is confined to the reviewed provider boundary', async () => {
  const files = await productionSources();
  const violations = [];
  for (const file of files) {
    const path = relativePath(file);
    const source = await readFile(file, 'utf8');
    if (RAW_DRIVER_IMPORT.test(source) && path !== RAW_CLIENT_PATH) violations.push(path + ': raw Redis driver import');
    if (SOURCE_CLIENT_FACTORY.test(source) && path !== RAW_CLIENT_PATH) violations.push(path + ': Redis client construction outside provider boundary');
    if (/\bRedisTenantCacheClient\b/.test(source) && !RAW_CLIENT_REFERENCES.has(path)) violations.push(path + ': raw Redis client referenced outside reviewed module boundary');
    if (DIRECT_REDIS_SCRIPT.test(source) && !LOW_LEVEL_REDIS_IMPLEMENTATIONS.has(path)) violations.push(path + ': Redis Lua command outside reviewed implementation boundary');
    if (source.includes(CACHE_NAMESPACE_LITERAL) && path !== CACHE_CONTRACT_PATH) violations.push(path + ': tenant-cache namespace literal outside namespace contract');
  }
  assert.deepEqual(violations, [], violations.join('\n'));
  assert.ok(files.length > 0, 'production source scan did not inspect any files');
});

test('only the API workspace declares the reviewed Redis driver', async () => {
  const manifests = await packageManifests();
  const violations = [];
  for (const file of manifests) {
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    const declared = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}), ...(manifest.optionalDependencies ?? {}) };
    for (const name of ['@redis/client', 'ioredis', 'redis']) {
      if (declared[name] === undefined) continue;
      const path = relativePath(file);
      if (path !== 'services/api/package.json' || name !== '@redis/client') violations.push(path + ': unexpected Redis driver ' + name);
      else if (declared[name] !== '6.3.0') violations.push(path + ': @redis/client must stay pinned to 6.3.0 pending reviewed upgrade');
    }
  }
  assert.deepEqual(violations, [], violations.join('\n'));
});

test('raw client is private to TenantCacheModule while app modules receive the facade and erasure adapter', async () => {
  const moduleSource = await readRequired(CACHE_MODULE_PATH);
  const moduleExports = moduleSource.match(/exports:\s*\[([\s\S]*?)\]/);
  assert.ok(moduleExports, 'TenantCacheModule must declare a reviewed export list');
  assert.match(moduleSource, /providers:\s*\[[\s\S]*?RedisTenantCacheClient/);
  assert.match(moduleExports[1], /\bTenantCacheService\b/);
  assert.match(moduleExports[1], /\bRedisCacheErasureAdapter\b/);
  assert.doesNotMatch(moduleExports[1], /\bRedisTenantCacheClient\b/);
  const saasModule = await readRequired(SAAS_MODULE_PATH);
  const providerBlock = saasModule.match(/providers:\s*\[([\s\S]*?)\n\s*\],\n\s*exports:/);
  assert.ok(providerBlock, 'SaasModule provider list must remain statically inspectable');
  assert.doesNotMatch(providerBlock[1], /^\s*RedisCacheErasureAdapter,\s*$/m, 'SaasModule should consume the module-exported adapter rather than instantiate a duplicate');
  assert.match(providerBlock[1], /inject:\s*\[[^\]]*WmsPodS3ErasureAdapter,\s*RedisCacheErasureAdapter/s);
});

test('TenantCacheService read/write methods use the atomic tenant/category erasure fence', async () => {
  const source = await readRequired(CACHE_SERVICE_PATH);
  const readMethod = methodBody(source, 'async get(', 'async set(');
  const writeMethod = methodBody(source, 'async set(', 'async delete(');
  assert.match(source, /READ_IF_UNFENCED[\s\S]*?redis\.call\('EXISTS', KEYS\[2\]\) == 1/);
  assert.match(source, /WRITE_IF_UNFENCED[\s\S]*?redis\.call\('EXISTS', KEYS\[2\]\) == 1/);
  assert.match(readMethod, /client\.eval\(READ_IF_UNFENCED/);
  assert.match(readMethod, /keys:\s*\[key,\s*fence\]/);
  assert.match(writeMethod, /client\.eval\(WRITE_IF_UNFENCED/);
  assert.match(writeMethod, /keys:\s*\[key,\s*fence\]/);
});
