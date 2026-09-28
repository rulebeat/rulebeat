import type Database from 'better-sqlite3';
import { DEMO_STAMP_KEY } from './stamp';

// Nothing here may import lib/db/client.ts. Every function takes the connection it works on, so the
// boot step (before client.ts has opened anything), the running app (through its own connection)
// and the tests (on throwaway files) all run the same code.

/** Meta key holding the moment the Demo's history ends: the newest simulated run. Written by the
 *  generator, moved forward by every shift. */
export const DEMO_HISTORY_ENDS_KEY = 'demo-history-ends-at';

/** Meta key holding when the last Reset happened. The banner compares it with what a browser last
 *  saw to show the one-time "this Demo was reset" notice. */
export const DEMO_RESET_AT_KEY = 'demo-reset-at';

/** A Reset refused because a database is not a Demo database. The message is for the operator. */
export class DemoResetRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoResetRefusedError';
  }
}

const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z/g;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// A cheap prefilter so the shift function only sees values that can hold a date at all.
const HAS_DATE_GLOB = '*[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*';
const SHIFT_FN = 'rulebeat_demo_shift';
// Marks a value moved in the first pass of a two-pass update, so a key column never holds two
// equal values mid-update. A control character cannot appear in any value RuleBeat writes.
const PENDING = '\u0001';

const SKIPPED_TABLES = new Set(['meta']);

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function utcDayNumber(d: Date): number {
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86_400_000);
}

function hasStamp(sqlite: Database.Database, schema: string): boolean {
  try {
    const row = sqlite
      .prepare(`SELECT 1 FROM ${schema}.meta WHERE key = ? LIMIT 1`)
      .get(DEMO_STAMP_KEY);
    return row !== undefined;
  } catch {
    return false;
  }
}

function userTables(sqlite: Database.Database, schema: string): string[] {
  return (sqlite
    .prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[]).map(r => r.name);
}

function columns(sqlite: Database.Database, schema: string, table: string): { name: string; type: string }[] {
  return sqlite.prepare(`PRAGMA ${schema}.table_info(${quoteIdent(table)})`).all() as { name: string; type: string }[];
}

/** Columns that are part of a primary key or a unique index, where shifting rows one at a time
 *  could briefly give two rows the same key. */
function keyColumns(sqlite: Database.Database, table: string): Set<string> {
  const keys = new Set<string>();
  for (const col of sqlite.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as { name: string; pk: number }[]) {
    if (col.pk > 0) keys.add(col.name);
  }
  for (const idx of sqlite.prepare(`PRAGMA index_list(${quoteIdent(table)})`).all() as { name: string; unique: number }[]) {
    if (!idx.unique) continue;
    for (const col of sqlite.prepare(`PRAGMA index_info(${quoteIdent(idx.name)})`).all() as { name: string | null }[]) {
      if (col.name) keys.add(col.name);
    }
  }
  return keys;
}

function readMeta(sqlite: Database.Database, key: string): string | null {
  const row = sqlite.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function writeMeta(sqlite: Database.Database, key: string, value: string): void {
  sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

/**
 * Moves every stored date so the Demo's history ends at `now`: finding ages, posture snapshots,
 * run and scan history, the audit log, and dates inside stored JSON. A timestamp moves by the exact
 * gap between the recorded end of history and `now`; a plain `YYYY-MM-DD` value (a posture
 * snapshot's day) moves by the same number of calendar days. Relative ages are unchanged, which is
 * the point: a finding that was 12 days old when the Demo was generated is 12 days old after a Reset.
 *
 * Does nothing on a database that has no recorded end of history. Runs in one transaction.
 */
export function shiftDemoHistory(sqlite: Database.Database, now: Date): void {
  const endsAt = readMeta(sqlite, DEMO_HISTORY_ENDS_KEY);
  if (!endsAt) return;
  const anchor = new Date(endsAt);
  if (Number.isNaN(anchor.getTime())) return;

  const deltaMs = now.getTime() - anchor.getTime();
  const deltaDays = utcDayNumber(now) - utcDayNumber(anchor);

  sqlite.function(SHIFT_FN, { deterministic: true }, (value: unknown) => {
    if (typeof value !== 'string') return value;
    if (ISO_DATE.test(value)) {
      const d = new Date(`${value}T00:00:00.000Z`);
      if (Number.isNaN(d.getTime())) return value;
      return new Date(d.getTime() + deltaDays * 86_400_000).toISOString().slice(0, 10);
    }
    return value.replace(ISO_TIMESTAMP, match => {
      const d = new Date(match);
      return Number.isNaN(d.getTime()) ? match : new Date(d.getTime() + deltaMs).toISOString();
    });
  });

  sqlite.transaction(() => {
    if (deltaMs !== 0 || deltaDays !== 0) {
      for (const table of userTables(sqlite, 'main')) {
        if (SKIPPED_TABLES.has(table)) continue;
        const keys = keyColumns(sqlite, table);
        for (const col of columns(sqlite, 'main', table)) {
          if (!/TEXT/i.test(col.type)) continue;
          const t = quoteIdent(table);
          const c = quoteIdent(col.name);
          if (keys.has(col.name)) {
            sqlite.prepare(`UPDATE ${t} SET ${c} = ? || ${SHIFT_FN}(${c}) WHERE ${c} GLOB ?`).run(PENDING, HAS_DATE_GLOB);
            sqlite.prepare(`UPDATE ${t} SET ${c} = substr(${c}, 2) WHERE substr(${c}, 1, 1) = ?`).run(PENDING);
          } else {
            sqlite.prepare(`UPDATE ${t} SET ${c} = ${SHIFT_FN}(${c}) WHERE ${c} GLOB ?`).run(HAS_DATE_GLOB);
          }
        }
      }
    }
    writeMeta(sqlite, DEMO_HISTORY_ENDS_KEY, now.toISOString());
  })();
}

/**
 * Returns the live Demo database to the state in `snapshotPath`, then shifts its history to end at
 * `now` and records `now` as the moment of this Reset.
 *
 * Works through the open connection rather than copying a file over it: every row of every table
 * the two databases share is replaced from the attached snapshot inside one transaction, so the
 * running app keeps its connection and never reads a half-copied file.
 *
 * Refuses, before changing anything, unless both the live database and the snapshot carry the
 * current Demo stamp. That is what stops a Reset from ever wiping a real install.
 */
export function resetDemoDatabase(sqlite: Database.Database, snapshotPath: string, now: Date): void {
  if (!hasStamp(sqlite, 'main')) {
    throw new DemoResetRefusedError(
      `The database is not a Demo database (no ${DEMO_STAMP_KEY} stamp), so the Reset did not touch it.`,
    );
  }

  sqlite.prepare('ATTACH DATABASE ? AS demo_snapshot').run(snapshotPath);
  try {
    if (!hasStamp(sqlite, 'demo_snapshot')) {
      throw new DemoResetRefusedError(
        `${snapshotPath} is not a Demo snapshot (no ${DEMO_STAMP_KEY} stamp), so the Reset did not use it.`,
      );
    }

    const snapshotTables = new Set(userTables(sqlite, 'demo_snapshot'));
    const shared = userTables(sqlite, 'main').filter(t => snapshotTables.has(t));
    const hasSequence = (sqlite
      .prepare(`SELECT 1 FROM main.sqlite_master WHERE name = 'sqlite_sequence'`).get() !== undefined)
      && (sqlite.prepare(`SELECT 1 FROM demo_snapshot.sqlite_master WHERE name = 'sqlite_sequence'`).get() !== undefined);

    sqlite.transaction(() => {
      // Inside the transaction: SQLite switches this back off at every commit.
      sqlite.pragma('defer_foreign_keys = ON');
      for (const table of shared) {
        const snapshotCols = new Set(columns(sqlite, 'demo_snapshot', table).map(c => c.name));
        const cols = columns(sqlite, 'main', table).map(c => c.name).filter(n => snapshotCols.has(n));
        const t = quoteIdent(table);
        const list = cols.map(quoteIdent).join(', ');
        sqlite.prepare(`DELETE FROM main.${t}`).run();
        if (cols.length > 0) {
          sqlite.prepare(`INSERT INTO main.${t} (${list}) SELECT ${list} FROM demo_snapshot.${t}`).run();
        }
      }
      if (hasSequence) {
        sqlite.prepare('DELETE FROM main.sqlite_sequence').run();
        sqlite.prepare('INSERT INTO main.sqlite_sequence (name, seq) SELECT name, seq FROM demo_snapshot.sqlite_sequence').run();
      }
    })();
  } finally {
    sqlite.prepare('DETACH DATABASE demo_snapshot').run();
  }

  finishDemoReset(sqlite, now);
}

/** The last step of every Reset, including the one a restart does: history moved to end at `now`,
 *  and `now` recorded as the moment of the Reset. */
export function finishDemoReset(sqlite: Database.Database, now: Date): void {
  shiftDemoHistory(sqlite, now);
  writeMeta(sqlite, DEMO_RESET_AT_KEY, now.toISOString());
}
