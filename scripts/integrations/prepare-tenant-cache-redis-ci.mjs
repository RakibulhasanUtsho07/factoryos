import { createClient } from '@redis/client';

if (process.env.CI !== 'true') {
  throw new Error('This Redis configuration harness is only allowed in CI');
}

const rawUrl = process.env.FACTORYOS_CACHE_URL || 'redis://127.0.0.1:6379/0';
const url = new URL(rawUrl);
if (url.protocol !== 'redis:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
  || (url.port && url.port !== '6379') || (url.pathname && url.pathname !== '/' && url.pathname !== '/0')) {
  throw new Error('CI cache setup may only target the isolated local Redis service');
}

const client = createClient({
  url: url.toString(),
  socket: { connectTimeout: 5000, socketTimeout: 15000 },
});
client.on('error', () => undefined);

try {
  await client.connect();
  if (await client.ping() !== 'PONG') throw new Error('Isolated Redis PING failed');
  await client.sendCommand(['CONFIG', 'SET', 'save', '']);
  await client.sendCommand(['CONFIG', 'SET', 'appendonly', 'yes']);
  await client.sendCommand(['CONFIG', 'SET', 'appendfsync', 'always']);

  const persistence = String(await client.sendCommand(['INFO', 'persistence']));
  if (!/(?:^|\r?\n)aof_enabled:1(?:\r?\n|$)/.test(persistence)
    || !/(?:^|\r?\n)aof_last_write_status:ok(?:\r?\n|$)/.test(persistence)) {
    throw new Error('Isolated Redis AOF did not become healthy');
  }
  const setting = await client.sendCommand(['CONFIG', 'GET', 'appendfsync']);
  const found = setting instanceof Map
    ? [...setting.entries()].find(([key]) => String(key).toLowerCase() === 'appendfsync')?.[1]
    : Array.isArray(setting)
      ? setting[setting.findIndex((item) => String(item).toLowerCase() === 'appendfsync') + 1]
      : null;
  if (String(found).toLowerCase() !== 'always') {
    throw new Error('Isolated Redis does not have appendfsync=always');
  }
  const saveSetting = await client.sendCommand(['CONFIG', 'GET', 'save']);
  const saveValue = saveSetting instanceof Map
    ? [...saveSetting.entries()].find(([key]) => String(key).toLowerCase() === 'save')?.[1]
    : Array.isArray(saveSetting)
      ? saveSetting[saveSetting.findIndex((item) => String(item).toLowerCase() === 'save') + 1]
      : null;
  if (String(saveValue) !== '') throw new Error('Isolated Redis RDB snapshots must be disabled');

  console.log('Isolated Redis erasure-fence persistence checks passed');
} finally {
  client.destroy();
}
