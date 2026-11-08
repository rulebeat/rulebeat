/**
 * The Postgres half of placement and rekey recording (ADR 0012). bootstrapPg() runs the placement correction and the
 * fingerprint rekey as upgrade steps, and a finding either one moves changes which cell it counts in, so the last
 * savepoint of the bootstrap recounts the rules of the findings that exist. Each step runs on a database whose record
 * already holds the state before it; the assertions are on the cells left and on a recount afterwards writing nothing.
 * Postgres only by nature; skipped on the default SQLite run (trend-record-corrections.test.ts makes the same
 * assertions there).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { computeLegacyFingerprint } from '@rulebeat/core/finding';
import { dbKind } from '@/lib/db/backend';
import { dbReady, pgDb } from '@/lib/db/client';
import { bootstrapPg } from '@/lib/db/pg/bootstrap';
import { FINGERPRINT_CASE_MARKER } from '@/lib/db/fingerprint-rekey';
import { recountTrendPg } from '@/lib/db/trend-record';
import { resetDb } from '../helpers/db';

const RULE = 'pg-trend-rule';
const SCAN = 'pg-trend-scan-1';
const SUB = '00000000-0000-0000-0000-000000000000';
const T1 = new Date('2026-03-10T09:00:00.000Z');
const vm = (rg: string) => `/subscriptions/${SUB}/resourceGroups/${rg}/providers/Microsoft.Compute/virtualMachines/vm-1`;

const raw = async (statement: string) => (await pgDb!.execute(sql.raw(statement))).rows as Record<string, unknown>[];
const lit = (v: string | null) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`);

async function databaseWithOneRule(): Promise<void> {
  await dbReady;
  await resetDb();
  await bootstrapPg(pgDb!);
  await raw(`
    INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types, conditions, raw_kql, query_backend, type)
    VALUES ('${RULE}', 'VMs without backup', 'test', 'security', 'high', true, '{"level":"subscription"}', '[]', '[]',
      'resources | project id, name, type, location, resourceGroup, subscriptionId', 'resource-graph', 'custom')`);
  await raw(`
    INSERT INTO scans (id, module, started_at, finished_at, duration_ms, subscriptions_scanned, findings, counts, total_rules, has_records)
    VALUES ('${SCAN}', 'security', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', 10, '[]', '[]', '{}', 1, 1)`);
}

async function insertFinding(f: { fingerprint: string; resourceId: string; subscriptionId: string; resourceGroup: string | null; placement: string }): Promise<void> {
  await raw(`
    INSERT INTO findings (fingerprint, rule_id, category, severity, kind, resource_id, resource_type, resource_name, subscription_id, resource_group,
      placement, title, evidence, evidence_rows, status, first_seen_at, last_seen_at, last_scan_id, times_seen, row_count, rows_scan_id)
    VALUES ('${f.fingerprint}', '${RULE}', 'security', 'high', 'state', ${lit(f.resourceId)}, 'microsoft.compute/virtualmachines', 'vm-1',
      '${f.subscriptionId}', ${lit(f.resourceGroup)}, '${f.placement}', 'VMs without backup', '{"n":1}', '[{"n":1}]', 'active',
      '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', '${SCAN}', 1, 1, '${SCAN}')`);
}

const recount = (at: Date) => pgDb!.transaction(tx => recountTrendPg(tx, { ruleIds: [RULE], now: at }));
const cells = async () => (await raw(`SELECT placement, open_count, suppressed_count, changed_at FROM trend_cells ORDER BY seq`)) as
  { placement: string; open_count: number; suppressed_count: number; changed_at: string }[];

describe.skipIf(dbKind !== 'pg')('bootstrapPg records what its upgrade steps move (ADR 0012)', () => {
  afterEach(async () => {
    await bootstrapPg(pgDb!);
    await resetDb();
  });

  describe('placement correction', () => {
    it('records a finding moving to the place its columns imply, and a recount afterwards writes nothing', async () => {
      await databaseWithOneRule();
      // Stored as a resource, though it has neither a subscription nor a resource group: a tenant-level id.
      await insertFinding({ fingerprint: 'fp-tenant', resourceId: '/providers/Microsoft.Foo/things/t1', subscriptionId: '', resourceGroup: null, placement: 'resource' });
      await recount(T1);
      expect(await cells()).toEqual([expect.objectContaining({ placement: 'resource', open_count: 1, changed_at: T1.toISOString() })]);

      await bootstrapPg(pgDb!);

      const after = await cells();
      expect(after).toHaveLength(3);
      const written = after.slice(1).sort((a, b) => a.placement.localeCompare(b.placement));
      expect(written).toEqual([
        expect.objectContaining({ placement: 'resource', open_count: 0 }),
        expect.objectContaining({ placement: 'unplaceable', open_count: 1 }),
      ]);
      expect(written.every(c => c.changed_at > T1.toISOString())).toBe(true);
      expect(await recount(new Date('2026-04-01T00:00:00.000Z'))).toEqual({ cells: 0, facts: 0 });
    });

    it('writes nothing when no finding needs placing', async () => {
      await databaseWithOneRule();
      await insertFinding({ fingerprint: 'fp-vm', resourceId: vm('rg-app'), subscriptionId: SUB, resourceGroup: 'rg-app', placement: 'resource' });
      await recount(T1);

      await bootstrapPg(pgDb!);

      expect(await cells()).toHaveLength(1);
    });
  });

  describe('fingerprint rekey', () => {
    it('records two findings the casing bug split merging into one, and a recount afterwards writes nothing', async () => {
      await databaseWithOneRule();
      await insertFinding({ fingerprint: computeLegacyFingerprint(RULE, vm('RG-APP')), resourceId: vm('RG-APP'), subscriptionId: SUB, resourceGroup: 'RG-APP', placement: 'resource' });
      await insertFinding({ fingerprint: computeLegacyFingerprint(RULE, vm('rg-app')), resourceId: vm('rg-app'), subscriptionId: SUB, resourceGroup: 'rg-app', placement: 'resource' });
      await raw(`DELETE FROM meta WHERE key = '${FINGERPRINT_CASE_MARKER}'`);
      await recount(T1);
      expect(await cells()).toEqual([expect.objectContaining({ open_count: 2, changed_at: T1.toISOString() })]);

      await bootstrapPg(pgDb!);

      const after = await cells();
      expect(after.map(c => c.open_count)).toEqual([2, 1]);
      expect(after[1]!.changed_at > T1.toISOString()).toBe(true);
      expect(await recount(new Date('2026-04-01T00:00:00.000Z'))).toEqual({ cells: 0, facts: 0 });
    });

    it('writes nothing once the marker is there', async () => {
      await databaseWithOneRule();
      await insertFinding({ fingerprint: computeLegacyFingerprint(RULE, vm('RG-APP')), resourceId: vm('RG-APP'), subscriptionId: SUB, resourceGroup: 'RG-APP', placement: 'resource' });
      await recount(T1);

      await bootstrapPg(pgDb!);

      expect(await cells()).toHaveLength(1);
    });
  });
});
