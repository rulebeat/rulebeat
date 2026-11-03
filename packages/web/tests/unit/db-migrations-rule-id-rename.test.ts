/**
 * A rule-id rename rewrites everything derived from the id (docs/engineering/conventions/data.md), and the
 * trend record is derived from the rule id (ADR 0012). Lists every table that has a `rule_id` column, from the
 * migrated schema rather than from a list kept here, puts one row under a legacy built-in id in each, runs the
 * rename and fails for any table the helper left on the old id. A new table with a `rule_id` is therefore
 * covered the day it is created, and one the helper skips fails here until it is rewritten or listed in
 * `NOT_RENAMED` with the reason.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/migrate';
import { makeSample, open, upgradeInProcess } from '../fixtures/upgrade';

const OLD_ID = 'builtin::orphan-unattached-disk';
const NEW_ID = '7a25444f-90c1-4c4e-b6dc-3076a857dfa8';

/** Tables with a `rule_id` the rename leaves alone, and why. Each is a gap that was there before the trend record. */
const NOT_RENAMED: Record<string, string> = {
  rule_versions: 'the seeder records the new id\'s versions again; rows under the old id are left behind unread',
};

let sqlite: Database.Database | undefined;
afterEach(() => { sqlite?.close(); sqlite = undefined; });

function tablesWithRuleId(db: Database.Database): string[] {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[];
  return tables
    .map(t => t.name)
    .filter(name => (db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).some(c => c.name === 'rule_id'))
    .sort();
}

/** One row under `OLD_ID`: every column that must have a value gets a placeholder of its type. */
function insertUnderOldId(db: Database.Database, table: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[];
  const values: Record<string, unknown> = {};
  for (const c of columns) {
    if (c.name === 'rule_id') values[c.name] = OLD_ID;
    else if (c.pk === 1 && /^INTEGER$/i.test(c.type) && columns.filter(x => x.pk > 0).length === 1) continue;
    else if (c.notnull && c.dflt_value === null) values[c.name] = /INT/i.test(c.type) ? 0 : 'x';
  }
  const names = Object.keys(values);
  db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...names.map(n => values[n]));
}

describe('renaming a rule id', () => {
  it('rewrites the rule id in every table that has one, the trend record\'s two included', () => {
    const sample = makeSample('current');
    upgradeInProcess(sample);
    sqlite = open(sample.file);

    const heldUnder = (table: string, id: string) => (sqlite!.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE rule_id = ?`).get(id) as { n: number }).n;
    const tables = tablesWithRuleId(sqlite);
    expect(tables).toEqual(expect.arrayContaining(['findings', 'finding_events', 'scan_findings', 'column_catalogue', 'trend_cells', 'trend_rule_facts']));
    // The seeder may already hold rows under the new id (the shipped rule it renames to), so the count before is what the move adds to.
    const newIdBefore = Object.fromEntries(tables.map(table => [table, heldUnder(table, NEW_ID)]));
    for (const table of tables) insertUnderOldId(sqlite, table);

    runMigrations(sqlite);

    const skipped = tables
      .filter(table => !(table in NOT_RENAMED))
      .filter(table => heldUnder(table, OLD_ID) > 0);
    expect(skipped, 'tables the rename left on the old rule id').toEqual([]);
    for (const table of tables.filter(t => !(t in NOT_RENAMED))) {
      expect(heldUnder(table, NEW_ID), table).toBe(newIdBefore[table]! + 1);
    }
  });

  it('lists each exception only while the table still holds a rule id', () => {
    const sample = makeSample('current');
    upgradeInProcess(sample);
    sqlite = open(sample.file);
    expect(tablesWithRuleId(sqlite)).toEqual(expect.arrayContaining(Object.keys(NOT_RENAMED)));
  });
});
