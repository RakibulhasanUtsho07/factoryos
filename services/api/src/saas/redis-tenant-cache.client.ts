import {
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RESP_TYPES } from '@redis/client';

type RedisClient = ReturnType<typeof createClient>;

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const MIN_CONNECT_TIMEOUT_MS = 1000;
const MAX_CONNECT_TIMEOUT_MS = 30000;

@Injectable()
export class RedisTenantCacheClient implements OnModuleDestroy {
  private client: RedisClient | null = null;
  private connecting: Promise<RedisClient> | null = null;

  constructor(private readonly config: ConfigService) {}

  /** Returns the singleton binary-safe client. Provider errors are never logged with URL/config values. */
  async getClient(): Promise<RedisClient> {
    if (this.client?.isReady) return this.client;
    if (this.connecting) return this.connecting;
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }

    const url = this.cacheUrl();
    if (!url) {
      throw new ServiceUnavailableException('Tenant cache provider is not configured');
    }

    const timeout = this.connectTimeoutMs();
    const client = createClient({
      url: url.toString(),
      disableOfflineQueue: true,
      socket: {
        connectTimeout: timeout,
        reconnectStrategy: (retries) => retries < 2
          ? Math.min(250 * (retries + 1), 1000)
          : new Error('tenant cache reconnect limit reached'),
      },
      commandOptions: {
        typeMapping: { [RESP_TYPES.BLOB_STRING]: Buffer },
      },
    });
    // node-redis requires an error listener. Deliberately do not log error objects:
    // their messages can contain provider host/config details.
    client.on('error', () => undefined);

    this.connecting = (async () => {
      try {
        await client.connect();
        this.client = client;
        return client;
      } catch {
        client.destroy();
        throw new ServiceUnavailableException('Tenant cache provider connection failed');
      } finally {
        this.connecting = null;
      }
    })();

    return this.connecting;
  }

  /**
   * Erasure only supports one standalone primary with no replica copies and no
   * cluster fan-out. Those other topologies need a separately reviewed adapter
   * that inventories every node/copy; scanning one endpoint must not prove them gone.
   */
  async assertStandalonePrimary(): Promise<void> {
    const client = await this.getClient();
    try {
      const ping = await client.ping();
      if (ping !== 'PONG') throw new Error('unexpected PING response');

      const clusterInfo = await client.sendCommand(['INFO', 'cluster']);
      const infoText = this.redisText(clusterInfo);
      if (!/(?:^|\r?\n)cluster_enabled:0(?:\r?\n|$)/.test(infoText)) {
        throw new Error('Redis Cluster is not a supported tenant-cache topology');
      }

      const memoryInfo = await client.sendCommand(['INFO', 'memory']);
      const memoryText = this.redisText(memoryInfo);
      if (!/(?:^|\r?\n)maxmemory_policy:noeviction(?:\r?\n|$)/.test(memoryText)) {
        throw new Error('Non-evicting cache topology is required to preserve erasure fences');
      }

      // Confirm that the atomic scripts used by cache writers/fence checks are
      // permitted by the provider ACL without mutating any keyspace.
      const scriptProbe: unknown = await client.eval('return 1', { keys: [], arguments: [] });
      if (scriptProbe !== 1) throw new Error('Redis Lua script execution is unavailable');

      const rawRole: unknown = await client.sendCommand(['ROLE']);
      if (!Array.isArray(rawRole) || this.redisText(rawRole[0]) !== 'master'
        || !Array.isArray(rawRole[2]) || rawRole[2].length !== 0) {
        throw new Error('Tenant cache must use a primary without unenumerated replica copies');
      }
    } catch {
      throw new ServiceUnavailableException(
        'Tenant cache topology cannot be independently enumerated by the configured erasure adapter',
      );
    }
  }

  async getBytes(key: string): Promise<Buffer | null> {
    const client = await this.getClient();
    const raw: unknown = await client.get(key);
    if (raw === null) return null;
    if (Buffer.isBuffer(raw)) return raw;
    if (typeof raw === 'string') return Buffer.from(raw, 'utf8');
    throw new ServiceUnavailableException('Tenant cache returned an unsupported value representation');
  }

  async onModuleDestroy(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client?.isOpen) client.destroy();
  }

  private cacheUrl(): URL | null {
    const raw = this.config.get<string>('FACTORYOS_CACHE_URL')?.trim();
    if (!raw) return null;
    try {
      const url = new URL(raw);
      const production = this.config.get<string>('NODE_ENV') === 'production';
      if (!['redis:', 'rediss:'].includes(url.protocol)
        || !url.hostname
        || url.search || url.hash
        || (url.pathname !== '' && url.pathname !== '/' && url.pathname !== '/0')
        || (production && (url.protocol !== 'rediss:' || !url.username || !url.password))) {
        return null;
      }
      return url;
    } catch {
      return null;
    }
  }

  private connectTimeoutMs(): number {
    const raw = this.config.get<string>('FACTORYOS_CACHE_CONNECT_TIMEOUT_MS');
    const parsed = raw === undefined || raw.trim() === '' ? DEFAULT_CONNECT_TIMEOUT_MS : Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < MIN_CONNECT_TIMEOUT_MS || parsed > MAX_CONNECT_TIMEOUT_MS) {
      return DEFAULT_CONNECT_TIMEOUT_MS;
    }
    return parsed;
  }

  private redisText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    throw new Error('Redis returned a non-text response');
  }
}
