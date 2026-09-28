/**
 * A Reset (lib/demo/reset.ts) wipes the live database and moves every date in it. These tests pin
 * what makes that safe and what makes it worth doing: it only ever touches a stamped Demo database,
 * it brings back exactly the snapshot, and after it the Demo's history ends at the Reset with every
 * relative age unchanged.
 *
 * Every database here is a throwaway file in a temp directory.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  DEMO_HISTORY_ENDS_KEY,
  DEMO_RESET_AT_KEY,
  DemoResetRefusedError,
  resetDemoDatabase,
  shiftDemoHistory,
} from '@/lib/demo/reset';
import { DEMO_STAMP_KEY } from '@/lib/demo/stamp';

const GENERATED_AT = '2026-01-10T12:00:00.000Z';

let dir: string;
const open: Database.Database[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rulebeat-demo-reset-'));
});

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A small database with the shapes a Reset has to handle: timestamps, a date in a primary key,
 *  dates inside JSON, and an autoincrement counter. */
function makeDemoDatabase(name: string, opts: { stamp?: boolean; marker?: string } = {}): Database.Database {
  const db = new Database(join(dir, name));
  open.push(db);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE findings (id TEXT PRIMARY KEY, first_seen_at TEXT, details TEXT, title TEXT);
    CREATE TABLE posture_snapshots (date TEXT NOT NULL, formula TEXT NOT NULL, passing INTEGER, PRIMARY KEY (date, formula));
    CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, summary TEXT);
  `);
  if (opts.stamp !== false) db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(DEMO_STAMP_KEY, '1');
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(DEMO_HISTORY_ENDS_KEY, GENERATED_AT);
  db.prepare('INSERT INTO findings VALUES (?, ?, ?, ?)').run(
    'f1', '2026-01-02T12:00:00.000Z', JSON.stringify({ expiresOn: '2026-01-20T00:00:00.000Z' }), opts.marker ?? 'snapshot');
  const snap = db.prepare('INSERT INTO posture_snapshots VALUES (?, ?, ?)');
  // Consecutive days, so a shift that moved rows one at a time would collide on the primary key.
  for (const day of ['2026-01-08', '2026-01-09', '2026-01-10']) snap.run(day, 'v2', 1);
  db.prepare('INSERT INTO audit (at, summary) VALUES (?, ?)').run('2026-01-10T11:00:00.000Z', 'seeded');
  return db;
}

function finding(db: Database.Database): { first_seen_at: string; details: string; title: string } {
  return db.prepare('SELECT first_seen_at, details, title FROM findings WHERE id = ?').get('f1') as never;
}

function meta(db: Database.Database, key: string): string | undefined {
  return (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

describe('shiftDemoHistory()', () => {
  it('moves timestamps, dates and dates inside JSON so history ends at now, keeping every age', () => {
    const db = makeDemoDatabase('demo.db');
    shiftDemoHistory(db, new Date('2026-03-01T12:00:00.000Z'));

    // 50 days later, to the millisecond: the finding was 8 days old and still is.
    expect(finding(db).first_seen_at).toBe('2026-02-21T12:00:00.000Z');
    expect(JSON.parse(finding(db).details)).toEqual({ expiresOn: '2026-03-11T00:00:00.000Z' });
    expect((db.prepare('SELECT date FROM posture_snapshots ORDER BY date').all() as { date: string }[]).map(r => r.date))
      .toEqual(['2026-02-27', '2026-02-28', '2026-03-01']);
    expect((db.prepare('SELECT at FROM audit').get() as { at: string }).at).toBe('2026-03-01T11:00:00.000Z');
    expect(meta(db, DEMO_HISTORY_ENDS_KEY)).toBe('2026-03-01T12:00:00.000Z');
  });

  it('moves posture days by calendar days, so a day never splits in two', () => {
    const db = makeDemoDatabase('demo.db');
    // 36 hours later but two calendar days on.
    shiftDemoHistory(db, new Date('2026-01-12T00:00:00.000Z'));
    expect((db.prepare('SELECT max(date) AS d FROM posture_snapshots').get() as { d: string }).d).toBe('2026-01-12');
  });

  it('leaves a value with no date in it alone', () => {
    const db = makeDemoDatabase('demo.db', { marker: 'Storage account 2026 plan' });
    shiftDemoHistory(db, new Date('2026-03-01T12:00:00.000Z'));
    expect(finding(db).title).toBe('Storage account 2026 plan');
  });

  it('does nothing on a database with no recorded end of history', () => {
    const db = makeDemoDatabase('demo.db');
    db.prepare('DELETE FROM meta WHERE key = ?').run(DEMO_HISTORY_ENDS_KEY);
    shiftDemoHistory(db, new Date('2026-03-01T12:00:00.000Z'));
    expect(finding(db).first_seen_at).toBe('2026-01-02T12:00:00.000Z');
  });
});

describe('resetDemoDatabase()', () => {
  it('replaces every row from the snapshot, then shifts it and records the Reset', () => {
    const snapshotPath = join(dir, 'snapshot.db');
    makeDemoDatabase('snapshot.db').close();
    const live = makeDemoDatabase('demo.db', { marker: 'visitor-edit' });
    live.prepare('INSERT INTO audit (at, summary) VALUES (?, ?)').run('2026-01-10T11:30:00.000Z', 'visitor deleted a rule');
    live.prepare('INSERT INTO findings VALUES (?, ?, ?, ?)').run('f2', GENERATED_AT, '{}', 'visitor-added');

    const now = new Date('2026-03-01T12:00:00.000Z');
    resetDemoDatabase(live, snapshotPath, now);

    expect(finding(live).title).toBe('snapshot');
    expect(live.prepare('SELECT count(*) AS n FROM findings').get()).toEqual({ n: 1 });
    expect(live.prepare('SELECT summary FROM audit').all()).toEqual([{ summary: 'seeded' }]);
    // The counter comes back too, so the next audit row gets the id it had in the snapshot.
    live.prepare('INSERT INTO audit (at, summary) VALUES (?, ?)').run(now.toISOString(), 'after');
    expect((live.prepare('SELECT max(id) AS id FROM audit').get() as { id: number }).id).toBe(2);

    expect(finding(live).first_seen_at).toBe('2026-02-21T12:00:00.000Z');
    expect(meta(live, DEMO_RESET_AT_KEY)).toBe(now.toISOString());
    expect(meta(live, DEMO_HISTORY_ENDS_KEY)).toBe(now.toISOString());
  });

  it('shifts from the snapshot, not from wherever the live database had got to', () => {
    const snapshotPath = join(dir, 'snapshot.db');
    makeDemoDatabase('snapshot.db').close();
    const live = makeDemoDatabase('demo.db');
    resetDemoDatabase(live, snapshotPath, new Date('2026-02-01T12:00:00.000Z'));
    resetDemoDatabase(live, snapshotPath, new Date('2026-03-01T12:00:00.000Z'));
    expect(finding(live).first_seen_at).toBe('2026-02-21T12:00:00.000Z');
  });

  it('refuses a live database without the Demo stamp and leaves it untouched', () => {
    const snapshotPath = join(dir, 'snapshot.db');
    makeDemoDatabase('snapshot.db').close();
    const live = makeDemoDatabase('rulebeat.db', { stamp: false, marker: 'customer-data' });

    expect(() => resetDemoDatabase(live, snapshotPath, new Date())).toThrow(DemoResetRefusedError);
    expect(finding(live)).toMatchObject({ title: 'customer-data', first_seen_at: '2026-01-02T12:00:00.000Z' });
  });

  it('refuses a snapshot without the Demo stamp and leaves the live database untouched', () => {
    const snapshotPath = join(dir, 'snapshot.db');
    makeDemoDatabase('snapshot.db', { stamp: false, marker: 'unstamped' }).close();
    const live = makeDemoDatabase('demo.db', { marker: 'visitor-edit' });

    expect(() => resetDemoDatabase(live, snapshotPath, new Date())).toThrow(DemoResetRefusedError);
    expect(finding(live).title).toBe('visitor-edit');
    expect(meta(live, DEMO_RESET_AT_KEY)).toBeUndefined();
    // The snapshot was detached on the way out, so the next Reset can attach it again.
    expect(live.prepare('PRAGMA database_list').all()).toHaveLength(1);
  });
});
