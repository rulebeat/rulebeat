/**
 * The Demo's boot step (lib/demo/boot.ts) overwrites a database file every time the Demo starts.
 * These tests pin the two things that make that safe: it only ever overwrites a Demo database, and
 * a restart restores exactly the snapshot for the configured Data set, Seed and release.
 *
 * Every file here lives in a temp directory. The ambient test database is never the target.
 *
 * The Demo is SQLite-only whatever backend the suite runs on, so the backend is pinned to SQLite
 * here; the Postgres refusal test swaps it for 'pg' on a fresh module registry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/backend', () => ({ dbKind: 'sqlite' }));
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  assertReplaceableDemoDatabase,
  prepareDemoDatabase,
  pruneDemoSnapshots,
  restoreDemoSnapshot,
  snapshotFileName,
  writeDemoSnapshot,
} from '@/lib/demo/boot';
import { DemoConfigError } from '@/lib/demo/config';
import { DEFAULT_SEED } from '@/lib/demo/prng';
import { DEMO_HISTORY_ENDS_KEY, DEMO_RESET_AT_KEY } from '@/lib/demo/reset';
import { DEMO_STAMP_KEY, LEGACY_DEMO_STAMP_KEYS } from '@/lib/demo/stamp';
import { getAppVersion } from '@/lib/version';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rulebeat-demo-boot-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function makeDatabase(path: string, opts: { stamp?: string; marker?: string } = {}): void {
  const sqlite = new Database(path);
  sqlite.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  sqlite.exec('CREATE TABLE marker (value TEXT)');
  if (opts.stamp) sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(opts.stamp, '1');
  if (opts.marker) sqlite.prepare('INSERT INTO marker (value) VALUES (?)').run(opts.marker);
  sqlite.close();
}

function readMarker(path: string): string | undefined {
  const sqlite = new Database(path, { readonly: true });
  try {
    return (sqlite.prepare('SELECT value FROM marker').get() as { value: string } | undefined)?.value;
  } finally {
    sqlite.close();
  }
}

describe('assertReplaceableDemoDatabase()', () => {
  it('accepts a missing file and an empty file', () => {
    expect(() => assertReplaceableDemoDatabase(join(dir, 'missing.db'))).not.toThrow();
    const empty = join(dir, 'empty.db');
    writeFileSync(empty, '');
    expect(() => assertReplaceableDemoDatabase(empty)).not.toThrow();
  });

  it('accepts a database stamped by this release or an earlier Demo', () => {
    for (const stamp of [DEMO_STAMP_KEY, ...LEGACY_DEMO_STAMP_KEYS]) {
      const path = join(dir, `${stamp}.db`);
      makeDatabase(path, { stamp });
      expect(() => assertReplaceableDemoDatabase(path)).not.toThrow();
    }
  });

  it('refuses a real database that carries no Demo stamp', () => {
    const path = join(dir, 'rulebeat.db');
    makeDatabase(path);
    expect(() => assertReplaceableDemoDatabase(path)).toThrow(DemoConfigError);
  });

  it('refuses a database with no meta table, and a file that is not SQLite at all', () => {
    const noMeta = join(dir, 'no-meta.db');
    const sqlite = new Database(noMeta);
    sqlite.exec('CREATE TABLE rules (id TEXT)');
    sqlite.close();
    expect(() => assertReplaceableDemoDatabase(noMeta)).toThrow(DemoConfigError);

    const text = join(dir, 'notes.db');
    writeFileSync(text, 'not a database');
    expect(() => assertReplaceableDemoDatabase(text)).toThrow(DemoConfigError);
  });
});

describe('snapshots', () => {
  it('names a snapshot by Data set, Seed and release', () => {
    expect(snapshotFileName({ dataSet: 'contoso', seed: 0xc0ffee }, '0.5.1')).toBe('contoso-seed-c0ffee-v0.5.1.db');
  });

  it('writes a snapshot that includes committed rows still in the WAL, and restores it over the live file', () => {
    const source = join(dir, 'source.db');
    const sqlite = new Database(source);
    sqlite.pragma('journal_mode = WAL');
    sqlite.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    sqlite.exec('CREATE TABLE marker (value TEXT)');
    sqlite.prepare('INSERT INTO marker (value) VALUES (?)').run('from-snapshot');

    const snapshot = join(dir, 'snaps', 'a.db');
    writeDemoSnapshot(sqlite, snapshot);
    sqlite.close();
    expect(existsSync(`${snapshot}.tmp`)).toBe(false);

    const live = join(dir, 'live.db');
    makeDatabase(live, { marker: 'visitor-edit' });
    writeFileSync(`${live}-wal`, 'stale');
    writeFileSync(`${live}-shm`, 'stale');

    restoreDemoSnapshot(snapshot, live);
    expect(existsSync(`${live}-wal`)).toBe(false);
    expect(existsSync(`${live}-shm`)).toBe(false);
    expect(readMarker(live)).toBe('from-snapshot');
  });

  it('prunes every snapshot except the one in use', () => {
    const snaps = join(dir, 'snaps');
    mkdirSync(snaps);
    for (const name of ['keep.db', 'old-release.db', 'other-seed.db', 'half-written.db.tmp']) {
      writeFileSync(join(snaps, name), '');
    }
    pruneDemoSnapshots(snaps, 'keep.db');
    expect(readdirSync(snaps)).toEqual(['keep.db']);
  });
});

describe('prepareDemoDatabase()', () => {
  it('restores the snapshot for the configured Data set, Seed and release, and prunes the rest', async () => {
    const snaps = join(dir, 'snaps');
    mkdirSync(snaps);
    const name = snapshotFileName({ dataSet: 'contoso', seed: DEFAULT_SEED }, getAppVersion());
    makeDatabase(join(snaps, name), { stamp: DEMO_STAMP_KEY, marker: 'pristine' });
    writeFileSync(join(snaps, 'contoso-seed-2a-v0.0.1.db'), '');

    const live = join(dir, 'demo.db');
    makeDatabase(live, { stamp: DEMO_STAMP_KEY, marker: 'visitor-edit' });
    vi.stubEnv('RULEBEAT_DB_PATH', live);
    vi.stubEnv('RULEBEAT_DEMO_SEED', '');
    vi.stubEnv('RULEBEAT_DEMO_DATASET', '');

    await expect(prepareDemoDatabase({ snapshotDir: snaps })).resolves.toBe('restored');
    expect(readMarker(live)).toBe('pristine');
    expect(readdirSync(snaps)).toEqual([name]);
  });

  it('moves the restored history to end at boot, and records the boot as a Reset', async () => {
    const snaps = join(dir, 'snaps');
    mkdirSync(snaps);
    const snapshot = join(snaps, snapshotFileName({ dataSet: 'contoso', seed: DEFAULT_SEED }, getAppVersion()));
    makeDatabase(snapshot, { stamp: DEMO_STAMP_KEY, marker: '2026-01-02T12:00:00.000Z' });
    const sqlite = new Database(snapshot);
    sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(DEMO_HISTORY_ENDS_KEY, '2026-01-10T12:00:00.000Z');
    sqlite.close();

    const live = join(dir, 'demo.db');
    vi.stubEnv('RULEBEAT_DB_PATH', live);
    vi.stubEnv('RULEBEAT_DEMO_SEED', '');
    vi.stubEnv('RULEBEAT_DEMO_DATASET', '');

    const before = Date.now();
    await prepareDemoDatabase({ snapshotDir: snaps });
    const reader = new Database(live, { readonly: true });
    try {
      const meta = (key: string) => (reader.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string }).value;
      const resetAt = new Date(meta(DEMO_RESET_AT_KEY)).getTime();
      expect(resetAt).toBeGreaterThanOrEqual(before);
      expect(meta(DEMO_HISTORY_ENDS_KEY)).toBe(meta(DEMO_RESET_AT_KEY));
      // Eight days before the end of history when generated, eight days before the boot now.
      expect(new Date(readMarker(live)!).getTime()).toBe(resetAt - 8 * 86_400_000);
    } finally {
      reader.close();
    }
  });

  it('refuses to replace a database that is not a Demo database, and leaves it untouched', async () => {
    const snaps = join(dir, 'snaps');
    mkdirSync(snaps);
    const name = snapshotFileName({ dataSet: 'contoso', seed: DEFAULT_SEED }, getAppVersion());
    makeDatabase(join(snaps, name), { stamp: DEMO_STAMP_KEY, marker: 'pristine' });

    const live = join(dir, 'rulebeat.db');
    makeDatabase(live, { marker: 'customer-data' });
    vi.stubEnv('RULEBEAT_DB_PATH', live);

    await expect(prepareDemoDatabase({ snapshotDir: snaps })).rejects.toThrow(/is not a Demo database/);
    expect(readMarker(live)).toBe('customer-data');
  });

  it('refuses an invalid Seed before touching any file', async () => {
    const live = join(dir, 'demo.db');
    makeDatabase(live, { stamp: DEMO_STAMP_KEY, marker: 'visitor-edit' });
    vi.stubEnv('RULEBEAT_DB_PATH', live);
    vi.stubEnv('RULEBEAT_DEMO_SEED', 'not-a-seed');

    await expect(prepareDemoDatabase({ snapshotDir: join(dir, 'snaps') })).rejects.toThrow(DemoConfigError);
    expect(readMarker(live)).toBe('visitor-edit');
  });

  it('refuses an in-memory database', async () => {
    vi.stubEnv('RULEBEAT_DB_PATH', ':memory:');
    await expect(prepareDemoDatabase({ snapshotDir: join(dir, 'snaps') })).rejects.toThrow(/:memory:/);
  });

  it('refuses to start on Postgres', async () => {
    vi.resetModules();
    vi.doMock('@/lib/db/backend', () => ({ dbKind: 'pg' }));
    try {
      const boot = await import('@/lib/demo/boot');
      await expect(boot.prepareDemoDatabase({ snapshotDir: join(dir, 'snaps') })).rejects.toThrow(/SQLite only/);
    } finally {
      vi.doUnmock('@/lib/db/backend');
      vi.resetModules();
    }
  });
});
