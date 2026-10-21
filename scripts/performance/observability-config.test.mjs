import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
async function read(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('Prometheus scrapes every declared API instance with a bearer token and release identity', async () => {
  const config = await read('deploy/observability/prometheus.yml');
  assert.match(config, /metrics_path: \/api\/internal\/metrics/);
  assert.match(config, /bearer_token_file: \/run\/secrets\/metrics_scrape_token/);
  assert.match(config, /factoryos-api-1:3001/);
  assert.match(config, /factoryos-api-2:3001/);
  assert.match(config, /release_sha: REPLACE_WITH_DEPLOYED_COMMIT_SHA/);
  assert.match(config, /postgres-exporter:9187/);
});

test('PostgreSQL monitoring queries cover bounded queue-age and lock signals without tenant labels', async () => {
  const config = await read('deploy/observability/postgres-queries.yml');
  for (const name of [
    'factoryos_outbox:',
    'factoryos_outbox_oldest:',
    'factoryos_outbox_freshness:',
    'factoryos_pg_blocking_sessions:',
    'factoryos_pg_lock_wait:',
    'factoryos_pg_long_transactions:',
  ]) assert.ok(config.includes(name), 'missing custom query ' + name);
  assert.match(config, /pg_blocking_pids/);
  assert.match(config, /seconds_since_last_publish/);
  assert.match(config, /Never attach tenant IDs, event IDs, SQL, or payload values as metric labels/);
});

test('collector receiver uses TLS and exporter buffering stays bounded', async () => {
  const config = await read('deploy/observability/otel-collector.yaml');
  assert.match(config, /cert_file: \/run\/secrets\/otel_receiver_cert/);
  assert.match(config, /key_file: \/run\/secrets\/otel_receiver_key/);
  assert.match(config, /limit_mib: 512/);
  assert.match(config, /queue_size: 1000/);
  assert.match(config, /max_elapsed_time: 5m/);
  assert.match(config, /OTEL_BACKEND_ENDPOINT/);
});

test('alert definitions cover API SLO proposals, queue freshness and saturation with proposal labels', async () => {
  const rules = await read('deploy/observability/alert-rules.yml');
  for (const alert of [
    'FactoryOSApiHigh5xxRatio',
    'FactoryOSApiHighP95Latency',
    'FactoryOSApiHighP99Latency',
    'FactoryOSDatabasePoolWaiting',
    'FactoryOSPostgresBlockedSessions',
    'FactoryOSOutboxQueueOldestAge',
    'FactoryOSOutboxStalePublication',
    'FactoryOSOtlpSpansDropped',
  ]) assert.ok(rules.includes('alert: ' + alert), 'missing alert ' + alert);
  assert.match(rules, /policy_status: proposed/);
  const policy = await read('deploy/observability/slo-policy.yml');
  assert.match(policy, /status: NOT_OWNER_APPROVED/);
  assert.match(policy, /approval_reference: ""/);
});

test('operator alert routing reads its secret from a file instead of committing a webhook', async () => {
  const config = await read('deploy/observability/alertmanager.yml');
  assert.match(config, /url_file: \/run\/secrets\/oncall_webhook_url/);
  assert.doesNotMatch(config, /https:\/\/hooks\.(slack|discord)\.com/);
  const compose = await read('deploy/observability/compose.yaml');
  assert.match(compose, /127\.0\.0\.1:9090:9090/);
  assert.match(compose, /127\.0\.0\.1:3000:3000/);
  assert.match(compose, /metrics_scrape_token/);
  assert.match(compose, /postgres_exporter_password/);
});

test('provisioned dashboard is valid JSON and displays API, database, queue and OTLP signals', async () => {
  const dashboard = JSON.parse(await read('deploy/observability/grafana/dashboards/factoryos-operational-reliability.json'));
  assert.equal(dashboard.uid, 'factoryos-operational-reliability');
  assert.ok(dashboard.panels.length >= 12);
  const content = JSON.stringify(dashboard);
  for (const metric of [
    'factoryos_http_requests_total',
    'factoryos_http_request_duration_seconds_bucket',
    'factoryos_db_pool_connections',
    'factoryos_pg_blocking_sessions_count',
    'factoryos_outbox_oldest_age_seconds',
    'factoryos_trace_export_queue_length',
    'factoryos_trace_spans_dropped_total',
  ]) assert.ok(content.includes(metric), 'dashboard missing ' + metric);
});
