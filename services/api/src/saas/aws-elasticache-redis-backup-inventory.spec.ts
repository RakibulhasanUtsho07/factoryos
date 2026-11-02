import { jest } from '@jest/globals';
import {
  captureAwsElastiCacheRedisBackupInventory,
  type AwsElastiCacheRedisBackupInventoryInput,
} from './aws-elasticache-redis-backup-inventory';

const account = '111111111111';
const readerRole = 'FactoryOSElasticacheBackupReader';
const credentials = {
  access_key_id: 'ASIAELASTICACHE12345',
  secret_access_key: 'elasticache-reader-secret-key-material-0123456789',
  session_token: 'elasticache-reader-session-token-material-0123456789',
};

function cacheCluster(id: string, engine = 'redis'): string {
  return '<CacheCluster><CacheClusterId>' + id + '</CacheClusterId>'
    + '<Engine>' + engine + '</Engine><EngineVersion>7.1</EngineVersion>'
    + '<CacheClusterStatus>available</CacheClusterStatus>'
    + '<ReplicationGroupId>rg-' + id + '</ReplicationGroupId>'
    + '<CacheNodeType>cache.r7g.large</CacheNodeType><NumCacheNodes>2</NumCacheNodes>'
    + '<SnapshotRetentionLimit>7</SnapshotRetentionLimit><SnapshotWindow>03:00-04:00</SnapshotWindow>'
    + '<CacheClusterCreateTime>2026-10-01T00:00:00.000Z</CacheClusterCreateTime>'
    + '</CacheCluster>';
}

function replicationGroup(id: string, globalId: string): string {
  return '<ReplicationGroup><ReplicationGroupId>' + id + '</ReplicationGroupId>'
    + '<NodeGroups><NodeGroup><NodeGroupId>0001</NodeGroupId>'
    + '<Status>node-group-status-must-not-shadow-root</Status>'
    + '<NodeGroupMembers><NodeGroupMember><CacheClusterId>' + id + '-001</CacheClusterId>'
    + '<CacheNodeId>0001</CacheNodeId><CurrentRole>primary</CurrentRole>'
    + '<PreferredAvailabilityZone>ap-southeast-1a</PreferredAvailabilityZone>'
    + '</NodeGroupMember></NodeGroupMembers></NodeGroup></NodeGroups>'
    + '<Status>available</Status><GlobalReplicationGroupInfo><GlobalReplicationGroupId>'
    + globalId + '</GlobalReplicationGroupId><GlobalReplicationGroupMemberRole>PRIMARY</GlobalReplicationGroupMemberRole>'
    + '</GlobalReplicationGroupInfo><MultiAZ>enabled</MultiAZ><AutomaticFailover>enabled</AutomaticFailover>'
    + '<ClusterEnabled>true</ClusterEnabled><SnapshotRetentionLimit>14</SnapshotRetentionLimit>'
    + '<SnapshotWindow>02:00-03:00</SnapshotWindow><SnapshottingClusterId>' + id + '-001</SnapshottingClusterId>'
    + '<MemberClusters><ClusterId>' + id + '-001</ClusterId><ClusterId>' + id + '-002</ClusterId></MemberClusters>'
    + '</ReplicationGroup>';
}

function globalReplicationGroup(): string {
  return '<GlobalReplicationGroup><GlobalReplicationGroupId>global-cache-01</GlobalReplicationGroupId>'
    + '<Status>available</Status><Engine>redis</Engine><EngineVersion>7.1</EngineVersion>'
    + '<CacheNodeType>cache.r7g.large</CacheNodeType><ClusterEnabled>true</ClusterEnabled>'
    + '<Members><ReplicationGroup><ReplicationGroupId>rg-primary</ReplicationGroupId>'
    + '<ReplicationGroupRegion>ap-southeast-1</ReplicationGroupRegion><Role>PRIMARY</Role><Status>available</Status>'
    + '</ReplicationGroup><ReplicationGroup><ReplicationGroupId>rg-replica</ReplicationGroupId>'
    + '<ReplicationGroupRegion>ap-northeast-1</ReplicationGroupRegion><Role>SECONDARY</Role><Status>available</Status>'
    + '</ReplicationGroup></Members></GlobalReplicationGroup>';
}

function snapshot(id: string, createdAt = '2026-11-01T05:30:00.000Z'): string {
  return '<Snapshot><SnapshotName>' + id + '</SnapshotName>'
    + '<ReplicationGroupId>rg-primary</ReplicationGroupId><CacheClusterId>cache-primary</CacheClusterId>'
    + '<SnapshotStatus>available</SnapshotStatus><SnapshotSource>manual</SnapshotSource>'
    + '<Engine>redis</Engine><EngineVersion>7.1</EngineVersion>'
    + '<CacheNodeType>cache.r7g.large</CacheNodeType><NumCacheNodes>2</NumCacheNodes>'
    + (createdAt ? '<SnapshotCreateTime>' + createdAt + '</SnapshotCreateTime>' : '')
    + '<NodeSnapshots><NodeSnapshot><CacheNodeId>0001</CacheNodeId>'
    + '<SnapshotCreateTime>' + (createdAt || '') + '</SnapshotCreateTime>'
    + '</NodeSnapshot></NodeSnapshots></Snapshot>';
}

function page(action: string, collection: string, items: string[], marker?: string): string {
  return '<' + action + 'Response><' + action + 'Result><' + collection + '>'
    + items.join('') + '</' + collection + '>'
    + (marker ? '<Marker>' + marker + '</Marker>' : '')
    + '</' + action + 'Result></' + action + 'Response>';
}

function sts(accountId = account, roleName = readerRole): string {
  return '<GetCallerIdentityResponse><GetCallerIdentityResult><Account>' + accountId + '</Account>'
    + '<Arn>arn:aws:sts::' + accountId + ':assumed-role/' + roleName + '/ci-run</Arn>'
    + '</GetCallerIdentityResult></GetCallerIdentityResponse>';
}

type PageMap = Record<string, string[]>;

function makeInput(
  options: {
    regions?: string[];
    pages?: PageMap;
    wrongIdentity?: boolean;
    deniedAction?: string;
    fetcherOverrides?: Partial<AwsElastiCacheRedisBackupInventoryInput>;
  } = {},
): {
  input: AwsElastiCacheRedisBackupInventoryInput;
  requests: Array<{ host: string; action: string; body: URLSearchParams; authorization: string }>;
} {
  const regions = options.regions ?? ['ap-southeast-1', 'ap-northeast-1'];
  const requests: Array<{ host: string; action: string; body: URLSearchParams; authorization: string }> = [];
  const pageIndices = new Map<string, number>();
  const fetcher = jest.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = init?.headers as Record<string, string>;
    const body = new URLSearchParams(String(init?.body ?? ''));
    const action = body.get('Action') ?? '';
    requests.push({
      host: url.host,
      action,
      body,
      authorization: String(headers?.authorization ?? ''),
    });
    if (action === 'GetCallerIdentity') return new Response(sts(options.wrongIdentity ? '999999999999' : account));
    if (options.deniedAction === action) {
      return new Response('<ErrorResponse><Error><Code>AccessDenied</Code></Error></ErrorResponse>', { status: 403 });
    }
    const region = url.host.split('.')[1] ?? '';
    const key = region + ':' + action;
    const supplied = options.pages?.[key];
    const index = pageIndices.get(key) ?? 0;
    pageIndices.set(key, index + 1);
    if (supplied) {
      const xml = supplied[index];
      if (!xml) throw new Error('unexpected extra page request for ' + key);
      return new Response(xml, { status: 200, headers: { 'content-type': 'text/xml' } });
    }
    if (action === 'DescribeCacheClusters') {
      return new Response(page(action, 'CacheClusters', [
        cacheCluster('cache-' + region),
        cacheCluster('memcached-' + region, 'memcached'),
      ]));
    }
    if (action === 'DescribeReplicationGroups') {
      return new Response(page(action, 'ReplicationGroups', [
        replicationGroup(region === 'ap-southeast-1' ? 'rg-primary' : 'rg-replica', 'global-cache-01'),
      ]));
    }
    if (action === 'DescribeGlobalReplicationGroups') {
      return new Response(page(action, 'GlobalReplicationGroups', [globalReplicationGroup()]));
    }
    if (action === 'DescribeSnapshots') {
      return new Response(page(action, 'Snapshots', [
        snapshot('manual.' + region),
      ]));
    }
    return new Response('<ErrorResponse><Error><Code>UnsupportedAction</Code></Error></ErrorResponse>', { status: 400 });
  });
  const input: AwsElastiCacheRedisBackupInventoryInput = {
    scopes: regions.map((region) => ({
      account_id: account,
      partition: 'aws',
      region,
      expected_assumed_role_name: readerRole,
      credentials,
    })),
    fetcher,
    now: () => new Date('2026-11-02T04:00:00.000Z'),
    ...options.fetcherOverrides,
  };
  return { input, requests };
}

describe('AWS ElastiCache Redis/Valkey backup inventory', () => {
  test('enumerates node-based clusters, replication groups, global datastore members and snapshots across all requested regions', async () => {
    const { input, requests } = makeInput();
    const result = await captureAwsElastiCacheRedisBackupInventory(input);

    expect(result.schema).toBe('factoryos.aws-elasticache-redis-backup-inventory/v1');
    expect(result.status).toBe('COMPLETE');
    expect(result.node_based_catalog_complete).toBe(true);
    expect(result.verified_scope_count).toBe(2);
    expect(result.cache_clusters).toHaveLength(2);
    expect(result.non_redis_cache_clusters_excluded).toBe(2);
    expect(result.replication_groups).toHaveLength(2);
    expect(result.replication_groups.find((x) => x.replication_group_id === 'rg-primary')?.status).toBe('available');
    expect(result.replication_groups[0]?.member_node_roles[0]?.current_role).toBe('primary');
    expect(result.global_replication_groups).toHaveLength(1);
    expect(result.global_replication_groups[0]?.members).toHaveLength(2);
    expect(result.global_replication_groups[0]?.observed_in_regions).toEqual(['ap-northeast-1', 'ap-southeast-1']);
    expect(result.snapshots).toHaveLength(2);
    expect(result.snapshots[0]?.snapshot_identity_kind).toBe('SNAPSHOT_NAME_AND_CREATE_TIME');
    expect(result.snapshots[0]?.snapshot_identity_reference).toMatch(/^elasticache-snapshot\.[a-f0-9]{40}$/);
    expect(result.query_receipt_references).toHaveLength(8);
    expect(result.pages_fetched).toBe(8);
    expect(result.requests_attempted).toBe(10);
    expect(result.whole_cache_backup_coverage_complete).toBe(false);
    expect(result.serverless_cache_and_snapshot_surfaces_enumerated).toBe(false);
    expect(result.self_managed_redis_aof_rdb_and_volume_backup_surfaces_enumerated).toBe(false);
    expect(result.provider_mutation_performed).toBe(false);
    expect(result.delete_api_available).toBe(false);
    expect(result.deletion_authorized).toBe(false);
    expect(requests.every((request) => request.authorization.startsWith('AWS4-HMAC-SHA256 Credential='))).toBe(true);
    expect(requests.every((request) => request.body.get('Version') === '2015-02-02' || request.action === 'GetCallerIdentity')).toBe(true);
    expect(requests.some((request) => request.action.startsWith('Delete') || request.action.startsWith('Modify'))).toBe(false);
    expect(requests.some((request) => request.body.get('ShowMemberInfo') === 'true')).toBe(true);
  });

  test('exhausts an empty snapshot continuation page and signs every page request', async () => {
    const pages: PageMap = {
      'ap-southeast-1:DescribeSnapshots': [
        page('DescribeSnapshots', 'Snapshots', [], 'empty-snapshot-page-token'),
        page('DescribeSnapshots', 'Snapshots', [snapshot('after-empty-page')]),
      ],
    };
    const { input, requests } = makeInput({ regions: ['ap-southeast-1'], pages });
    const result = await captureAwsElastiCacheRedisBackupInventory(input);
    expect(result.status).toBe('PARTIAL');
    expect(result.snapshots).toHaveLength(1);
    expect(result.blockers).toContain(account + ':ap-northeast-1:GLOBAL_DATASTORE_MEMBER_REGION_NOT_SCANNED');
    expect(result.pages_fetched).toBe(5);
    const snapshotRequests = requests.filter((request) => request.action === 'DescribeSnapshots');
    expect(snapshotRequests).toHaveLength(2);
    expect(snapshotRequests[0]?.body.get('Marker')).toBeNull();
    expect(snapshotRequests[1]?.body.get('Marker')).toBe('empty-snapshot-page-token');
    expect(snapshotRequests.every((request) => request.body.get('MaxRecords') === '50')).toBe(true);
    expect(snapshotRequests.every((request) => request.authorization.includes('SignedHeaders='))).toBe(true);
  });

  test('does not claim complete global replication coverage when a replica region was not requested', async () => {
    const { input } = makeInput({ regions: ['ap-southeast-1'] });
    const result = await captureAwsElastiCacheRedisBackupInventory(input);
    expect(result.status).toBe('PARTIAL');
    expect(result.node_based_catalog_complete).toBe(false);
    expect(result.unscanned_global_member_scopes).toEqual([{
      account_id: account,
      partition: 'aws',
      region: 'ap-northeast-1',
      global_replication_group_id: 'global-cache-01',
      replication_group_id: 'rg-replica',
    }]);
    expect(result.blockers).toContain(account + ':ap-northeast-1:GLOBAL_DATASTORE_MEMBER_REGION_NOT_SCANNED');
  });

  test('fails closed for an unexpected STS role identity and does not call ElastiCache APIs', async () => {
    const { input, requests } = makeInput({ regions: ['ap-southeast-1'], wrongIdentity: true });
    const result = await captureAwsElastiCacheRedisBackupInventory(input);
    expect(result.status).toBe('PARTIAL');
    expect(result.verified_scope_count).toBe(0);
    expect(result.cache_clusters).toEqual([]);
    expect(result.blockers).toContain(account + ':ap-southeast-1:ASSUMED_ROLE_IDENTITY_VERIFICATION_FAILED');
    expect(requests.map((request) => request.action)).toEqual(['GetCallerIdentity']);
  });

  test('marks an access-denied snapshot catalog as partial rather than synthesizing an empty backup inventory', async () => {
    const { input } = makeInput({ regions: ['ap-southeast-1'], deniedAction: 'DescribeSnapshots' });
    const result = await captureAwsElastiCacheRedisBackupInventory(input);
    expect(result.status).toBe('PARTIAL');
    expect(result.snapshots).toEqual([]);
    expect(result.blockers).toContain(account + ':ap-southeast-1:DESCRIBESNAPSHOTS_INVENTORY_INCOMPLETE');
  });

  test('rejects repeated continuation markers and preserves an explicit incomplete catalog outcome', async () => {
    const pages: PageMap = {
      'ap-southeast-1:DescribeReplicationGroups': [
        page('DescribeReplicationGroups', 'ReplicationGroups', [], 'repeat-marker'),
        page('DescribeReplicationGroups', 'ReplicationGroups', [], 'repeat-marker'),
      ],
    };
    const { input } = makeInput({ regions: ['ap-southeast-1'], pages });
    const result = await captureAwsElastiCacheRedisBackupInventory(input);
    expect(result.status).toBe('PARTIAL');
    expect(result.blockers).toContain(account + ':ap-southeast-1:DESCRIBEREPLICATIONGROUPS_INVENTORY_INCOMPLETE');
  });

  test('marks snapshots without a generation timestamp as partial and never treats the name as an immutable generation', async () => {
    const pages: PageMap = {
      'ap-southeast-1:DescribeSnapshots': [
        page('DescribeSnapshots', 'Snapshots', [snapshot('legacy-snapshot', '')]),
      ],
    };
    const { input } = makeInput({ regions: ['ap-southeast-1'], pages });
    const result = await captureAwsElastiCacheRedisBackupInventory(input);
    expect(result.status).toBe('PARTIAL');
    expect(result.snapshots[0]?.create_time).toBeNull();
    expect(result.blockers).toContain(account + ':ap-southeast-1:SNAPSHOT_GENERATION_TIMESTAMP_MISSING:legacy-snapshot');
    expect(result.deletion_authorized).toBe(false);
  });

  test('stops at the shared request/page budget and keeps deletion disabled', async () => {
    const { input } = makeInput({
      regions: ['ap-southeast-1'],
      fetcherOverrides: { max_pages: 2 },
    });
    const result = await captureAwsElastiCacheRedisBackupInventory(input);
    expect(result.status).toBe('PARTIAL');
    expect(result.blockers).toContain('GLOBAL_AWS_REQUEST_OR_PAGE_BUDGET_EXHAUSTED');
    expect(result.deletion_authorized).toBe(false);
  });
});
