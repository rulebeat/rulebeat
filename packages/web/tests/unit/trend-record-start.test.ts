/**
 * Recording from the first start (ADR 0012). The start is part of the seed path both backends share, so it
 * is driven here through `runSeeds()` on a throwaway SQLite file with an injected clock; the Postgres twin
 * (`seedPg()`) runs the same script over the same tables. A database as the previous release left it has
 * findings and no trend record.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { openDatabase, runMigrations, runSeeds } from '@/lib/db/migrate';
import { trendCells, trendRecordedDays, trendRuleFacts, trendState } from '@/lib/db/schema';
import { makeSample, type Sample } from '../fixtures/upgrade';
import { catalogueOf, shippedRule } from '../helpers/catalogue';

const RULE_A = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const RULE_B = 'bbbbbbbb-0000-4000-8000-0000000000b2';
const T1 = new Date('2026-05-20T10:00:00.000Z');
const T1_LATER = new Date('2026-05-20T18:45:00.000Z');
const T2 = new Date('2026-05-21T07:15:00.000Z');
const catalogue = catalogueOf(
  shippedRule({ id: RULE_A, definition: { name: 'Rule A' } }),
  shippedRule({ id: RULE_B, enabled: false, definition: { name: 'Rule B' } }),
);

let sample: Sample;
let sqlite: Database.Database;

beforeEach(() => {
  sample = makeSample('current');
  sqlite = openDatabase(sample.file);
  runMigrations(sqlite);
});
afterEach(() => { sqlite.close(); vi.restoreAllMocks(); });

const start = (now: Date) => runSeeds(sqlite, sample.dataDir, { catalogue, now, skipOwnerBootstrap: true });
const rows = (table: string) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[];

let counter = 0;
function insertFinding(over: Record<string, unknown>): string {
  const row: Record<string, unknown> = {
    fingerprint: `fp-${++counter}`, rule_id: RULE_A, category: 'security', severity: 'high', kind: 'state', subscription_id: 'SUB-1',
    resource_group: 'RG-A', placement: 'resource', title: 't', status: 'active', first_seen_at: '2026-04-01T00:00:00.000Z',
    last_seen_at: '2026-04-01T00:00:00.000Z', ...over,
  };
  const keys = Object.keys(row);
  sqlite.prepare(`INSERT INTO findings (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(k => row[k]));
  return row.fingerprint as string;
}

/** The database as the previous release left it: the shipped rules seeded, findings stored, no trend record. */
function previousRelease(): void {
  start(new Date('2026-01-01T00:00:00.000Z'));
  insertFinding({});
  insertFinding({ subscription_id: 'sub-1', resource_group: 'rg-a' });
  const suppressed = insertFinding({});
  insertFinding({ resource_group: 'RG-B', severity: 'low' });
  insertFinding({ resource_group: null, subscription_id: '', placement: 'management-group', management_group_id: 'MG-1', severity: 'medium' });
  insertFinding({ status: 'fixed' });
  insertFinding({ kind: 'activity' });
  sqlite.prepare(`INSERT INTO suppressions (id, fingerprint, reason, suppressed_at) VALUES ('s1', ?, 'accepted', '2026-04-02T00:00:00.000Z')`).run(suppressed);
  for (const table of ['trend_cells', 'trend_rule_facts', 'trend_recorded_days', 'trend_state']) sqlite.exec(`DELETE FROM ${table}`);
}

describe('the first start', () => {
  it('writes one row per non-zero cell, one fact row per rule and one marker, all dated by the injected clock', () => {
    previousRelease();

    start(T1);

    const at = T1.toISOString();
    expect(rows('trend_cells').map(({ seq: _seq, ...c }) => c)).toEqual(expect.arrayContaining([
      { rule_id: RULE_A, placement: 'resource', subscription_id: 'sub-1', resource_group: 'rg-a', management_group_id: '', severity: 'high', changed_at: at, open_count: 2, suppressed_count: 1 },
      { rule_id: RULE_A, placement: 'resource', subscription_id: 'sub-1', resource_group: 'rg-b', management_group_id: '', severity: 'low', changed_at: at, open_count: 1, suppressed_count: 0 },
      { rule_id: RULE_A, placement: 'management-group', subscription_id: '', resource_group: '', management_group_id: 'mg-1', severity: 'medium', changed_at: at, open_count: 1, suppressed_count: 0 },
    ]));
    expect(rows('trend_cells')).toHaveLength(3);

    expect(rows('trend_rule_facts').map(f => [f.rule_id, f.changed_at, f.enabled, f.deleted])).toEqual([
      [RULE_A, at, 1, 0],
      [RULE_B, at, 0, 0],
    ]);
    expect(rows('trend_recorded_days')).toEqual([{ day: '2026-05-20', record_version: 1, first_recorded_at: at, covered: '[]' }]);
  });

  it('starts the event window 180 days back when finding events exist, and at the upgrade day when none do', () => {
    previousRelease();
    start(T1);
    expect(rows('trend_state')[0]).toMatchObject({ id: 1, events_kept_since: '2026-05-20' });

    sqlite.exec('DELETE FROM trend_state');
    sqlite.prepare(`INSERT INTO finding_events (id, fingerprint, rule_id, category, scan_id, type, occurred_at) VALUES ('e1', 'fp-1', ?, 'security', 'scan-1', 'created', '2026-04-01T00:00:00.000Z')`).run(RULE_A);
    start(T1);
    expect(rows('trend_state')[0]).toMatchObject({ id: 1, events_kept_since: '2025-11-21' });
  });

  it('changes nothing a customer had: rules, findings, suppressions and events are as they were', () => {
    previousRelease();
    sqlite.prepare(`INSERT INTO finding_events (id, fingerprint, rule_id, category, scan_id, type, occurred_at) VALUES ('e1', 'fp-1', ?, 'security', 'scan-1', 'created', '2026-04-01T00:00:00.000Z')`).run(RULE_A);
    const carried = ['rules', 'findings', 'suppressions', 'finding_events', 'rule_versions'];
    const before = carried.map(rows);

    start(T1);

    expect(carried.map(rows)).toEqual(before);
    expect(before[1]!.length).toBeGreaterThan(0);
  });

  it('writes nothing on a second start on the same day', () => {
    previousRelease();
    start(T1);
    const tables = ['trend_cells', 'trend_rule_facts', 'trend_recorded_days'];
    const before = tables.map(rows);

    start(T1_LATER);

    expect(tables.map(rows)).toEqual(before);
    expect(before[0]!.length).toBeGreaterThan(0);
  });

  it('does not warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    previousRelease();
    start(T1);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('a later start', () => {
  it('corrects only the key whose write was skipped, dated at that start, and logs counts only', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    previousRelease();
    start(T1);
    const before = rows('trend_cells');
    insertFinding({ subscription_id: 'SECRET-SUB', resource_group: 'secret-rg', severity: 'critical' });

    start(T2);

    const after = rows('trend_cells');
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toMatchObject({ rule_id: RULE_A, subscription_id: 'secret-sub', severity: 'critical', changed_at: T2.toISOString(), open_count: 1, suppressed_count: 0 });
    expect(rows('trend_rule_facts')).toHaveLength(2);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]!.join(' '));
    expect(message).toMatch(/1 cell/);
    for (const secret of ['secret', 'SECRET', RULE_A, 'sub-1', T2.toISOString()]) expect(message).not.toContain(secret);

    start(T2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('writes the marker of a day it is the first to see', () => {
    previousRelease();
    start(T1);

    start(T2);

    expect(rows('trend_recorded_days').map(d => d.day)).toEqual(['2026-05-20', '2026-05-21']);
  });
});

describe('a start that cannot record', () => {
  it('logs it and leaves nothing half written, rather than stopping the app booting', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    previousRelease();
    sqlite.exec('DROP TABLE trend_cells');

    expect(() => start(T1)).not.toThrow();

    expect(error).toHaveBeenCalledTimes(1);
    expect(rows('trend_rule_facts')).toEqual([]);
    expect(rows('trend_recorded_days')).toEqual([]);
  });
});

describe('the tables', () => {
  it('are created with the columns the Drizzle schema declares, and survive a second migration run', () => {
    for (const [table, name] of [[trendCells, 'trend_cells'], [trendRuleFacts, 'trend_rule_facts'], [trendRecordedDays, 'trend_recorded_days'], [trendState, 'trend_state']] as const) {
      const declared = getTableConfig(table).columns;
      const columns = sqlite.prepare(`PRAGMA table_info(${name})`).all() as { name: string; notnull: number; pk: number }[];
      expect(columns.map(c => c.name).sort(), name).toEqual(declared.map(c => c.name).sort());
      for (const column of columns) expect(column.notnull === 1 || column.pk > 0, `${name}.${column.name}`).toBe(declared.find(d => d.name === column.name)!.notNull);
    }
    runMigrations(sqlite);
  });

  it('number their rows by an autoincrement seq that is never reused', () => {
    sqlite.exec(`INSERT INTO trend_cells (rule_id, placement, subscription_id, resource_group, management_group_id, severity, changed_at, open_count, suppressed_count) VALUES ('r', 'resource', '', '', '', 'high', 't', 1, 0)`);
    sqlite.exec(`DELETE FROM trend_cells`);
    sqlite.exec(`INSERT INTO trend_cells (rule_id, placement, subscription_id, resource_group, management_group_id, severity, changed_at, open_count, suppressed_count) VALUES ('r', 'resource', '', '', '', 'high', 't', 1, 0)`);
    expect(rows('trend_cells')[0]!.seq).toBe(2);
  });
});
