/**
 * #273: the upgrade that adds `management_group_hierarchy`. Run on a database as the previous release
 * left it (every other table filled, this one absent). Migrations swallow their own errors, so the test
 * reads content back: every user, role assignment, rule, finding and suppression is as it was, and the
 * new table exists, empty, with the columns the two schema twins declare.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { makeSample, open, upgradeInProcess } from '../fixtures/upgrade';
import { managementGroupHierarchy } from '@/lib/db/schema';

let sqlite: Database.Database | undefined;
afterEach(() => { sqlite?.close(); sqlite = undefined; });

const rowsOf = (db: Database.Database, table: string, order: string) =>
  db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() as Record<string, unknown>[];

const CARRIED = [
  ['users', 'id'], ['role_assignments', 'user_id, tenant_id, scope'], ['rules', 'id'], ['findings', 'fingerprint, rule_id'],
  ['suppressions', 'id'], ['local_accounts', 'user_id'], ['dashboards', 'id'],
] as const;

describe('upgrading from the release before management group Scopes', () => {
  it('leaves users, role assignments, rules, findings and suppressions as they were, and adds the empty table', () => {
    const sample = makeSample('pre-rbac');
    upgradeInProcess(sample);
    sqlite = open(sample.file);

    // The previous release: everything this one has, bar the table.
    sqlite.exec('DROP TABLE management_group_hierarchy');
    sqlite.prepare(`
      INSERT INTO users (id, email, role, session_epoch, created_at, access_source)
      VALUES ('mg-up-viewer', 'mg-up-viewer@example.com', 'viewer', 0, '2026-01-02T03:04:05.000Z', 'manual')
    `).run();
    sqlite.prepare(`INSERT INTO role_assignments (user_id, tenant_id, scope, role) VALUES ('mg-up-viewer', 't', '/subscriptions/00000000-0000-0000-0000-00000000000a', 'viewer')`).run();
    sqlite.prepare(`INSERT INTO role_assignments (user_id, tenant_id, scope, role) VALUES ('mg-up-viewer', 't', '/providers/Microsoft.Management/managementGroups/mg-example', 'viewer')`).run();

    const before = Object.fromEntries(CARRIED.map(([table, order]) => [table, rowsOf(sqlite!, table, order)]));
    // The comparison has teeth only if there is something to compare.
    expect(before.rules!.length).toBeGreaterThan(0);
    expect(before.suppressions!.length).toBeGreaterThan(0);
    expect(before.role_assignments!.length).toBe(2);
    sqlite.close();

    upgradeInProcess(sample);
    sqlite = open(sample.file);

    for (const [table, order] of CARRIED) expect(rowsOf(sqlite, table, order), table).toEqual(before[table]);
    expect(rowsOf(sqlite, 'management_group_hierarchy', 'node_id')).toEqual([]);
  });

  it('creates the table with the columns and primary key the Drizzle schema declares', () => {
    const sample = makeSample('current');
    upgradeInProcess(sample);
    sqlite = open(sample.file);
    const columns = sqlite.prepare(`PRAGMA table_info(management_group_hierarchy)`).all() as { name: string; notnull: number; pk: number }[];
    const declared = getTableConfig(managementGroupHierarchy).columns;
    expect(columns.map(c => c.name).sort()).toEqual(declared.map(c => c.name).sort());
    for (const column of columns) {
      expect(Boolean(column.notnull) || column.pk > 0, column.name).toBe(declared.find(d => d.name === column.name)!.notNull);
    }
    expect(columns.filter(c => c.pk > 0).map(c => c.name).sort()).toEqual(['kind', 'node_id', 'tenant_id']);
  });

  it('leaves a copy of the tree already stored alone when the upgrade runs again', () => {
    const sample = makeSample('current');
    upgradeInProcess(sample);
    sqlite = open(sample.file);
    sqlite.prepare(`INSERT INTO management_group_hierarchy (tenant_id, kind, node_id, display_name, parent_id) VALUES ('t', 'managementGroup', 'mg-example', 'Example', NULL)`).run();
    sqlite.close();

    upgradeInProcess(sample);
    sqlite = open(sample.file);
    expect(rowsOf(sqlite, 'management_group_hierarchy', 'node_id')).toEqual([
      { tenant_id: 't', kind: 'managementGroup', node_id: 'mg-example', display_name: 'Example', parent_id: null },
    ]);
  });
});
