/**
 * ADR 0016: the upgrade that adds `scope_sets`. Run on a database as the previous release left it (every
 * other table filled, this one absent). Migrations swallow their own errors, so the test reads content
 * back: every user, role assignment, rule, finding and suppression is as it was, and the new table exists,
 * empty, with the columns the two schema twins declare.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { makeSample, open, upgradeInProcess } from '../fixtures/upgrade';
import { scopeSets } from '@/lib/db/schema';

let sqlite: Database.Database | undefined;
afterEach(() => { sqlite?.close(); sqlite = undefined; });

const rowsOf = (db: Database.Database, table: string, order: string) =>
  db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() as Record<string, unknown>[];

const CARRIED = [
  ['users', 'id'], ['role_assignments', 'user_id, tenant_id, scope'], ['rules', 'id'], ['findings', 'fingerprint, rule_id'],
  ['suppressions', 'id'], ['local_accounts', 'user_id'], ['dashboards', 'id'], ['saved_views', 'id'],
] as const;

describe('upgrading from the release before Scope sets', () => {
  it('leaves users, role assignments, rules, findings and suppressions as they were, and adds the empty table', () => {
    const sample = makeSample('pre-rbac');
    upgradeInProcess(sample);
    sqlite = open(sample.file);

    // The previous release: everything this one has, bar the table.
    sqlite.exec('DROP TABLE scope_sets');
    sqlite.prepare(`
      INSERT INTO saved_views (id, name, tab, query, created_at, updated_at)
      VALUES ('set-up-view', 'Set upgrade view', 'results', 'scope=%2Fsubscriptions%2Fx', '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05.000Z')
    `).run();

    const before = Object.fromEntries(CARRIED.map(([table, order]) => [table, rowsOf(sqlite!, table, order)]));
    // The comparison has teeth only if there is something to compare.
    expect(before.rules!.length).toBeGreaterThan(0);
    expect(before.suppressions!.length).toBeGreaterThan(0);
    expect(before.saved_views!.length).toBe(1);
    sqlite.close();

    upgradeInProcess(sample);
    sqlite = open(sample.file);

    for (const [table, order] of CARRIED) expect(rowsOf(sqlite, table, order), table).toEqual(before[table]);
    expect(rowsOf(sqlite, 'scope_sets', 'hash')).toEqual([]);
  });

  it('creates the table with the columns and primary key the Drizzle schema declares', () => {
    const sample = makeSample('current');
    upgradeInProcess(sample);
    sqlite = open(sample.file);
    const columns = sqlite.prepare(`PRAGMA table_info(scope_sets)`).all() as { name: string; notnull: number; pk: number }[];
    const declared = getTableConfig(scopeSets).columns;
    expect(columns.map(c => c.name).sort()).toEqual(declared.map(c => c.name).sort());
    for (const column of columns) {
      expect(Boolean(column.notnull) || column.pk > 0, column.name).toBe(declared.find(d => d.name === column.name)!.notNull);
    }
    expect(columns.filter(c => c.pk > 0).map(c => c.name)).toEqual(['hash']);
  });

  it('leaves a set already stored alone when the upgrade runs again', () => {
    const sample = makeSample('current');
    upgradeInProcess(sample);
    sqlite = open(sample.file);
    sqlite.prepare(`INSERT INTO scope_sets (hash, paths, created_at) VALUES (?, ?, ?)`)
      .run('f'.repeat(64), JSON.stringify(['/subscriptions/00000000-0000-0000-0000-00000000000a']), '2026-01-02T03:04:05.000Z');
    sqlite.close();

    upgradeInProcess(sample);
    sqlite = open(sample.file);
    expect(rowsOf(sqlite, 'scope_sets', 'hash')).toEqual([
      { hash: 'f'.repeat(64), paths: '["/subscriptions/00000000-0000-0000-0000-00000000000a"]', created_at: '2026-01-02T03:04:05.000Z' },
    ]);
  });
});
