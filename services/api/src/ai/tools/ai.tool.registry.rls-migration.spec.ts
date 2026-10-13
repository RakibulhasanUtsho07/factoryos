import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(
  resolve(
    process.cwd(),
    '../../migrations/026_ai_tool_registry_global_write_hardening.sql',
  ),
  'utf8',
).replace(/\s+/g, ' ');

describe('AI tool registry RLS hardening migration', () => {
  it('allows tenant sessions to read global tools and tools in their own tenant', () => {
    expect(migration).toContain(
      'CREATE POLICY ai_tool_registry_select_scope ON ai_tool_registry FOR SELECT USING ( tenant_id IS NULL OR tenant_id = factoryos_current_tenant_id() )',
    );
  });

  it('only allows tenant-scoped inserts for the active tenant', () => {
    expect(migration).toContain(
      'CREATE POLICY ai_tool_registry_insert_tenant_scope ON ai_tool_registry FOR INSERT WITH CHECK ( tenant_id IS NOT NULL AND tenant_id = factoryos_current_tenant_id() )',
    );
  });

  it('replaces the previous combined policy and does not reintroduce an all-command policy', () => {
    expect(migration).toContain(
      'DROP POLICY IF EXISTS ai_tool_registry_tenant_isolation ON ai_tool_registry',
    );
    expect(migration).not.toMatch(
      /CREATE POLICY\s+\S+\s+ON ai_tool_registry\s+FOR ALL/i,
    );
  });

  it('records the migration idempotently', () => {
    expect(migration).toContain(
      "'026_ai_tool_registry_global_write_hardening'",
    );
    expect(migration).toContain(
      'ON CONFLICT ( version ) DO NOTHING',
    );
  });
});
