/**
 * Placement correction and fingerprint rekey record their cells (ADR 0012). Both are upgrade steps that change a
 * posture input (where a finding sits, and which findings exist and which suppression covers them), so each is run
 * on a database as the previous release left it, with the record already holding the state before the step. The
 * assertions are on the cells the step left and on a recount afterwards writing nothing: if the step did not
 * record its own change in its own transaction, the recount would find the rows it should have found.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { computeLegacyFingerprint } from '@rulebeat/core/finding';
import { openDatabase, runMigrations } from '@/lib/db/migrate';
import { FINGERPRINT_CASE_MARKER } from '@/lib/db/fingerprint-rekey';
import { recountTrendSqlite } from '@/lib/db/trend-record';
import { makeSample } from '../fixtures/upgrade';

const RULE = '6b1f8c2e-4d3a-4f6b-9c1e-7a2d5e8f0b13';
const SUB = '00000000-0000-0000-0000-000000000000';
const T1 = new Date('2026-03-10T09:00:00.000Z');
const vm = (rg: string) => `/subscriptions/${SUB}/resourceGroups/${rg}/providers/Microsoft.Compute/virtualMachines/vm-1`;

let sqlite: Database.Database;

beforeEach(() => {
  const sample = makeSample('current');
  sqlite = openDatabase(sample.file);
  runMigrations(sqlite);
  sqlite.prepare(`
    INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types, conditions, type)
    VALUES (?, 'VMs without backup', 'test', 'security', 'high', 1, '{"level":"subscription"}', '[]', '[]', 'custom')
  `).run(RULE);
});
afterEach(() => { sqlite.close(); vi.restoreAllMocks(); });

function insertFinding(f: {
  fingerprint: string; resourceId: string; subscriptionId: string; resourceGroup: string | null; placement: string;
  status?: 'active' | 'resolved'; lastSeenAt?: string;
}): void {
  sqlite.prepare(`
    INSERT INTO findings (fingerprint, rule_id, category, severity, kind, resource_id, resource_type, resource_name, subscription_id, resource_group,
      placement, title, status, first_seen_at, last_seen_at)
    VALUES (?, ?, 'security', 'high', 'state', ?, 'microsoft.compute/virtualmachines', 'vm-1', ?, ?, ?, 'VMs without backup', ?,
      '2026-03-01T00:00:00.000Z', ?)
  `).run(f.fingerprint, RULE, f.resourceId, f.subscriptionId, f.resourceGroup, f.placement, f.status ?? 'active', f.lastSeenAt ?? '2026-03-01T00:00:00.000Z');
}

const recount = (at: Date) => sqlite.transaction(() => recountTrendSqlite(sqlite, { ruleIds: [RULE], now: at }))();
const cells = () => sqlite.prepare(`SELECT placement, subscription_id, resource_group, open_count, suppressed_count, changed_at FROM trend_cells ORDER BY seq`).all() as
  { placement: string; subscription_id: string; resource_group: string; open_count: number; suppressed_count: number; changed_at: string }[];

describe('placement correction', () => {
  it('records a finding moving to the place its columns imply, and a recount afterwards writes nothing', () => {
    // Stored as a resource, though it has neither a subscription nor a resource group: a tenant-level id.
    insertFinding({ fingerprint: 'fp-tenant', resourceId: '/providers/Microsoft.Foo/things/t1', subscriptionId: '', resourceGroup: null, placement: 'resource' });
    recount(T1);
    expect(cells()).toEqual([expect.objectContaining({ placement: 'resource', open_count: 1, changed_at: T1.toISOString() })]);

    runMigrations(sqlite);

    const after = cells();
    expect(after).toHaveLength(3);
    const written = after.slice(1).sort((a, b) => a.placement.localeCompare(b.placement));
    expect(written).toEqual([
      expect.objectContaining({ placement: 'resource', open_count: 0 }),
      expect.objectContaining({ placement: 'unplaceable', open_count: 1 }),
    ]);
    expect(written.every(c => c.changed_at > T1.toISOString())).toBe(true);
    expect(recount(new Date('2026-04-01T00:00:00.000Z'))).toEqual({ cells: 0, facts: 0 });
  });

  it('writes nothing when no finding needs placing', () => {
    insertFinding({ fingerprint: 'fp-vm', resourceId: vm('rg-app'), subscriptionId: SUB, resourceGroup: 'rg-app', placement: 'resource' });
    recount(T1);

    runMigrations(sqlite);

    expect(cells()).toHaveLength(1);
  });
});

describe('fingerprint rekey', () => {
  it('records two findings the casing bug split merging into one, and a recount afterwards writes nothing', () => {
    insertFinding({ fingerprint: computeLegacyFingerprint(RULE, vm('RG-APP')), resourceId: vm('RG-APP'), subscriptionId: SUB, resourceGroup: 'RG-APP', placement: 'resource' });
    insertFinding({ fingerprint: computeLegacyFingerprint(RULE, vm('rg-app')), resourceId: vm('rg-app'), subscriptionId: SUB, resourceGroup: 'rg-app', placement: 'resource' });
    sqlite.prepare(`DELETE FROM meta WHERE key = ?`).run(FINGERPRINT_CASE_MARKER);
    recount(T1);
    expect(cells()).toEqual([expect.objectContaining({ open_count: 2, changed_at: T1.toISOString() })]);

    runMigrations(sqlite);

    expect(cells().map(c => c.open_count)).toEqual([2, 1]);
    expect(cells()[1]!.changed_at > T1.toISOString()).toBe(true);
    expect(recount(new Date('2026-04-01T00:00:00.000Z'))).toEqual({ cells: 0, facts: 0 });
  });

  it('records an active finding merged into a resolved duplicate seen later, and a recount afterwards writes nothing', () => {
    // The merge keeps the duplicate seen last, here the resolved one, so the rule has no active finding afterwards.
    insertFinding({ fingerprint: computeLegacyFingerprint(RULE, vm('RG-APP')), resourceId: vm('RG-APP'), subscriptionId: SUB, resourceGroup: 'RG-APP', placement: 'resource' });
    insertFinding({
      fingerprint: computeLegacyFingerprint(RULE, vm('rg-app')), resourceId: vm('rg-app'), subscriptionId: SUB, resourceGroup: 'rg-app', placement: 'resource',
      status: 'resolved', lastSeenAt: '2026-03-05T00:00:00.000Z',
    });
    sqlite.prepare(`DELETE FROM meta WHERE key = ?`).run(FINGERPRINT_CASE_MARKER);
    recount(T1);
    expect(cells()).toEqual([expect.objectContaining({ open_count: 1, changed_at: T1.toISOString() })]);

    runMigrations(sqlite);

    expect(sqlite.prepare(`SELECT status FROM findings`).all()).toEqual([{ status: 'resolved' }]);
    expect(cells().map(c => c.open_count)).toEqual([1, 0]);
    expect(recount(new Date('2026-04-01T00:00:00.000Z'))).toEqual({ cells: 0, facts: 0 });
  });

  it('writes nothing once the marker is there', () => {
    insertFinding({ fingerprint: computeLegacyFingerprint(RULE, vm('RG-APP')), resourceId: vm('RG-APP'), subscriptionId: SUB, resourceGroup: 'RG-APP', placement: 'resource' });
    recount(T1);

    runMigrations(sqlite);

    expect(cells()).toHaveLength(1);
  });
});
